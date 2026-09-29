# webclip_widget

把一个网页转成 widget 的 agent 服务端。[pi coding agent](https://github.com/earendil-works/pi) 作为 SDK 跑在 Cloudflare Workers + Durable Objects 上，**工具全部在服务端执行**——客户端是 iOS app，不保证在线。

设计与取舍记录在 [`.agents/notes/implemented/`](.agents/notes/implemented/)。本文件只讲怎么跑起来。

## 形状

```
iOS app ──HTTP/SSE──► Worker ──► UserAgentDO（每用户一个）
                                   ├── pi AgentSession      编排
                                   ├── SQLite               会话、事件日志、工作区
                                   ├── just-bash            grep / rg / find / sed / awk / jq
                                   ├── Browser Run          preview_widget
                                   └── alarm                turn 保活 + 中断检测
```

工作区是 DO SQLite 里的虚拟文件系统，按 512 KB 分块。**分块对 `IFileSystem` 以上不可见**：`readFileBuffer` 先拼回完整字节，因此块大小影响不了任何命令的正确性。

## 接口

```
POST   /v1/sessions                      建空会话 → { sessionId }
GET    /v1/sessions                      列表（busy 由 turns 推导）
DELETE /v1/sessions/{id}                 删除，连同工作区与日志
POST   /v1/sessions/{id}/prompt          启动 turn → 200 text/event-stream
GET    /v1/sessions/{id}/events?since=   补发 since 之后；有 turn 在跑则接上
POST   /v1/sessions/{id}/abort           中止
```

每个请求带 `authorization: Bearer <AUTH_TOKEN>` 与 `x-webclip-user: <id>`。

**首轮用 `multipart/form-data` 上传网页**，`file` 部分可重复，`.gz` 后缀或 `application/gzip` 会被解压后落盘。后续轮次用 JSON。

`turnId` 由客户端生成，必须是小写 UUIDv4。它保证的性质是「同一次提交的重试给出同一个 id，不同的提交给出不同的 id」——**不能用计数器**：客户端重装后计数归零，可能命中幂等窗口内的已完成 turn，使用户的新输入被静默吞掉。

## SSE 事件

带 `id:` 的推进 `Last-Event-ID`，不带的不推进。增量因此不会让重连从一条消息的中间开始。

| `event:` | `id:` | 用途 |
|---|---|---|
| `stream` | 否 | token 与思考增量，渲染用 |
| `tool_start` / `tool_end` | 否 | agent 在做什么 |
| `entry` | 是 | 完成的消息、工具调用、工具结果 |
| `out_file` | 是 | `/out` 下的文件被写入 |
| `turn_end` | 是 | 一轮结束，**实时版内联产物内容** |
| `error` | 是 | 本轮失败，`code` 取自封闭集合 |
| `stream_end` | 否 | 连接终止符 |

**客户端只看 `stream_end` 决定是否重连**：收到它之后关闭是干净结束；未收到就关闭是掉线，带 `Last-Event-ID` 回来。

产物落盘时只留 `path` / `bytes` / `sha256`，回放时由投影从工作区读当前内容——历史因此不随迭代轮数膨胀。

## 本地运行

```bash
npm install
cp .dev.vars.example .dev.vars   # 填 LLM_BASE_URL / LLM_API_KEY / AUTH_TOKEN
npm run dev
```

```bash
npm run check        # typecheck + 测试 + Agent Note 门禁
npm test             # 71 条，跑在真实 workerd 里
npm run typecheck
```

## CLI

同一个工具承担两件事：端到端检查的夹具，以及 iOS app 就绪之前驱动服务端的手段。

```bash
export WEBCLIP_URL=https://…  WEBCLIP_TOKEN=…  WEBCLIP_USER=me

npm run cli -- new "某个页面"          # 建会话
npm run cli -- prompt <session> "…"    # 跑一轮，流式打印
npm run cli -- chat                    # 连续对话，每行一轮
npm run cli -- chat <session>          # 接着已有会话聊
npm run cli -- events <session> 0      # 回放并跟随
npm run cli -- sessions                # 列表
npm run cli -- abort <session>
```

`chat` 里以 `/` 开头的行是命令，其余按原文发送；想发以斜杠开头的文本就写 `//`。

| 命令 | 作用 |
|---|---|
| `/help` | 列出全部命令 |
| `/list` | 所有会话，当前一条标 `*` |
| `/new [title]` | 新建并切过去 |
| `/switch <session>` | 切到已有会话 |
| `/session` | 当前会话、游标、暂存文件 |
| `/history [since]` | 回放本会话的日志 |
| `/file [path\|clear]` | 为下一条消息暂存文件 |
| `/gzip` | 切换上传是否压缩 |
| `/abort` | 中止正在跑的轮次 |
| `/rm [session]` | 删除会话，默认当前 |
| `/quit` | 退出 |

命令表是唯一的清单，`/help` 由它生成，因此不存在未记录的命令，也不存在记录了却不存在的命令。切换会话会把游标归零：序号只在产生它的那条日志里有意义。


**首轮带上网页与截图**：

```bash
npm run cli -- prompt <session> \
  --file ./source.html --file ./screenshot.png --gzip \
  "读 source.html，把报价做成 widget"
```

`--file` 可重复，文件写入工作区根目录：路径中的目录部分会被剥掉，`./a/b/source.html` 落成 `/source.html`，所以提示词里直接按文件名引用。`--gzip` 只压缩文本类扩展名——服务端解压后再落盘，因此 `grep` 看到的是真实字节；PNG 之类不会被再压一遍。

### 指向本地

```bash
npm run dev    # 另开一个终端

export WEBCLIP_URL=http://localhost:8787
export WEBCLIP_TOKEN=$(grep AUTH_TOKEN .dev.vars | cut -d= -f2-)
export WEBCLIP_USER=me
npm run e2e
```

`.dev.vars` **必须包含 `AUTH_TOKEN`**，否则本地服务对所有请求返回 503——密钥未配置时它失败关闭，不会放行。

```bash
npm run e2e                  # 端到端检查，约 20 秒
WEBCLIP_SLOW=1 npm run e2e   # 额外跑保活用例，需 2–5 分钟
```

`e2e` 打的是**真实服务与真实模型**，断言全部关于协议行为——断线重连有无缺口、重放是否开新轮、回放是否携带产物内容——**从不断言模型说了什么**，那不可复现。

保活用例默认跳过，因为它需要一轮超过 70 秒的模型时间。它会**自证跑过了死线**：turn 若短于 70 秒即判失败，因为那个时长本就不会触发驱逐，通过也说明不了任何事。

`preview_widget` 在本地需要 miniflare 下载 Chromium。**本机若是 Apple Silicon 可能拿到架构不匹配的二进制**（`spawn Unknown system error -88`），该能力只能在部署后验证。

## 部署

```bash
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put LLM_API_KEY
npx wrangler secret put LLM_BASE_URL
npx wrangler deploy
```

**不要在 `wrangler.jsonc` 的 `vars` 里声明这三个**：空值会覆盖 secret。

## 已知缺口

- **`userId` 未经校验。** 持有 token 者可读写任意用户的会话；用户之间的边界目前不是安全边界。
- **系统提示词只有骨架。** `BriefProvider` 固定了接口，内容是单独的工作。它的 `system()` 必须对同一 `sessionId` 逐字节稳定——上游按前缀匹配缓存，时间戳或依赖迭代顺序的拼装会让每一轮都未命中，而症状只是账单变贵、首 token 变慢。
- **一轮进行中不支持插入新提示**，返回 `409`，客户端本地排队。
- **渲染成功不等于 widget 正确。** `preview_widget` 抓得到语法错误、未捕获异常与加载失败，抓不到「渲染出来了但数字是编的」。
- **目标运行环境是 iOS 的 WebView，而 Browser Run 是 Chromium。** 截图是近似，没有任何服务端方案能验证 WKWebView 的真实行为。
