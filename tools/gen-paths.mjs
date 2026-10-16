/**
 * 生成 `tsconfig.paths.json`：把 `@deepseek-ai/*` 映射到 DSH 源码树的 `src/*.ts`。
 *
 * 为什么要生成而不是手写：DSH 各包的 `package.json#exports` 指向 `lib/`（构建产物），
 * 本机源码树未构建；而包的目录名与包名不同构（`@deepseek-ai/dsh-typert-protocol`
 * 在 `packages/typert/protocol/`），通配符覆盖不到，只能逐包列。
 *
 * 生成物**入库**，并由 `--check` 模式当门禁：源码树里新增依赖包而映射表没跟着更新
 * 时，验证会失败而不是悄悄退化成"类型检查其实什么都没检查"。
 *
 * 用法：
 *   node tools/gen-paths.mjs          # 写文件
 *   node tools/gen-paths.mjs --check  # 只校验是否为最新
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = join(ROOT, 'tsconfig.paths.json')
const HARNESS_ROOT = process.env.DSH_SOURCE_ROOT ?? resolve(ROOT, '..', 'deepseek-harness')

/** 包名 → 包目录。 */
const packages = new Map()

/** 登记一个可能是 `@deepseek-ai/*` 包的目录。 */
function addPackage(dir) {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return
  let name
  try {
    name = JSON.parse(readFileSync(manifest, 'utf8')).name
  } catch {
    return // 不是可解析的清单：跳过。
  }
  if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) return
  if (packages.has(name)) return
  try {
    packages.set(name, realpathSync(dir))
  } catch {
    packages.set(name, dir)
  }
}

/** 扫描一个目录下的直接子目录。 */
function scanDir(dir) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) addPackage(join(dir, entry.name))
  }
}

scanDir(join(HARNESS_ROOT, 'node_modules', '@deepseek-ai'))
scanDir(join(HARNESS_ROOT, 'vendor'))
const groupsDir = join(HARNESS_ROOT, 'packages')
if (existsSync(groupsDir)) {
  for (const group of readdirSync(groupsDir, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(join(groupsDir, group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      scanDir(join(groupsDir, group.name, pkg.name, 'node_modules', '@deepseek-ai'))
    }
  }
}

/** 转成 tsconfig 里的路径：同盘一律相对（可随仓库移动），跨盘才用绝对路径。 */
function targetPath(file) {
  const rel = relative(ROOT, file)
  if (isAbsolute(rel)) return file.replace(/\\/g, '/')
  const posix = rel.replace(/\\/g, '/')
  return posix.startsWith('..') ? posix : `./${posix}`
}

const paths = {}
for (const [name, dir] of [...packages].sort(([left], [right]) => left.localeCompare(right))) {
  const index = join(dir, 'src', 'index.ts')
  if (existsSync(index)) paths[name] = [targetPath(index)]
  // 子路径导出（`/types`、`/assistant-stream`、`/invariant` …）在源码里就是 src 下的同名文件。
  const src = join(dir, 'src')
  if (existsSync(src)) {
    paths[`${name}/*`] = [`${targetPath(src)}/*.ts`, `${targetPath(src)}/*/index.ts`]
  }
}

const doc = {
  $comment: '由 tools/gen-paths.mjs 生成，勿手改；`node tools/gen-paths.mjs --check` 校验是否为最新',
  extends: './tsconfig.json',
  compilerOptions: { paths },
}
const rendered = `${JSON.stringify(doc, null, 2)}\n`
const packageCount = [...packages.values()].filter(dir => existsSync(join(dir, 'src', 'index.ts'))).length

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current !== rendered) {
    console.error(`tsconfig.paths.json 不是最新（映射了 ${packageCount} 个包）：请运行 node tools/gen-paths.mjs`)
    process.exit(1)
  }
  console.log(`tsconfig.paths.json 已是最新（映射 ${packageCount} 个包）`)
} else {
  writeFileSync(OUT, rendered)
  console.log(`已写入 tsconfig.paths.json（映射 ${packageCount} 个包）`)
}
