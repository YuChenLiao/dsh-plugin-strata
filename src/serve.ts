/**
 * 本地 Strata 服务的托管：按需拉起、等待就绪、空闲回收。
 *
 * 设计边界（都是实测代价决定的，交接文档 4.2 / 6.2）：
 *  - **懒启动**：不在插件装载时拉起。只有真正要用（一次模型请求，或主对话显式调用
 *    `strata_serve`）才启动，因为加载要 47–79 秒、常驻约 20 GB 内存。
 *  - **只回收自己拉起的进程**：服务可能是别人先起好的（文档 5.3 明确警告过这一点）。
 *    归属由"我们手里有没有 handle"判定，外部服务只复用、绝不终止。
 *  - **空闲即停**：最后一次活动（请求或工具调用）之后 `idleShutdownMs` 无动作就停掉，
 *    避免那 20 GB 一直占着。
 *
 * @module dsh-plugin-strata/serve
 */

import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { StrataError } from './host.ts'
import type { ResolvedConfig } from './config.ts'
import { missingInstallationHint } from './detect.ts'
import type { StrataInstall } from './detect.ts'
import { describe, fetchListing, isLoaded } from './models.ts'
import { strataHeaders } from './adapter.ts'

/** 进程托管需要的窄接口；`ctx.subprocess` 结构上即满足它，测试用桩替换。 */
export interface ProcessSpawner {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** 服务当前的可观测状态。 */
export interface ServeStatus {
  /** `stopped` 没有服务；`starting` 正在拉起/加载；`running` 已加载完成。 */
  state: 'stopped' | 'starting' | 'running'
  /** 端点是否应答（未必已加载完成）。 */
  reachable: boolean
  /** 模型是否报告 `loaded`。 */
  loaded: boolean
  /** 是否为**本插件**拉起的进程：只有它为真时才会被自动停止。 */
  managed: boolean
  /** 服务报出的模型 id。 */
  models: string[]
  /** 空闲自动停止的剩余毫秒数；没有托管进程或未开启时为 `undefined`。 */
  idleShutdownInMs?: number
  /** 自动检测到的安装位置（找不到、或用户直接给了启动命令时为 `undefined`）。 */
  install?: { root: string; source: StrataInstall['source'] }
}

/** 一次停止尝试的结果。 */
export interface StopOutcome {
  /** 是否真的终止了一个本插件托管的进程。 */
  stopped: boolean
  /** 没停的原因（用于给人看的说明）。 */
  reason?: string
}

/** 托管器的构造参数。 */
export interface SupervisorOptions {
  /** 每次调用时解析连接事实。 */
  resolveFacts: () => ResolvedConfig
  /** 每次需要启动时解析本机安装（自动检测；找不到就是 `undefined`）。 */
  resolveInstall: () => StrataInstall | undefined
  spawner: ProcessSpawner
  /** 等待模型加载完成的上限。 */
  readyTimeoutMs: number
  /** 空闲多久后停止托管的服务；`0` 表示不自动停止。 */
  idleShutdownMs: number
  /** 请求到来而服务未运行时是否自动拉起。 */
  autoStart: boolean
  /** 观测日志。 */
  log?: (message: string) => void
  /** 测试注入的睡眠函数，默认 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>
  /** 测试注入的时钟，默认 `Date.now`。 */
  now?: () => number
}

/** 就绪探测的最小间隔：加载期间端点连不上，没必要连续猛打。 */
const PROBE_INTERVAL_MS = 2_000

/** 终止流程的宽限期：给服务自己收尾的机会，超时后不再空等。 */
const TERMINATE_GRACE_MS = 15_000

/**
 * 一个托管实例只对应一个服务进程范围。
 *
 * 不是线程安全的并发放心依赖：`ensureServed()` 把并发的启动请求折叠成同一个
 * promise，因此同一时刻最多拉起一个进程。
 */
export class StrataSupervisor {
  private readonly options: SupervisorOptions
  private handle: SubprocessHandle | undefined
  private starting: Promise<ServeStatus> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private state: ServeStatus['state'] = 'stopped'
  private lastActivityAt = 0

  /**
   * @param options - 事实解析、进程拉起方式、超时与空闲策略。
   */
  constructor(options: SupervisorOptions) {
    this.options = options
  }

