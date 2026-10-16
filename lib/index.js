// 由 tools/build.mjs 生成（esbuild 打包 src/index.ts）；勿手改。 本文件自包含：不 import 任何宿主包。

// src/host.ts
var USER_AGENT = "deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)";
function attributionHeaders() {
  return { "user-agent": USER_AGENT };
}
var StrataError = class extends Error {
  /** 稳定的机器可读错误码（自有数据属性）。 */
  code;
  /** 与 {@link code} 一致的失败事实（自有数据属性）。 */
  failure;
  /**
   * @param message - 面向人的失败说明，不能为空。
   * @param code - 稳定的机器可读错误码，不能为空。
   * @param options - 可选的 HTTP 状态与原始异常。
   */
  constructor(message, code, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    if (message.length === 0) throw new Error("StrataError message must be a non-empty string");
    if (code.length === 0) throw new Error("StrataError code must be a non-empty string");
    this.name = "StrataError";
    this.code = code;
    this.failure = Object.freeze({
      message,
      code,
      ...options.status === void 0 ? {} : { status: options.status }
    });
  }
};
function defineTool(definition) {
  return definition;
}

// src/config.ts
var DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
var DEFAULT_CONTEXT_WINDOW = 65536;
var DEFAULT_MAX_TOKENS = 8192;
var DEFAULT_REASONING_EFFORT = "none";
var DEFAULT_REQUEST_TIMEOUT_MS = 6e5;
var DEFAULT_READY_TIMEOUT_MS = 18e4;
var DEFAULT_IDLE_SHUTDOWN_MS = 3e5;
var DEFAULT_AUTO_START = true;
var REASONING_EFFORTS = ["none", "low", "medium", "high"];
function resolveConfig(config, port) {
  const baseURL = (config.baseURL ?? (port === void 0 ? DEFAULT_BASE_URL : `http://127.0.0.1:${port}/v1`)).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseURL)) {
    throw new Error(`strata: baseURL \u5FC5\u987B\u662F http(s) \u7EDD\u5BF9\u5730\u5740\uFF0C\u6536\u5230 "${config.baseURL}"`);
  }
  const model = config.model;
  if (model !== void 0 && (typeof model !== "string" || model.length === 0)) {
    throw new Error("strata: model \u82E5\u7ED9\u5C31\u5FC5\u987B\u662F\u975E\u7A7A\u5B57\u7B26\u4E32");
  }
  const apiKey = config.apiKey ?? "local";
  const contextWindow = config.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    throw new Error("strata: contextWindow \u5FC5\u987B\u662F\u6B63\u6574\u6570");
  }
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("strata: maxTokens \u5FC5\u987B\u662F\u6B63\u6574\u6570");
  }
  const reasoningEffort = config.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  if (!REASONING_EFFORTS.includes(reasoningEffort)) {
    const widened = reasoningEffort;
    throw new Error(`strata: reasoningEffort \u5FC5\u987B\u662F ${REASONING_EFFORTS.join(" / ")} \u4E4B\u4E00\uFF0C\u6536\u5230 "${widened}"`);
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("strata: requestTimeoutMs \u5FC5\u987B\u662F\u6B63\u6574\u6570\u6BEB\u79D2");
  }
  const serveCommand = config.serveCommand !== void 0 && config.serveCommand.length > 0 ? config.serveCommand : void 0;
  if (serveCommand !== void 0 && serveCommand.some((segment) => typeof segment !== "string" || segment.length === 0)) {
    throw new Error("strata: serveCommand \u5FC5\u987B\u662F\u975E\u7A7A\u7684\u5B57\u7B26\u4E32\u6570\u7EC4\uFF08argv[0] \u4E3A\u53EF\u6267\u884C\u6587\u4EF6\uFF09");
  }
  const readyTimeoutMs = config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new Error("strata: readyTimeoutMs \u5FC5\u987B\u662F\u6B63\u6574\u6570\u6BEB\u79D2");
  }
  const idleShutdownMs = config.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  if (!Number.isSafeInteger(idleShutdownMs) || idleShutdownMs < 0) {
    throw new Error("strata: idleShutdownMs \u5FC5\u987B\u662F\u975E\u8D1F\u6574\u6570\u6BEB\u79D2\uFF080 \u8868\u793A\u4E0D\u81EA\u52A8\u505C\u6B62\uFF09");
  }
  const autoStart = config.autoStart ?? DEFAULT_AUTO_START;
  if (typeof autoStart !== "boolean") throw new Error("strata: autoStart \u5FC5\u987B\u662F\u5E03\u5C14\u503C");
  return {
    baseURL,
    ...model === void 0 ? {} : { model },
    apiKey,
    contextWindow,
    maxTokens,
    reasoningEffort,
    requestTimeoutMs,
    ...serveCommand === void 0 ? {} : { serveCommand: [...serveCommand] },
    readyTimeoutMs,
    idleShutdownMs,
    autoStart
  };
}

// src/models.ts
function readListing(body) {
  if (typeof body !== "object" || body === null) return [];
  const data = body.data;
  if (!Array.isArray(data)) return [];
  return data.filter((entry) => typeof entry === "object" && entry !== null && typeof entry.id === "string");
}
function isLoaded(entries) {
  return entries.some((entry) => entry.status?.value === "loaded");
}
async function fetchListing(baseURL, headers, signal) {
  let response;
  try {
    response = await fetch(`${baseURL}/models`, { method: "GET", headers, ...signal === void 0 ? {} : { signal } });
  } catch (error) {
    throw new StrataError(`strata: \u65E0\u6CD5\u8FDE\u63A5 ${baseURL}\uFF08${describe(error)}\uFF09`, "TRANSPORT", { cause: error });
  }
  if (!response.ok) {
    throw new StrataError(`strata: GET /models \u8FD4\u56DE HTTP ${response.status}`, "HTTP_STATUS", { status: response.status });
  }
  return readListing(await response.json());
}
function describe(error) {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
  return String(error);
}

