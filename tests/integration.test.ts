/**
 * 端到端契约测试：本插件 + **真实的** DSH `LlmRuntime` + 真实 `BlockAssembler`，
 * 对面是一个本地桩服务（不是 mock 出来的适配器）。
 *
 * 为什么不用假的 provider：插件唯一的风险点就是"它是否符合 harness 的适配器契约"。
 * 这里让请求真的经过 `LlmRuntime` 的注册表、失败规范化、块装配，因此下面每条断言
 * 成立的都意味着"dsh 能从这条路由拿到它期望的东西"。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { StrataAdapter } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'
import { apply } from '../src/index.ts'

/** 桩服务收到的一次请求。 */
interface StubRequest {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: any
}

/** 桩服务要回的内容。 */
interface StubReply {
  status?: number
  contentType?: string
  /** 按顺序写出的原始字节分片——故意切碎，用来证明 SSE 解析不依赖分片边界。 */
  frames: string[]
}

interface Stub {
  baseURL: string
  requests: StubRequest[]
  /** 只取对话补全请求。 */
  chats: () => StubRequest[]
  close: () => Promise<void>
}

/**
 * 起一个本地桩服务。
 * @param respond - 按请求产生回复。
 * @returns 桩服务的基址、收到的请求与关闭函数。
 */
async function startStub(respond: (request: StubRequest) => StubReply): Promise<Stub> {
  const requests: StubRequest[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (piece) => { raw += piece })
    request.on('end', () => {
      const recorded: StubRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
      }
      requests.push(recorded)
      const reply = respond(recorded)
      response.writeHead(reply.status ?? 200, {
        'content-type': reply.contentType ?? 'text/event-stream',
        'cache-control': 'no-cache',
      })
      for (const frame of reply.frames) response.write(frame)
      response.end()
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    chats: () => requests.filter(request => request.url.endsWith('/chat/completions')),
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

/** 一帧 OpenAI 兼容的 SSE 文本。 */
function sse(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-stub',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

/** 建一个装了真实 LlmRuntime 与真实插件入口的上下文。 */
async function contextWith(baseURL: string, config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  apply(ctx, { baseURL, model: 'qwen3.6-35b-a3b-ud-q4_k_xl', ...config })
  return ctx
}

/** 收集一条流，并返回装配后的助手消息。 */
async function drain(ctx: Context, options: GenerateOptions): Promise<{ chunks: StreamChunk[]; assembler: BlockAssembler }> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return { chunks, assembler }
}

function userMessage(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

test('一次完整对话：真实 LlmRuntime 装配出助手消息，请求形状符合服务契约', async () => {
  const stub = await startStub(() => ({
    frames: [
      // 分片故意切在 JSON 中间与 UTF-8 中间。
      sse({ role: 'assistant', content: '' }).slice(0, 40),
      sse({ role: 'assistant', content: '' }).slice(40),
      ': keep-alive\n\n',
      sse({ content: '你' }).slice(0, 30),
      sse({ content: '你' }).slice(30) + sse({ content: '好' }),
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 18, completion_tokens: 2, total_tokens: 20 } }) + '\n\n',
      sse({}, 'stop'),
      'data: [DONE]\n\n',
    ],
  }))
  try {
    const ctx = await contextWith(stub.baseURL)
    const { assembler } = await drain(ctx, {
      provider: 'strata',
      model: 'qwen3.6-35b-a3b-ud-q4_k_xl',
      messages: [userMessage('用一句话自我介绍')],
    })
    assert.deepEqual(assembler.blocks(), [{ type: 'text', text: '你好' }])
    assert.deepEqual(assembler.finish, { kind: 'stop' })
    assert.deepEqual(assembler.usage, { inputTokens: 18, outputTokens: 2, totalTokens: 20 })

    const [chat] = stub.chats()
    assert.ok(chat !== undefined, '桩服务应收到一次对话补全请求')
    assert.equal(chat.url, '/v1/chat/completions')
    assert.equal(chat.body.model, 'qwen3.6-35b-a3b-ud-q4_k_xl')
    assert.equal(chat.body.stream, true)
    // 交接文档 3.5：不传 reasoning_effort 会把预算全烧在思考通道上。
    assert.equal(chat.body.reasoning_effort, 'none')
    assert.deepEqual(chat.body.messages, [{ role: 'user', content: '用一句话自我介绍' }])
    assert.equal(chat.body.max_tokens, 8192)
    // 归因头是 harness 对适配器的硬性要求。
    assert.match(String(chat.headers['user-agent']), /deepseek-harness/)
    assert.equal(chat.headers.authorization, 'Bearer local')
    assert.match(String(chat.headers['content-type']), /application\/json/)
  } finally {
    await stub.close()
  }
})