  /** 探测服务当前状态，绝不启动或停止任何东西。 */
  async status(): Promise<ServeStatus> {
    const facts = this.options.resolveFacts()
    let models: string[] = []
    let reachable = false
    let loaded = false
    try {
      const entries = await fetchListing(facts.baseURL, strataHeaders(facts))
      models = entries.map(entry => entry.id)
      reachable = true
      loaded = isLoaded(entries)
    } catch {
      // 连不上就是"没有服务在跑"，这是常态而不是故障（加载期间也连不上）。
      reachable = false
    }
    const managed = this.handle !== undefined
    if (reachable && loaded && this.starting === undefined) this.state = 'running'
    else if (!reachable && !managed) this.state = 'stopped'
    const install = this.options.resolveInstall()
    return {
      state: this.state,
      reachable,
      loaded,
      managed,
      models,
      ...install === undefined ? {} : { install: { root: install.root, source: install.source } },
      ...managed && this.options.idleShutdownMs > 0
        ? { idleShutdownInMs: Math.max(0, this.options.idleShutdownMs - (this.now() - this.lastActivityAt)) }
        : {},
    }
  }

  /**
   * 确保服务可用：已加载完成就直接复用；否则**按配置**决定是否拉起并等到就绪。
   * 这是模型请求路径用的入口——它遵守 `autoStart`。
   * @param signal - 调用方取消；中止只结束**这一次等待**，已经拉起的进程继续加载
   *   （并发的调用方可能仍在等它），最终由空闲回收或卸载收尾。
   * @returns 就绪后的状态。
   * @throws StrataError 不允许自动启动而服务又没跑，或启动后迟迟不就绪。
   */
  ensureServed(signal?: AbortSignal): Promise<ServeStatus> {
    return this.acquire(signal, this.options.autoStart)
  }

  /**
   * 显式启动并等到就绪，忽略 `autoStart` 策略——这是 `strata_serve` 工具用的入口：
   * 主对话明确要求启动时，"是否允许自动拉起"这条策略不该拦住它。
   * @param signal - 调用方取消，语义同 {@link ensureServed}。
   * @returns 就绪后的状态。
   */
  serveNow(signal?: AbortSignal): Promise<ServeStatus> {
    return this.acquire(signal, true)
  }

  /** 两个入口共用的获取流程。 */
  private async acquire(signal: AbortSignal | undefined, allowStart: boolean): Promise<ServeStatus> {
    const current = await this.status()
    if (current.loaded) {
      this.touch()
      return current
    }
    if (!allowStart) {
      throw new StrataError(
        `strata: 本地服务未运行（${this.options.resolveFacts().baseURL} 连不上或模型未加载）。`
        + ' 本插件的 autoStart 已关闭，请先调用 `strata_serve` 工具启动本地模型服务，再重试。',
        'SERVICE_NOT_RUNNING',
      )
    }
    if (this.starting !== undefined) return this.starting
    this.starting = this.start(signal)
    try {
      return await this.starting
    } finally {
      this.starting = undefined
    }
  }

