/**
 * 服务托管的契约测试：懒启动、只回收自己拉起的进程、就绪超时、空闲自动停止。
 *
 * 全部跑在假进程 + 本地桩服务上：拉起器只记录"拉起了什么、终止了什么"，桩服务用可变
 * 状态模拟"加载中 → 已加载"。因此每条断言都是关于**策略**的，不会真的去占 20 GB 显存。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../src/config.ts'
import type { StrataInstall } from '../src/detect.ts'
import { StrataSupervisor, serveArgv } from '../src/serve.ts'
import type { ProcessSpawner } from '../src/serve.ts'
import { fakeSpawner, startStub } from './lib/stubs.ts'
import type { StubService } from './lib/stubs.ts'

/** 一个假的"自动检测到的安装"：这些测试关心策略，不关心磁盘上真实装了什么。 */
const FAKE_INSTALL: StrataInstall = {
  root: 'C:\\Strata',
  serverScript: 'C:\\Strata\\serve\\server.py',
  python: 'C:\\Strata\\.venv\\Scripts\\python.exe',
  engineConfig: 'C:\\Strata\\strata-qwen36-ud-q4_k_xl.json',
  port: 8080,
  model: 'qwen3.6-35b-a3b-ud-q4_k_xl',
  source: 'common-path',
}

/** 造一个托管器；默认把轮询间隔压到 0，免得测试白等。 */
function supervisorFor(service: StubService, options: {
  autoStart?: boolean
  readyTimeoutMs?: number
  idleShutdownMs?: number
  spawner: ProcessSpawner
  /** `null` 表示"这台机器上检测不到安装"；省略则用 {@link FAKE_INSTALL}。 */
  install?: StrataInstall | null
}): StrataSupervisor {
  return new StrataSupervisor({
    resolveFacts: () => resolveConfig({
      baseURL: service.baseURL,
      readyTimeoutMs: options.readyTimeoutMs ?? 1_000,
      idleShutdownMs: options.idleShutdownMs ?? 0,
      autoStart: options.autoStart ?? true,
    }),
    resolveInstall: () => options.install === null ? undefined : options.install ?? FAKE_INSTALL,
    spawner: options.spawner,
    readyTimeoutMs: options.readyTimeoutMs ?? 1_000,
    idleShutdownMs: options.idleShutdownMs ?? 0,
    autoStart: options.autoStart ?? true,
    sleep: () => Promise.resolve(),
  })
}

test('服务已经就绪时直接复用，不重复拉起', async () => {
  const service = await startStub(true)
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const supervisor = supervisorFor(service, { spawner })
    const status = await supervisor.ensureServed()
    assert.equal(status.loaded, true)
    assert.equal(status.managed, false, '不是我们拉起的进程，就不算我们管着')
    assert.equal(spawned.length, 0)
  } finally {
    await service.close()
  }
})

test('懒启动：服务没跑时拉起，并按配置的端口/引擎配置组装命令', async () => {
  const service = await startStub()
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const supervisor = supervisorFor(service, { spawner })
    // 拉起之后桩服务才"加载完成"，模拟真实的服务启动。
    const status = await supervisor.ensureServed()
    assert.equal(status.state, 'running')
    assert.equal(status.loaded, true)
    assert.equal(status.managed, true)
    assert.equal(spawned.length, 1, '同一次启动只拉起一个进程')
    const spec = spawned[0]
    assert.ok(spec !== undefined)
    assert.match(spec.argv[0] ?? '', /python\.exe$/i)
    assert.ok(spec.argv.includes('--port'), '端口要与探测的端点一致')
    assert.equal(spec.argv[spec.argv.indexOf('--port') + 1], new URL(service.baseURL).port)
    assert.equal(spec.cwd.toLowerCase(), 'c:\\strata')
    assert.deepEqual(spec.stdio.stdin, 'ignore')
  } finally {
    await service.close()
  }
})

test('并发调用折叠成一次启动', async () => {
  const service = await startStub()
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const supervisor = supervisorFor(service, { spawner })
    await Promise.all([supervisor.ensureServed(), supervisor.ensureServed(), supervisor.ensureServed()])
    assert.equal(spawned.length, 1)
  } finally {
    await service.close()
  }
})

test('迟迟不就绪：报错并把自己拉起的进程收掉', async () => {
  const service = await startStub()
  const { spawner, spawned, terminated } = fakeSpawner()
  try {
    const supervisor = supervisorFor(service, { spawner, readyTimeoutMs: 1 })
    await assert.rejects(supervisor.ensureServed(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SERVICE_NOT_READY')
      return true
    })
    assert.equal(spawned.length, 1)
    assert.deepEqual(terminated, [1], '起不来的进程不能留在机器上')
  } finally {
    await service.close()
  }
})

test('禁自动启动时不拉起，报错里给出可行动指引', async () => {
  const service = await startStub()
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const supervisor = supervisorFor(service, { spawner, autoStart: false })
    await assert.rejects(supervisor.ensureServed(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'SERVICE_NOT_RUNNING')
      assert.match(String((error as Error).message), /strata_serve/)
      return true
    })
    assert.equal(spawned.length, 0)
  } finally {
    await service.close()
  }
})

