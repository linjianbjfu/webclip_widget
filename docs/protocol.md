# HTTP 与 SSE 客户端协议

本文描述当前服务端对外行为，供 iOS 和 CLI 客户端接入。请求路由由 [router.ts](../backend/src/router.ts) 和 [handlers.ts](../backend/src/do/handlers.ts) 实现，公共载荷类型见 [protocol.ts](../backend/src/protocol.ts)。SSE 的选择理由与幂等设计见[后端架构决策](../.agents/notes/implemented/architecture/2026-09-28-backend-architecture.md)。

## 认证与寻址

每个请求携带：

```http
authorization: Bearer <AUTH_TOKEN>
x-webclip-user: <user-id>
```

服务端先校验共享密钥，再按用户标识路由到该用户的 Durable Object。用户标识去除首尾空白后必须非空且不超过 200 个字符；这只是格式检查，不能证明调用者身份。持有共享密钥的人可以访问任意用户的会话。

| HTTP 状态 | JSON 的 `error` | 含义 |
|---|---|---|
| 503 | `auth_not_configured` | 服务端未配置共享密钥 |
| 401 | `unauthorized` | Bearer token 缺失或不匹配 |
| 400 | `missing_user` | 用户标识为空或过长，响应同时给出 `header` |
| 404 | `not_found` | 路由或会话不存在 |

## 会话

| 请求 | 成功响应 |
|---|---|
| `POST /v1/sessions` | 201，`{ "sessionId": "…" }` |
| `GET /v1/sessions` | 200，`{ "sessions": […] }` |
| `DELETE /v1/sessions/{id}` | 204，无响应体 |

创建请求接受 JSON `{ "title": "可选标题" }`，同时建立会话工作区的 `/out` 目录。创建接口不接收文件，也没有设置模型或思考等级的请求字段。会话列表按 `updatedAt` 倒序，字段为 `id`、`title`、`model`、`createdAt`、`updatedAt`、`busy`；时间为 Unix 毫秒，`busy` 由进行中的 turn 推导。

删除会话会删除其工作区、事件和 turn 记录。运行中的模型任务没有与删除操作联动取消，应在轮次结束后删除。

## 提交提示

```http
POST /v1/sessions/{id}/prompt
Content-Type: application/json
```

```json
{
  "turnId": "9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01",
  "text": "读取 source.html，把报价做成 widget",
  "since": 0
}
```

| 字段 | 契约 |
|---|---|
| `turnId` | 必填，小写、带连字符的 UUIDv4；客户端生成，同一次提交的重试复用同一个值 |
| `text` | 新 turn 必须有非空文本，服务端去除首尾空白；已有 turn 的重试可省略 |
| `since` | 可选，默认 0；先补发该序号之后的会话记录，再接实时流 |

成功响应为 200，`Content-Type: text/event-stream`，响应体直接承载 SSE。客户端需保存待提交的 `turnId`，不能为每次网络重试重新生成。不同提交使用不同 UUID；iOS 可使用 `UUID().uuidString.lowercased()`。

### 上传网页和截图

有文件时使用 `multipart/form-data`。文本部分为 `turnId`、`text`、`since`；每个文件使用一个可重复的 `file` 部分。由客户端 HTTP 库生成 multipart boundary。

文件写入会话工作区根目录：路径部分和文件名前导点被剥离，名称截为最多 120 个字符，空名称被跳过。同名文件写入同一路径。文件名以 `.gz` 结尾或 MIME 类型为 `application/gzip` 时，服务端解压后保存，并去掉 `.gz` 后缀；不使用 part 的 `Content-Encoding` 判断压缩。

上传截图只会保存文件，不会自动作为图片参数注入本次模型调用。当前接口没有 `images` 字段，图片或文件上传不能代替新 turn 所需的非空 `text`。可以在提示中要求模型读取上传的文件。

已有 `turnId` 的重试不会再次写入上传文件；可用只带 `turnId` 和 `since` 的 JSON 请求重试。对于新的 `turnId`，multipart 文件写入发生在空提示和并发冲突检查之前，因此不能把 HTTP 400 或 409 理解为上传一定未产生副作用。

### 幂等与并发

| 状态 | 行为 |
|---|---|
| 没有该 `turnId`，会话空闲 | 创建 turn 并执行提示 |
| 相同 `turnId` 正在运行 | 加入该会话的实时流，不另开一轮 |
| 相同 `turnId` 已结束，会话空闲 | 补发 `since` 之后的记录，然后结束流 |
| 会话正在运行另一个 `turnId` | 409，`{ "error": "turn_in_progress", "runningTurnId": "…" }` |