test('工具调用闭环：服务吐 tool_calls，结果回传时是独立的 role=tool 消息', async () => {
  const stub = await startStub(request => request.body?.messages?.some((message: { role: string }) => message.role === 'tool') === true
    ? { frames: [sse({ content: '北京晴朗 18℃' }), sse({}, 'stop'), 'data: [DONE]\n\n'] }
    : {
      frames: [
        sse({ tool_calls: [{ index: 0, id: 'call_54fd76ebaacd49e0981cac60', function: { name: 'get_weather', arguments: '' } }] }),
        sse({ tool_calls: [{ index: 0, function: { arguments: '{"city":"\\u5317\\u4eac"}' } }] }),
        sse({}, 'tool_calls'),
        'data: [DONE]\n\n',
      ],
    })
  try {
    const ctx = await contextWith(stub.baseURL)
    const tools = [{ name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: {} } }]
    const first = await drain(ctx, {
      provider: 'strata',
      model: 'qwen3.6-35b-a3b-ud-q4_k_xl',
      messages: [userMessage('北京天气如何')],
      tools,
    })
    assert.deepEqual(first.assembler.finish, { kind: 'tool-calls' })
    const call = first.assembler.blocks()[0]
    assert.ok(call !== undefined && call.type === 'tool-call')
    assert.equal(call.name, 'get_weather')
    assert.equal(call.arguments, '{"city":"\\u5317\\u4eac"}')
    assert.equal(stub.chats()[0]?.body.tools?.[0]?.function?.name, 'get_weather')
    assert.equal(stub.chats()[0]?.body.tool_choice, 'auto')

    const toolResult = createToolResultMessage({
      callId: brandString<ToolCallId>(call.id),
      content: [{ type: 'text', text: '18℃ 晴朗' }],
      isError: false,
    })
    const second = await drain(ctx, {
      provider: 'strata',
      model: 'qwen3.6-35b-a3b-ud-q4_k_xl',
      messages: [userMessage('北京天气如何'), first.assembler.message(), toolResult],
      tools,
    })
    assert.deepEqual(second.assembler.blocks(), [{ type: 'text', text: '北京晴朗 18℃' }])
    const sent = stub.chats()[1]?.body.messages ?? []
    assert.deepEqual(sent[1], {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_54fd76ebaacd49e0981cac60',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"\\u5317\\u4eac"}' },
      }],
    })
    assert.deepEqual(sent[2], { role: 'tool', tool_call_id: 'call_54fd76ebaacd49e0981cac60', content: '18℃ 晴朗' })
  } finally {
    await stub.close()
  }
})

test('思考烧完预算（content 为 null + finish_reason=length）不被当成空回复', async () => {
  const stub = await startStub(() => ({
    frames: [
      sse({ reasoning_content: '我先想想' }),
      sse({ reasoning_content: '……还是没想完' }, 'length'),
      'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 512, total_tokens: 524 } }) + '\n\n',
      'data: [DONE]\n\n',
    ],
  }))
  try {
    const ctx = await contextWith(stub.baseURL)
    const { assembler } = await drain(ctx, {
      provider: 'strata',
      model: 'qwen3.6-35b-a3b-ud-q4_k_xl',
      messages: [userMessage('难问题')],
    })
    assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: '我先想想……还是没想完' }])
    assert.deepEqual(assembler.finish, { kind: 'max-tokens' })
  } finally {
    await stub.close()
  }
})