// src/sse.ts
var DONE = "[DONE]";
function consumeLine(line, data) {
  if (line.length === 0) {
    if (data.length === 0) return void 0;
    const payload = data.join("\n");
    data.length = 0;
    return payload;
  }
  if (line.startsWith(":")) return void 0;
  const colon = line.indexOf(":");
  const field = colon === -1 ? line : line.slice(0, colon);
  if (field !== "data") return void 0;
  let value = colon === -1 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  data.push(value);
  return void 0;
}
async function* parseSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const data = [];
  let buffer = "";
  let done = false;
  try {
    while (!done) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const payload = consumeLine(buffer.slice(0, newline).replace(/\r$/, ""), data);
        buffer = buffer.slice(newline + 1);
        if (payload !== void 0) {
          if (payload === DONE) {
            done = true;
            break;
          }
          yield payload;
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (!done) {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        const payload = consumeLine(buffer.replace(/\r$/, ""), data);
        if (payload === DONE) {
          done = true;
        } else if (payload !== void 0) {
          yield payload;
        }
      }
    }
  } finally {
    if (done) await reader.cancel().catch(() => void 0);
  }
  if (!done) throw new StrataError("SSE \u6D41\u5728\u6536\u5230 [DONE] \u4E4B\u524D\u7ED3\u675F", "STREAM_CLOSED");
}

// src/translate.ts
function mapFinishReason(reason) {
  switch (reason) {
    case "length":
      return { kind: "max-tokens" };
    case "tool_calls":
    case "function_call":
      return { kind: "tool-calls" };
    default:
      return { kind: "stop" };
  }
}
function mapUsage(usage) {
  const input = usage?.prompt_tokens;
  const output = usage?.completion_tokens;
  if (typeof input !== "number" || typeof output !== "number") return void 0;
  const total = usage?.total_tokens;
  return {
    inputTokens: input,
    outputTokens: output,
    ...typeof total === "number" ? { totalTokens: total } : {}
  };
}
var StreamTranslator = class {
  blocks = /* @__PURE__ */ new Map();
  toolBlocks = /* @__PURE__ */ new Map();
  active;
  nextIndex = 0;
  sawFinish = false;
  usageValue;
  timingsValue;
  /**
   * 翻译一个数据帧。
   * @param payload - SSE 的 `data` 负载（一段 JSON 文本）。
   * @returns 该帧产生的 chunk，顺序即块顺序。
   */
  push(payload) {
    const chunk = JSON.parse(payload);
    const out = [];
    if (chunk.timings !== void 0) this.timingsValue = chunk.timings;
    const choice = chunk.choices?.[0];
    if (choice !== void 0) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        const block = this.openText("reasoning", out);
        block.text += reasoning;
        out.push({ type: "reasoning-delta", index: block.index, text: reasoning });
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        const block = this.openText("text", out);
        block.text += content;
        out.push({ type: "text-delta", index: block.index, text: content });
      }
      for (const call of delta?.tool_calls ?? []) out.push(...this.toolDelta(call, out));
      const reason = choice.finish_reason;
      if (typeof reason === "string" && reason.length > 0) {
        this.closeAll(out);
        out.push({ type: "finish", reason: mapFinishReason(reason) });
        this.sawFinish = true;
      }
    }
    if (chunk.usage !== void 0) {
      const usage = mapUsage(chunk.usage);
      if (usage !== void 0) {
        this.usageValue = usage;
        out.push({ type: "usage", usage });
      }
    }
    return out;
  }
  /**
   * 流结束时冲刷：服务没有给出 `finish_reason` 时补齐块收尾与完成原因，
   * 保证消费者拿到的流一定以 `finish` 结束。
   * @returns 剩余 chunk；流已经正常结束时为空。
   */
  end() {
    if (this.sawFinish) return [];
    const out = [];
    this.closeAll(out);
    out.push({ type: "finish", reason: { kind: "stop" } });
    this.sawFinish = true;
    return out;
  }
  /** 已经收到 `finish_reason`。 */
  get finished() {
    return this.sawFinish;
  }
  /** 这一条响应的 token 用量（服务未提供时为 `undefined`）。 */
  get usage() {
    return this.usageValue;
  }
  /** 服务在响应里报告的最后一份 timings（性能观测用，可能为 `undefined`）。 */
  get timings() {
    return this.timingsValue;
  }
  /** 取（必要时新建）当前类型的活动文本块，切换类型时先收尾旧块。 */
  openText(kind, out) {
    if (this.active !== void 0 && this.active.kind === kind) return this.active;
    this.closeActive(out);
    const block = { kind, index: this.nextIndex++, text: "" };
    this.blocks.set(block.index, block);
    this.active = block;
    out.push({ type: "block-start", index: block.index, blockType: kind });
    return block;
  }
  /** 翻译一个工具调用的分片。 */
  toolDelta(call, out) {
    const toolIndex = call.index ?? 0;
    let blockIndex = this.toolBlocks.get(toolIndex);
    if (blockIndex === void 0) {
      this.closeActive(out);
      const block2 = {
        kind: "tool-call",
        index: this.nextIndex++,
        // 服务在首个分片给出调用 id；缺失时给一个确定性的兜底 id，绝不发空洞。
        id: call.id ?? `call-${toolIndex}`,
        name: call.function?.name ?? "",
        args: ""
      };
      this.blocks.set(block2.index, block2);
      this.toolBlocks.set(toolIndex, block2.index);
      blockIndex = block2.index;
      out.push({ type: "block-start", index: blockIndex, blockType: "tool-call" });
    }
    const block = this.blocks.get(blockIndex);
    if (block === void 0 || block.kind !== "tool-call") {
      throw new Error(`strata: \u5DE5\u5177\u5757 ${blockIndex} \u4E0D\u5728\u7D2F\u79EF\u8868\u91CC`);
    }
    if (call.id !== void 0 && call.id.length > 0) block.id = call.id;
    const name2 = call.function?.name;
    if (name2 !== void 0 && name2.length > 0) block.name = name2;
    const argumentsDelta = call.function?.arguments ?? "";
    block.args += argumentsDelta;
    return [{
      type: "tool-call-delta",
      index: blockIndex,
      id: block.id,
      ...name2 === void 0 || name2.length === 0 ? {} : { name: name2 },
      argumentsDelta
    }];
  }
  /** 收尾活动文本块（若有）。 */
  closeActive(out) {
    const active = this.active;
    if (active === void 0) return;
    out.push({ type: "block-end", index: active.index, block: assemble(active) });
    this.active = void 0;
  }
  /** 收尾全部未关闭的块，按块序号升序。 */
  closeAll(out) {
    this.closeActive(out);
    const open = [...this.blocks.values()].filter((block) => block.kind === "tool-call").sort((left, right) => left.index - right.index);
    for (const block of open) {
      out.push({ type: "block-end", index: block.index, block: assemble(block) });
      this.blocks.delete(block.index);
    }
  }
};
function assemble(block) {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return { type: "tool-call", id: block.id, name: block.name, arguments: block.args };
  }
}

