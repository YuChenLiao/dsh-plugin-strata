/**
 * 请求组装：把 harness 的 provider-neutral 请求翻译成 OpenAI 兼容的
 * `POST /v1/chat/completions` 请求体。
 *
 * 只做翻译，不做 I/O，因此全部行为都能用纯函数断言。
 *
 * 三条与 Strata 实测行为直接相关的规则（交接文档 3.4 / 3.5）：
 *  1. `reasoning_effort` 必须显式带上。不传时服务会把整个 `max_tokens` 花在思考
 *     通道上，`content` 返回 null —— 对 agent 场景等同于"空回复"。
 *  2. 工具结果在 harness 里是 **user 角色、`tool-result` 块**，在 OpenAI 协议里
 *     必须展开成独立的 `role: "tool"` 消息并带 `tool_call_id`。
 *  3. 本机无视觉能力（`BUILD.json` 的 `vision: none`），因此非文本块按确定性
 *     占位文本投影，不静默丢弃内容。
 *
 * @module dsh-plugin-strata/wire
 */

import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

/** 本插件支持的思考档位，对应服务的 `reasoning_effort`。 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high'

/** 一次请求的已解析连接事实。 */
export interface RequestFacts {
  /**
   * 强制指定的模型 id；**默认不设**。
   *
   * 模型由后端提供：dsh 的模型列表来自服务的 `GET /v1/models`，用户选中什么，
   * `options.model` 就是什么。只有部署方明确想覆盖选择器的选择时才写配置。
   */
  model?: string
  /** 思考档位，原样进请求体 `reasoning_effort`。 */
  reasoningEffort: ReasoningEffort
  /** 请求级输出上限（`max_tokens`）；未配置时不发该字段。 */
  maxTokens?: number
}

/** OpenAI 兼容协议里的一条消息。 */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
}

/** OpenAI 兼容协议里的一次工具调用。 */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** OpenAI 兼容协议里的一张工具声明。 */
export interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** 组装完成的请求体。 */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  reasoning_effort: ReasoningEffort
  tools?: WireTool[]
  tool_choice?: 'auto'
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/**
 * 把内容块投影成文本。
 * @param blocks - 一条消息的块列表。
 * @returns 拼接后的文本；多块之间不加分隔符（harness 的块本身就是完整片段）。
 */
export function textOf(blocks: readonly ContentBlock[]): string {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * 一条消息可能展开成多条 wire 消息：harness 把工具结果放在 user 消息里，
 * OpenAI 要求每个结果自成一个 `role: "tool"` 消息。
 * @param message - harness 消息。
 * @returns 该消息对应的 wire 消息，顺序与块顺序一致。
 */
export function translateMessage(message: Message): WireMessage[] {
  if (message.role === 'system') {
    const text = textOf(message.content)
    return text.length === 0 ? [] : [{ role: 'system', content: text }]
  }
  if (message.role === 'assistant') {
    const text = textOf(message.content)
    const calls: WireToolCall[] = []
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } })
      }
    }
    // OpenAI 要求带工具调用的助手消息 content 可以为 null，但不能省略该字段。
    return [{
      role: 'assistant',
      content: text.length === 0 ? null : text,
      ...calls.length === 0 ? {} : { tool_calls: calls },
    }]
  }
  const results = message.content.filter(block => block.type === 'tool-result')
  if (results.length > 0) {
    return results.map(block => ({
      role: 'tool' as const,
      tool_call_id: block.toolCallId,
      content: textOf(block.content),
    }))
  }
  return [{ role: 'user', content: textOf(message.content) }]
}

/**
 * 组装一次对话补全请求体。
 * @param options - harness 装配完成的请求。
 * @param facts - 本插件的已解析连接事实。
 * @returns 可直接 `JSON.stringify` 的请求体。
 */
export function buildChatRequest(options: GenerateOptions, facts: RequestFacts): WireRequest {
  const messages: WireMessage[] = []
  // 一次性调用方把系统提示放在 options.system；loop 调用方把它放在首条 system 消息里。
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) messages.push(...translateMessage(message))
  const tools = translateTools(options.tools)
  const maxTokens = options.maxTokens ?? facts.maxTokens
  return {
    // 模型 id 来自调用方（也就是 dsh 的模型选择器，其列表由服务的 /v1/models 决定）；
    // 配置里的 `model` 只在部署方明确想覆盖时才生效。
    model: facts.model ?? options.model,
    messages,
    stream: true,
    // 显式带上：不传会把 max_tokens 全烧在思考通道上（交接文档 3.5）。
    reasoning_effort: facts.reasoningEffort,
    ...tools.length === 0 ? {} : { tools, tool_choice: 'auto' },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...maxTokens === undefined ? {} : { max_tokens: maxTokens },
    ...options.stop === undefined || options.stop.length === 0 ? {} : { stop: [...options.stop] },
  }
}

/**
 * 翻译工具声明。
 * @param tools - harness 工具 schema，未声明时为空。
 * @returns OpenAI 兼容的工具数组。
 */
export function translateTools(tools: readonly ToolSchema[] | undefined): WireTool[] {
  return (tools ?? []).map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}
