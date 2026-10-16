# dsh-plugin-strata

把本机的 **[Strata](https://github.com/Niko1221/Strata)（HIP/AMD）推理服务**接进 DSH：dsh 侧的
模型请求会被翻译成 `POST {baseURL}/chat/completions` 的 OpenAI 兼容流式调用，响应再翻译回
harness 的 chunk 协议。插件还能**按需把服务拉起来**，用完自动释放。

## 环境前提

| 项 | 值 |
| --- | --- |
| Strata | 自带 OpenAI 兼容服务（`serve/server.py`），默认端口 8080 |
| 后端 | AMD HIP（`strata.exe`）；任何兼容该端点的部署都可用 |
| 模型 | **由服务决定**：插件不写死模型名，dsh 的模型列表来自 `GET /v1/models` |

参考量级（20 GB 显存这一档的机器上实测）：从拉起至就绪约 **70–79 秒**，引擎常驻约 **20 GB**
内存。这个数量级正是本插件要"懒启动 + 空闲回收"的原因。

## 装进 dsh

发布态：

```powershell
dsh plugin --profile <你的 profile> add github:YuChenLiao/dsh-plugin-strata
```

本地开发态（改代码即时生效）：

```powershell
git clone <本仓库> dsh-plugin-strata && cd dsh-plugin-strata
node tools/install.mjs          # 构建产物 + 登记到本机 profile（默认读 DSH_PROFILE，可 --profile 指定）
node tools/install.mjs --check  # 只检查登记状态，不改动
```

两条路都走官方入口：`install.mjs` 内部调的就是 `dsh plugin --profile <p> add link:<本目录>`，
它会同时写好 profile 的 `dependencies` 与 `dsh.profile.bundles`。装完在 dsh 的「设置 → 插件」里
启用——**运行中的 dsh 也能直接启用，不必重启**（实测启用后立即装载成功，三个托管工具随即出现在
主对话的工具表里）。

**改动之后**：`link:` 安装时 profile 指向的就是这个目录，所以只有两种情形：

| 改了什么 | 要做的事 |
| --- | --- |
| `src/` 里的代码 | `node tools/build.mjs`（`lib/index.js` 才是 dsh 装载的东西） |
| `package.json` 的 `name` / `dsh` / `exports` | 再跑一次 `node tools/install.mjs` |

### 产物必须自包含（踩过的坑）

dsh 装载第三方插件时，模块解析从**插件的真实目录**开始，而那个目录不在宿主的 `node_modules`
解析路径上——产物里只要有一句裸 import（哪怕是 `@deepseek-ai/dsh-llm`），装载就会以
`failed to import` 失败。已发布的两个插件（按 github 装的与按 link 装的）产物都是零 import 的：
这是 dsh 插件的形态约定。

因此 `src/host.ts` 把宿主契约收敛成最小自实现（错误类、归因头、工具定义构造器），打包时
**不设 external**。类型仍从真实包 `import type` 取（编译期擦除），所以
`StrataAdapter implements LlmAdapter` 这类检查依然对着 DSH 的真实契约；错误类的形状也不是
猜的：`dsh-llm` 的 `normalizeLlmFailure` 明确为跨包副本设计，读的是错误自己的 `code` /
`failure` 数据属性。`tests/bundle.test.ts` 里有一条断言守着这个约束——产物里不得出现裸 import
或 `@deepseek-ai/` 字样。

## 服务托管：按需拉起，空闲回收

插件**不在 dsh 装载时**拉起服务。加载要一分多钟、常驻 20 GB，所以启动时机交出去：

- **懒启动**（默认 `autoStart: true`）：一条发往 `strata` 模型的请求会先把服务拉起来，
  等它加载完，再发请求。第一次会多等约 80 秒。
- **主对话显式决定**：三个工具让 agent 自己判断时机——先预热、先查状态、或提前释放。
- **空闲回收**：最后一次活动（模型请求或工具调用）之后 `idleShutdownMs`（默认 5 分钟）
  无动作，就停掉服务、释放内存。**加载中的服务不会被误杀**（加载也算活动）。
- **只回收自己拉起的进程**：服务可能是别人先起好的，那种情况插件只复用，绝不终止。

主对话可用的工具：

| 工具 | 用途 |
| --- | --- |
| `strata_serve` | 现在就用本地模型：拉起并等到就绪（已在跑则复用）。显式调用会突破 `autoStart: false` |
| `strata_status` | 服务在不在、模型是否加载完、是不是本插件管着、还有多久回收 |
| `strata_stop` | 立刻释放那 20 GB，不必等空闲到期 |

三者都无参数，直接调用即可。

## 配置

全部字段可省略；下表是默认值（等于 `cordis.patch.yml` 里写的那份）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `http://127.0.0.1:8080/v1` | OpenAI 兼容基址；末尾斜杠会被去掉 |
| `model` | 不指定 | **模型由后端提供**：dsh 的模型列表来自服务的 `GET /v1/models`，选中什么就发什么。只有要强制覆盖选择器时才写 |
| `apiKey` | `local` | 本地服务不校验，任意非空串即可 |
| `contextWindow` | 后端自述 | 上报上下文容量的**兜底值**：能读到就优先用服务 `GET /v1/models` 里的 `meta.n_ctx` |
| `maxTokens` | `8192` | 请求未指定时的输出上限 |
| `reasoningEffort` | `none` | 思考档位 `none`/`low`/`medium`/`high` |
| `requestTimeoutMs` | `600000` | 单次请求总超时 |
| `autoStart` | `true` | 请求到来而服务没跑时是否自动拉起 |
| `idleShutdownMs` | `300000` | 空闲多久后停止托管的服务；`0` 表示不自动停止 |
| `readyTimeoutMs` | `180000` | 等待模型加载完成的上限 |
| `serveCommand` | 无 | 直接给完整 argv；给了就跳过自动检测（通常不用） |

`baseURL` 也可以不写：不写就跟着检测到的服务端口走（见下一节）。

## 本机安装是自动检测的

插件不要求你手填任何路径。需要启动服务时，它按顺序找安装根目录：

1. `STRATA_HOME` 环境变量（部署方明确指定的位置优先）；
2. `%USERPROFILE%\Strata`、`%LOCALAPPDATA%\Strata`；
3. 各盘根下的 `Strata`（`C:` 到 `F:`）。

判定条件是明确的两条：目录里有 `serve/server.py`，**并且**装好了引擎（`engine/strata.exe`）或虚拟环境（`.venv\Scripts\python.exe`）。命中之后，引擎配置（`strata-*.json`）、端口与模型名都从那个目录里读出来——所以换台机器、换个模型、换个盘符都不用改配置。有虚拟环境就用它，否则交给 PATH 上的 `python`。

一个都没找到时**不猜、也不静默**：

- 装载时日志说明检测过哪些位置、判定条件是什么，并给出上游地址；
- `strata_serve` 与模型请求以 `NO_INSTALLATION` 失败，错误消息里带 `https://github.com/Niko1221/Strata` 与一键包地址；
- `strata_status` 会明说"没检测到安装，本插件无法自己启动服务"。

上游地址取自本机安装自己的 `setup.py` 与 `README.md`，不是猜的。

`reasoningEffort` 默认 `none` 是有理由的：本模型默认先"想"一大段，思考走非标准的
`reasoning_content` 通道。不传或传 `low` 时 `max_tokens` 会被思考吃光、`content` 返回
null——在 agent 场景里等于空回复。实测 `none` 下整条请求约 1.5 秒返回完整答案。

### 模型完全来自后端

插件里没有任何模型名字的常量：

- dsh 的模型列表由 `listModels()` 从服务的 `GET /v1/models` 实时读出（`strata_status` 也会显示服务报出的模型）；
- 选择器里选中哪个 id，请求体就带哪个（`options.model`），插件不覆盖；
- `resolveModel()` 的上下文容量也从后端读（`meta.n_ctx`），读不到才用 `contextWindow` 配置值兜底；
- 服务不可达时 `listModels()` 返回**空列表**而不是编一个——编出来的那个，等服务换了模型就变成谎话。

所以要换模型，在 Strata 那边换（`strata-*.json` 指向哪个 GGUF 就是哪个），dsh 侧不用改任何配置。

## 验证

```powershell
node tools/build.mjs          # 打包 lib/index.js（dsh 装载的是产物）
node tools/run-tests.mjs      # 映射表 → 产物 → 类型检查 → 全部测试
node tools/install.mjs --check # 确认 dsh profile 里登记的就是这个目录

# 真实生命周期验证（拉起 → 就绪 → 回答 → 空闲释放；默认跳过）
$env:STRATA_LIVE_SERVE = '1'; node tools/run-tests.mjs --only=tests
```

本机实测（`node tools/run-tests.mjs`）：

```
===== 映射表（tsconfig.paths.json） =====   tsconfig.paths.json 已是最新（映射 251 个包）
===== 产物（lib/index.js 与源码一致） ===== lib/index.js 已是最新
===== 类型检查（tsc，对象为 DSH 源码契约） =====
Diagnostics 总数 70：本仓库 0，依赖源码（DSH vendor/packages）70
本仓库 src/ 与 tests/ 无类型错误。
===== 测试（11 个文件） =====
ℹ tests 76   ℹ pass 74   ℹ fail 0   ℹ skipped 2
全部验证通过。
```

两个跳过的是需要真实服务的用例（`STRATA_LIVE_SERVE=1` 才跑）。开启后实测输出：

```
  [strata] strata: 拉起本地服务 <install-root>\.venv\Scripts\python.exe <install-root>\serve\server.py --engine strata --config <install-root>\strata-<model>.json --port 8080
  [strata] 从拉起至就绪 60.4 秒，模型 <服务报出的 id>
  [strata] 回答耗时 2479 毫秒：我是通义千问，由阿里云通义实验室独立开发的大语言模型...
  [strata] strata: 停止本地服务（空闲超时）
✔ 真实托管：拉起 → 就绪 → 回答 → 空闲释放 (87880ms)
```

路径与模型名都是运行时检测/由服务报出的，这里用占位符表示；实测数字随机器而异。

它从"机器上没有服务"开始：断言 8080 不可达 → **自动检测出安装位置** → 用 DSH 真实的
`subprocess` 服务（Windows 下走 Job 对象）拉起 → 等到 `loaded` → 经插件适配器发一条真实
中文请求 → 等过空闲窗口 → 断言托管关系解除、且**端口已经关闭**。命令里的每一个路径都是
检测出来的，没有一个是配置写进去的。

### 验证是怎么构造的

- **类型与运行时契约取自 DSH 源码本身。** 本工程不安装依赖：`tsconfig.paths.json` 由
  `tools/gen-paths.mjs` 生成，把 251 个 `@deepseek-ai/*` 包映射到源码树的 `src/*.ts`；
  测试通过 `tools/lib/harness-hook.mjs` 从源码加载 `LlmAdapter` / `LlmRuntime` /
  `ToolRuntime`。断言的签名与行为是**真实契约**，不是本仓库手抄的类型桩。
- **端到端用的是真实服务**：真实 `LlmRuntime` + 真实 `BlockAssembler` + 真实 `ToolRuntime`
  注册表，对面只是一个本地桩服务。桩服务故意把字节切碎、插入 `: keep-alive` 注释行，
  以复现实测形状。
- **进程托管的策略测试全部跑在假进程上**：拉起器只记录"拉起了什么、终止了什么"，
  因此"只回收自己的进程""加载中不被误杀""活动会推迟回收"这些断言不占显存。
- **类型检查的门禁是"本仓库零错误"。** DSH 用 TypeScript project references 让每个包
  （含 `vendor/`）按自己的 tsconfig 编译；本工程把这些源码扁平拉进一个 program，于是
  `vendor/cordis` 这类按宽设置编译的文件会报 70 条诊断。这不是本层能修的编译边界，
  因此脚本把它**显式计数并打印**，门禁只对本仓库的 `src/` 与 `tests/`。

## 设计要点

- **思考通道单独成块**：`reasoning_content` 映射到 harness 的 `reasoning` 块，与可见
  文本分开；`finish_reason == "length"` 映射成 `max-tokens`，因此"思考烧完预算"表现为
  可见的截断，而不是一次静默的空回复。
- **工具调用原生闭环**：`tools` 走请求体 `tools` + `tool_choice: "auto"`；流式
  `tool_calls` 分片按响应内的 `index` 独立累积；harness 的 `tool-result` 块展开成独立的
  `role: "tool"` 消息并带 `tool_call_id`。
- **文本模态对齐**：`resolveModel` 声明 `inputModalities: ['text']`，于是 harness 会把
  图像历史投影成文本占位（本机 `vision: none`）。
- **归因头**：每个 provider 请求都带 `attributionHeaders()`（harness 对适配器的硬性要求）。
- **启动失败要说出原因**：等待就绪超时会把服务进程 stdout/stderr 的尾部（600 字节）
  带进错误消息——加载进度、显存不足、端口占用都只写在它自己的输出里。
- **托管失败不拖垮插件**：`subprocess` 与 `tools` 都是可选注入；这个 profile 没有它们时，
  provider 照常工作，只是没有拉起服务的能力与那三个工具。

## 已知限制

- **没有 Config 模式，因此没有设置界面表单**：产物自包含（见上文）意味着不能依赖
  `schemastery` 运行时，配置只能写 `cordis.yml`（改完重启 dsh）。校验集中在
  `resolveConfig` 一个显式步骤里，写错会在装载期就报出来。
- **未做重试策略**：沿用 harness 的常规默认（`providerRetryPolicy` 未覆写）。
- **未发 `stream_options.include_usage`**：用量只在服务主动给出 `usage` 帧时上报。
- **空闲回收是"进程级"的**：它终止的是本插件拉起的进程范围；若服务自己 fork 出脱离进程范围的
  子进程，本层看不到（本机的服务结构是 python + `strata.exe` 两个进程，实测都能收掉）。
- **依赖的报错不构成本层门禁**：见上文"验证是怎么构造的"最后一条。
- **未验证项**（照抄交接文档第 7 节，本插件同样没测）：长上下文（>64K）、并发、
  `/v1/responses`、`reasoning_budget_tokens`、与其它 provider 的并存行为。

## 参考与致谢

### Strata

本插件的后端是 **[Strata](https://github.com/Niko1221/Strata)**：它自带 OpenAI 兼容服务
（`serve/server.py`）、HIP/AMD 与 CUDA 后端、多模型族支持，以及文档齐全的安装与更新流程。
模型加载、推理引擎、端点协议全部属于该项目，本插件只做两件事——把它的端点接进 DSH，
以及按需把它的进程拉起来/收回去。感谢 Strata 的作者与贡献者。

### DSH 生态里实际参考过的实现

以下都是 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库里的包，
路径取自各包自己的 `package.json#repository`：

- [@deepseek-ai/dsh-llm-deepseek](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-deepseek)：
  适配器该怎么写（SSE 帧解析、`[DONE]` 终止语义、失败规范化）的第一手范例，本插件的 `sse.ts`
  与 `adapter.ts` 对着它写。
- [@deepseek-ai/dsh-llm-pi-ai](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/llm/llm-pi-ai)：
  provider 插件如何注册路由、如何把配置解析成每请求的连接事实。
- [dsh-plugin-structured-prompt](https://github.com/YuChenLiao/dsh-plugin-structured-prompt)：
  第三方插件工程的形态参考——自包含产物、`tools/run-tests.mjs` 式的验证链、测试期对宿主模块的
  解析手法（本插件的 `tools/lib/*` 与它同源）。
- [dsh-ops](https://github.com/T-Auto/dsh-ops)：它的产物证明了"第三方插件产物必须零 import"这条
  形态约定（本插件在这里踩过坑，见上文"产物必须自包含"）。

### 同类插件推荐

- [songzhiyin/dsh-local-model](https://github.com/songzhiyin/dsh-local-model)：注册自定义 LLM 适配器，
  支持 OpenAI 兼容端点与 Ollama 原生协议，含端点表与工具调用的文本兜底。
- [b8yg7vjstj-ctrl/dsh-llamacpp-bridge](https://github.com/b8yg7vjstj-ctrl/dsh-llamacpp-bridge)：
  更进一步，直接托管推理进程（探测可执行文件与模型目录、启动/停止、就绪轮询、日志面板）——
  与本文的进程托管部分要解决的问题同构。
