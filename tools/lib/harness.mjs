/**
 * 本工程与 DSH 源码树之间的唯一定位点。
 *
 * 本插件不安装任何依赖（`node_modules` 一律没有）：类型、运行时契约、测试加载器、
 * 打包器全部借用本机已有的 DSH 源码树。这样做的直接后果是**验证的对象是 DSH 自己
 * 的那份源码**（真实的 `LlmAdapter` / `LlmRuntime` 契约），而不是手工复制的类型桩。
 *
 * `DSH_SOURCE_ROOT` 可覆盖源码树位置。
 */
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 本插件仓库根目录。 */
export const PLUGIN_ROOT = resolve(HERE, '..', '..')
/** DSH 源码树根目录。 */
export const HARNESS_ROOT = process.env.DSH_SOURCE_ROOT ?? resolve(PLUGIN_ROOT, '..', 'deepseek-harness')
/** DSH 源码树里的 tsx 加载器（让 Node 直接跑 `.ts` 源码）。 */
export const TSX_LOADER = pathToFileURL(join(HARNESS_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
/** DSH 源码树里的 TypeScript 编译器入口。 */
export const TSC_BIN = join(HARNESS_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
/** 把 `@deepseek-ai/*` 映射到源码的加载钩子。 */
export const HARNESS_HOOK = pathToFileURL(join(HERE, 'harness-hook.mjs')).href

/**
 * 从 DSH 源码树的依赖环境里解析一个包（打包器这类开发期工具用）。
 * @param specifier - 包名。
 * @returns 解析到的绝对路径。
 */
export function resolveFromHarness(specifier) {
  return createRequire(join(HARNESS_ROOT, 'package.json')).resolve(specifier)
}

/**
 * 找到 DSH 源码树里 pnpm 存放的 esbuild 入口。
 *
 * 为什么要扫而不是 `require.resolve`：esbuild 是 pnpm 的**间接**依赖，只存在于
 * `node_modules/.pnpm/esbuild@<version>/`，从仓库根解析不到。取版本最高的一个。
 * @returns esbuild 的 CommonJS 入口路径。
 * @throws Error 源码树里没有 esbuild。
 */
export function resolveEsbuild() {
  const store = join(HARNESS_ROOT, 'node_modules', '.pnpm')
  const candidates = existsSync(store)
    ? readdirSync(store).filter(name => /^esbuild@\d/.test(name)).sort().reverse()
    : []
  for (const candidate of candidates) {
    const entry = join(store, candidate, 'node_modules', 'esbuild', 'lib', 'main.js')
    if (existsSync(entry)) return entry
  }
  throw new Error(`在 ${store} 里找不到 esbuild`)
}

/** 跑 Node 子进程时统一的 ESM 预载参数。 */
export const SOURCE_LOADER_ARGS = ['--import', TSX_LOADER, '--import', HARNESS_HOOK]
