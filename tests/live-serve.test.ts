/**
 * 真实端到端：从"机器上没有服务"开始，用真实 `subprocess` 服务把 35B 服务拉起来、
 * 等它加载完成、发一条真实请求，再停掉它。
 *
 * 默认**跳过**：这一步要加载 22.85 GB 权重（实测 79 秒）并常驻约 20 GB 内存，属于
 * 显式开启的运维级验证，不该让日常改动变重。开启方式：
 *
 * ```powershell
 * $env:STRATA_LIVE_SERVE = '1'; node tools/run-tests.mjs --only=tests
 * ```
 *
 * 起点要求 8080 上没有别人在跑的服务——有就跳过，不去打扰它。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { StrataAdapter } from '../src/adapter.ts'
import { DEFAULT_BASE_URL, resolveConfig } from '../src/config.ts'
import { detectInstallation } from '../src/detect.ts'
import { describe, fetchListing } from '../src/models.ts'
import { StrataSupervisor } from '../src/serve.ts'
import type { ProcessSpawner } from '../src/serve.ts'

const ENABLED = process.env.STRATA_LIVE_SERVE === '1'
const BASE_URL = process.env.STRATA_BASE_URL ?? DEFAULT_BASE_URL

/** 空闲回收窗口：live 验证要短到能在一次运行里看完，因此不用默认的 5 分钟。 */
const IDLE_MS = 20_000

test('真实托管：拉起 → 就绪 → 回答 → 空闲释放', {
  skip: ENABLED ? false : '设置 STRATA_LIVE_SERVE=1 才跑（要加载 35B 权重，约 1–2 分钟、20 GB 内存）',
}, async () => {
  const facts = resolveConfig({ baseURL: BASE_URL, idleShutdownMs: IDLE_MS, readyTimeoutMs: 240_000 })

  // 起点：确认没有别人在跑的服务，避免把外部服务误当成自己拉起来的。
  let reachable = true
  try {
    await fetchListing(facts.baseURL, {})
  } catch {
    reachable = false
  }
  assert.equal(reachable, false, `${facts.baseURL} 上已有服务在跑，live 托管验证需要从"空机器"开始`)

  // 真实 DSH 进程服务（Windows 下走 Job 对象管理进程范围）。
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  let spawner: ProcessSpawner | undefined
  await ctx.plugin({
    name: 'strata-live-probe',
    inject: ['subprocess'],
    apply(scoped) { spawner = scoped.subprocess },
  })
  assert.ok(spawner !== undefined, 'subprocess 服务应当可用')

  const supervisor = new StrataSupervisor({
    resolveFacts: () => resolveConfig({ baseURL: BASE_URL, idleShutdownMs: IDLE_MS, readyTimeoutMs: 240_000 }),
    // 真实检测：这条用例要连"安装位置是自动找出来的"一起验证。
    resolveInstall: () => detectInstallation({}),
    spawner,
    readyTimeoutMs: 240_000,
    idleShutdownMs: IDLE_MS,
    autoStart: true,
    log: message => console.log(`  [strata] ${message}`),
  })

  const startedAt = Date.now()
  const status = await supervisor.serveNow()
  const loadMs = Date.now() - startedAt
  assert.equal(status.loaded, true)
  assert.equal(status.managed, true, '这个进程是本插件拉起来的，因此也由它负责回收')
  // 模型 id 来自后端，不在用例里写死。
  const model = status.models[0]
  assert.ok(model !== undefined && model.length > 0, `服务应报出至少一个模型，实际 ${JSON.stringify(status.models)}`)
  console.log(`  [strata] 从拉起至就绪 ${(loadMs / 1000).toFixed(1)} 秒，模型 ${model}`)

  // 真实请求：经插件自己的适配器，走真实的 LlmRuntime 装配路径。
  const llmCtx = new Context()
  await llmCtx.plugin(LlmRuntime)
  llmCtx.llm.registerAdapter(['strata'], new StrataAdapter({
    resolveFacts: () => resolveConfig({ baseURL: BASE_URL }),
    ensureServed: async () => { await supervisor.ensureServed() },
    touch: () => { supervisor.touch() },
  }))
  const assembler = new BlockAssembler()
  const askedAt = Date.now()
  for await (const chunk of llmCtx.llm.stream({
    provider: 'strata',
    model,
    messages: [createUserMessage({ content: [{ type: 'text', text: '用一句话自我介绍' }], source: { kind: 'user' } })],
    maxTokens: 160,
  })) assembler.push(chunk as StreamChunk)
  const answerMs = Date.now() - askedAt
  const text = assembler.blocks().map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.ok(text.trim().length > 0, `真实服务应返回可见文本，实际 ${JSON.stringify(assembler.blocks())}`)
  assert.match(text, /[\u4e00-\u9fa5]/)
  console.log(`  [strata] 回答耗时 ${answerMs} 毫秒：${text.trim()}`)

  // 空闲回收：活动停止后等过一个窗口，服务应当自己消失。
  await new Promise(resolve => setTimeout(resolve, IDLE_MS + 5_000))
  const after = await supervisor.status()
  assert.equal(after.managed, false, '空闲到期后不应再持有进程')
  await assert.rejects(
    fetchListing(facts.baseURL, {}),
    (error: unknown) => {
      // 端口关掉了：这正是"释放了那 20 GB"的可观测证据。
      assert.match(describe(error), /无法连接|fetch failed|ECONNREFUSED/)
      return true
    },
    '服务端口应当已经关闭',
  )
})
