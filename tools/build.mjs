/**
 * 打包插件产物：`src/index.ts` → `lib/index.js`（单个**自包含**的 ESM 文件）。
 *
 * 为什么必须自包含：dsh 装载第三方插件时，模块解析从插件的真实目录开始，而那个目录
 * 不在宿主的 `node_modules` 解析路径上——产物里只要有一句裸 import（哪怕是
 * `@deepseek-ai/dsh-llm`），装载就会以 "failed to import" 失败。本机已装的
 * `dsh-ops`（github 装法）与 `dsh-plugin-structured-prompt`（link 装法）的产物都是
 * 零 import 的：这是 dsh 插件的形态约定，不是本插件的怪癖。
 *
 * 因此 esbuild **不设 external**；宿主契约由 `src/host.ts` 收敛成最小自实现。
 *
 * esbuild 借自 DSH 源码树的依赖环境（本工程不安装依赖）。
 *
 * 用法：`node tools/build.mjs [--check]`
 *   --check 只校验产物是否与源码一致（验证链用），不写文件。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PLUGIN_ROOT, resolveEsbuild } from './lib/harness.mjs'

const OUT = join(PLUGIN_ROOT, 'lib', 'index.js')
const require = createRequire(import.meta.url)
const esbuild = require(resolveEsbuild())

const result = await esbuild.build({
  entryPoints: [join(PLUGIN_ROOT, 'src', 'index.ts')],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  banner: {
    js: '// 由 tools/build.mjs 生成（esbuild 打包 src/index.ts）；勿手改。'
      + ' 本文件自包含：不 import 任何宿主包。',
  },
  write: !process.argv.includes('--check'),
})

if (process.argv.includes('--check')) {
  // esbuild 的 write:false 会把产物放进 outputFiles；比对是否与磁盘上的一致。
  const inMemory = result.outputFiles?.[0]?.text ?? ''
  const onDisk = (() => {
    try {
      return readFileSync(OUT, 'utf8')
    } catch {
      return ''
    }
  })()
  if (inMemory !== onDisk) {
    console.error('lib/index.js 不是最新：请运行 node tools/build.mjs')
    process.exit(1)
  }
  console.log('lib/index.js 已是最新')
} else {
  console.log(`已写入 lib/index.js（${readFileSync(OUT, 'utf8').length} 字节）`)
}
