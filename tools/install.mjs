/**
 * 把本插件安装进本机 dsh profile —— 幂等，可以随时重复跑。
 *
 * 为什么要一个脚本：改动之后"dsh 里跑的是不是最新代码"必须是一条命令能回答的问题。
 * 这里做四件事：
 *  1. 构建产物（`lib/index.js`，dsh 装载的就是它）；
 *  2. 确认 profile 里登记了本插件（依赖 + bundle 层）——没登记才让 dsh 去装；
 *  3. 校验 profile 的登记指向**本目录**（换了路径的旧登记要看得见）；
 *  4. 打印接下来要做什么（启用/重载）。
 *
 * 关于"改动之后要不要重新装"：
 *  - 本插件是 `link:` 安装，profile 里指向的是这个目录的软链，**代码改动不需要重新装**；
 *    重新构建产物即可，dsh 的 HMR 会在模块变化时重载，必要时重启 dsh。
 *  - 只有 `package.json` 的 `name` / `dsh.bundle` / `exports` 变了，才需要重新登记。
 *
 * 用法：
 *   node tools/install.mjs                 # 装到 DSH_PROFILE（默认 desktop）
 *   node tools/install.mjs --profile web   # 指定 profile
 *   node tools/install.mjs --check         # 只检查，不安装
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT } from './lib/harness.mjs'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const profileFlag = args.indexOf('--profile')
const profile = profileFlag === -1 ? (process.env.DSH_PROFILE ?? 'desktop') : args[profileFlag + 1]

if (profile === undefined || profile.length === 0) {
  console.error('用法：node tools/install.mjs [--profile <name>] [--check]')
  process.exit(2)
}

const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const pluginName = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).name
/** dsh 的 link 依赖用正斜杠写法。 */
const linkSpec = `link:${PLUGIN_ROOT.replace(/\\/g, '/')}`

if (!existsSync(manifestPath)) {
  console.error(`找不到 profile：${profileDir}`)
  console.error(`现有 profile 可用 --profile 指定，或先运行一次 dsh 让它初始化 ${profile}。`)
  process.exit(1)
}

/**
 * 读 profile 清单里的插件登记。
 * @returns 依赖声明与 bundle 层里是否各自登记了本插件。
 */
function registration() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dependency = manifest.dependencies?.[pluginName]
  const bundles = manifest.dsh?.profile?.bundles ?? []
  return { dependency, inBundles: bundles.includes(pluginName) }
}

// 1) 产物：dsh 装载的是 lib/index.js，永远是先构建再看登记。
console.log('== 构建产物 ==')
const build = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'tools', 'build.mjs')], {
  cwd: PLUGIN_ROOT,
  stdio: 'inherit',
})
if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1)

// 2) 登记：已登记且指向本目录就算装好，不必再跑 pnpm。
console.log(`\n== profile ${profile} 的登记 ==`)
const before = registration()
const pointsHere = typeof before.dependency === 'string'
  && before.dependency.toLowerCase() === linkSpec.toLowerCase()

if (pointsHere && before.inBundles) {
  console.log(`已登记：${pluginName} → ${before.dependency}（bundle 层已包含）`)
  console.log(checkOnly ? '检查通过。' : '无需重新安装。')
  process.exit(0)
}

if (pointsHere && !before.inBundles) {
  console.error(`依赖已指向本目录，但 profile 的 dsh.profile.bundles 里没有 ${pluginName}。`)
  console.error(`请在 ${manifestPath} 的 dsh.profile.bundles 数组里补上 "${pluginName}"。`)
  process.exit(1)
}

if (before.dependency !== undefined) {
  console.error(`profile 已登记 ${pluginName}，但指向的是 ${before.dependency}，不是本目录的 ${linkSpec}。`)
  console.error('这只会在插件被移动过时出现；确认无误后用 `dsh plugin --profile '
    + `${profile} add ${linkSpec}\` 覆盖登记。`)
  process.exit(1)
}

if (checkOnly) {
  console.error(`${pluginName} 尚未登记到 profile ${profile}。运行 node tools/install.mjs 安装。`)
  process.exit(1)
}

// 3) 交给官方 CLI：它会同时更新依赖与 bundle 层（实测两者都会写对）。
console.log(`安装：dsh plugin --profile ${profile} add ${linkSpec}`)
const install = spawnSync('dsh', ['plugin', '--profile', profile, 'add', linkSpec], {
  cwd: PLUGIN_ROOT,
  stdio: 'inherit',
  shell: true,
})
if ((install.status ?? 1) !== 0) {
  console.error('安装命令失败：请检查 dsh 是否在 PATH 上。')
  process.exit(install.status ?? 1)
}

const after = registration()
if (typeof after.dependency !== 'string' || !after.inBundles) {
  console.error(`安装命令已跑完，但 profile 里没有出现完整登记：依赖=${String(after.dependency)}，bundle=${after.inBundles}`)
  process.exit(1)
}

console.log(`\n已安装：${pluginName} → ${after.dependency}`)
console.log('接下来：dsh 里「设置 → 插件」启用它，或重启 dsh；运行中的 dsh 也可以在插件管理器里直接启用。')