新提示不能插入正在运行的轮次；客户端应排队，待流结束后再提交。同一 turn 可以有多个订阅连接，客户端负责避免重复呈现。

无效 `turnId` 返回 400 `invalid_turn_id`；新 turn 的空文本返回 400 `empty_prompt`。幂等依赖保留的 turn 行：alarm 会清理结束超过 24 小时的记录，清理后同一 ID 可能被视为新请求，不能依赖无限期去重。

## 历史与重连

```http
GET /v1/sessions/{id}/events?since=41
```

`since` 取最后收到的带 `id:` 事件的序号；服务端返回严格大于它的已存记录，按序号排序。省略时为 0。当前实现只读取查询参数，**不读取 `Last-Event-ID` 请求头**。

有 turn 运行时，补发后继续接收实时广播；会话空闲时，补发后立即发送 `stream_end` 并关闭。会话在列表查询和建立流之间结束，不会因此返回错误。

客户端保存会话级游标，只在收到带 `id:` 的帧时推进。换会话必须切换对应游标。收到 `stream_end` 后关闭是正常结束；未收到就关闭时，客户端使用保存的游标重新连接。断线期间的 token 和工具进度不回放，完成的条目可以回放。

## SSE 事件

每帧以空行结束，`data:` 是一行 JSON。序号在一个会话内递增，跨 turn 连续。带 `id:` 的事件来自持久化日志；没有 `id:` 的事件不推进游标。

| 事件 | 带 `id:` | 当前载荷 |
|---|---|---|
| `stream` | 否 | `{ events: [assistantMessageEvent] }`，pi 的消息增量 |
| `tool_start` | 否 | `{ toolCallId, name, args }` |
| `tool_end` | 否 | `{ toolCallId, name, isError }`，完整工具结果在 `entry` 中 |
| `entry` | 是 | 原始 pi `SessionEntry`；可能包含消息、模型切换或压缩等条目 |
| `turn_end` | 是 | `{ turnId, reason, out }` |
| `error` | 是 | `{ turnId, code, message, retryable }` |
| `stream_end` | 否 | `{ sessionBusy: false }`，连接结束 |

`reason` 为 `completed`、`aborted` 或 `failed`。一次历史回放可能包含多个 `turn_end`，它们都不是连接结束信号。

事件日志支持 `out_file`，但当前执行路径没有发布它；也没有独立发布 `tool_update` 或 `compaction` 事件。客户端不能依赖这些进度通知。`entry` 没有统一添加服务端 `turnId` 包装，也没有经过面向用户的文本投影；不能把所有条目直接当作聊天正文。

### 产物

成功轮次的实时 `turn_end.out` 收集 `/out` 下的直接子文件，按路径排序。每项包含 `path`（如 `out/widget.html`）、`bytes`、`sha256` 和 UTF-8 解码的 `content`。没有大小阈值，也不递归收集子目录。

事件日志只保存 `path`、`bytes`、`sha256`，**历史回放不会补上 `content`**。服务端也没有独立的文件下载端点。因此客户端需要在实时接收时保存产物；错过实时结果或换设备后，目前不能仅靠历史接口取回文件内容。二进制产物不能依赖 UTF-8 `content` 无损交付。

### Widget 文件与截图

widget 构建的交付文件为 `out/extra.js`、`out/widget.html`、`out/meta.json`。普通对话不要求产生文件；`reason: completed` 表示 turn 执行结束，不代表所有 widget 质量检查通过。传输层仍收集 `/out` 的直接子文件，三文件要求由 prompt、预览和 CLI 保存校验执行。

`meta.json` 只有 `size`，例如 `{"size":"middle"}`，有效值为 `small`、`middle`、`large`。明确指定尺寸时遵从用户；首次没有指定时，模型按所需内容选择能清晰呈现的最小尺寸，后续修改保留该尺寸，除非用户或内容需求改变。自动选择是模型判断，不保证每次任务得到相同档位。

| size | 参考预览画布（CSS px） | 常见内容 |
|---|---|---|
| small | 160 × 160 | 单个指标、状态或简短摘要 |
| middle | 344 × 160 | 多个指标、紧凑对比或少量条目 |
| large | 344 × 360 | 较长列表或多个内容组 |

尺寸由 [widget-contract.ts](../backend/src/widget-contract.ts) 定义，是项目预览基准。HTML 自适应客户端实际 viewport；客户端选择对应的 iOS widget family，设置 WebView 画布与截图缩放倍率。`#widget-root` 从 `(0, 0)` 铺满画布，不靠滚动展示内容，也不以三档基准值硬编码根宽高。

