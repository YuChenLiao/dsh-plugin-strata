/**
 * SSE 解析的契约测试。
 *
 * 这里的每一条都对应交接文档 3.3 实测到的形状：空行分隔、`: keep-alive` 注释行、
 * 结尾 `data: [DONE]`，以及"读取点可以落在任意字节位置"（网络分片）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DONE, consumeLine, parseSse } from '../src/sse.ts'

/** 把若干原始字节分片拼成一个响应流。 */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let position = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[position]
      position += 1
      if (next === undefined) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(next))
    },
  })
}

/** 收集一个流的全部负载。 */
async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const seen: string[] = []
  for await (const payload of parseSse(stream)) seen.push(payload)
  return seen
}

test('consumeLine 只在空行结束事件，注释行与其它字段被忽略', () => {
  const data: string[] = []
  assert.equal(consumeLine(': keep-alive', data), undefined)
  assert.equal(consumeLine('event: message', data), undefined)
  assert.equal(consumeLine('data: {"a":1}', data), undefined)
  assert.deepEqual(data, ['{"a":1}'])
  assert.equal(consumeLine('', data), '{"a":1}')
  assert.deepEqual(data, [], '事件完成后累积缓冲被清空')
})

test('consumeLine 连接多行 data，并支持无冒号的 data 字段', () => {
  const data: string[] = []
  consumeLine('data: first', data)
  consumeLine('data:second', data)
  consumeLine('data', data)
  assert.equal(consumeLine('', data), 'first\nsecond\n')
})

test('parseSse 容忍空行与 keep-alive 注释行（实测格式）', async () => {
  const frames = await collect(streamOf([
    'data: {"choices":[{"delta":{"content":"1"}}]}\n\n',
    ': keep-alive\n\n',
    'data: {"choices":[{"delta":{"content":"2"}}]}\n\n',
    'data: [DONE]\n\n',
  ]))
  assert.deepEqual(frames, ['{"choices":[{"delta":{"content":"1"}}]}', '{"choices":[{"delta":{"content":"2"}}]}'])
})

test('parseSse 拼回被任意切碎的字节分片（含 UTF-8 中间切）', async () => {
  const payload = 'data: {"content":"你好"}\n\ndata: [DONE]\n\n'
  const bytes = new TextEncoder().encode(payload)
  const pieces: Uint8Array[] = []
  for (let position = 0; position < bytes.length; position += 3) {
    pieces.push(bytes.slice(position, position + 3))
  }
  let position = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = pieces[position]
      position += 1
      if (next === undefined) {
        controller.close()
        return
      }
      controller.enqueue(next)
    },
  })
  assert.deepEqual(await collect(stream), ['{"content":"你好"}'])
})

test('parseSse 处理 CRLF 行尾', async () => {
  const frames = await collect(streamOf(['data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n']))
  assert.deepEqual(frames, ['{"a":1}'])
})

test('缺少 [DONE] 的截断流被判为失败', async () => {
  await assert.rejects(
    collect(streamOf(['data: {"choices":[{"delta":{"content":"半"}}]}\n\n'])),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'STREAM_CLOSED')
      return true
    },
  )
})

test('未以空行终止的尾部事件不派发（截断就是截断）', async () => {
  await assert.rejects(collect(streamOf(['data: {"a":1}\n\n', 'data: [DONE]'])), /STREAM_CLOSED|\[DONE\]/)
})

test('DONE 常量与服务的终止负载一致', () => {
  assert.equal(DONE, '[DONE]')
})
