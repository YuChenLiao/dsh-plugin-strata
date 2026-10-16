/**
 * 暴露给主对话的工具：由主对话决定何时唤起、何时释放本地模型服务。
 *
 * 三个工具对应三种判断，而不是把一件事拆成三个入口：
 *  - `strata_serve`：现在就用本地模型 → 唤起并等到就绪（避免第一条请求干等 80 秒）。
 *  - `strata_status`：先看看它在不在、是不是本插件管着的。
 *  - `strata_stop`：用完了 / 要让出显存 → 立刻释放那 20 GB。
 *
 * 描述写给模型看，因此只讲它需要判断的事实（要等多久、会不会重复拉起、谁负责回收），
 * 不讲实现。
 *
 * 工具定义用标准 JSON Schema 手写（不走 `dsh-tools` 的 `defineTool`）：原因见
 * `host.ts` —— 产物必须自包含。宿主 `ToolRuntime` 读的是普通字段，不检查定义来自
 * 哪个工厂函数。
 *
 * @module dsh-plugin-strata/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from './host.ts'
import type { StrataSupervisor } from './serve.ts'

/** 登记三个工具所需的东西；`tools` 服务由调用方保证存在。 */
export interface ToolDeps {
  supervisor: StrataSupervisor
}

/** `strata_serve` 的返回值。 */
interface ServeValue {
  state: string
  loaded: boolean
  managed: boolean
  models: string[]
  elapsedMs: number
}

/** `strata_status` 的返回值。 */
interface StatusValue {
  state: string
  reachable: boolean
  loaded: boolean
  managed: boolean
  models: string[]
  idleShutdownInMs?: number
  installRoot?: string
}

/** `strata_stop` 的返回值。 */
interface StopValue {
  stopped: boolean
  reason?: string
}

/**
 * 注册 `strata_serve` / `strata_status` / `strata_stop`。
 * @param ctx - 带 `tools` 注册表的上下文。
 * @param deps - 托管器。
 */
export function registerStrataTools(ctx: Context, deps: ToolDeps): void {
  const { supervisor } = deps

  ctx.tools.register(defineTool({
    name: 'strata_serve',
    description:
      'Start the local Strata inference service (AMD HIP) and wait until its model reports loaded, '
      + 'so a later request to the `strata` model does not sit through the weight load. Loading the '
      + '35B model takes roughly one to two minutes and holds about 20 GB of memory. Safe to call '
      + 'when the service is already running: it is reused, never started twice. The service is '
      + 'stopped automatically after an idle period, and only if this plugin started it.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['state', 'loaded', 'managed', 'models', 'elapsedMs'],
        properties: {
          state: { type: 'string', enum: ['stopped', 'starting', 'running'] },
          loaded: { type: 'boolean' },
          managed: { type: 'boolean' },
          models: { type: 'array', items: { type: 'string' } },
          elapsedMs: { type: 'integer' },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const served = value as unknown as ServeValue
        return [{
          type: 'text',
          text: `Local Strata service is ${served.state} (model loaded: ${served.loaded}, `
            + `started by this plugin: ${served.managed}) after ${served.elapsedMs} ms. `
            + `Models: ${served.models.length === 0 ? '(none reported)' : served.models.join(', ')}.`,
        }]
      },
    },
    async execute(_args, exec) {
      const startedAt = Date.now()
      const status = await supervisor.serveNow(exec.signal)
      return {
        state: status.state,
        loaded: status.loaded,
        managed: status.managed,
        models: [...status.models],
        elapsedMs: Date.now() - startedAt,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Start local Strata service', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'strata_status',
    description:
      'Report the local Strata inference service state: where the installation was detected, whether '
      + 'the endpoint answers, whether the model finished loading, whether this plugin manages the '
      + 'process (and will therefore stop it when idle), which models it advertises, and how long '
      + 'until an idle shutdown.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['state', 'reachable', 'loaded', 'managed', 'models'],
        properties: {
          state: { type: 'string', enum: ['stopped', 'starting', 'running'] },
          reachable: { type: 'boolean' },
          loaded: { type: 'boolean' },
          managed: { type: 'boolean' },
          models: { type: 'array', items: { type: 'string' } },
          idleShutdownInMs: { type: 'integer' },
          installRoot: { type: 'string' },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const status = value as unknown as StatusValue
        return [{
          type: 'text',
          text: `Strata service: state=${status.state}, endpoint reachable=${status.reachable}, `
            + `model loaded=${status.loaded}, managed by this plugin=${status.managed}`
            + `${status.idleShutdownInMs === undefined ? '' : `, idle shutdown in ${status.idleShutdownInMs} ms`}. `
            + `Models: ${status.models.length === 0 ? '(none reported)' : status.models.join(', ')}. `
            + (status.installRoot === undefined
              ? 'No local Strata installation was detected, so this plugin cannot start one itself.'
              : `Installation detected at ${status.installRoot}.`),
        }]
      },
    },
    async execute() {
      const status = await supervisor.status()
      return {
        state: status.state,
        reachable: status.reachable,
        loaded: status.loaded,
        managed: status.managed,
        models: [...status.models],
        ...status.idleShutdownInMs === undefined ? {} : { idleShutdownInMs: status.idleShutdownInMs },
        ...status.install === undefined ? {} : { installRoot: status.install.root },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check local Strata service', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'strata_stop',
    description:
      'Stop the local Strata inference service to free its memory immediately, instead of waiting '
      + 'for the idle shutdown. Only a service started by this plugin is stopped; a service someone '
      + 'else started is left running.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['stopped'],
        properties: {
          stopped: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value): ContentBlock[] => {
        const outcome = value as unknown as StopValue
        return [{
          type: 'text',
          text: outcome.stopped
            ? 'Local Strata service stopped; its memory is released.'
            : `Local Strata service was not stopped: ${outcome.reason ?? 'no managed process'}.`,
        }]
      },
    },
    async execute() {
      const outcome = await supervisor.stop('主对话请求停止')
      return {
        stopped: outcome.stopped,
        ...outcome.reason === undefined ? {} : { reason: outcome.reason },
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Stop local Strata service', kind: 'other' }),
  }))
}