// src/wire.ts
function textOf(blocks) {
  let text = "";
  for (const block of blocks) {
    if (block.type === "text") text += block.text;
  }
  return text;
}
function translateMessage(message) {
  if (message.role === "system") {
    const text = textOf(message.content);
    return text.length === 0 ? [] : [{ role: "system", content: text }];
  }
  if (message.role === "assistant") {
    const text = textOf(message.content);
    const calls = [];
    for (const block of message.content) {
      if (block.type === "tool-call") {
        calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments } });
      }
    }
    return [{
      role: "assistant",
      content: text.length === 0 ? null : text,
      ...calls.length === 0 ? {} : { tool_calls: calls }
    }];
  }
  const results = message.content.filter((block) => block.type === "tool-result");
  if (results.length > 0) {
    return results.map((block) => ({
      role: "tool",
      tool_call_id: block.toolCallId,
      content: textOf(block.content)
    }));
  }
  return [{ role: "user", content: textOf(message.content) }];
}
function buildChatRequest(options, facts) {
  const messages = [];
  if (options.system !== void 0 && options.system.length > 0) {
    messages.push({ role: "system", content: options.system });
  }
  for (const message of options.messages) messages.push(...translateMessage(message));
  const tools = translateTools(options.tools);
  const maxTokens = options.maxTokens ?? facts.maxTokens;
  return {
    // 模型 id 来自调用方（也就是 dsh 的模型选择器，其列表由服务的 /v1/models 决定）；
    // 配置里的 `model` 只在部署方明确想覆盖时才生效。
    model: facts.model ?? options.model,
    messages,
    stream: true,
    // 显式带上：不传会把 max_tokens 全烧在思考通道上（交接文档 3.5）。
    reasoning_effort: facts.reasoningEffort,
    ...tools.length === 0 ? {} : { tools, tool_choice: "auto" },
    ...options.temperature === void 0 ? {} : { temperature: options.temperature },
    ...maxTokens === void 0 ? {} : { max_tokens: maxTokens },
    ...options.stop === void 0 || options.stop.length === 0 ? {} : { stop: [...options.stop] }
  };
}
function translateTools(tools) {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }));
}

