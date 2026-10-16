/**
 * 流式帧翻译的契约测试：思考通道、工具调用分片、用量、完成原因。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { StreamTranslator, mapFinishReason, mapUsage } from '../src/translate.ts'

/** 构造一帧 OpenAI 兼容的流式响应。 */
function frame(delta: Record<string, unknown>, finish: string | null = null): string {
  return JSON.stringify({
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
}

test('文本流产生 block-start / text-delta / block-end / finish', () => {
  const translator = new StreamTranslator()
  assert.deepEqual(translator.push(frame({ role: 'assistant', content: '' })), [], '空增量不产生块')
  assert.deepEqual(translator.push(frame({ content: '你' })), [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你' },
  ])
  assert.deepEqual(translator.push(frame({ content: '好' })), [
    { type: 'text-delta', index: 0, text: '好' },
  ])
  assert.deepEqual(translator.push(frame({}, 'stop')), [
    { type: 'block-end', index: 0, block: { type: 'text', text: '你好' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(translator.finished, true)
  assert.deepEqual(translator.end(), [], '已经结束的流不需要补收尾')
})

test('思考通道进 reasoning 块，与可见文本分开', () => {
  const translator = new StreamTranslator()
  const reasoning = translator.push(frame({ reasoning_content: '先想' }))
  assert.deepEqual(reasoning, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '先想' },
  ])
  const answer = translator.push(frame({ content: '答案' }))
  assert.deepEqual(answer, [
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先想' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '答案' },
  ])
})

test('工具调用的分片累积成一个块，arguments 原样拼接', () => {
  const translator = new StreamTranslator()
  assert.deepEqual(translator.push(frame({
    tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }],
  })), [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'get_weather', argumentsDelta: '' },
  ])
  assert.deepEqual(translator.push(frame({
    tool_calls: [{ index: 0, function: { arguments: '{"city":"' } }],
  })), [
    { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '{"city":"' },
  ])
  assert.deepEqual(translator.push(frame({
    tool_calls: [{ index: 0, function: { arguments: '北京"}' } }],
  })), [
    { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '北京"}' },
  ])
  assert.deepEqual(translator.push(frame({}, 'tool_calls')), [
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('并行多个工具调用各占一个块，按出现顺序编号', () => {
  const translator = new StreamTranslator()
  translator.push(frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }] }))
  const second = translator.push(frame({ tool_calls: [{ index: 1, id: 'b', function: { name: 'y', arguments: '{}' } }] }))
  assert.deepEqual(second[0], { type: 'block-start', index: 1, blockType: 'tool-call' })
  const closed = translator.push(frame({}, 'tool_calls'))
  assert.deepEqual(closed.map(chunk => chunk.type), ['block-end', 'block-end', 'finish'])
  assert.deepEqual(closed.map(chunk => (chunk.type === 'block-end' ? chunk.index : -1)), [0, 1, -1])
})

test('用量帧（choices 为空）只产出 usage', () => {
  const translator = new StreamTranslator()
  const usage = translator.push(JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 18, completion_tokens: 5, total_tokens: 23 },
  }))
  assert.deepEqual(usage, [{ type: 'usage', usage: { inputTokens: 18, outputTokens: 5, totalTokens: 23 } }])
  assert.deepEqual(translator.usage, { inputTokens: 18, outputTokens: 5, totalTokens: 23 })
})

test('流意外结束但没有 finish 帧时补齐收尾与 stop', () => {
  const translator = new StreamTranslator()
  translator.push(frame({ content: '半句' }))
  const tail = translator.end()
  assert.deepEqual(tail, [
    { type: 'block-end', index: 0, block: { type: 'text', text: '半句' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(translator.end(), [])
})

test('timings 被记录，供上层做性能观测', () => {
  const translator = new StreamTranslator()
  translator.push(JSON.stringify({ choices: [], timings: { predicted_per_second: 47.8, draft_n: 406, draft_n_accepted: 308 } }))
  assert.equal(translator.timings?.predicted_per_second, 47.8)
  assert.equal(translator.timings?.draft_n_accepted, 308)
})

test('finish_reason 映射：length 是 max-tokens，而不是正常的 stop', () => {
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinishReason('function_call'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinishReason('something_new'), { kind: 'stop' })
})

test('usage 缺字段时不编造数字', () => {
  assert.equal(mapUsage(undefined), undefined)
  assert.equal(mapUsage({ prompt_tokens: 3 }), undefined)
})

test('翻译器产出的块序列能被 harness 的装配器原样组装', async () => {
  const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
  const translator = new StreamTranslator()
  const chunks: StreamChunk[] = [
    ...translator.push(frame({ reasoning_content: '想一下' })),
    ...translator.push(frame({ content: '答案' })),
    ...translator.push(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })),
    ...translator.push(frame({}, 'stop')),
  ]
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  assert.deepEqual(assembler.blocks(), [
    { type: 'reasoning', text: '想一下' },
    { type: 'text', text: '答案' },
  ])
  assert.deepEqual(assembler.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 })
  assert.deepEqual(assembler.finish, { kind: 'stop' })
})
