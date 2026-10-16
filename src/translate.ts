/**
 * 流式数据帧 → harness `StreamChunk` 的状态机。
 *
 * 这是本插件与 harness 的唯一协议接缝，因此翻译规则写死在这里并且可单测：
 *  - `delta.reasoning_content` → `reasoning-delta`。Strata 的思考通道是非标准字段
 *    （交接文档 3.5），harness 的 `reasoning` 块正好承载它，思考内容因此不会被丢进
 *    可见文本，也不会被当成"空回复"。
 *  - `delta.content` → `text-delta`。
 *  - `delta.tool_calls[]` → `tool-call-delta`：按响应内的 `index` 各自累积，块序号
 *    与 OpenAI 的 tool 序号解耦；`arguments` 分片原样透传，harness 侧自行拼接 JSON。
 *  - `finish_reason` 映射到 harness 的 `FinishReason`；`length` 是 `max-tokens`
 *    —— 交接文档 3.5 的"思考耗尽预算"正是这条路径。
 *
 * @module dsh-plugin-strata/translate
 */

import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm'

/** 一个流式数据帧的非标准扩展字段（性能计数，不解析也不报错）。 */
export interface StrataTimings {
  prompt_n?: number
  prompt_ms?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
  draft_n?: number
  draft_n_accepted?: number
}

/** 一次工具调用的分片（OpenAI 流式 `tool_calls[]` 的一个元素）。 */
export interface WireToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/** 服务返回的一个流式数据帧（OpenAI 兼容，含 Strata 的非标准字段）。 */
export interface ChatStreamChunk {
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: WireToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  timings?: StrataTimings
}

/** 正在累积的文本/推理块。 */
interface TextBlockState {
  kind: 'text' | 'reasoning'
  index: number
  text: string
}

/** 正在累积的工具调用块（`arguments` 是未解析的 JSON 分片拼接）。 */
interface ToolBlockState {
  kind: 'tool-call'
  index: number
  id: ToolCallId
  name: string
  args: string
}

/** 正在累积的一个块。 */
type OpenBlock = TextBlockState | ToolBlockState

/**
 * 把 `finish_reason` 映射到 harness 的完成原因。
 * @param reason - 服务给出的 `finish_reason`。
 * @returns harness 的完成原因；未知取值按正常结束处理（不制造失败）。
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'length': return { kind: 'max-tokens' }
    case 'tool_calls':
    case 'function_call': return { kind: 'tool-calls' }
    default: return { kind: 'stop' }
  }
}

/**
 * 映射 token 用量。harness 的 `inputTokens` 是**未缓存输入**，而本地服务不做缓存计费，
 * 因此 `prompt_tokens` 直接就是未缓存输入。
 * @param usage - 服务给出的 usage 对象。
 * @returns harness 的 token 用量；字段不可用时返回 `undefined`（不编造数字）。
 */
export function mapUsage(usage: ChatStreamChunk['usage']): TokenUsage | undefined {
  const input = usage?.prompt_tokens
  const output = usage?.completion_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  const total = usage?.total_tokens
  return {
    inputTokens: input,
    outputTokens: output,
    ...typeof total === 'number' ? { totalTokens: total } : {},
  }
}

/**
 * 有状态的帧翻译器：一个实例对应一条响应流。
 *
 * 同步、无 I/O：`push()` 只做翻译，HTTP 由调用方负责，因此翻译逻辑可以脱离
 * 网络直接测。
 */
export class StreamTranslator {
  private readonly blocks = new Map<number, OpenBlock>()
  private readonly toolBlocks = new Map<number, number>()
  private active: TextBlockState | undefined
  private nextIndex = 0
  private sawFinish = false
  private usageValue: TokenUsage | undefined
  private timingsValue: StrataTimings | undefined

