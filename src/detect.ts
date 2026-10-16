/**
 * 本机 Strata 安装的自动检测。
 *
 * 为什么不让用户手填路径：安装位置（盘符、venv、引擎配置名）本来就能从磁盘上看出来，
 * 写进配置只会变成"换台机器就失效"。这里的规则是：
 *
 *  1. 先看环境变量 `STRATA_HOME`（部署方明确指定的位置优先）；
 *  2. 再看常见安装位置（用户主目录、`%LOCALAPPDATA%`、各盘符根下的 `Strata`）；
 *  3. 判定标准是"这个目录里有 `serve/server.py`，并且装好了引擎或虚拟环境"——不做
 *     模糊匹配，宁可报"找不到"也不去启动一个不像 Strata 的东西；
 *  4. 引擎配置（`strata-*.json`）与端口从目录里读出来，而不是内置一份。
 *
 * 一个都找不到时**不猜**：交给调用方把上游地址告诉用户。
 *
 * @module dsh-plugin-strata/detect
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

/** 上游仓库：README 与 `setup.py` 里一致的那个地址。 */
export const STRATA_UPSTREAM = 'https://github.com/Niko1221/Strata'

/** 上游提供的一键下载包（README 的安装指引用它）。 */
export const STRATA_DOWNLOAD_URL = 'https://github.com/Niko1221/Strata/archive/refs/heads/main.zip'

/** 检测所需的文件系统视图；测试注入假实现，生产用磁盘。 */
export interface DetectFs {
  /** 路径是否存在（文件或目录）。 */
  exists(path: string): boolean
  /** 列出一个目录的条目名；目录不存在时返回空数组。 */
  list(dir: string): string[]
  /** 读一个 JSON 文件；内容不合法时抛出。 */
  readJson(path: string): unknown
}

/** 磁盘版文件系统视图。 */
export const diskFs: DetectFs = {
  exists: path => existsSync(path),
  list: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      // 目录不存在或没有权限，都等同于"这里没有东西"。
      return []
    }
  },
  readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
}

/** 找到的安装。 */
export interface StrataInstall {
  /** 安装根目录。 */
  root: string
  /** 服务入口脚本（`serve/server.py`）。 */
  serverScript: string
  /** 启动服务用的解释器。 */
  python: string
  /** 引擎配置 json；没找到时为 `undefined`（仍可用 `--engine` 启动）。 */
  engineConfig?: string
  /** 引擎配置里报的端口。 */
  port?: number
  /** 引擎配置里报的模型 id。 */
  model?: string
  /** 这个结果是怎么来的，写日志与工具输出时用。 */
  source: 'env' | 'common-path'
}

/** 一次检测的输入。 */
export interface DetectOptions {
  /** 文件系统视图，默认磁盘。 */
  fs?: DetectFs
  /** 环境变量，默认 `process.env`。 */
  env?: Record<string, string | undefined>
  /** 用户显式写下的启动命令：给了它就不需要检测。 */
  explicitCommand?: string[]
  /** 期望的模型 id，用来在多个引擎配置里挑一个。 */
  model?: string
  /** 期望的端口，用来在多个引擎配置里挑一个（其次判据）。 */
  port?: number
}

/** 引擎配置文件名必须匹配这个形状，避免把 `.bak` 之类当成现用配置。 */
const ENGINE_CONFIG = /^strata-.+\.json$/

/**
 * 生成候选安装根目录。
 * @param env - 环境变量。
 * @returns 按优先级排列的候选目录（已去重）。
 */
export function candidateRoots(env: Record<string, string | undefined>): string[] {
  const roots: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined || value.length === 0) return
    const normalized = normalize(value)
    if (!roots.some(existing => existing.toLowerCase() === normalized.toLowerCase())) roots.push(normalized)
  }
  push(env.STRATA_HOME)
  const home = env.USERPROFILE ?? env.HOME
  if (home !== undefined) {
    push(join(home, 'Strata'))
    push(join(home, 'strata'))
  }
  if (env.LOCALAPPDATA !== undefined) push(join(env.LOCALAPPDATA, 'Strata'))
  // 常见的"放在某个盘根目录"的装法；不遍历整盘，那太慢也不值得。
  for (const drive of ['C:', 'D:', 'E:', 'F:']) push(`${drive}\\Strata`)
  return roots
}