// src/adapter.ts
var ERROR_BODY_CHARS = 400;
var CATALOG_TTL_MS = 5e3;
var StrataAdapter = class {
  resolveFacts;
  fetchImpl;
  log;
  ensureServed;
  touch;
  /** 后端模型目录的短缓存（见 `catalog`）。 */
  catalogCache;
  /**
   * @param options - 事实解析器、可选 fetch 注入、日志与托管钩子。
   */
  constructor(options) {
    this.resolveFacts = options.resolveFacts;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log;
    this.ensureServed = options.ensureServed;
    this.touch = options.touch;
  }
  /**
   * 描述这条路由。
   * @param provider - 注册时传入的 provider 名。
   * @returns provider 元数据（id 必须等于传入值）。
   */
  providerInfo(provider) {
    return { id: provider, name: "Strata\uFF08\u672C\u673A HIP \u63A8\u7406\uFF09" };
  }
  /**
   * 不覆写重试策略：`undefined` 即采用 harness 的常规默认。
   *
   * 这个方法与 {@link imageRequestPricing}、{@link prepareCall} 一起，是
   * `LlmAdapter` 基类给出的默认实现——本插件不继承它（原因见 `host.ts`），
   * 因此按同样的语义自己给一份。
   * @returns 总是 `undefined`。
   */
  providerRetryPolicy() {
    return void 0;
  }
  /**
   * 不声明图片计价：本机 `vision: none`，请求里不会有图像。
   * @returns 总是 `undefined`。
   */
  imageRequestPricing() {
    return void 0;
  }
  /**
   * 绑定一次调用的模型元数据与派发入口（基类默认实现的等价物）。
   * @param provider - 已注册的 provider 路由。
   * @param model - 确切的模型 id。
   * @param signal - 模型解析的取消信号。
   * @returns 模型元数据与这一代适配器的流入口。
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    };
  }
  /**
   * 询问服务当前有哪些模型。
   *
   * 这是模型列表的**唯一来源**：服务不可达时返回空数组，而不是编一个出来——
   * 编出来的那个一旦服务换了模型就会变成谎话。
   * @param provider - 本条路由的 provider 名。
   * @returns 服务报出的模型目录。
   */
  async listModels(provider) {
    const facts = this.resolveFacts();
    const entries = await this.catalog(facts);
    return entries.map((entry) => ({
      provider,
      id: entry.id,
      name: entry.id,
      ...typeof entry.meta?.n_ctx === "number" ? { description: `\u4E0A\u4E0B\u6587 ${entry.meta.n_ctx}` } : {},
      inputModalities: ["text"]
    }));
  }
  /**
   * 解析一条确切路由的元数据，上下文容量以后端报出的为准。
   * @param provider - 本条路由的 provider 名。
   * @param model - 请求里的模型 id（来自 dsh 的选择器，列表由后端提供）。
   * @returns 模型元数据。`inputModalities: ['text']` 让 harness 把图像历史投影成
   *   文本（本机 `vision: none`，交给服务反而会失败）。
   */
  async resolveModel(provider, model, _signal) {
    const facts = this.resolveFacts();
    const entry = (await this.catalog(facts)).find((candidate) => candidate.id === model);
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ["text"],
      // 后端自述的容量优先（GET /v1/models 的 meta.n_ctx）；拿不到才用配置值。
      context: { contextWindow: entry?.meta?.n_ctx ?? facts.contextWindow },
      defaultMaxTokens: facts.maxTokens,
      reasoning: {
        efforts: REASONING_EFFORTS.map((id) => ({ id, name: id })),
        defaultEffort: facts.reasoningEffort
      }
    };
  }
  /**
   * 读取后端的模型目录，带一个短缓存。
   *
   * 一次调用里 `resolveModel` 与 `listModels` 都会问，缓存把"每轮多打两次 HTTP"
   * 压成一次；几秒的窗口足够，因为服务换模型本来就要重启（重新加载权重）。
   * @param facts - 已解析的连接事实。
   * @returns 服务报出的模型条目；服务不可达时为空数组。
   */
  async catalog(facts) {
    const now = Date.now();
    if (this.catalogCache !== void 0 && now - this.catalogCache.at < CATALOG_TTL_MS) {
      return this.catalogCache.entries;
    }
    try {
      const entries = await fetchListing(facts.baseURL, strataHeaders(facts));
      this.catalogCache = { at: now, entries };
      return entries;
    } catch (error) {
      this.log?.(`strata: \u8BFB\u53D6\u6A21\u578B\u76EE\u5F55\u5931\u8D25\uFF08${describe(error)}\uFF09`);
      return [];
    }
  }
  /**
   * 流式执行一次模型调用。
   * @param options - harness 装配完成的请求；必须遵守 `options.signal`。
   * @returns 该次调用的 chunk 流；失败以异常抛出，由 `LlmRuntime` 规范化为
   *   `error` / `aborted` 完成原因。
   */
  async *stream(options) {
    const facts = this.resolveFacts();
    await this.ensureServed?.(options.signal);
    this.touch?.();
    const url = `${facts.baseURL}/chat/completions`;
    const body = buildChatRequest(options, {
      ...facts.model === void 0 ? {} : { model: facts.model },
      reasoningEffort: facts.reasoningEffort,
      maxTokens: facts.maxTokens
    });
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers(facts),
        body: JSON.stringify(body),
        signal: combineSignals(facts.requestTimeoutMs, options.signal)
      });
    } catch (error) {
      throw new StrataError(`strata: POST ${url} \u5931\u8D25\uFF1A${describe(error)}`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) throw await httpFailure(response, url);
    const streamBody = response.body;
    if (streamBody === null) {
      throw new StrataError("strata: \u54CD\u5E94\u6CA1\u6709\u53EF\u8BFB\u7684\u6B63\u6587\u6D41", "EMPTY_STREAM", { status: response.status });
    }
    const translator = new StreamTranslator();
    for await (const payload of parseSse(streamBody)) {
      for (const chunk of translator.push(payload)) yield chunk;
    }
    for (const chunk of translator.end()) yield chunk;
    this.touch?.();
    const timings = translator.timings;
    if (timings !== void 0) {
      this.log?.(`strata: ${timings.predicted_per_second ?? "?"} tok/s\uFF08prompt ${timings.prompt_n ?? "?"} / \u9884\u6D4B ${timings.predicted_n ?? "?"} / MTP \u63A5\u53D7 ${timings.draft_n_accepted ?? 0}/${timings.draft_n ?? 0}\uFF09`);
    }
  }
  /** 组装请求头：归因头 + 凭据 + 内容类型。 */
  headers(facts) {
    return strataHeaders(facts);
  }
};
function strataHeaders(facts) {
  return {
    "content-type": "application/json",
    ...attributionHeaders(),
    ...facts.apiKey.length === 0 ? {} : { authorization: `Bearer ${facts.apiKey}` }
  };
}
function combineSignals(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === void 0 ? timeout : AbortSignal.any([timeout, signal]);
}
async function httpFailure(response, url) {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, ERROR_BODY_CHARS);
  } catch (error) {
    detail = `\uFF08\u8BFB\u53D6\u9519\u8BEF\u6B63\u6587\u5931\u8D25\uFF1A${describe(error)}\uFF09`;
  }
  return new StrataError(
    `strata: POST ${url} \u8FD4\u56DE HTTP ${response.status}${detail.length === 0 ? "" : `\uFF1A${detail}`}`,
    "HTTP_STATUS",
    { status: response.status }
  );
}

