/**
 * 暴露给主对话的工具的契约测试：注册结果、参数/输出契约、以及它们真正的副作用
 * （启动、查询、停止都落到托管器上）。
 *
 * 走真实的 `ToolRuntime` 注册表执行，因此参数校验与输出校验都是 harness 那一套，
 * 而不是本仓库自说自话。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/config.ts'
import type { StrataInstall } from '../src/detect.ts'
import { StrataSupervisor } from '../src/serve.ts'
import type { ProcessSpawner } from '../src/serve.ts'
import { registerStrataTools } from '../src/tools.ts'
import { fakeSpawner, startStub } from './lib/stubs.ts'
import type { StubService } from './lib/stubs.ts'

/** 假的"自动检测到的安装"：这些用例关心工具契约，不关心磁盘上装了什么。 */
const FAKE_INSTALL: StrataInstall = {
  root: 'C:\\Strata',
  serverScript: 'C:\\Strata\\serve\\server.py',
  python: 'C:\\Strata\\.venv\\Scripts\\python.exe',
  engineConfig: 'C:\\Strata\\strata-qwen36-ud-q4_k_xl.json',
  source: 'common-path',
}

/** 建一个装了真实工具注册表 + 三个工具的上下文。 */
async function contextWith(service: StubService, spawner: ProcessSpawner, options: {
  autoStart?: boolean
} = {}): Promise<{ tools: ToolRuntime; supervisor: StrataSupervisor }> {
  const ctx = new Context()
  // 工具注册表本身依赖 systemPrompt（`static inject = ['systemPrompt']`），
  // 少了它这个服务根本不会装载。
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const supervisor = new StrataSupervisor({
    resolveFacts: () => resolveConfig({ baseURL: service.baseURL }),
    resolveInstall: () => FAKE_INSTALL,
    spawner,
    readyTimeoutMs: 1_000,
    idleShutdownMs: 0,
    autoStart: options.autoStart ?? true,
    sleep: () => Promise.resolve(),
  })
  let tools: ToolRuntime | undefined
  // 与产品里一样：工具经 `inject` 声明的上下文注册（cordis 的属性代理要求先声明依赖）。
  await ctx.plugin({
    name: 'strata-tools-test',
    inject: ['tools'],
    apply(scoped) {
      tools = scoped.tools
      registerStrataTools(scoped, { supervisor })
    },
  })
  assert.ok(tools !== undefined, 'tools 服务应当已装载')
  return { tools, supervisor }
}

/** 走真实注册表跑一次工具调用。 */
async function call(tools: ToolRuntime, name: string, index: number): Promise<{ text: string; isError: boolean }> {
  const result = await tools.execute({
    callId: brandString<ToolCallId>(`call_${index}`),
    name,
    arguments: {},
    signal: new AbortController().signal,
  })
  const text = result.content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('')
  return { text, isError: result.isError }
}

test('三个工具都注册进注册表，且参数表为空（调用时不需要模型填任何东西）', async () => {
  const service = await startStub(true)
  const { spawner } = fakeSpawner(service)
  try {
    const { tools } = await contextWith(service, spawner)
    const names = tools.schemas().map(schema => schema.name).filter(name => name.startsWith('strata_'))
    assert.deepEqual(names.sort(), ['strata_serve', 'strata_status', 'strata_stop'])
    for (const name of names) {
      const definition = tools.get(name)
      assert.ok(definition !== undefined)
      assert.equal(definition.description.length > 40, true, `${name} 的说明要够模型判断用`)
      assert.deepEqual(definition.parameters, { type: 'object', properties: {} })
    }
  } finally {
    await service.close()
  }
})

test('strata_status 只读：报告状态而不启动任何东西', async () => {
  const service = await startStub()
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const { tools } = await contextWith(service, spawner)
    const stopped = await call(tools, 'strata_status', 1)
    assert.equal(stopped.isError, false)
    assert.match(stopped.text, /state=stopped/)
    assert.match(stopped.text, /managed by this plugin=false/)
    assert.equal(spawned.length, 0, '查询不该拉起任何进程')

    service.loaded = true
    const running = await call(tools, 'strata_status', 2)
    assert.match(running.text, /state=running/)
    assert.match(running.text, /qwen3\.6-35b-a3b-ud-q4_k_xl/)
  } finally {
    await service.close()
  }
})

test('strata_serve 唤起服务并等到就绪，报告耗时与是否本插件托管', async () => {
  const service = await startStub()
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const { tools } = await contextWith(service, spawner)
    const result = await call(tools, 'strata_serve', 1)
    assert.equal(result.isError, false)
    assert.match(result.text, /is running/)
    assert.match(result.text, /model loaded: true/)
    assert.match(result.text, /started by this plugin: true/)
    assert.match(result.text, /after \d+ ms/)
    assert.equal(spawned.length, 1)
  } finally {
    await service.close()
  }
})

test('strata_serve 在服务已就绪时复用，不重复拉起', async () => {
  const service = await startStub(true)
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const { tools } = await contextWith(service, spawner)
    const result = await call(tools, 'strata_serve', 1)
    assert.equal(result.isError, false)
    assert.match(result.text, /started by this plugin: false/)
    assert.equal(spawned.length, 0)
  } finally {
    await service.close()
  }
})

test('strata_serve 在禁自动启动时也能显式拉起（工具就是那个"例外通道"）', async () => {
  const service = await startStub()
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const { tools } = await contextWith(service, spawner, { autoStart: false })
    const result = await call(tools, 'strata_serve', 1)
    assert.equal(result.isError, false)
    assert.equal(spawned.length, 1, '显式调用应当直接拉起')
  } finally {
    await service.close()
  }
})

test('strata_stop 停掉托管的服务；对别人的服务只说明原因', async () => {
  const service = await startStub()
  const { spawner, terminated } = fakeSpawner(service)
  try {
    const { tools } = await contextWith(service, spawner)
    await call(tools, 'strata_serve', 1)
    const stopped = await call(tools, 'strata_stop', 2)
    assert.equal(stopped.isError, false)
    assert.match(stopped.text, /stopped/)
    assert.deepEqual(terminated, [1])

    // 外部服务：另一个上下文，桩服务已经是 loaded 但没人拉起过它。
    service.loaded = true
    const external = await contextWith(service, fakeSpawner(service).spawner)
    const outcome = await call(external.tools, 'strata_stop', 3)
    assert.equal(outcome.isError, false)
    assert.match(outcome.text, /not stopped/)
  } finally {
    await service.close()
  }
})

test('启动失败时工具以 isError 交回失败原因，而不是假装成功', async () => {
  const service = await startStub()
  // 不传 service：桩服务永远不会报告 loaded，启动必然超时。
  const { spawner } = fakeSpawner()
  try {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const supervisor = new StrataSupervisor({
      resolveFacts: () => resolveConfig({ baseURL: service.baseURL }),
      resolveInstall: () => FAKE_INSTALL,
      spawner,
      readyTimeoutMs: 1,
      idleShutdownMs: 0,
      autoStart: true,
      sleep: () => Promise.resolve(),
    })
    let tools: ToolRuntime | undefined
    await ctx.plugin({
      name: 'strata-tools-timeout-test',
      inject: ['tools'],
      apply(scoped) {
        tools = scoped.tools
        registerStrataTools(scoped, { supervisor })
      },
    })
    assert.ok(tools !== undefined)
    const failed = await call(tools, 'strata_serve', 9)
    assert.equal(failed.isError, true)
    assert.match(failed.text, /就绪|ready/)
  } finally {
    await service.close()
  }
})