/**
 * 检测本机安装。不做任何启发式猜测：每个候选目录都必须满足明确的判定条件。
 * @param options - 文件系统视图、环境变量、显式命令与选择偏好。
 * @returns 找到的安装；没有则为 `undefined`。
 */
export function detectInstallation(options: DetectOptions = {}): StrataInstall | undefined {
  const fs = options.fs ?? diskFs
  const env = options.env ?? process.env
  // 用户给了完整启动命令就没必要检测——他要的就是那条命令。
  if (options.explicitCommand !== undefined && options.explicitCommand.length > 0) return undefined
  for (const root of candidateRoots(env)) {
    const install = inspectRoot(root, fs, options)
    if (install !== undefined) return install
  }
  return undefined
}

/**
 * 判定一个目录是不是可用的 Strata 安装。
 * @param root - 候选根目录。
 * @param fs - 文件系统视图。
 * @param options - 模型/端口偏好。
 * @returns 安装信息；这个目录不像安装时返回 `undefined`。
 */
function inspectRoot(root: string, fs: DetectFs, options: DetectOptions): StrataInstall | undefined {
  const serverScript = join(root, 'serve', 'server.py')
  if (!fs.exists(serverScript)) return undefined
  const venvPython = [join(root, '.venv', 'Scripts', 'python.exe'), join(root, 'venv', 'Scripts', 'python.exe')]
    .find(candidate => fs.exists(candidate))
  const engine = join(root, 'engine', 'strata.exe')
  // 只见到 server.py 不算数：没有引擎也没有虚拟环境的目录，装的是别的东西。
  if (venvPython === undefined && !fs.exists(engine)) return undefined
  const config = pickEngineConfig(root, fs, options)
  const source: StrataInstall['source'] = root.toLowerCase() === normalize(options.env?.STRATA_HOME ?? '').toLowerCase()
    ? 'env'
    : 'common-path'
  return {
    root,
    serverScript,
    // 没有虚拟环境时交给 PATH 上的 python；服务自己会按配置里的 lib_dirs 处理库路径。
    python: venvPython ?? 'python',
    ...config === undefined ? {} : {
      engineConfig: join(root, config.file),
      ...config.port === undefined ? {} : { port: config.port },
      ...config.model === undefined ? {} : { model: config.model },
    },
    source,
  }
}

/** 从目录里挑一份引擎配置。 */
function pickEngineConfig(
  root: string,
  fs: DetectFs,
  options: DetectOptions,
): { file: string; port?: number; model?: string } | undefined {
  const files = fs.list(root)
    .filter(name => ENGINE_CONFIG.test(name))
    .sort()
  if (files.length === 0) return undefined
  const read = (file: string): { port?: number; model?: string } => {
    let body: unknown
    try {
      body = fs.readJson(join(root, file))
    } catch {
      // 坏掉的配置不是"没有配置"：跳过它，让别的候选还有机会。
      return {}
    }
    if (typeof body !== 'object' || body === null) return {}
    const record = body as { port?: unknown; model_name?: unknown }
    return {
      ...typeof record.port === 'number' ? { port: record.port } : {},
      ...typeof record.model_name === 'string' ? { model: record.model_name } : {},
    }
  }
  // 优先挑与预期模型/端口一致的那份；都不匹配就用排序后的第一份。
  const described = files.map(file => ({ file, ...read(file) }))
  const byModel = options.model === undefined ? undefined : described.find(entry => entry.model === options.model)
  const byPort = options.port === undefined ? undefined : described.find(entry => entry.port === options.port)
  return byModel ?? byPort ?? described[0]
}

/**
 * 找不到安装时给用户的说明（工具与错误消息共用）。
 * @returns 一段带下一步动作的文本。
 */
export function missingInstallationHint(): string {
  return '本机没检测到 Strata 安装（看过 STRATA_HOME、用户主目录、%LOCALAPPDATA% 与各盘根下的 Strata 目录，'
    + '判定条件是目录里有 serve/server.py 且装好引擎或虚拟环境）。'
    + `安装方式见 ${STRATA_UPSTREAM}（一键包 ${STRATA_DOWNLOAD_URL}，装完执行其中的 SETUP），`
    + '或用 config.serveCommand 直接给出启动命令。'
}