// src/detect.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
var STRATA_UPSTREAM = "https://github.com/Niko1221/Strata";
var STRATA_DOWNLOAD_URL = "https://github.com/Niko1221/Strata/archive/refs/heads/main.zip";
var diskFs = {
  exists: (path) => existsSync(path),
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readJson: (path) => JSON.parse(readFileSync(path, "utf8"))
};
var ENGINE_CONFIG = /^strata-.+\.json$/;
function candidateRoots(env) {
  const roots = [];
  const push = (value) => {
    if (value === void 0 || value.length === 0) return;
    const normalized = normalize(value);
    if (!roots.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) roots.push(normalized);
  };
  push(env.STRATA_HOME);
  const home = env.USERPROFILE ?? env.HOME;
  if (home !== void 0) {
    push(join(home, "Strata"));
    push(join(home, "strata"));
  }
  if (env.LOCALAPPDATA !== void 0) push(join(env.LOCALAPPDATA, "Strata"));
  for (const drive of ["C:", "D:", "E:", "F:"]) push(`${drive}\\Strata`);
  return roots;
}
function detectInstallation(options = {}) {
  const fs = options.fs ?? diskFs;
  const env = options.env ?? process.env;
  if (options.explicitCommand !== void 0 && options.explicitCommand.length > 0) return void 0;
  for (const root of candidateRoots(env)) {
    const install = inspectRoot(root, fs, options);
    if (install !== void 0) return install;
  }
  return void 0;
}
function inspectRoot(root, fs, options) {
  const serverScript = join(root, "serve", "server.py");
  if (!fs.exists(serverScript)) return void 0;
  const venvPython = [join(root, ".venv", "Scripts", "python.exe"), join(root, "venv", "Scripts", "python.exe")].find((candidate) => fs.exists(candidate));
  const engine = join(root, "engine", "strata.exe");
  if (venvPython === void 0 && !fs.exists(engine)) return void 0;
  const config = pickEngineConfig(root, fs, options);
  const source = root.toLowerCase() === normalize(options.env?.STRATA_HOME ?? "").toLowerCase() ? "env" : "common-path";
  return {
    root,
    serverScript,
    // 没有虚拟环境时交给 PATH 上的 python；服务自己会按配置里的 lib_dirs 处理库路径。
    python: venvPython ?? "python",
    ...config === void 0 ? {} : {
      engineConfig: join(root, config.file),
      ...config.port === void 0 ? {} : { port: config.port },
      ...config.model === void 0 ? {} : { model: config.model }
    },
    source
  };
}
function pickEngineConfig(root, fs, options) {
  const files = fs.list(root).filter((name2) => ENGINE_CONFIG.test(name2)).sort();
  if (files.length === 0) return void 0;
  const read = (file) => {
    let body;
    try {
      body = fs.readJson(join(root, file));
    } catch {
      return {};
    }
    if (typeof body !== "object" || body === null) return {};
    const record = body;
    return {
      ...typeof record.port === "number" ? { port: record.port } : {},
      ...typeof record.model_name === "string" ? { model: record.model_name } : {}
    };
  };
  const described = files.map((file) => ({ file, ...read(file) }));
  const byModel = options.model === void 0 ? void 0 : described.find((entry) => entry.model === options.model);
  const byPort = options.port === void 0 ? void 0 : described.find((entry) => entry.port === options.port);
  return byModel ?? byPort ?? described[0];
}
function missingInstallationHint() {
  return `\u672C\u673A\u6CA1\u68C0\u6D4B\u5230 Strata \u5B89\u88C5\uFF08\u770B\u8FC7 STRATA_HOME\u3001\u7528\u6237\u4E3B\u76EE\u5F55\u3001%LOCALAPPDATA% \u4E0E\u5404\u76D8\u6839\u4E0B\u7684 Strata \u76EE\u5F55\uFF0C\u5224\u5B9A\u6761\u4EF6\u662F\u76EE\u5F55\u91CC\u6709 serve/server.py \u4E14\u88C5\u597D\u5F15\u64CE\u6216\u865A\u62DF\u73AF\u5883\uFF09\u3002\u5B89\u88C5\u65B9\u5F0F\u89C1 ${STRATA_UPSTREAM}\uFF08\u4E00\u952E\u5305 ${STRATA_DOWNLOAD_URL}\uFF0C\u88C5\u5B8C\u6267\u884C\u5176\u4E2D\u7684 SETUP\uFF09\uFF0C\u6216\u7528 config.serveCommand \u76F4\u63A5\u7ED9\u51FA\u542F\u52A8\u547D\u4EE4\u3002`;
}

