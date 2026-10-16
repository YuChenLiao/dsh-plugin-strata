/**
 * 测试用 ESM 加载钩子：把 `@deepseek-ai/*` 裸说明符解析到 DSH 源码树的 `src/*.ts`。
 *
 * 为什么需要它：DSH 各包的 `package.json#exports` 一律指向 `lib/`（构建产物）。
 * 本机源码树未执行 `pnpm run build`，因此常规解析会命中不存在的文件。本工程刻意
 * 不引入构建步骤 —— 测试直接对被测插件的 TS 源码运行，对 `@deepseek-ai/dsh-llm`
 * 也直接加载源码，这样断言的是**真实的 LlmAdapter 契约**（Service Definition 源
 * 码），而不是本地手写的类型桩。
 *
 * 解析规则（只拦截 `@deepseek-ai/<name>`，其余说明符原样交给 Node）：
 *   `@deepseek-ai/dsh-llm`         → `<pkg>/src/index.ts`
 *   `@deepseek-ai/dsh-llm/types`   → `<pkg>/src/types.ts`（或 `<pkg>/src/types/index.ts`）
 *
 * 包目录来自三处扫描（都先取 realpath，让被映射模块能从**自己的** node_modules
 * 环境解析依赖）：DSH 根的 `node_modules/@deepseek-ai`、`vendor/`（Cordis 等 vendored
 * 包）、以及 `packages/<group>/<pkg>/node_modules/@deepseek-ai`。
 *
 * 通过 `node --import ./tools/lib/harness-hook.mjs` 注册；`DSH_SOURCE_ROOT` 可覆盖
 * 源码树位置。
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 本插件仓库根目录。 */
export const PLUGIN_ROOT = resolve(HERE, '..', '..')
/** DSH 源码树根目录；`DSH_SOURCE_ROOT` 可覆盖。 */
export const HARNESS_ROOT = process.env.DSH_SOURCE_ROOT ?? resolve(PLUGIN_ROOT, '..', 'deepseek-harness')

/** 包名 → 包目录（已 realpath）。 */
const PACKAGES = {}

/** 记录一个目录，若它是 `@deepseek-ai/*` 包则登记其名字。 */
function addPackage(dir) {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return
  let name
  try {
    name = JSON.parse(readFileSync(manifest, 'utf8')).name
  } catch {
    // 清单不是合法 JSON：它不是可解析的包，跳过（不在这里制造失败）。
    return
  }
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) return
  try {
    PACKAGES[name] = realpathSync(dir)
  } catch {
    PACKAGES[name] = dir
  }
}

/** 扫描一个目录下所有子目录，登记其中的 `@deepseek-ai` 包。 */
function scanDir(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) addPackage(join(dir, entry.name))
  }
}

scanDir(join(HARNESS_ROOT, 'node_modules', '@deepseek-ai'))
scanDir(join(HARNESS_ROOT, 'vendor'))
const groups = join(HARNESS_ROOT, 'packages')
if (existsSync(groups)) {
  for (const group of readdirSync(groups, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupDir = join(groups, group.name)
    for (const pkg of readdirSync(groupDir, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      scanDir(join(groupDir, pkg.name, 'node_modules', '@deepseek-ai'))
    }
  }
}

const HOOK = `
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PACKAGES = ${JSON.stringify(PACKAGES)}
const PREFIX = '@deepseek-ai/'

/** 子路径导出名 → 源码文件（不含扩展名）。 */
function candidates(pkgDir, sub) {
  if (sub === undefined || sub === '') return [join(pkgDir, 'src', 'index.ts')]
  return [join(pkgDir, 'src', sub + '.ts'), join(pkgDir, 'src', sub, 'index.ts')]
}

export async function resolve(specifier, context, next) {
  if (specifier.startsWith(PREFIX) && !specifier.endsWith('/package.json')) {
    const rest = specifier.slice(PREFIX.length)
    const slash = rest.indexOf('/')
    const name = PREFIX + (slash === -1 ? rest : rest.slice(0, slash))
    const pkgDir = PACKAGES[name]
    if (pkgDir !== undefined) {
      for (const file of candidates(pkgDir, slash === -1 ? '' : rest.slice(slash + 1))) {
        if (existsSync(file)) return { url: pathToFileURL(file).href, shortCircuit: true }
      }
    }
  }
  return next(specifier, context)
}
`

register(`data:text/javascript,${encodeURIComponent(HOOK)}`, pathToFileURL(`${HERE}/`))
