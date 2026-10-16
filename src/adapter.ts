/**
 * `strata` provider 的适配器：把 harness 的模型调用翻译成对本地 Strata 服务的
 * `POST /v1/chat/completions`（流式），再把流式数据帧翻译回 harness 的 chunk。
 *
 * 本机服务的实测行为（交接文档第 3 节）决定了实现里的三个硬性选择：
 *  1. 每个 provider 请求都必须带归因头（harness 的适配器合同），这里统一从
 *     `attributionHeaders()` 取。
 *  2. `content` 为 null 且 `finish_reason == "length"` 是"思考烧完了预算"，不是
 *     空回复：映射成 `max-tokens` 的完成原因，让上层看到截断而不是静默成功。
 *  3. 生成速度 40–70 tok/s，超时按分钟给；超时值可配。
 *
 * @module dsh-plugin-strata/adapter
 */

import type { LlmAdapter, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import { StrataError, attributionHeaders } from './host.ts'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.ts'
import { REASONING_EFFORTS } from './config.ts'
import { describe, fetchListing } from './models.ts'
import type { StrataModelEntry } from './models.ts'
import { parseSse } from './sse.ts'
import { StreamTranslator } from './translate.ts'
import { buildChatRequest } from './wire.ts'

/** 适配器的构造参数。 */
export interface StrataAdapterOptions {
  /** 每次请求解析一次连接事实（配置变更立刻生效，不需要重建适配器）。 */
  resolveFacts: () => ResolvedConfig
  /** 注入的 `fetch`，默认全局实现；测试用它接本地桩服务器。 */
  fetchImpl?: typeof fetch
  /** 观测日志回调（timings、就绪状态）；省略则不打日志。 */
  log?: (message: string) => void
  /**
   * 请求前的懒启动钩子：服务没运行时按策略拉起并等到就绪（本地权重加载要一到两分钟）。
   * 省略即不做任何托管，请求直连端点。
   */
  ensureServed?: (signal?: AbortSignal) => Promise<void>
  /** 记录一次活动，用于空闲回收计时。 */
  touch?: () => void
}

/** 一次请求的错误响应体最多读入的字符数。 */
const ERROR_BODY_CHARS = 400

/** 模型目录缓存的有效期：一次调用里 `resolveModel` 与 `listModels` 都会问后端。 */
const CATALOG_TTL_MS = 5_000

/**
 * 本地 Strata 服务的适配器。
 *
 * 只做 I/O 与协议翻译，不做重试：重试策略属于路由，`providerRetryPolicy` 未覆写
 * 即采用 harness 的常规默认。
 */
export class StrataAdapter implements LlmAdapter {
  private readonly resolveFacts: () => ResolvedConfig
  private readonly fetchImpl: typeof fetch
  private readonly log: ((message: string) => void) | undefined
  private readonly ensureServed: ((signal?: AbortSignal) => Promise<void>) | undefined
  private readonly touch: (() => void) | undefined
  /** 后端模型目录的短缓存（见 `catalog`）。 */
  private catalogCache: { at: number; entries: readonly StrataModelEntry[] } | undefined

  /**
   * @param options - 事实解析器、可选 fetch 注入、日志与托管钩子。
   */
  constructor(options: StrataAdapterOptions) {
    this.resolveFacts = options.resolveFacts
    this.fetchImpl = options.fetchImpl ?? fetch
    this.log = options.log
    this.ensureServed = options.ensureServed
    this.touch = options.touch
  }

  /**
   * 描述这条路由。
   * @param provider - 注册时传入的 provider 名。
   * @returns provider 元数据（id 必须等于传入值）。
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Strata（本机 HIP 推理）' }
  }

  /**
   * 不覆写重试策略：`undefined` 即采用 harness 的常规默认。
   *
   * 这个方法与 {@link imageRequestPricing}、{@link prepareCall} 一起，是
   * `LlmAdapter` 基类给出的默认实现——本插件不继承它（原因见 `host.ts`），
   * 因此按同样的语义自己给一份。
   * @returns 总是 `undefined`。
   */
  providerRetryPolicy(): undefined {
    return undefined
  }

  /**
   * 不声明图片计价：本机 `vision: none`，请求里不会有图像。
   * @returns 总是 `undefined`。
   */
  imageRequestPricing(): undefined {
    return undefined
  }

  /**
   * 绑定一次调用的模型元数据与派发入口（基类默认实现的等价物）。
   * @param provider - 已注册的 provider 路由。
   * @param model - 确切的模型 id。
   * @param signal - 模型解析的取消信号。
   * @returns 模型元数据与这一代适配器的流入口。
   */
  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  /**
   * 询问服务当前有哪些模型。
   *
   * 这是模型列表的**唯一来源**：服务不可达时返回空数组，而不是编一个出来——
   * 编出来的那个一旦服务换了模型就会变成谎话。
   * @param provider - 本条路由的 provider 名。
   * @returns 服务报出的模型目录。
   */
  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const facts = this.resolveFacts()
    const entries = await this.catalog(facts)
    return entries.map(entry => ({
      provider,
      id: entry.id,
      name: entry.id,
      ...typeof entry.meta?.n_ctx === 'number' ? { description: `上下文 ${entry.meta.n_ctx}` } : {},
      inputModalities: ['text'] as const,
    }))
  }

  /**
   * 解析一条确切路由的元数据，上下文容量以后端报出的为准。
   * @param provider - 本条路由的 provider 名。
   * @param model - 请求里的模型 id（来自 dsh 的选择器，列表由后端提供）。
   * @returns 模型元数据。`inputModalities: ['text']` 让 harness 把图像历史投影成
   *   文本（本机 `vision: none`，交给服务反而会失败）。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const facts = this.resolveFacts()
    const entry = (await this.catalog(facts)).find(candidate => candidate.id === model)
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      // 后端自述的容量优先（GET /v1/models 的 meta.n_ctx）；拿不到才用配置值。
      context: { contextWindow: entry?.meta?.n_ctx ?? facts.contextWindow },
      defaultMaxTokens: facts.maxTokens,
      reasoning: {
        efforts: REASONING_EFFORTS.map(id => ({ id: id as ReasoningEffortId, name: id })),
        defaultEffort: facts.reasoningEffort as ReasoningEffortId,
      },
    }
  }

  /**
   * 读取后端的模型目录，带一个短缓存。
   *
   * 一次调用里 `resolveModel` 与 `listModels` 都会问，缓存把"每轮多打两次 HTTP"
   * 压成一次；几秒的窗口足够，因为服务换模型本来就要重启（重新加载权重）。
   * @param facts - 已解析的连接事实。
   * @returns 服务报出的模型条目；服务不可达时为空数组。
   */
  private async catalog(facts: ResolvedConfig): Promise<readonly StrataModelEntry[]> {
    const now = Date.now()
    if (this.catalogCache !== undefined && now - this.catalogCache.at < CATALOG_TTL_MS) {
      return this.catalogCache.entries
    }
    try {
      const entries = await fetchListing(facts.baseURL, strataHeaders(facts))
      this.catalogCache = { at: now, entries }
      return entries
    } catch (error) {
      this.log?.(`strata: 读取模型目录失败（${describe(error)}）`)
      return []
    }
  }

  /**
   * 流式执行一次模型调用。
   * @param options - harness 装配完成的请求；必须遵守 `options.signal`。
   * @returns 该次调用的 chunk 流；失败以异常抛出，由 `LlmRuntime` 规范化为
   *   `error` / `aborted` 完成原因。
   */
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const facts = this.resolveFacts()
    // 懒启动发生在真正要用它的这一刻；服务没起而策略禁止自动启动时，这里抛出的
    // LlmError 会带着可行动的指引走 harness 的失败规范化路径。
    await this.ensureServed?.(options.signal)
    this.touch?.()
    const url = `${facts.baseURL}/chat/completions`
    const body = buildChatRequest(options, {
      ...facts.model === undefined ? {} : { model: facts.model },
      reasoningEffort: facts.reasoningEffort,
      maxTokens: facts.maxTokens,
    })
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(facts),
        body: JSON.stringify(body),
        signal: combineSignals(facts.requestTimeoutMs, options.signal),
      })
    } catch (error) {
      throw new StrataError(`strata: POST ${url} 失败：${describe(error)}`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) throw await httpFailure(response, url)
    const streamBody = response.body
    if (streamBody === null) {
      throw new StrataError('strata: 响应没有可读的正文流', 'EMPTY_STREAM', { status: response.status })
    }
    const translator = new StreamTranslator()
    for await (const payload of parseSse(streamBody)) {
      for (const chunk of translator.push(payload)) yield chunk
    }
    for (const chunk of translator.end()) yield chunk
    this.touch?.()
    const timings = translator.timings
    if (timings !== undefined) {
      this.log?.(`strata: ${timings.predicted_per_second ?? '?'} tok/s`
        + `（prompt ${timings.prompt_n ?? '?'} / 预测 ${timings.predicted_n ?? '?'}`
        + ` / MTP 接受 ${timings.draft_n_accepted ?? 0}/${timings.draft_n ?? 0}）`)
    }
  }

  /** 组装请求头：归因头 + 凭据 + 内容类型。 */
  private headers(facts: ResolvedConfig): Record<string, string> {
    return strataHeaders(facts)
  }
}