// src/serve.ts
var PROBE_INTERVAL_MS = 2e3;
var TERMINATE_GRACE_MS = 15e3;
var StrataSupervisor = class {
  options;
  handle;
  starting;
  idleTimer;
  state = "stopped";
  lastActivityAt = 0;
  /**
   * @param options - 事实解析、进程拉起方式、超时与空闲策略。
   */
  constructor(options) {
    this.options = options;
  }
  /** 探测服务当前状态，绝不启动或停止任何东西。 */
  async status() {
    const facts = this.options.resolveFacts();
    let models = [];
    let reachable = false;
    let loaded = false;
    try {
      const entries = await fetchListing(facts.baseURL, strataHeaders(facts));
      models = entries.map((entry) => entry.id);
      reachable = true;
      loaded = isLoaded(entries);
    } catch {
      reachable = false;
    }
    const managed = this.handle !== void 0;
    if (reachable && loaded && this.starting === void 0) this.state = "running";
    else if (!reachable && !managed) this.state = "stopped";
    const install = this.options.resolveInstall();
    return {
      state: this.state,
      reachable,
      loaded,
      managed,
      models,
      ...install === void 0 ? {} : { install: { root: install.root, source: install.source } },
      ...managed && this.options.idleShutdownMs > 0 ? { idleShutdownInMs: Math.max(0, this.options.idleShutdownMs - (this.now() - this.lastActivityAt)) } : {}
    };
  }
  /**
   * 确保服务可用：已加载完成就直接复用；否则**按配置**决定是否拉起并等到就绪。
   * 这是模型请求路径用的入口——它遵守 `autoStart`。
   * @param signal - 调用方取消；中止只结束**这一次等待**，已经拉起的进程继续加载
   *   （并发的调用方可能仍在等它），最终由空闲回收或卸载收尾。
   * @returns 就绪后的状态。
   * @throws StrataError 不允许自动启动而服务又没跑，或启动后迟迟不就绪。
   */
  ensureServed(signal) {
    return this.acquire(signal, this.options.autoStart);
  }
  /**
   * 显式启动并等到就绪，忽略 `autoStart` 策略——这是 `strata_serve` 工具用的入口：
   * 主对话明确要求启动时，"是否允许自动拉起"这条策略不该拦住它。
   * @param signal - 调用方取消，语义同 {@link ensureServed}。
   * @returns 就绪后的状态。
   */
  serveNow(signal) {
    return this.acquire(signal, true);
  }
  /** 两个入口共用的获取流程。 */
  async acquire(signal, allowStart) {
    const current = await this.status();
    if (current.loaded) {
      this.touch();
      return current;
    }
    if (!allowStart) {
      throw new StrataError(
        `strata: \u672C\u5730\u670D\u52A1\u672A\u8FD0\u884C\uFF08${this.options.resolveFacts().baseURL} \u8FDE\u4E0D\u4E0A\u6216\u6A21\u578B\u672A\u52A0\u8F7D\uFF09\u3002 \u672C\u63D2\u4EF6\u7684 autoStart \u5DF2\u5173\u95ED\uFF0C\u8BF7\u5148\u8C03\u7528 \`strata_serve\` \u5DE5\u5177\u542F\u52A8\u672C\u5730\u6A21\u578B\u670D\u52A1\uFF0C\u518D\u91CD\u8BD5\u3002`,
        "SERVICE_NOT_RUNNING"
      );
    }
    if (this.starting !== void 0) return this.starting;
    this.starting = this.start(signal);
    try {
      return await this.starting;
    } finally {
      this.starting = void 0;
    }
  }
  /** 记录一次活动：把空闲回收的计时推后。 */
  touch() {
    this.lastActivityAt = this.now();
    if (this.handle === void 0 || this.options.idleShutdownMs <= 0) return;
    if (this.idleTimer !== void 0) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = void 0;
      if (this.state === "starting") {
        this.touch();
        return;
      }
      void this.stop("\u7A7A\u95F2\u8D85\u65F6");
    }, this.options.idleShutdownMs);
    this.idleTimer.unref?.();
  }
  /**
   * 停止服务。只终止**本插件拉起**的进程；外部服务只记录不动作。
   * @param reason - 停止原因，写进日志。
   * @returns 是否真的停掉了托管进程。
   */
  async stop(reason) {
    this.clearIdle();
    const handle = this.handle;
    if (handle === void 0) {
      this.state = "stopped";
      return { stopped: false, reason: `\u670D\u52A1\u4E0D\u662F\u672C\u63D2\u4EF6\u62C9\u8D77\u7684\uFF0C\u4E0D\u505C\u6B62\uFF08${reason}\uFF09` };
    }
    this.handle = void 0;
    this.state = "stopped";
    this.options.log?.(`strata: \u505C\u6B62\u672C\u5730\u670D\u52A1\uFF08${reason}\uFF09`);
    handle.terminate();
    try {
      const settled = await handle.waitForExit(AbortSignal.timeout(TERMINATE_GRACE_MS));
      if (!settled) this.options.log?.("strata: \u8FDB\u7A0B\u8303\u56F4\u672A\u5728\u5BBD\u9650\u671F\u5185\u6E05\u7A7A\uFF0C\u53EF\u80FD\u4ECD\u6709\u6B8B\u7559");
    } catch (error) {
      this.options.log?.(`strata: \u505C\u6B62\u672C\u5730\u670D\u52A1\u65F6\u51FA\u9519\uFF1A${describe(error)}`);
    }
    return { stopped: true };
  }
  /** 插件卸载时的同步收尾：起过的进程不留在机器上。 */
  dispose() {
    this.clearIdle();
    const handle = this.handle;
    this.handle = void 0;
    this.state = "stopped";
    handle?.terminate();
  }
  /** 拉起服务并等到模型加载完成。 */
  async start(signal) {
    const facts = this.options.resolveFacts();
    const probeFirst = await this.status();
    if (probeFirst.loaded) {
      this.touch();
      return probeFirst;
    }
    const install = this.options.resolveInstall();
    const spec = {
      argv: serveArgv(facts, install),
      // 服务要求工作目录是安装根目录（它按相对路径找 engine/ 与 serve/）。
      cwd: install?.root ?? process.cwd(),
      stdio: {
        stdin: "ignore",
        // 服务日志是排障用的诊断尾巴，只留最近一段，避免常驻内存被日志吃掉。
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 64 * 1024 }
      },
      graceMs: TERMINATE_GRACE_MS
    };
    this.options.log?.(`strata: \u62C9\u8D77\u672C\u5730\u670D\u52A1 ${spec.argv.join(" ")}`);
    const handle = this.options.spawner.spawn(spec);
    this.handle = handle;
    void handle.done.then(
      () => {
        if (this.handle === handle) this.handle = void 0;
      },
      () => {
        if (this.handle === handle) this.handle = void 0;
      }
    );
    this.state = "starting";
    this.touch();
    try {
      await this.waitUntilLoaded(signal);
    } catch (error) {
      await this.stop("\u542F\u52A8\u5931\u8D25");
      throw error;
    }
    this.state = "running";
    this.touch();
    const ready = await this.status();
    return { ...ready, state: "running" };
  }
  /** 轮询直到模型报告 loaded。 */
  async waitUntilLoaded(signal) {
    const facts = this.options.resolveFacts();
    const deadline = this.now() + this.options.readyTimeoutMs;
    while (this.now() < deadline) {
      await this.sleep(PROBE_INTERVAL_MS);
      this.touch();
      if (signal?.aborted === true) throw new StrataError("strata: \u7B49\u5F85\u670D\u52A1\u5C31\u7EEA\u88AB\u53D6\u6D88", "ABORTED");
      try {
        const entries = await fetchListing(facts.baseURL, strataHeaders(facts));
        if (isLoaded(entries)) return;
      } catch {
      }
    }
    const tail = this.outputTail();
    throw new StrataError(
      `strata: \u670D\u52A1\u5728 ${Math.round(this.options.readyTimeoutMs / 1e3)} \u79D2\u5185\u6CA1\u6709\u5C31\u7EEA\u300235B \u6743\u91CD\u9996\u6B21\u52A0\u8F7D\u66F4\u6162\uFF0C\u53EF\u8C03\u5927 readyTimeoutMs \u6216\u67E5\u770B\u670D\u52A1\u65E5\u5FD7\u3002` + (tail.length === 0 ? "\uFF08\u6CA1\u8BFB\u5230\u670D\u52A1\u8F93\u51FA\uFF09" : `
\u670D\u52A1\u8F93\u51FA\u5C3E\u90E8\uFF1A
${tail}`),
      "SERVICE_NOT_READY"
    );
  }
  /**
   * 服务进程输出（stdout+stderr）的尾部。
   *
   * 启动失败时必须能说出"为什么"：35B 服务的加载进度、显存不足、端口占用都只写在
   * 它自己的输出里，把这几百字节带进错误消息比让人去翻日志快得多。
   * @returns 最近一段输出；没有可读输出时为空串。
   */
  outputTail() {
    const handle = this.handle;
    if (handle === void 0) return "";
    const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
    const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
    return `${stdout}${stderr}`.trim().slice(-600);
  }
  clearIdle() {
    if (this.idleTimer !== void 0) clearTimeout(this.idleTimer);
    this.idleTimer = void 0;
  }
  sleep(ms) {
    if (this.options.sleep !== void 0) return this.options.sleep(ms);
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  now() {
    return this.options.now?.() ?? Date.now();
  }
};
function serveArgv(facts, install) {
  if (facts.serveCommand !== void 0 && facts.serveCommand.length > 0) return [...facts.serveCommand];
  if (install === void 0) {
    throw new StrataError(`strata: ${missingInstallationHint()}`, "NO_INSTALLATION");
  }
  const url = new URL(facts.baseURL);
  const port = url.port.length > 0 ? url.port : "8080";
  return [
    install.python,
    install.serverScript,
    "--engine",
    "strata",
    ...install.engineConfig === void 0 ? [] : ["--config", install.engineConfig],
    "--port",
    port
  ];
}