test('服务返回 5xx：失败被规范化为 error 完成原因并带上状态码与响应原文', async () => {
  const stub = await startStub(() => ({
    status: 500,
    contentType: 'application/json',
    frames: ['{"error":"engine crashed"}'],
  }))
  try {
    const ctx = await contextWith(stub.baseURL)
    const { chunks, assembler } = await drain(ctx, {
      provider: 'strata',
      model: 'qwen3.6-35b-a3b-ud-q4_k_xl',
      messages: [userMessage('hi')],
    })
    assert.deepEqual(assembler.finish.kind, 'error')
    assert.equal(chunks.at(-1)?.type, 'finish')
    const failure = JSON.stringify(assembler.finish)
    assert.match(failure, /engine crashed/)
    assert.match(failure, /500/)
  } finally {
    await stub.close()
  }
})

test('服务不可达：失败被规范化为 error，且不抛出到调用方之外', async () => {
  const stub = await startStub(() => ({ frames: [] }))
  const deadURL = stub.baseURL
  await stub.close()
  const ctx = await contextWith(deadURL)
  const { assembler } = await drain(ctx, {
    provider: 'strata',
    model: 'qwen3.6-35b-a3b-ud-q4_k_xl',
    messages: [userMessage('hi')],
  })
  assert.equal(assembler.finish.kind, 'error')
})

test('装载路径：注册出的 provider 出现在 llm 注册表里，且能解析模型元数据', async () => {
  const stub = await startStub(() => ({ frames: [] }))
  try {
    const ctx = await contextWith(stub.baseURL, { contextWindow: 65536 })
    assert.deepEqual(ctx.llm.listProviders(), [{ id: 'strata', name: 'Strata（本机 HIP 推理）' }])
    const model = await ctx.llm.resolveModelInfo('strata', 'qwen3.6-35b-a3b-ud-q4_k_xl')
    assert.deepEqual(model.context, { contextWindow: 65536 })
    assert.deepEqual(model.inputModalities, ['text'])
    assert.equal(model.reasoning?.defaultEffort, 'none')
    assert.deepEqual(model.reasoning?.efforts.map(effort => effort.id), ['none', 'low', 'medium', 'high'])
  } finally {
    await stub.close()
  }
})

test('模型目录：读服务的 /v1/models，失败时回落到配置值', async () => {
  const stub = await startStub(() => ({
    contentType: 'application/json',
    frames: [JSON.stringify({
      object: 'list',
      data: [{ id: 'qwen3.6-35b-a3b-ud-q4_k_xl', object: 'model', status: { value: 'loaded' }, meta: { n_ctx: 65536 } }],
    })],
  }))
  try {
    const ctx = await contextWith(stub.baseURL)
    assert.deepEqual(await ctx.llm.listModels('strata'), [{
      provider: 'strata',
      id: 'qwen3.6-35b-a3b-ud-q4_k_xl',
      name: 'qwen3.6-35b-a3b-ud-q4_k_xl',
      description: '上下文 65536',
      inputModalities: ['text'],
    }])
  } finally {
    await stub.close()
  }
})

test('适配器也可以不经插件入口直接注册（组件可独立使用）', async () => {
  const stub = await startStub(() => ({ frames: [sse({ content: 'ok' }), sse({}, 'stop'), 'data: [DONE]\n\n'] }))
  try {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['strata'], new StrataAdapter({
      resolveFacts: () => resolveConfig({ baseURL: stub.baseURL }),
    }))
    const { assembler } = await drain(ctx, { provider: 'strata', model: 'm', messages: [userMessage('hi')] })
    assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'ok' }])
  } finally {
    await stub.close()
  }
})
