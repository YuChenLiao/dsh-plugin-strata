/**
 * 与宿主（DSH）之间的最小自实现层。
 *
 * 为什么不能直接 `import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'`：
 * dsh 装载第三方插件时，模块解析从**插件的真实目录**开始（`link:` 安装更是如此），
 * 而插件目录不在宿主的 `node_modules` 解析路径上——产物里只要有一句裸 import，装载
 * 就会以 "failed to import" 失败。这一点在本机已装的插件上有两个现成证据：
 * `dsh-ops`（github 安装）与 `dsh-plugin-structured-prompt`（link 安装）的产物里都
 * **没有任何 `@deepseek-ai/*` import**。
 *
 * 所以这里的做法是：
 *  - **类型**照旧从真实包 `import type` 取（编译期擦除，不产生运行时依赖），因此
 *    `StrataAdapter implements LlmAdapter` 这类检查仍然对着 DSH 的真实契约；
 *  - **运行时**只保留最小自实现：一个带自有 `code` / `failure` 数据属性的错误类、
 *    一个归因头函数、一个工具定义构造器。
 *
 * 错误类的形状不是猜的：`@deepseek-ai/dsh-llm` 的 `normalizeLlmFailure` 明确为
 * 跨包副本设计——它读 `error` 的**自有数据属性** `code` 与 `failure`，两者一致就
 * 采信，不要求 `instanceof HarnessError`。
 *
 * @module dsh-plugin-strata/host
 */

import type { LlmAdapter, LlmFailure } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** 本插件发往服务端的 `User-Agent`（与 harness 的 `attributionHeaders()` 同义）。 */
export const USER_AGENT = 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)'

/**
 * 构造发往 provider 的归因头。
 *
 * harness 对适配器的硬性要求是"每个 provider 请求都带归因头"；这里给出同值的最小
 * 实现，避免为了一个常量字符串而依赖整个 `dsh-llm` 运行时。
 * @returns 可直接并入请求头的对象。
 */
export function attributionHeaders(): Record<string, string> {
  return { 'user-agent': USER_AGENT }
}

/** 错误的附加事实；形状与 `dsh-llm` 的 `LlmFailure` 一致。 */
export interface StrataErrorOptions {
  /** provider 边界上观测到的 HTTP 状态码。 */
  status?: number
  /** 原始异常，保留因果链。 */
  cause?: unknown
}

/**
 * 本插件的错误类型。
 *
 * `code` 与 `failure` 都是**自有数据属性**（不是 getter、不是原型上的字段），
 * 这正是宿主 `normalizeLlmFailure` 采信跨包错误所需的形状；两者 `code` 必须一致，
 * 否则宿主会退化成 `UNKNOWN`。
 */
export class StrataError extends Error {
  /** 稳定的机器可读错误码（自有数据属性）。 */
  readonly code: string
  /** 与 {@link code} 一致的失败事实（自有数据属性）。 */
  readonly failure: LlmFailure

  /**
   * @param message - 面向人的失败说明，不能为空。
   * @param code - 稳定的机器可读错误码，不能为空。
   * @param options - 可选的 HTTP 状态与原始异常。
   */
  constructor(message: string, code: string, options: StrataErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    if (message.length === 0) throw new Error('StrataError message must be a non-empty string')
    if (code.length === 0) throw new Error('StrataError code must be a non-empty string')
    this.name = 'StrataError'
    this.code = code
    this.failure = Object.freeze({
      message,
      code,
      ...options.status === undefined ? {} : { status: options.status },
    })
  }
}

/**
 * 声明一个模型可见的工具。
 *
 * 只是把字面量定成 `ToolDefinition`：宿主 `ToolRuntime` 读的是普通对象字段
 * （`name` / `description` / `parameters` / `output` / `execute`），不检查它是不是
 * 某个工厂函数的产物，因此这里不需要 `dsh-tools` 的 `defineTool`。
 * @param definition - 完整的工具定义。
 * @returns 同一个对象（便于在注册处保留类型）。
 */
export function defineTool(definition: ToolDefinition): ToolDefinition {
  return definition
}

/** 适配器必须实现的成员（`stream` 之外都是 `LlmAdapter` 的默认实现，这里照抄语义）。 */
export type AdapterSurface = Pick<
  LlmAdapter,
  'providerInfo' | 'providerRetryPolicy' | 'listModels' | 'resolveModel' | 'prepareCall' | 'stream'
>