// src/tools.ts
function registerStrataTools(ctx, deps) {
  const { supervisor } = deps;
  ctx.tools.register(defineTool({
    name: "strata_serve",
    description: "Start the local Strata inference service (AMD HIP) and wait until its model reports loaded, so a later request to the `strata` model does not sit through the weight load. Loading the 35B model takes roughly one to two minutes and holds about 20 GB of memory. Safe to call when the service is already running: it is reused, never started twice. The service is stopped automatically after an idle period, and only if this plugin started it.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["state", "loaded", "managed", "models", "elapsedMs"],
        properties: {
          state: { type: "string", enum: ["stopped", "starting", "running"] },
          loaded: { type: "boolean" },
          managed: { type: "boolean" },
          models: { type: "array", items: { type: "string" } },
          elapsedMs: { type: "integer" }
        }
      },
      render: (_args, value) => {
        const served = value;
        return [{
          type: "text",
          text: `Local Strata service is ${served.state} (model loaded: ${served.loaded}, started by this plugin: ${served.managed}) after ${served.elapsedMs} ms. Models: ${served.models.length === 0 ? "(none reported)" : served.models.join(", ")}.`
        }];
      }
    },
    async execute(_args, exec) {
      const startedAt = Date.now();
      const status = await supervisor.serveNow(exec.signal);
      return {
        state: status.state,
        loaded: status.loaded,
        managed: status.managed,
        models: [...status.models],
        elapsedMs: Date.now() - startedAt
      };
    },
    presentCall: () => ({ card: "generic", title: "Start local Strata service", kind: "other" })
  }));
  ctx.tools.register(defineTool({
    name: "strata_status",
    description: "Report the local Strata inference service state: where the installation was detected, whether the endpoint answers, whether the model finished loading, whether this plugin manages the process (and will therefore stop it when idle), which models it advertises, and how long until an idle shutdown.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["state", "reachable", "loaded", "managed", "models"],
        properties: {
          state: { type: "string", enum: ["stopped", "starting", "running"] },
          reachable: { type: "boolean" },
          loaded: { type: "boolean" },
          managed: { type: "boolean" },
          models: { type: "array", items: { type: "string" } },
          idleShutdownInMs: { type: "integer" },
          installRoot: { type: "string" }
        }
      },
      render: (_args, value) => {
        const status = value;
        return [{
          type: "text",
          text: `Strata service: state=${status.state}, endpoint reachable=${status.reachable}, model loaded=${status.loaded}, managed by this plugin=${status.managed}${status.idleShutdownInMs === void 0 ? "" : `, idle shutdown in ${status.idleShutdownInMs} ms`}. Models: ${status.models.length === 0 ? "(none reported)" : status.models.join(", ")}. ` + (status.installRoot === void 0 ? "No local Strata installation was detected, so this plugin cannot start one itself." : `Installation detected at ${status.installRoot}.`)
        }];
      }
    },
    async execute() {
      const status = await supervisor.status();
      return {
        state: status.state,
        reachable: status.reachable,
        loaded: status.loaded,
        managed: status.managed,
        models: [...status.models],
        ...status.idleShutdownInMs === void 0 ? {} : { idleShutdownInMs: status.idleShutdownInMs },
        ...status.install === void 0 ? {} : { installRoot: status.install.root }
      };
    },
    presentCall: () => ({ card: "generic", title: "Check local Strata service", kind: "other" })
  }));
  ctx.tools.register(defineTool({
    name: "strata_stop",
    description: "Stop the local Strata inference service to free its memory immediately, instead of waiting for the idle shutdown. Only a service started by this plugin is stopped; a service someone else started is left running.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["stopped"],
        properties: {
          stopped: { type: "boolean" },
          reason: { type: "string" }
        }
      },
      render: (_args, value) => {
        const outcome = value;
        return [{
          type: "text",
          text: outcome.stopped ? "Local Strata service stopped; its memory is released." : `Local Strata service was not stopped: ${outcome.reason ?? "no managed process"}.`
        }];
      }
    },
    async execute() {
      const outcome = await supervisor.stop("\u4E3B\u5BF9\u8BDD\u8BF7\u6C42\u505C\u6B62");
      return {
        stopped: outcome.stopped,
        ...outcome.reason === void 0 ? {} : { reason: outcome.reason }
      };
    },
    presentCall: () => ({ card: "generic", title: "Stop local Strata service", kind: "other" })
  }));
}

