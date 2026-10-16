/**
 * 对**真实**本机 Strata 服务的冒烟测试。
 *
 * 服务没起、或 35B 权重还在加载（实测 47–61 秒）时**跳过而不是失败**：服务启停是
 * 运维决定（常驻约 20 GB 内存），不该让一次代码改动因此变红。跳过会明确打印原因，
 * 因此"这次跑到底验了什么"永远是清楚的。
 *
 * 基址可用 `STRATA_BASE_URL` 覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_BASE_URL } from '../src/config.ts'
import { apply } from '../src/index.ts'
import { describe, fetchListing, isLoaded } from '../src/models.ts'

const BASE_URL = process.env.STRATA_BASE_URL ?? DEFAULT_BASE_URL

test('真实服务：模型已加载，且能通过本插件完成一次流式对话', async (t) => {
  let entries
  try {
    entries = await fetchListing(BASE_URL, {})
  } catch (error) {
    t.skip(`本机服务未运行（${describe(error)}）`)
    return
  }
  if (!isLoaded(entries)) {
    t.skip(`${BASE_URL} 可达但模型尚未加载完成`)
    return
  }
  // 模型 id 完全来自后端：不写死任何名字，用服务报出的第一个。
  const model = entries[0]?.id
  assert.ok(model !== undefined && model.length > 0, `服务应报出至少一个模型，实际为 ${JSON.stringify(entries)}`)

  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  apply(ctx, { baseURL: BASE_URL })

  const assembler = new BlockAssembler()
  const started = Date.now()
  for await (const chunk of ctx.llm.stream({
    provider: 'strata',
    model,
    messages: [createUserMessage({ content: [{ type: 'text', text: '用一句话自我介绍' }], source: { kind: 'user' } })],
    maxTokens: 160,
  })) assembler.push(chunk)
  const elapsedMs = Date.now() - started

  const blocks = assembler.blocks()
  const text = blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.ok(text.trim().length > 0, `真实服务应返回可见文本，实际块为 ${JSON.stringify(blocks)}`)
  assert.match(text, /[\u4e00-\u9fa5]/, '本机模型应能用中文回答')
  assert.ok(['stop', 'max-tokens'].includes(assembler.finish.kind), `完成原因应为 stop / max-tokens，实际 ${JSON.stringify(assembler.finish)}`)
  assert.ok(elapsedMs < 180_000, `本地推理应在 3 分钟内返回，实际 ${elapsedMs}ms`)
})