`extra.js` 是可直接执行的同步脚本，整个文件采用立即执行函数表达式（IIFE），例如 `(() => { /* 从 document 提取 */ return data; })()`。客户端执行整份脚本后直接得到 JSON 对象，不需要先注册函数、传参或再调用命名函数。返回对象本身，不返回 JSON 字符串、Promise、函数或 DOM 节点；内部字段只使用 JSON 值，缺值用 null，保留数值零。

脚本直接读取源网页的 `document`，变量留在 IIFE 内，可重复执行。它不修改网页、不发网络请求、不执行捕获 HTML 中的脚本，也不负责写文件；客户端将执行结果序列化为 data.json。

`widget.html` 使用内嵌 CSS 和 JS，定义同步函数 `window.renderWidget(data)`。每次调用替换当前内容；数据结构由同一 bundle 的提取和渲染脚本共同约定。页面每次加载时通过 `fetch('./data.json', { cache: 'no-store' })` 获取同目录数据，检查 HTTP 状态、解析 JSON 后渲染。HTML 不内嵌捕获数据或使用写死的数值兜底；源文本作为文本写入 DOM，widget 页面不加载 `extra.js`。

客户端在原网页 WebView 中直接执行 `extra.js` 的完整内容，将执行返回的对象序列化为同目录的 `data.json`。随后启动本地 HTTP server，以 HTTP URL 打开 `widget.html`。`data.json` 是客户端运行时文件，不属于服务端交付的三个文件；下载 HTML 后仅用 file:// 打开不属于受支持的数据加载流程。

HTML 在同步初始化时公开 `window.widgetReady` Promise，只有数据请求、JSON 解析和渲染完成后才 resolve。HTTP、网络、JSON 或渲染失败时，在原尺寸内显示静态错误状态并 reject，不能回退到捕获时的数据；页面附加 rejection handler，避免未处理异常，同时保持该 Promise 的拒绝状态。客户端等待 `widgetReady` 成功以及字体、图片加载完成后截图。刷新由客户端更新文件并重新加载页面触发，不轮询、不自动重试。

生成页面用于静态截图：禁止 CSS/JS/SVG 动画、过渡、动图、视频、定时刷新或依赖点击、hover、滚动的内容。除同目录 data.json 外，所需样式、脚本和静态图片均内嵌，不依赖远程资源。

`preview_widget` 在独立浏览器页面中用 DOMParser 解析 `/source.html`，将捕获文档绑定为 document，直接求值整份 extra.js 并读取完成值，将结果作为同源 `/data.json` 的 HTTP 响应。预览按 metadata 设置画布，等待 widgetReady（最多 15 秒），要求实际发生数据请求，再检查数据渲染一致性、重复渲染、根边界、溢出和可检测的动画声明。截图保留页面实际加载后的状态，后续诊断调用不能替页面补好截图。完整提取 JSON 写到工作区 `/widget-preview-data.json` 供模型检查字段，该临时文件不交付。单次预览不能穷尽任意 JS 定时行为或动图，也不能证明每个字段都来自正确的源区域；Chromium 结果不能替代 WKWebView 真机验证。

### 错误与中止

流开始前的请求错误通过 HTTP 状态返回；流中的执行错误通过 `error` 返回。当前执行失败路径随后发送失败的 `turn_end`，最后发送 `stream_end`。

| `code` | 当前用途 |
|---|---|
| `llm_failed` | turn 执行捕获的异常，不仅限于模型响应错误 |
| `turn_timeout` | alarm 检查到无进展的 turn 超过最长时限 |
| `recovery_exhausted` | 无进展的 turn 已达到恢复次数上限 |
| `internal` | 类型中保留，当前执行路径未主动发送 |

客户端依赖 `code` 和 `retryable`，不要解析 `message` 判断行为。决定重做已失败的请求时使用新的 `turnId`。工具失败可作为工具结果交给模型继续处理，不一定终止整轮。

`POST /v1/sessions/{id}/abort` 在有运行中 turn 时返回 200 `{ "aborted": "<turnId>" }`，记录 `reason: "aborted"` 的 `turn_end`，关闭订阅流；空闲时返回 409 `no_running_turn`。当前处理器没有取消底层模型任务，后台执行仍可能继续写入，不应把这个响应当作停止所有副作用的保证。

## 当前接入限制

除上面的认证、产物恢复和取消限制外，[Hub](../backend/src/do/hub.ts) 每个订阅者最多排队 64 次未完成写入，历史补发也经过此队列。大量积压可能截断回放并遗漏 `stream_end`；客户端重连不能替代服务端对长历史交付的修复。生产接入需验证长会话、后台恢复和真实 WKWebView 行为。