/**
 * 组装发往本地服务的请求头。
 *
 * 归因头是 harness 对适配器的硬性合同（每个 provider 请求都要带），因此在唯一
 * 一处组装，避免适配器与就绪探测各写一份而漂移。
 * @param facts - 已解析的连接事实。
 * @returns 请求头。
 */
export function strataHeaders(facts: ResolvedConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...attributionHeaders(),
    ...facts.apiKey.length === 0 ? {} : { authorization: `Bearer ${facts.apiKey}` },
  }
}

/**
 * 组合总超时与调用方取消信号。
 * @param timeoutMs - 单次请求总超时。
 * @param signal - 调用方信号（可选）。
 * @returns 任一触发即中止的信号。
 */
export function combineSignals(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal])
}

/**
 * 把非 2xx 响应变成带状态的 `LlmError`，并附上服务原文（截断）便于定位。
 * @param response - 非 2xx 的响应。
 * @param url - 请求地址，写进错误消息。
 * @returns 待抛出的错误。
 */
export async function httpFailure(response: Response, url: string): Promise<StrataError> {
  let detail = ''
  try {
    detail = (await response.text()).slice(0, ERROR_BODY_CHARS)
  } catch (error) {
    // 正文读不出来不影响错误本身：状态码已经足够定位。
    detail = `（读取错误正文失败：${describe(error)}）`
  }
  return new StrataError(
    `strata: POST ${url} 返回 HTTP ${response.status}${detail.length === 0 ? '' : `：${detail}`}`,
    'HTTP_STATUS',
    { status: response.status },
  )
}
