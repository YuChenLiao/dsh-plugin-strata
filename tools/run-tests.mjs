/**
 * 本仓库的验证入口：把"能工作"拆成可执行、可复现的三段。
 *
 *   1. 映射表最新    —— `tsconfig.paths.json` 与 DSH 源码树一致（否则类型检查等于没查）。
 *   2. 类型检查      —— `tsc` 对着 DSH 的**真实契约源码**检查本插件的 `src/` 与 `tests/`。
 *   3. 契约与端到端  —— `node --test` 跑全部测试；端到端用例用真实的 `LlmRuntime`
 *                       加一个本地桩服务，覆盖请求体、SSE 分帧、工具调用与失败规范化。
 *
 * 类型检查对"依赖侧报错"的处理是显式的，不隐藏：
 * DSH 用 TypeScript project references 让每个包（含 `vendor/`）按**自己的** tsconfig
 * 编译；本工程把这些源码扁平拉进一个 program，因此 `vendor/cordis` 一类按宽设置编译的
 * 文件会报错。本层的门禁是**本仓库源文件零错误**，依赖侧只计数并打印——它的编译设置
 * 由 DSH 自己的门禁负责，不是这一层能改的。
 *
 * 用法：`node tools/run-tests.mjs [--only=check|types|tests]`
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, SOURCE_LOADER_ARGS, TSC_BIN } from './lib/harness.mjs'

const only = process.argv.find(argument => argument.startsWith('--only='))?.slice('--only='.length)
const wants = name => only === undefined || only === name

/** 逐段执行：名称、命令、参数、失败时的说明。 */
let failed = 0

/**
 * 跑一个同步子进程步骤。
 * @param {string} title - 步骤名。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {{ capture?: boolean }} [options] - `capture` 时收集输出而不是直接继承。
 * @returns {{ status: number, output: string }} 退出码与（捕获到的）输出。
 */
function run(title, command, args, options = {}) {
  console.log(`\n===== ${title} =====`)
  const result = spawnSync(command, args, {
    cwd: PLUGIN_ROOT,
    encoding: 'utf8',
    stdio: options.capture === true ? 'pipe' : 'inherit',
  })
  const output = options.capture === true ? `${result.stdout ?? ''}${result.stderr ?? ''}` : ''
  return { status: result.status ?? 1, output }
}

// 1) 映射表与产物都必须与源码一致——否则后面的检查查的不是当前这棵代码。
if (wants('check')) {
  for (const [title, script] of [
    ['映射表（tsconfig.paths.json）', 'gen-paths.mjs'],
    ['产物（lib/index.js 与源码一致）', 'build.mjs'],
  ]) {
    const result = run(title, process.execPath, [join(PLUGIN_ROOT, 'tools', script), '--check'], { capture: true })
    process.stdout.write(result.output)
    if (result.status !== 0) failed += 1
  }
}

// 2) 类型检查：门禁只对本仓库的文件。
if (wants('types')) {
  const result = run('类型检查（tsc，对象为 DSH 源码契约）', process.execPath, [TSC_BIN, '--noEmit', '-p', join(PLUGIN_ROOT, 'tsconfig.paths.json')], { capture: true })
  const errors = result.output.split('\n').filter(line => line.includes('error TS'))
  const own = errors.filter(line => /^\.?\/?(src|tests)[\\/]/.test(line))
  const dependency = errors.length - own.length
  console.log(`Diagnostics 总数 ${errors.length}：本仓库 ${own.length}，依赖源码（DSH vendor/packages）${dependency}`)
  if (dependency > 0) {
    console.log('依赖源码的诊断不由本层判定（它们按各自 tsconfig 编译）；若数量变化，说明 DSH 源码树或映射表变了。')
  }
  for (const line of own) console.log(line)
  if (own.length > 0) {
    console.error(`本仓库有 ${own.length} 处类型错误。`)
    failed += 1
  } else {
    console.log('本仓库 src/ 与 tests/ 无类型错误。')
  }
}

// 3) 全部测试。
if (wants('tests')) {
  const testsDir = join(PLUGIN_ROOT, 'tests')
  const files = existsSync(testsDir)
    ? readdirSync(testsDir).filter(name => name.endsWith('.test.ts')).sort().map(name => join(testsDir, name))
    : []
  if (files.length === 0) {
    console.error('找不到任何 tests/*.test.ts。')
    failed += 1
  } else {
    const result = run(`测试（${files.length} 个文件）`, process.execPath, [...SOURCE_LOADER_ARGS, '--test', ...files])
    if (result.status !== 0) failed += 1
  }
}

if (failed > 0) {
  console.error(`\n${failed} 段验证未通过。`)
  process.exit(1)
}
console.log('\n全部验证通过。')