  /**
   * 翻译一个数据帧。
   * @param payload - SSE 的 `data` 负载（一段 JSON 文本）。
   * @returns 该帧产生的 chunk，顺序即块顺序。
   */
  push(payload: string): StreamChunk[] {
    const chunk = JSON.parse(payload) as ChatStreamChunk
    const out: StreamChunk[] = []
    if (chunk.timings !== undefined) this.timingsValue = chunk.timings
    const choice = chunk.choices?.[0]
    if (choice !== undefined) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        const block = this.openText('reasoning', out)
        block.text += reasoning
        out.push({ type: 'reasoning-delta', index: block.index, text: reasoning })
      }
      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        const block = this.openText('text', out)
        block.text += content
        out.push({ type: 'text-delta', index: block.index, text: content })
      }
      for (const call of delta?.tool_calls ?? []) out.push(...this.toolDelta(call, out))
      const reason = choice.finish_reason
      if (typeof reason === 'string' && reason.length > 0) {
        this.closeAll(out)
        out.push({ type: 'finish', reason: mapFinishReason(reason) })
        this.sawFinish = true
      }
    }
    if (chunk.usage !== undefined) {
      const usage = mapUsage(chunk.usage)
      if (usage !== undefined) {
        this.usageValue = usage
        out.push({ type: 'usage', usage })
      }
    }
    return out
  }

  /**
   * 流结束时冲刷：服务没有给出 `finish_reason` 时补齐块收尾与完成原因，
   * 保证消费者拿到的流一定以 `finish` 结束。
   * @returns 剩余 chunk；流已经正常结束时为空。
   */
  end(): StreamChunk[] {
    if (this.sawFinish) return []
    const out: StreamChunk[] = []
    this.closeAll(out)
    out.push({ type: 'finish', reason: { kind: 'stop' } })
    this.sawFinish = true
    return out
  }

  /** 已经收到 `finish_reason`。 */
  get finished(): boolean {
    return this.sawFinish
  }

  /** 这一条响应的 token 用量（服务未提供时为 `undefined`）。 */
  get usage(): TokenUsage | undefined {
    return this.usageValue
  }

  /** 服务在响应里报告的最后一份 timings（性能观测用，可能为 `undefined`）。 */
  get timings(): StrataTimings | undefined {
    return this.timingsValue
  }

  /** 取（必要时新建）当前类型的活动文本块，切换类型时先收尾旧块。 */
  private openText(kind: 'text' | 'reasoning', out: StreamChunk[]): TextBlockState {
    if (this.active !== undefined && this.active.kind === kind) return this.active
    this.closeActive(out)
    const block: TextBlockState = { kind, index: this.nextIndex++, text: '' }
    this.blocks.set(block.index, block)
    this.active = block
    out.push({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }

  /** 翻译一个工具调用的分片。 */
  private toolDelta(call: WireToolCallDelta, out: StreamChunk[]): StreamChunk[] {
    const toolIndex = call.index ?? 0
    let blockIndex = this.toolBlocks.get(toolIndex)
    if (blockIndex === undefined) {
      this.closeActive(out)
      const block: ToolBlockState = {
        kind: 'tool-call',
        index: this.nextIndex++,
        // 服务在首个分片给出调用 id；缺失时给一个确定性的兜底 id，绝不发空洞。
        id: (call.id ?? `call-${toolIndex}`) as ToolCallId,
        name: call.function?.name ?? '',
        args: '',
      }
      this.blocks.set(block.index, block)
      this.toolBlocks.set(toolIndex, block.index)
      blockIndex = block.index
      out.push({ type: 'block-start', index: blockIndex, blockType: 'tool-call' })
    }
    const block = this.blocks.get(blockIndex)
    if (block === undefined || block.kind !== 'tool-call') {
      throw new Error(`strata: 工具块 ${blockIndex} 不在累积表里`)
    }
    if (call.id !== undefined && call.id.length > 0) block.id = call.id as ToolCallId
    const name = call.function?.name
    if (name !== undefined && name.length > 0) block.name = name
    const argumentsDelta = call.function?.arguments ?? ''
    block.args += argumentsDelta
    return [{
      type: 'tool-call-delta',
      index: blockIndex,
      id: block.id,
      ...name === undefined || name.length === 0 ? {} : { name },
      argumentsDelta,
    }]
  }

  /** 收尾活动文本块（若有）。 */
  private closeActive(out: StreamChunk[]): void {
    const active = this.active
    if (active === undefined) return
    out.push({ type: 'block-end', index: active.index, block: assemble(active) })
    this.active = undefined
  }

  /** 收尾全部未关闭的块，按块序号升序。 */
  private closeAll(out: StreamChunk[]): void {
    this.closeActive(out)
    const open = [...this.blocks.values()]
      .filter((block): block is ToolBlockState => block.kind === 'tool-call')
      .sort((left, right) => left.index - right.index)
    for (const block of open) {
      out.push({ type: 'block-end', index: block.index, block: assemble(block) })
      this.blocks.delete(block.index)
    }
  }
}

/** 组装一个块的最终内容。 */
function assemble(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return { type: 'tool-call', id: block.id, name: block.name, arguments: block.args }
  }
}
