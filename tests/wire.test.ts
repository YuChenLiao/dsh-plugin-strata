/**
 * 请求组装（harness 消息 → OpenAI 兼容请求体）的契约测试。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createAssistantMessage, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { buildChatRequest, translateMessage, translateTools } from '../src/wire.ts'
import type { RequestFacts } from '../src/wire.ts'

const FACTS: RequestFacts = { model: 'qwen3.6-35b-a3b-ud-q4_k_xl', reasoningEffort: 'none', maxTokens: 128 }

test('助手消息的工具调用进 tool_calls，且不带文本时 content 为 null', () => {
  const id = brandString<ToolCallId>('call_1')
  const message = createAssistantMessage({
    content: [{ type: 'tool-call', id, name: 'get_weather', arguments: '{"city":"北京"}' }],
    source: { provider: 'strata', model: 'm' },
  })
  assert.deepEqual(translateMessage(message), [{
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
  }])
})

test('工具结果展开成独立的 role=tool 消息并带 tool_call_id', () => {
  const message = createToolResultMessage({
    callId: brandString<ToolCallId>('call_7'),
    content: [{ type: 'text', text: '18℃' }],
    isError: false,
  })
  assert.deepEqual(translateMessage(message), [
    { role: 'tool', tool_call_id: 'call_7', content: '18℃' },
  ])
})

test('空系统提示不产生任何 wire 消息', () => {
  const request = buildChatRequest({
    provider: 'strata',
    model: 'm',
    messages: [],
    system: '',
  }, FACTS)
  assert.deepEqual(request.messages, [])
})

test('options.system 与 system 角色消息都进首部 system 消息', () => {
  const system = createMessage({
    role: 'system',
    content: [{ type: 'text', text: '规则' }],
    source: { kind: 'plugin', plugin: 'test' },
  })
  const request = buildChatRequest({
    provider: 'strata',
    model: 'm',
    messages: [system],
    system: '一次性提示',
  }, FACTS)
  assert.deepEqual(request.messages, [
    { role: 'system', content: '一次性提示' },
    { role: 'system', content: '规则' },
  ])
})

test('请求体恒带 reasoning_effort（缺省会把预算烧在思考通道上）', () => {
  const request = buildChatRequest({ provider: 'strata', model: 'm', messages: [] }, FACTS)
  assert.equal(request.reasoning_effort, 'none')
  assert.equal(request.stream, true)
  assert.equal(request.model, FACTS.model)
  assert.equal(request.max_tokens, 128)
})

test('显式 max_tokens / temperature / stop 覆盖事实值', () => {
  const request = buildChatRequest({
    provider: 'strata',
    model: 'm',
    messages: [],
    maxTokens: 7,
    temperature: 0.2,
    stop: ['\n\n'],
  }, FACTS)
  assert.equal(request.max_tokens, 7)
  assert.equal(request.temperature, 0.2)
  assert.deepEqual(request.stop, ['\n\n'])
})

test('没有工具时不发 tools / tool_choice；有工具时声明为 function 并自动选择', () => {
  const without = buildChatRequest({ provider: 'strata', model: 'm', messages: [] }, FACTS)
  assert.equal(without.tools, undefined)
  assert.equal(without.tool_choice, undefined)
  const tools = translateTools([{ name: 'get_weather', description: '查天气', parameters: { type: 'object' } }])
  assert.deepEqual(tools, [{
    type: 'function',
    function: { name: 'get_weather', description: '查天气', parameters: { type: 'object' } },
  }])
  const withTools = buildChatRequest({ provider: 'strata', model: 'm', messages: [], tools: [{ name: 't', description: 'd', parameters: {} }] }, FACTS)
  assert.equal(withTools.tool_choice, 'auto')
  assert.equal(withTools.tools?.length, 1)
})

test('用户消息的文本块按顺序拼接', () => {
  const message = createUserMessage({
    content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }],
    source: { kind: 'user' },
  })
  assert.deepEqual(translateMessage(message), [{ role: 'user', content: '第一段第二段' }])
})