// src/index.ts
var name = "llm-strata";
var inject = ["llm"];
var PROVIDER = "strata";
function apply(ctx, config) {
  const facts = resolveConfig(config);
  const resolveInstall = () => detectInstallation({
    ...facts.serveCommand === void 0 ? {} : { explicitCommand: facts.serveCommand },
    ...facts.model === void 0 ? {} : { model: facts.model }
  });
  const resolveFacts = () => resolveConfig(config, resolveInstall()?.port);
  let supervisor;
  const adapter = new StrataAdapter({
    resolveFacts,
    log: (message) => ctx.logger.info(message),
    ensureServed: async (signal) => {
      await supervisor?.ensureServed(signal);
    },
    touch: () => {
      supervisor?.touch();
    }
  });
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.inject(["subprocess", "tools"], (scoped) => {
    const resolved = resolveFacts();
    const managed = new StrataSupervisor({
      resolveFacts,
      resolveInstall,
      spawner: scoped.subprocess,
      readyTimeoutMs: resolved.readyTimeoutMs,
      idleShutdownMs: resolved.idleShutdownMs,
      autoStart: resolved.autoStart,
      log: (message) => scoped.logger.info(message)
    });
    supervisor = managed;
    registerStrataTools(scoped, { supervisor: managed });
    scoped.effect(() => () => {
      managed.dispose();
    });
  });
  reportEnvironment(ctx, resolveFacts, resolveInstall);
}
function reportEnvironment(ctx, resolveFacts, resolveInstall) {
  void (async () => {
    const facts = resolveFacts();
    const install = resolveInstall();
    if (install === void 0) {
      ctx.logger.info(`strata: ${missingInstallationHint()}`);
      return;
    }
    ctx.logger.info(`strata: \u68C0\u6D4B\u5230 Strata \u5B89\u88C5 ${install.root}\uFF08\u6765\u6E90 ${install.source === "env" ? "STRATA_HOME" : "\u5E38\u89C1\u5B89\u88C5\u4F4D\u7F6E"}${install.engineConfig === void 0 ? "" : `\uFF0C\u914D\u7F6E ${install.engineConfig}`}\uFF09\uFF0C\u7AEF\u70B9 ${facts.baseURL}`);
    try {
      const entries = await fetchListing(facts.baseURL, strataHeaders(facts));
      const loaded = entries.filter((entry) => entry.status?.value === "loaded").map((entry) => entry.id);
      if (isLoaded(entries)) {
        ctx.logger.info(`strata: \u670D\u52A1\u5DF2\u5C31\u7EEA\uFF0C\u5DF2\u52A0\u8F7D ${loaded.join("\u3001")}`);
      } else {
        ctx.logger.info(`strata: \u670D\u52A1\u53EF\u8FBE\uFF0C\u4F46\u6A21\u578B\u5C1A\u672A\u52A0\u8F7D\u5B8C\u6210\uFF08\u5B9E\u6D4B\u9700 47\u201379 \u79D2\uFF09`);
      }
    } catch {
      ctx.logger.info(`strata: \u5F53\u524D\u6CA1\u6709\u670D\u52A1\u5728 ${facts.baseURL} \u5E94\u7B54\uFF1B\u9700\u8981\u65F6\u4F1A\u6309\u914D\u7F6E\u62C9\u8D77`);
    }
  })();
}
export {
  DEFAULT_AUTO_START,
  DEFAULT_BASE_URL,
  DEFAULT_IDLE_SHUTDOWN_MS,
  DEFAULT_REASONING_EFFORT,
  PROVIDER,
  STRATA_DOWNLOAD_URL,
  STRATA_UPSTREAM,
  StrataAdapter,
  StrataSupervisor,
  StreamTranslator,
  apply,
  buildChatRequest,
  candidateRoots,
  consumeLine,
  detectInstallation,
  fetchListing,
  inject,
  isLoaded,
  mapFinishReason,
  mapUsage,
  missingInstallationHint,
  name,
  parseSse,
  readListing,
  registerStrataTools,
  resolveConfig,
  serveArgv,
  strataHeaders,
  translateMessage,
  translateTools
};
