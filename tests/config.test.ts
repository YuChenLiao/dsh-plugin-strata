/**
 * 配置解析的契约测试：默认值、边界、以及"配置错了要在最早可解析的时刻炸响"。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_BASE_URL, DEFAULT_REASONING_EFFORT, resolveConfig } from '../src/config.ts'

test('空配置解析出本机默认值', () => {
  const facts = resolveConfig({})
  assert.equal(facts.baseURL, DEFAULT_BASE_URL)
  // 模型不由插件决定：默认不指定，请求体里用调用方（dsh 选择器，其列表来自服务的 /v1/models）给的那个。
  assert.equal(facts.model, undefined)
  assert.equal(facts.reasoningEffort, DEFAULT_REASONING_EFFORT)
  assert.equal(facts.contextWindow, 65536)
  assert.ok(facts.requestTimeoutMs > 0)
})

test('基址末尾的斜杠被去掉，避免拼出 //chat/completions', () => {
  assert.equal(resolveConfig({ baseURL: 'http://127.0.0.1:8080/v1//' }).baseURL, 'http://127.0.0.1:8080/v1')
})

test('非法配置立即抛错', () => {
  assert.throws(() => resolveConfig({ baseURL: '127.0.0.1:8080' }), /baseURL/)
  assert.throws(() => resolveConfig({ model: '' }), /model/)
  assert.throws(() => resolveConfig({ contextWindow: 0 }), /contextWindow/)
  assert.throws(() => resolveConfig({ contextWindow: 1024.5 }), /contextWindow/)
  assert.throws(() => resolveConfig({ maxTokens: -1 }), /maxTokens/)
  assert.throws(() => resolveConfig({ requestTimeoutMs: 0 }), /requestTimeoutMs/)
  assert.throws(
    () => resolveConfig({ reasoningEffort: 'turbo' as never }),
    /reasoningEffort/,
  )
})

test('contextWindow 与 maxTokens 采用配置值', () => {
  const facts = resolveConfig({ contextWindow: 32768, maxTokens: 512, reasoningEffort: 'low' })
  assert.equal(facts.contextWindow, 32768)
  assert.equal(facts.maxTokens, 512)
  assert.equal(facts.reasoningEffort, 'low')
})
