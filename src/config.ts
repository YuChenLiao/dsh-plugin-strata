/**
 * 插件配置：cordis.yml 里那段 `config:` 的形状、默认值与解析。
 *
 * 解析是**显式一步**（`resolveConfig`），装载期与每次请求都走它：部署相关的取值
 * 全部可配，代码里不留"只有改源码才能调"的常量。
 *
 * @module dsh-plugin-strata/config
 */

/** 本机 Strata 服务的 OpenAI 兼容基址（交接文档 3.1）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1'

/** 服务按配置提供的上下文容量（`--max-context 65536`）。 */
export const DEFAULT_CONTEXT_WINDOW = 65536

/** 单次请求输出上限；思考关闭时的常规取值。 */
export const DEFAULT_MAX_TOKENS = 8192

/**
 * 默认思考档位。`none` 是本机的实测最优：不传或 `low` 会把预算烧在思考通道上，
 * `none` 下 1.2 秒返回完整答案（交接文档 3.5）。
 */
export const DEFAULT_REASONING_EFFORT = 'none'

/** 本机生成速度 40–70 tok/s，长回答需要的时间远超常规云端请求。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000

/** 等待模型加载完成的上限；实测首次 79 秒，留足余量。 */
export const DEFAULT_READY_TIMEOUT_MS = 180_000

/** 空闲自动停止：最后一次活动之后 5 分钟无调用就释放那 20 GB。 */
export const DEFAULT_IDLE_SHUTDOWN_MS = 300_000

/** 请求到来而服务未运行时是否自动拉起（懒启动）。 */
export const DEFAULT_AUTO_START = true

/** 思考档位，对应服务端 `reasoning_effort`。 */
export const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const
/** 一个思考档位。 */
export type ReasoningEffort = typeof REASONING_EFFORTS[number]

/** 插件配置（yml 里每个字段都可省略，省略值见各默认常量）。 */
export interface Config {
  /** OpenAI 兼容基址；不写就按检测到的服务端口拼（检测不到则用 8080）。 */
  baseURL?: string
  /**
   * 强制指定的模型 id；**默认不设**。
   *
   * 模型由后端提供：dsh 的模型列表来自服务的 `GET /v1/models`，选择器里选中的 id 会
   * 作为请求体 `model` 发回去。只有部署方明确要覆盖选择器的选择时才写这里。
   */
  model?: string
  /** `Authorization: Bearer` 的值；本地服务不校验，填任意非空串即可。 */
  apiKey?: string
  /** 上报给 harness 的上下文容量，默认 65536。 */
  contextWindow?: number
  /** 请求未指定时的输出上限，默认 8192。 */
  maxTokens?: number
  /** 思考档位，默认 `none`。 */
  reasoningEffort?: ReasoningEffort
  /** 单次请求总超时（毫秒），默认 600000。 */
  requestTimeoutMs?: number
  /**
   * 服务启动的完整 argv；给了它就完全按它拉起，跳过自动检测。
   * 安装位置能自动检测出来，所以正常情况下不用写这个。
   */
  serveCommand?: string[]
  /** 等待模型加载完成的上限（毫秒），默认 180000。 */
  readyTimeoutMs?: number
  /** 空闲多久后停止本插件拉起的服务；0 表示不自动停止。默认 300000（5 分钟）。 */
  idleShutdownMs?: number
  /** 请求到来而服务未运行时是否自动拉起，默认 true。 */
  autoStart?: boolean
}

/** 已校验的连接事实：每次请求都从这里取，不读原始配置。 */
export interface ResolvedConfig {
  /** 去掉末尾斜杠的基址。 */
  baseURL: string
  /** 强制指定的模型 id；未配置时为 `undefined`，此时用调用方（dsh 选择器）给的那个。 */
  model?: string
  apiKey: string
  contextWindow: number
  maxTokens: number
  reasoningEffort: ReasoningEffort
  requestTimeoutMs: number
  /** 服务启动 argv；未配置时为 `undefined`，由自动检测出的安装信息组装（见 `serve.ts`）。 */
  serveCommand?: string[]
  readyTimeoutMs: number
  idleShutdownMs: number
  autoStart: boolean
}

/**
 * 把配置解析成已校验的连接事实。
 *
 * 这里**不导出 Schemastery 模式**：产物必须自包含（见 `host.ts`），而模式对象要么
 * 依赖 `schemastery` 运行时、要么手写一份与它竞争的校验规则。dsh 的 Loader 会把
 * `cordis.yml` 里那一段 `config:` 原样交给 `apply`，因此校验就集中在下面这一个显式
 * 步骤里：每个默认值与边界都在这里判一次，配置错了要在**最早可解析的时刻**炸响，
 * 而不是在第一条请求上变成看不懂的失败。
 *
 * 代价写在 README 里：没有模式就没有设置界面里的表单，配置只能写 `cordis.yml`。
 * @param config - 原始插件配置。
 * @param port - 自动检测到的服务端口；用户没写 `baseURL` 时用它拼端点。
 * @returns 已校验的事实。
 * @throws Error 任一字段不合法。
 */
export function resolveConfig(config: Config, port?: number): ResolvedConfig {
  const baseURL = (config.baseURL ?? (port === undefined ? DEFAULT_BASE_URL : `http://127.0.0.1:${port}/v1`))
    .replace(/\/+$/, '')
  if (!/^https?:\/\//.test(baseURL)) {
    throw new Error(`strata: baseURL 必须是 http(s) 绝对地址，收到 "${config.baseURL}"`)
  }
  // 模型默认由后端提供（dsh 的列表来自服务的 /v1/models），这里只处理显式覆盖。
  const model = config.model
  if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
    throw new Error('strata: model 若给就必须是非空字符串')
  }
  const apiKey = config.apiKey ?? 'local'
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error('strata: contextWindow 必须是正整数')
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('strata: maxTokens 必须是正整数')
  }
  const reasoningEffort = config.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  if (!REASONING_EFFORTS.includes(reasoningEffort)) {
    // 放宽到 string 再判：动态配置更新不会经过 schema 校验。
    const widened: string = reasoningEffort
    throw new Error(`strata: reasoningEffort 必须是 ${REASONING_EFFORTS.join(' / ')} 之一，收到 "${widened}"`)
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('strata: requestTimeoutMs 必须是正整数毫秒')
  }
  // Schemastery 会把未配置的数组规整成 `[]`，因此空数组等同于"没配"。
  const serveCommand = config.serveCommand !== undefined && config.serveCommand.length > 0
    ? config.serveCommand
    : undefined
  if (serveCommand !== undefined
    && serveCommand.some(segment => typeof segment !== 'string' || segment.length === 0)) {
    throw new Error('strata: serveCommand 必须是非空的字符串数组（argv[0] 为可执行文件）')
  }
  const readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new Error('strata: readyTimeoutMs 必须是正整数毫秒')
  }
  const idleShutdownMs = config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS
  if (!Number.isSafeInteger(idleShutdownMs) || idleShutdownMs < 0) {
    throw new Error('strata: idleShutdownMs 必须是非负整数毫秒（0 表示不自动停止）')
  }
  const autoStart = config.autoStart ?? DEFAULT_AUTO_START
  if (typeof autoStart !== 'boolean') throw new Error('strata: autoStart 必须是布尔值')
  return {
    baseURL,
    ...model === undefined ? {} : { model },
    apiKey,
    contextWindow,
    maxTokens,
    reasoningEffort,
    requestTimeoutMs,
    ...serveCommand === undefined ? {} : { serveCommand: [...serveCommand] },
    readyTimeoutMs,
    idleShutdownMs,
    autoStart,
  }
}
