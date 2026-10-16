/**
 * 交付产物的装载测试：验证 `lib/index.js`（dsh 真正会去装载的东西）本身可用。
 *
 * 源码测试证明逻辑对，这一条证明**产物**能装进真实的 `llm` 服务并注册出 provider
 * —— 也就是"把目录交给 dsh 之后会发生什么"。产物里的 `@deepseek-ai/*` 是外部依赖，
 * 由加载钩子解析到 DSH 源码（与 dsh 运行时提供它们等价）。
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/** 本仓库根目录（从测试文件位置回退两级）。 */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BUNDLE = join(PLUGIN_ROOT, 'lib', 'index.js')

test('产物自包含：不 import 任何宿主包（dsh 从插件目录解析不到它们）', () => {
  assert.ok(statSync(BUNDLE).size > 1000, 'lib/index.js 应已构建')
  const source = readFileSync(BUNDLE, 'utf8')
  // 只有 `node:` 内置模块与相对路径允许出现；任何裸包名都会让 dsh 装载失败。
  const bareImports = source.split('\n')
    .filter(line => /^\s*import\b[\s\S]*from\s+['"](?!node:|\.)/.test(line))
  assert.deepEqual(bareImports, [], `产物不得有裸 import：${bareImports.join(' | ')}`)
  assert.doesNotMatch(source, /@deepseek-ai\//, '产物里不应出现宿主包名')
  assert.doesNotMatch(source, /\brequire\(/, '产物不应留有 CommonJS require')
})

test('产物装载后注册出 strata provider，并能完成一次真实调用的端到端装配', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    response.write(chunk({ role: 'assistant', content: '' }))
    response.write(chunk({ content: '本地模型' }))
    response.write(chunk({}, 'stop'))
    response.write('data: [DONE]\n\n')
    response.end()
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo

  try {
    const plugin = await import(pathToFileURL(BUNDLE).href)
    assert.equal(plugin.name, 'llm-strata')
    assert.deepEqual(plugin.inject, ['llm'])
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(plugin.Config, undefined, '产物不导出 Config 模式：校验集中在 resolveConfig 里')

    // yml 里的 config 由 Loader 原样交给 apply。
    const config = { baseURL: `http://127.0.0.1:${port}/v1`, model: 'qwen3.6-35b-a3b-ud-q4_k_xl' }
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    plugin.apply(ctx, config)
    assert.deepEqual(ctx.llm.listProviders(), [{ id: 'strata', name: 'Strata（本机 HIP 推理）' }])

    const text: string[] = []
    for await (const item of ctx.llm.stream({
      provider: 'strata',
      model: config.model,
      messages: [],
    })) {
      if (item.type === 'text-delta') text.push(item.text)
    }
    assert.deepEqual(text, ['本地模型'])
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)))
    })
  }
})

test('产物装载后把三个托管工具注册进主对话的工具表', async () => {
  const ctx = new Context()
  // 工具注册表依赖 systemPrompt，进程托管依赖 subprocess：两者齐了插件才会注册工具。
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LlmRuntime)

  const plugin = await import(pathToFileURL(BUNDLE).href)
  // 端点指向没人监听的端口：这条只验装载与注册，不验连通。
  plugin.apply(ctx, { baseURL: 'http://127.0.0.1:1/v1', autoStart: false })

  let tools: ToolRuntime | undefined
  await ctx.plugin({
    name: 'inspect-tools',
    inject: ['tools'],
    apply(scoped) { tools = scoped.tools },
  })
  assert.ok(tools !== undefined, 'tools 服务应当已装载')
  const names = tools.schemas().map(schema => schema.name).filter(name => name.startsWith('strata_')).sort()
  assert.deepEqual(names, ['strata_serve', 'strata_status', 'strata_stop'])
})

test('缺少 subprocess 时插件照常提供 provider，只是不注册托管工具', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)

  const plugin = await import(pathToFileURL(BUNDLE).href)
  plugin.apply(ctx, { baseURL: 'http://127.0.0.1:1/v1' })
  assert.deepEqual(ctx.llm.listProviders(), [{ id: 'strata', name: 'Strata（本机 HIP 推理）' }])

  let tools: ToolRuntime | undefined
  await ctx.plugin({
    name: 'inspect-tools-again',
    inject: ['tools'],
    apply(scoped) { tools = scoped.tools },
  })
  assert.ok(tools !== undefined)
  const names = tools.schemas().map(schema => schema.name).filter(name => name.startsWith('strata_'))
  assert.deepEqual(names, [], '没有 subprocess 就不该注册托管工具')
})