  /** 记录一次活动：把空闲回收的计时推后。 */
  touch(): void {
    this.lastActivityAt = this.now()
    if (this.handle === undefined || this.options.idleShutdownMs <= 0) return
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      // 加载中不算空闲：进程已经起了、只是还没加载完，杀掉它等于白烧一分钟。
      // 这条与轮询里的 touch 是两道独立的保险——只要空闲窗口比轮询间隔还短，
      // 单靠轮询续命仍然会漏。
      if (this.state === 'starting') {
        this.touch()
        return
      }
      void this.stop('空闲超时')
    }, this.options.idleShutdownMs)
    // 空闲回收不该把 dsh 自己的事件循环钉住。
    this.idleTimer.unref?.()
  }

  /**
   * 停止服务。只终止**本插件拉起**的进程；外部服务只记录不动作。
   * @param reason - 停止原因，写进日志。
   * @returns 是否真的停掉了托管进程。
   */
  async stop(reason: string): Promise<StopOutcome> {
    this.clearIdle()
    const handle = this.handle
    if (handle === undefined) {
      this.state = 'stopped'
      return { stopped: false, reason: `服务不是本插件拉起的，不停止（${reason}）` }
    }
    this.handle = undefined
    this.state = 'stopped'
    this.options.log?.(`strata: 停止本地服务（${reason}）`)
    handle.terminate()
    try {
      const settled = await handle.waitForExit(AbortSignal.timeout(TERMINATE_GRACE_MS))
      if (!settled) this.options.log?.('strata: 进程范围未在宽限期内清空，可能仍有残留')
    } catch (error) {
      // 终止流程本身失败只记日志：进程已经不在我们的职责范围内了。
      this.options.log?.(`strata: 停止本地服务时出错：${describe(error)}`)
    }
    return { stopped: true }
  }

  /** 插件卸载时的同步收尾：起过的进程不留在机器上。 */
  dispose(): void {
    this.clearIdle()
    const handle = this.handle
    this.handle = undefined
    this.state = 'stopped'
    handle?.terminate()
  }

  /** 拉起服务并等到模型加载完成。 */
  private async start(signal?: AbortSignal): Promise<ServeStatus> {
    const facts = this.options.resolveFacts()
    // 竞态兜底：探测与服务启动之间可能有人把它起好了，那就不重复拉起。
    const probeFirst = await this.status()
    if (probeFirst.loaded) {
      this.touch()
      return probeFirst
    }
    const install = this.options.resolveInstall()
    const spec: SubprocessSpawnSpec = {
      argv: serveArgv(facts, install),
      // 服务要求工作目录是安装根目录（它按相对路径找 engine/ 与 serve/）。
      cwd: install?.root ?? process.cwd(),
      stdio: {
        stdin: 'ignore',
        // 服务日志是排障用的诊断尾巴，只留最近一段，避免常驻内存被日志吃掉。
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: TERMINATE_GRACE_MS,
    }
    this.options.log?.(`strata: 拉起本地服务 ${spec.argv.join(' ')}`)
    const handle = this.options.spawner.spawn(spec)
    this.handle = handle
    // 进程自己退出（崩溃、被外部杀掉）时及时交出所有权，避免我们在一个不存在的
    // 进程上记账、进而再也不肯重启。
    void handle.done.then(
      () => { if (this.handle === handle) this.handle = undefined },
      () => { if (this.handle === handle) this.handle = undefined },
    )
    this.state = 'starting'
    this.touch()
    try {
      await this.waitUntilLoaded(signal)
    } catch (error) {
      // 起不来就把它收掉：半个加载中的进程比没有服务更糟（占着 20 GB 却不干活）。
      await this.stop('启动失败')
      throw error
    }
    this.state = 'running'
    this.touch()
    const ready = await this.status()
    return { ...ready, state: 'running' }
  }

  /** 轮询直到模型报告 loaded。 */
  private async waitUntilLoaded(signal?: AbortSignal): Promise<void> {
    const facts = this.options.resolveFacts()
    const deadline = this.now() + this.options.readyTimeoutMs
    while (this.now() < deadline) {
      await this.sleep(PROBE_INTERVAL_MS)
      // 加载中不算空闲：每轮探测都续命。否则空闲窗口比加载时间短时（35B 要一到两分钟），
      // 回收会把一个正在加载、马上就能用的服务杀掉。
      this.touch()
      if (signal?.aborted === true) throw new StrataError('strata: 等待服务就绪被取消', 'ABORTED')
      try {
        const entries = await fetchListing(facts.baseURL, strataHeaders(facts))
        if (isLoaded(entries)) return
      } catch {
        // 加载期间连不上是预期行为（文档 5.3），继续等。
      }
    }
    const tail = this.outputTail()
    throw new StrataError(
      `strata: 服务在 ${Math.round(this.options.readyTimeoutMs / 1000)} 秒内没有就绪。`
      + '35B 权重首次加载更慢，可调大 readyTimeoutMs 或查看服务日志。'
      + (tail.length === 0 ? '（没读到服务输出）' : `\n服务输出尾部：\n${tail}`),
      'SERVICE_NOT_READY',
    )
  }

  /**
   * 服务进程输出（stdout+stderr）的尾部。
   *
   * 启动失败时必须能说出"为什么"：35B 服务的加载进度、显存不足、端口占用都只写在
   * 它自己的输出里，把这几百字节带进错误消息比让人去翻日志快得多。
   * @returns 最近一段输出；没有可读输出时为空串。
   */
  private outputTail(): string {
    const handle = this.handle
    if (handle === undefined) return ''
    const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return `${stdout}${stderr}`.trim().slice(-600)
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private sleep(ms: number): Promise<void> {
    if (this.options.sleep !== undefined) return this.options.sleep(ms)
    return new Promise<void>(resolve => { setTimeout(resolve, ms) })
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

/**
 * 组装服务启动命令。
 *
 * 两件事都不写死：可执行文件与脚本来自自动检测（`detect.ts`），端口来自已解析的端点
 * ——因此命令与探测永远指向同一个端口。用户显式写了 `serveCommand` 就完全照用。
 * @param facts - 已解析的连接事实。
 * @param install - 自动检测到的安装；没有安装且没有 `serveCommand` 时报错。
 * @returns 完整的 argv（`argv[0]` 是可执行文件）。
 * @throws StrataError 既没有安装信息、也没有显式启动命令。
 */
export function serveArgv(facts: ResolvedConfig, install: StrataInstall | undefined): string[] {
  if (facts.serveCommand !== undefined && facts.serveCommand.length > 0) return [...facts.serveCommand]
  if (install === undefined) {
    throw new StrataError(`strata: ${missingInstallationHint()}`, 'NO_INSTALLATION')
  }
  const url = new URL(facts.baseURL)
  const port = url.port.length > 0 ? url.port : '8080'
  return [
    install.python,
    install.serverScript,
    '--engine', 'strata',
    ...install.engineConfig === undefined ? [] : ['--config', install.engineConfig],
    '--port', port,
  ]
}