test('空闲超时后自动停止托管的服务', async () => {
  const service = await startStub()
  const { spawner, terminated } = fakeSpawner(service)
  try {
    // 空闲窗口要明显长于一次探测往返，否则测的是网络抖动而不是策略。
    const supervisor = supervisorFor(service, { spawner, idleShutdownMs: 300 })
    await supervisor.ensureServed()
    assert.equal((await supervisor.status()).managed, true)
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.deepEqual(terminated, [1], '空闲到期后应终止托管的进程')
    // 桩服务不会随进程终止而消失（真服务会），因此这里断言的是托管关系已经解除。
    assert.equal((await supervisor.status()).managed, false)
  } finally {
    await service.close()
  }
})

test('空闲回收不会碰别人的进程：外部服务只复用、不停', async () => {
  const service = await startStub(true)
  const { spawner, terminated } = fakeSpawner(service)
  try {
    const supervisor = supervisorFor(service, { spawner, idleShutdownMs: 300 })
    await supervisor.ensureServed()
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.deepEqual(terminated, [], '不是我们拉起的服务，任何情况下都不终止')
    const outcome = await supervisor.stop('测试')
    assert.equal(outcome.stopped, false)
    assert.match(String(outcome.reason), /不是本插件拉起的/)
    assert.equal(service.loaded, true, '外部服务仍在运行')
  } finally {
    await service.close()
  }
})

test('加载中的服务不会被空闲回收误杀（窗口比加载时间短）', async () => {
  const service = await startStub()
  // 不自动置为 loaded：这个用例要的是"加载很久"，由测试自己控制。
  const { spawner, terminated } = fakeSpawner()
  try {
    const supervisor = new StrataSupervisor({
      resolveFacts: () => resolveConfig({ baseURL: service.baseURL }),
      resolveInstall: () => FAKE_INSTALL,
      spawner,
      readyTimeoutMs: 2_000,
      // 空闲窗口 30ms，而"加载"要 200ms：加载期间必须持续续命。
      idleShutdownMs: 30,
      autoStart: true,
      sleep: () => new Promise(resolve => setTimeout(resolve, 40)),
    })
    setTimeout(() => { service.loaded = true }, 200)
    const status = await supervisor.ensureServed()
    assert.equal(status.loaded, true)
    assert.deepEqual(terminated, [], '加载途中不该被回收')
  } finally {
    await service.close()
  }
})

test('活动会推迟空闲回收', async () => {
  const service = await startStub()
  const { spawner, terminated } = fakeSpawner(service)
  try {
    const supervisor = supervisorFor(service, { spawner, idleShutdownMs: 300 })
    await supervisor.ensureServed()
    // 持续活动：总时长超过空闲窗口，但每次间隔都小于它，因此不该被停。
    for (let round = 0; round < 5; round += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      supervisor.touch()
    }
    assert.deepEqual(terminated, [], '一直有调用就不该停')
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.deepEqual(terminated, [1], '活动停止后才回收')
  } finally {
    await service.close()
  }
})

test('卸载时收掉自己拉起的进程', async () => {
  const service = await startStub()
  const { spawner, terminated } = fakeSpawner(service)
  try {
    const supervisor = supervisorFor(service, { spawner })
    await supervisor.ensureServed()
    supervisor.dispose()
    assert.deepEqual(terminated, [1])
  } finally {
    await service.close()
  }
})

test('serveArgv 在给了 serveCommand 时完全照用，不需要安装检测', () => {
  const facts = resolveConfig({ baseURL: 'http://127.0.0.1:8080/v1', serveCommand: ['C:\\x\\run.exe', '--way', 'custom'] })
  assert.deepEqual(serveArgv(facts, undefined), ['C:\\x\\run.exe', '--way', 'custom'])
})

test('serveArgv 用检测到的安装组装命令，端口取端点端口', () => {
  const facts = resolveConfig({ baseURL: 'http://127.0.0.1:9090/v1' })
  assert.deepEqual(serveArgv(facts, FAKE_INSTALL), [
    'C:\\Strata\\.venv\\Scripts\\python.exe',
    'C:\\Strata\\serve\\server.py',
    '--engine', 'strata',
    '--config', 'C:\\Strata\\strata-qwen36-ud-q4_k_xl.json',
    '--port', '9090',
  ])
})

test('serveArgv 在既没有安装、也没有显式命令时，报错里给出上游地址', () => {
  const facts = resolveConfig({ baseURL: 'http://127.0.0.1:8080/v1' })
  assert.throws(() => serveArgv(facts, undefined), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'NO_INSTALLATION')
    assert.match(String((error as Error).message), /github\.com\/Niko1221\/Strata/)
    return true
  })
})

test('检测不到安装时，启动请求以可行动的指引失败（而不是静默不启动）', async () => {
  const service = await startStub()
  const { spawner, spawned } = fakeSpawner(service)
  try {
    const supervisor = supervisorFor(service, { spawner, install: null })
    await assert.rejects(supervisor.serveNow(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'NO_INSTALLATION')
      assert.match(String((error as Error).message), /serve\/server\.py/)
      return true
    })
    assert.deepEqual(spawned, [], '没有安装就不该拉起任何东西')
  } finally {
    await service.close()
  }
})
