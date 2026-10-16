/**
 * SSE 帧解析：把 `fetch` 的响应字节流切成一个个事件 `data` 负载。
 *
 * Strata 的流式输出是标准 OpenAI SSE，但实测**帧之间夹着空行与 `: keep-alive`
 * 注释行**（交接文档 3.3）。因此这里按 SSE 规范自行解析，而不是按行猜：
 * 只有空行才结束一个事件，`:` 开头的是注释，多个 `data:` 行按 `\n` 连接，
 * `event` / `id` / `retry` 等字段忽略。
 *
 * 结尾必须出现 `[DONE]`：没有它就是截断，抛 `StrataError('STREAM_CLOSED')`
 * 让上层的失败规范化路径统一处理（与 `llm-deepseek` 的 SSE 合同一致）。
 *
 * @module dsh-plugin-strata/sse
 */

import { StrataError } from './host.ts'

/** 终止负载：服务在最后一个数据帧之后发送。 */
export const DONE = '[DONE]'

/**
 * 消费一行 SSE 文本，维护当前事件累积的 `data` 值。
 *
 * 独立成纯函数是为了能被直接单测：SSE 的边界行为（空行、注释、多行 data、
 * 无冒号字段）全在这里，不需要起 HTTP 服务器就能验证。
 * @param line - 一行文本，不含行尾换行符（`\r` 由调用方剥掉）。
 * @param data - 当前事件的 `data` 行累积缓冲，就地修改。
 * @returns 事件在本行结束时完成时返回其负载，否则返回 `undefined`。
 */
export function consumeLine(line: string, data: string[]): string | undefined {
  if (line.length === 0) {
    if (data.length === 0) return undefined
    const payload = data.join('\n')
    data.length = 0
    return payload
  }
  if (line.startsWith(':')) return undefined
  const colon = line.indexOf(':')
  const field = colon === -1 ? line : line.slice(0, colon)
  if (field !== 'data') return undefined
  let value = colon === -1 ? '' : line.slice(colon + 1)
  if (value.startsWith(' ')) value = value.slice(1)
  data.push(value)
  return undefined
}

/**
 * 解析 SSE 字节流，逐个产出事件负载，直到 `[DONE]`。
 * @param stream - 原始 SSE 字节流；读取点可以落在任意位置，包括 UTF-8 序列中间。
 * @returns 按到达顺序产出的事件负载；`[DONE]` 不产出，而是正常结束迭代。
 * @throws StrataError 当流在 `[DONE]` 之前结束（截断的响应不可信）。
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const data: string[] = []
  let buffer = ''
  let done = false
  try {
    while (!done) {
      const result = await reader.read()
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const payload = consumeLine(buffer.slice(0, newline).replace(/\r$/, ''), data)
        buffer = buffer.slice(newline + 1)
        if (payload !== undefined) {
          if (payload === DONE) {
            done = true
            break
          }
          yield payload
        }
        newline = buffer.indexOf('\n')
      }
    }
    if (!done) {
      // 流在行中间结束：最后一段没有换行，按同一规则处理（未终止的事件仍不派发）。
      buffer += decoder.decode()
      if (buffer.length > 0) {
        const payload = consumeLine(buffer.replace(/\r$/, ''), data)
        if (payload === DONE) {
          done = true
        } else if (payload !== undefined) {
          yield payload
        }
      }
    }
  } finally {
    // 提前结束（[DONE]）时释放读取锁并放弃剩余字节，避免连接被吊着。
    if (done) await reader.cancel().catch(() => undefined)
  }
  if (!done) throw new StrataError('SSE 流在收到 [DONE] 之前结束', 'STREAM_CLOSED')
}
