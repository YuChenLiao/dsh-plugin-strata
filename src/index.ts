/**
 * 插件入口：把本机 Strata（HIP/AMD）推理服务注册成 harness 的一个 provider
 * 路由（`strata`），于是 dsh 的模型选择器里就多了一个跑在本地 20 GB 显存上的
 * Qwen3.6-35B-A3B。
 *
 * ```yaml
 * - id: llm-strata
 *   name: dsh-plugin-strata
 *   config:
 *     baseURL: http://127.0.0.1:8080/v1
 *     model: qwen3.6-35b-a3b-ud-q4_k_xl
 *     reasoningEffort: none
 *     autoStart: true          # 请求到来而服务没跑时自动拉起（懒启动）
 *     idleShutdownMs: 300000   # 5 分钟无调用就停掉，释放那 20 GB
 * ```
 *
 * 服务生命周期由 `StrataSupervisor` 托管：**不随 dsh 装载而起**，只在真正要用时拉起
 * （一次模型请求，或主对话显式调用 `strata_serve`），空闲 5 分钟后自动停止，而且**只停
 * 自己拉起的进程**——服务可能是别人先起好的（交接文档 5.3 的警告）。
 *
 * 托管能力依赖 `subprocess` 服务；该 profile 没有它时插件照常提供 provider，只是不托管
 * 进程（用 `ctx.inject` 可选装载，因此不写进 `inject` 的必需依赖里）。
 *
 * @module dsh-plugin-strata
 */

import type { Context } from '@deepseek-ai/cordis'
import { StrataAdapter, strataHeaders } from './adapter.ts'
import { resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { detectInstallation, missingInstallationHint } from './detect.ts'
import type { StrataInstall } from './detect.ts'
import { fetchListing, isLoaded } from './models.ts'
import { StrataSupervisor } from './serve.ts'
import { registerStrataTools } from './tools.ts'

export const name = 'llm-strata'
export const inject = ['llm']

/** 本插件拥有的 provider 路由名；会话里选它即走本机模型。 */
export const PROVIDER = 'strata'

export { StrataAdapter, strataHeaders } from './adapter.ts'
export type { StrataAdapterOptions } from './adapter.ts'
export { StrataSupervisor, serveArgv } from './serve.ts'
export type { ProcessSpawner, ServeStatus, StopOutcome, SupervisorOptions } from './serve.ts'
export { registerStrataTools } from './tools.ts'
export {
  STRATA_DOWNLOAD_URL,
  STRATA_UPSTREAM,
  candidateRoots,
  detectInstallation,
  missingInstallationHint,
} from './detect.ts'
export type { DetectFs, DetectOptions, StrataInstall } from './detect.ts'
export {
  DEFAULT_AUTO_START,
  DEFAULT_BASE_URL,
  DEFAULT_IDLE_SHUTDOWN_MS,
  DEFAULT_REASONING_EFFORT,
  resolveConfig,
} from './config.ts'
export { buildChatRequest, translateMessage, translateTools } from './wire.ts'
export { StreamTranslator, mapFinishReason, mapUsage } from './translate.ts'
export { consumeLine, parseSse } from './sse.ts'
export { fetchListing, isLoaded, readListing } from './models.ts'

/**
 * 装载插件：注册 `strata` 路由、可选地托管服务进程并暴露三个工具。
 * @param ctx - 插件上下文；`llm` 服务由 `inject` 保证存在。
 * @param config - 已由 {@link Config} 校验过的插件配置。
 * @throws Error 配置不合法（装载期就炸响，而不是等第一条请求）。
 */
export function apply(ctx: Context, config: Config): void {
  // 装载期解析一次：配置错了在这里失败，而不是在第一条请求上变成看不懂的错误。
  const facts = resolveConfig(config)
  /**
   * 自动检测本机安装。每次都重新检测（几个文件系统调用）：用户可能刚装好或换了版本，
   * 缓存住只会让"装完还要重启 dsh"这种事发生。
   */
  const resolveInstall = (): StrataInstall | undefined => detectInstallation({
    ...facts.serveCommand === undefined ? {} : { explicitCommand: facts.serveCommand },
    ...facts.model === undefined ? {} : { model: facts.model },
  })
  // 端点端口优先用检测到的那个：配置文件里写了 8080，就不该在这里再写一次。
  const resolveFacts = (): ResolvedConfig => resolveConfig(config, resolveInstall()?.port)
  let supervisor: StrataSupervisor | undefined

  const adapter = new StrataAdapter({
    resolveFacts,
    log: message => ctx.logger.info(message),
    ensureServed: async (signal) => { await supervisor?.ensureServed(signal) },
    touch: () => { supervisor?.touch() },
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)

  // 进程托管与工具都依赖可选能力：这个 profile 没有 subprocess（拉不起进程）或没有
  // tools 注册表时，插件只是少了这几个工具，provider 照常工作。
  ctx.inject(['subprocess', 'tools'], (scoped) => {
    const resolved = resolveFacts()
    const managed = new StrataSupervisor({
      resolveFacts,
      resolveInstall,
      spawner: scoped.subprocess,
      readyTimeoutMs: resolved.readyTimeoutMs,
      idleShutdownMs: resolved.idleShutdownMs,
      autoStart: resolved.autoStart,
      log: message => scoped.logger.info(message),
    })
    supervisor = managed
    registerStrataTools(scoped, { supervisor: managed })
    // 空闲回收是兜底，这里才是"自己起的一定收"：卸载时不留进程在机器上。
    scoped.effect(() => () => { managed.dispose() })
  })

  reportEnvironment(ctx, resolveFacts, resolveInstall)
}

/**
 * 非阻塞地报告一次环境与状态。三件事都要说清楚，否则用户无从判断：
 * 有没有找到本机安装、端点上是哪个端口、服务当前是就绪还是没跑。
 *
 * 服务没起、或权重还在加载，都不是插件装载失败：路由照常注册，真要用时会被拉起。
 * 因此这里只写日志，绝不抛错。
 * @param ctx - 插件上下文。
 * @param resolveFacts - 端点等连接事实。
 * @param resolveInstall - 本机安装的自动检测。
 */
function reportEnvironment(
  ctx: Context,
  resolveFacts: () => ResolvedConfig,
  resolveInstall: () => StrataInstall | undefined,
): void {
  void (async () => {
    const facts = resolveFacts()
    const install = resolveInstall()
    if (install === undefined) {
      // 没装不是错误：插件只是没法在这里拉起服务。把上游地址给出来才是有用的信息。
      ctx.logger.info(`strata: ${missingInstallationHint()}`)
      return
    }
    ctx.logger.info(`strata: 检测到 Strata 安装 ${install.root}`
      + `（来源 ${install.source === 'env' ? 'STRATA_HOME' : '常见安装位置'}`
      + `${install.engineConfig === undefined ? '' : `，配置 ${install.engineConfig}`}）`
      + `，端点 ${facts.baseURL}`)
    try {
      const entries = await fetchListing(facts.baseURL, strataHeaders(facts))
      const loaded = entries.filter(entry => entry.status?.value === 'loaded').map(entry => entry.id)
      if (isLoaded(entries)) {
        ctx.logger.info(`strata: 服务已就绪，已加载 ${loaded.join('、')}`)
      } else {
        ctx.logger.info(`strata: 服务可达，但模型尚未加载完成（实测需 47–79 秒）`)
      }
    } catch {
      // 服务没跑是常态（插件按需拉起它），不值得刷警告。
      ctx.logger.info(`strata: 当前没有服务在 ${facts.baseURL} 应答；需要时会按配置拉起`)
    }
  })()
}
