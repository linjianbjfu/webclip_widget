# Agent Note: 后端架构——pi 接入、会话管理、存储与客户端协议

Status: proposed

## 问题

[工作区文件系统与工具执行层](2026-09-28-server-workspace-filesystem.md)定下了工具跑在哪、文件存在哪。本篇定其余部分：pi 怎么接进 Workers、会话与 turn 怎么管、SQLite 里放什么、以及 iOS 客户端用什么协议连上来。

约束与那篇相同，核心仍是一条：**客户端不保证在线**。这条对本篇的影响比对文件系统更直接，因为它同时决定了三件事的形状——一轮 turn 在客户端消失后能否跑完、重连后如何补齐、以及传输层该选什么。

有一条平台事实是全部设计的地基，且与直觉相反：

> Durable Object 的保活规则中，出站 TCP 与出站 WebSocket 会延缓驱逐，但**普通 `fetch()` 子请求不会保活 Durable Object，即使响应体仍在流式返回**。

调 LLM 用的正是普通 `fetch()`。因此一轮正在进行的 turn 本身不能阻止 DO 被驱逐。

### 实测：无保活的 detached 任务在 70 秒被杀

先定义两个词，后文反复使用：

- **detached 任务**：已经启动、仍在运行，但**没有任何入站请求在等它**的异步任务。典型形态是处理器排好一个 `setTimeout` 链或启动一个 Promise 后立即返回响应——请求几毫秒就结束了，任务却还要跑几分钟。
- **保活**：能重置 DO 不活跃计时器的东西。只有三类：在途的入站请求、排着的 alarm、活动的出站 TCP 或出站 WebSocket。**普通 `fetch()` 不在其列**（见上）。

平台并不跟踪"某个任务是否还在跑"。判断驱逐时它只看上述三项，一个仍在排队的 `setTimeout` 链既不是请求也不是事件，因此不计入。"detached" 是本文的说法，从平台视角那个 Durable Object 就是闲着。

值得注意的是 `setTimeout` **并非完全不可见**——它出现在休眠的判定条件里，而休眠与驱逐是两套机制：

| | 触发条件 | 时间 | 后果 |
|---|---|---|---|
| 休眠 | 无 `setTimeout`/`setInterval`、无在途 `fetch()`、无标准 WebSocket API、无在处理的请求或事件、无出站长连接 | 10 秒 | 移出内存，WebSocket 保持连接，**不计费** |
| 驱逐 | 无入站请求或事件，且无出站 TCP / WebSocket | **70–140 秒** | 完全移出，运行中的一切消失 |

一个 `setTimeout` 链让 DO **过不了休眠**，却**挡不住驱逐**，于是落进最差的组合：`idle, in-memory, non-hibernateable`——持续计费，70 秒后仍被杀。既花了钱又没保住任务。

这也解释了 alarm 为什么有效：它保活靠的不是"有东西在跑"，而是**每次触发都构成一次入站事件**，把不活跃计时器重置掉。

一轮 turn 必然是 detached 的：`runTurn` 不能被 await，否则响应要等整轮结束才返回，流式就不存在了。因此问题变成"它靠什么活着"。

部署到生产实测（`setTimeout` 循环每 5 秒写一条心跳，期间对该 DO 零入站请求、零 alarm、零出站长连接）：

| 场景 | 心跳数 | 存活时长 | 最大间隔 |
|---|---|---|---|
| 无保活 | 15 | **70 秒** | 5,000 ms |
| 每 30 秒一次 alarm | 61 | **300 秒（跑满）** | 5,000 ms |
| SSE 响应持续打开 | 61 | **300 秒（跑满）** | 5,000 ms |

基线组的心跳间隔全程稳定在 5 秒后**硬停**，不是逐渐降速；文档给的窗口是 70–140 秒，实测踩在下限。agent 的一轮 turn 是 1–5 分钟，因此"无保活的 turn 活不过 70 秒"是默认结局而非边角情况。

落到本设计上：**客户端连着时，SSE 那条响应就是在途入站请求，顺带托住了 DO**；客户端一断（iOS 进后台即会发生），这层保护随响应一起消失，turn 在 70 秒后被杀。保活 alarm 存在的意义就是补上这段——alarm 的触发本身是一次入站事件，与客户端在不在线无关。

**两种保活都有效**，这决定了下面的设计：turn 的持久性**首先来自主动保活**，增量持久化与恢复退居为硬故障（代码部署、运行时重启、崩溃）的兜底。

## 方案

本篇的验收标准如何分层承担，见[测试策略](../testing/2026-09-28-test-strategy.md)。

### 组件切分

```
iOS app
  │  POST  /v1/sessions/{id}/prompt   ──►  响应体即 SSE 流，从第一个 token 起
  │  POST  /v1/sessions/{id}/abort
  │
  │  GET   /v1/sessions/{id}/events?since=   仅断线重连时使用
  ▼
Worker（无状态）            鉴权 → 解析 userId → 路由到 DO
  ▼
UserAgentDO（idFromName(userId)）
  ├── pi AgentSession × N        编排
  ├── SQLite                     会话、条目日志、工作区
  ├── just-bash/browser          工具执行（见文件系统篇）
  ├── Browser Run                preview_widget（见文件系统篇）
  └── alarm                      turn 期间保活 + 中断检测（同一个槽位）
```

一个用户一个 DO，与 edge-mac-widget 相同。DO 的单写者语义天然匹配"一个用户的会话集合"。

### pi 接入

[edge-mac-widget](../../../../AGENTS.md#参考实现edge-mac-widget) 已经在 Workers 上把 pi 跑通过，其中若干条是踩出来的，直接复用，不重新推导：

| 事项 | 做法 | 为什么 |
|---|---|---|
| TypeBox JIT | 独立模块里 `Settings.Set({ useAcceleration: false })`，且在任何 pi 模块之前求值 | pi 用 `Compile()` 校验工具参数，内部走 `new Function`，Workers 抛 `Code generation from strings disallowed`，表现为**所有**工具调用失败 |
| `import.meta.url` | `wrangler.jsonc` 的 `define` 里给一个常量 | pi 的 `config.ts` 在模块作用域调 `fileURLToPath(import.meta.url)`，打包后为 `undefined`，Worker 一启动就崩 |
| 会话存储 | `SessionManager.inMemory()` + 增量落盘 | Workers 的 `node:fs` 是按请求隔离的内存 VFS，文件版 SessionManager 不可用 |
| 落盘触发 | 自持 `SessionManager` 引用，在 `message_end` / `turn_end` / `tool_execution_end` / `compaction_end` 后 drain `getEntries()` | `entry_appended` **只在扩展调用 `pi.appendEntry()` 时触发**，不是通用持久化钩子；订阅它会得到一个空的 SQLite |
| 落盘游标初值 | `history.length > 0 ? getEntries().length : 0` | 每次打开会话 pi 都会写入 `model_change` / `thinking_level_change` 两条引导条目。新会话必须落盘它们，恢复的会话必须跳过。恒为 `length` 会导致恢复时读不到模型与思考等级并静默回退；恒为 0 会每恢复一次重复追加两条 |
| 扩展 | `noExtensions: true` | jiti 动态加载 TS 在 Workers 不可用 |
| 模型接入 | `ModelRuntime.create({ credentials: InMemoryCredentialStore, modelsPath: null })`，只注册当前选中的 provider | 全内存，密钥留在 Workers Secret；未使用的 provider 无需配置 key |
| 工具环境 | 只转发 `PI_*` 前缀的变量 | `nodejs_compat` 把 secrets 一并填进 `process.env`，pi 的 bash 工具用 `getShellEnv()` 构造子进程环境——原样转发等于把网关 key 交出去 |

#### 系统提示词留作独立工作

pi 的会话需要一份 operating brief——告诉模型怎么读 HTML、怎么定位选区、怎么写 XPath 兜底、怎么避免编造数据。edge-mac-widget 的对应文件有 818 行，其质量直接决定产品好坏：本篇与文件系统篇记录的"渲染成功不等于数字正确"那类风险，防线全在这里。

**本版本不设计提示词内容，只固定它的接口**：

```ts
interface BriefProvider {
  /**
   * 会话级系统提示词。provider 不支持 system role 时由调用方降级为首条 user 消息。
   *
   * 对同一个 sessionId 必须逐字节稳定——上游的 prompt 缓存按前缀匹配，
   * 任何时间戳、随机标识或依赖迭代顺序的拼装都会让每一轮都未命中。
   */
  system(ctx: { sessionId: string; workspaceRoot: string; outDir: string }): string
  /** 从条目中剥除 brief，供历史投影使用。 */
  strip(text: string): string
}
```

`system()` 与 `strip()` 必须成对：投影依赖 `strip` 把 brief 从首条用户消息里摘干净，否则恢复的客户端会看到服务端提示词。实现阶段可从 edge-mac-widget 的版本裁剪起步，但那份文本是为"工具在客户端执行"写的，涉及本机路径与 shell 能力的段落不适用。

与 edge-mac-widget 的**唯一结构性差异**：那边通过 WebSocket RPC 把 `*Operations` 指向客户端，这边指向同进程的 DO SQLite 文件系统。pi 的这层 seam 不变，换的只是另一端。

### 存储布局

```sql
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  title          TEXT,
  model          TEXT,
  thinking_level TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
-- 故意没有 status 列：会话是否繁忙由 turns 推导
--   SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'
-- 冗余存一份必然与 turns 漂移，而漂移的症状是会话卡在 running 再也发不了 prompt。

-- 协议事件日志。唯一的有序日志，`seq` 是 SSE `id:` 与续传游标的来源。
-- pi 条目是其中一种记录，不是全部：out_file / turn_end / error 由本服务产生，
-- pi 并不知道它们，但它们同样需要 seq 才能参与续传。
CREATE TABLE events (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,   -- 会话级单调递增，服务端分配，跨 turn 连续
  turn_id    TEXT NOT NULL,      -- 产生该记录的 turn，供客户端分组
  kind       TEXT NOT NULL,      -- 'pi_entry' | 'out_file' | 'turn_end' | 'error'
  payload    TEXT NOT NULL,      -- kind='pi_entry' 时是 pi 的原始 SessionEntry，逐字保存
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX events_pi ON events (session_id, kind, seq);

-- 每一轮 turn，进行中与已结束的都保留。
-- 已结束的行不能立刻删除：幂等窗口内仍需据其回答迟到的重试。
CREATE TABLE turns (
  session_id       TEXT NOT NULL,
  turn_id          TEXT NOT NULL,     -- 客户端生成的 UUIDv4，session 内唯一
  status           TEXT NOT NULL,     -- running | completed | aborted | failed
  started_at       INTEGER NOT NULL,
  last_progress_at INTEGER NOT NULL,
  ended_at         INTEGER,
  prompt           TEXT NOT NULL,     -- 原始输入，用于中断后重放这一轮
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX turns_by_status ON turns (session_id, status);

-- 工作区。每个会话一份，互不可见。见文件系统篇。
CREATE TABLE files (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mode       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  UNIQUE (session_id, path)     -- 不是 path 全局唯一：一个 DO 装同一用户的多个会话
);
CREATE TABLE chunks (file_id INTEGER, idx INTEGER, data BLOB, PRIMARY KEY (file_id, idx));
```

**只有一份有序日志，就是 `events`。** 客户端看到的历史是它的投影，不是第二份存储。

恢复 pi 会话时只读 `kind = 'pi_entry'` 的记录（`events_pi` 索引为此存在），其余记录不参与上下文重建——它们是协议层的事实，不是对话的一部分。反过来，续传读全部记录，因为客户端需要它们。

这与[下面否决的](#曾考虑的替代方案)"单独建表持久化 token 增量"不冲突：那条否决的是**增量**（一轮几千条），这里是每轮几条协议事件，量级相差三个数量级。

这与 edge-mac-widget 的做法一致：`HistoryMessage` 是 `StoredEntry` 的投影，投影时剥掉藏在首条用户消息里的 operating brief，使恢复的客户端永远看不到服务端的系统提示词。

### 不持久化 token 增量

一个看似自然但错误的设计是把每个 `text_delta` 也写进日志，让客户端能从任意字节续上。**不这么做。**

增量是渲染用的瞬时数据，不是会话事实。真正的事实是完成后的消息、工具调用与工具结果——它们本来就作为 pi 条目落盘了。`text_delta` 与那条条目是**同一份内容的两种形态**：

```
LLM 流式返回
   ├─→ text_delta ×N   推给当前连着的客户端，渲染用
   └─→ message_end     pi 写入完整 SessionEntry → 落盘 → GET /history 读它
```

因此 `GET /history` 不需要也不应该累加增量。edge-mac-widget 的 `toHistoryMessages` 正是这样做的：输入是 `StoredEntry[]`，直接从 `entry.message.content` 抽取完整正文，不经过任何增量累加。自行 merge 会把 pi 已经给出的内容重拼一遍，且拼出的版本可能与 pi 的不一致——thinking 块与工具调用的结构化参数并不出现在 `text_delta` 里。

因此：

- **turn 进行中**：增量以合帧形式推给当前连着的客户端，不落盘、不保证送达
- **完成单元**（`message_end` / `tool_execution_end` 等）：作为 pi 条目落盘，带 `seq`
- **客户端重连**：按 `seq` 补齐已完成的条目，然后接上当前的实时增量

**thinking 同理，且这一点关系到上游的 prompt 缓存。** `thinking_delta` 不落盘，但 thinking **内容**落盘——它是 pi 消息 content 里的一个 part：

```ts
interface ThinkingContent {
  type: "thinking"
  thinking: string
  thinkingSignature?: string   // 供多轮延续时回传给 API
  redacted?: boolean
}
```

恢复会话走的是 `buildSessionContext(原始条目)`，不经过任何投影，因此 thinking 与其签名原样回到上下文，发给上游的请求与当初一致，缓存前缀不因恢复而断裂。客户端历史里看不到 thinking，那是投影所为（`contentText` 只取 `type === "text"`），只影响客户端呈现，不影响喂给模型的那一路。

这意味着**续传粒度是条目而非 token**：断线期间半截的消息，客户端要等它完成才看得到。对一个本来就会离线几分钟的移动端，这是正确的取舍——它需要的是结果，不是错过的字。代价是省掉了数量级更高的写入。

**被中断的半截消息不落盘，靠重发补回。** DO 若在消息流到一半时被驱逐，`message_end` 未触发、条目未写入，已经推给用户的那部分正文丢失；看门狗恢复时重发该次 LLM 调用，消息重新生成。

这是有意为之：一条截断的 assistant 消息不应进入对话历史，否则后续推理会建立在模型没说完的句子上。持久化半截消息只是把一个 UX 瑕疵换成上下文污染。

### prompt 缓存的前缀稳定性

上游的 prompt 缓存按**前缀逐字节相同**命中。恢复会话本身不破坏它（见上），但有四件事会：

| 威胁 | 后果 |
|---|---|
| operating brief 不稳定 | 每一轮都未命中 |
| 工具定义变更 | 一次部署作废全部在跑会话的缓存 |
| 切换 provider 或模型 | 必然失效 |
| 缓存 TTL 过期 | 隔时较久恢复的会话无论如何都是冷的 |

**第一条是唯一完全由本设计控制、且最容易无意引入的。** 它不报错、不产生错误结果，只表现为账单变贵与首 token 变慢，因此可能很久无人察觉。

因此给 `BriefProvider.system()` 加一条契约：**对同一个 `sessionId`，它必须逐字节稳定**。具体禁止的是时间戳、随机标识、以及任何依赖迭代顺序的拼装（例如遍历 `Map` 或 `Set` 生成工具清单）。若 brief 需要随会话变化的信息，该信息必须来自入参且本身稳定。

后三条不由本设计承担，但需要在切换 provider 或改动工具定义时**预期到一次缓存冷启**，不要把随之而来的延迟上升误判为性能回归。

### turn 的持久性

分两层：**主动保活**防止 turn 中断，**恢复**兜住保活失效的情况。

#### 第一层：turn 期间的保活 alarm

1. `POST /prompt` 写入 `turns` 行（`status = running`，含原始 prompt），排一个 **30 秒后的 alarm**，随即启动 turn 并返回 SSE 流
2. alarm 每次触发：若该会话仍有 `status = running` 的 turn，就**再排下一个 30 秒 alarm**
3. turn 结束：把该行置为 `completed` / `aborted` / `failed` 并填 `ended_at`，**不再续排 alarm**

第 3 步**改状态而不是删行**——幂等窗口内仍要靠这一行回答迟到的重试。删除由单独的清理路径按保留期执行。

alarm 的触发本身就是一次入站事件，足以重置不活跃计时器——实测 61 次心跳跑满 300 秒即为此机制。客户端在线时 SSE 的在途请求同样保活，两者叠加而不冲突。

这一层的收益是**消除中断**：不中断就没有重发、没有重复计费、没有"正文流到一半消失又重新生成"的 UX 瑕疵。

turn 结束后不再续排 alarm，DO 随即进入正常驱逐路径，空闲不计费。

#### 第二层：恢复

保活挡不住全部情况——代码部署会强制重启 DO，运行时也可能因平台原因迁移实例。因此仍需恢复路径：

1. 每落盘一批条目，更新 `turns.last_progress_at`
2. alarm 触发时若发现 `status = running` 但 `last_progress_at` 已陈旧（超过若干个 alarm 周期），说明该轮已经中断
3. **从已落盘的条目重建会话上下文并继续这一轮**，而不是直接判失败

由于第一层已经把中断变成罕见事件，这条路径的触发频率应当很低；**恢复次数是一个需要监控的指标**，持续升高说明保活失效。

#### 一个 alarm，两个职责

保活与看门狗**共用同一个 alarm 槽位**（DO 只有一个）。每次触发做两件事：检查是否需要恢复，然后续排下一个。不要为两个目的分别 `setAlarm`——后写的会覆盖先写的。

重建走的正是恢复会话那条路（读回条目 → 线性重链 `parentId` → `buildSessionContext()`）——恢复机制只有一套，不为中断另写一套。

### 与客户端的通信

见下面的协议一节。结论是 **SSE + 普通 HTTP**，且**流是 turn 作用域的**：只在一轮 turn 进行期间保持连接，空闲时不挂着。

```
POST   /v1/sessions                      创建空会话，初始化工作区 → { sessionId }
GET    /v1/sessions                      列表
DELETE /v1/sessions/{id}                 删除会话，连同其工作区与条目
GET    /v1/sessions/{id}/history?since=  历史（条目投影）
POST   /v1/sessions/{id}/prompt          启动 turn → 200 text/event-stream；首轮在此上传 source 与截图
GET    /v1/sessions/{id}/events?since=   断线重连；turn 已结束时补发后立即关闭
POST   /v1/sessions/{id}/abort
```

**本版本不做鉴权。** `userId` 暂由请求头直接给出，Worker 不校验。这是一个明确的临时状态，不是疏漏——见[风险](#风险)。

**`POST /prompt` 直接返回 SSE 流，而不是返回 `202` 再让客户端另开一条 GET。** 后者存在一个真实的竞态：两步之间产生的 token 增量会丢失——因为增量不落盘（见上一节），客户端会看到一条消息的开头不是流进来的，而是等整条完成后突然出现。发起与接收合并为同一个请求，这个窗口从根上不存在。

浏览器的 `EventSource` 只支持 GET，但本项目的客户端是 iOS：`URLSession.bytes(for:)` 对 POST 同样适用，且 SSE 解析本来就要自己写，不依赖 `EventSource`。

`GET /events` 只用于**断线重连**。SSE 每条事件带 `id: <seq>`，重连时客户端带上 `Last-Event-ID`（或等价的 `since=`），服务端据此补发已完成的条目——这正是 edge-mac-widget 手工实现的 `sinceSeq` 游标，只不过由协议本身定义了语义。

#### `POST /sessions`：建会话并初始化工作区

```http
POST /v1/sessions
Content-Type: application/json

{ "title": "某某股票页面" }        // 可选
```

返回 `201` 与 `{ "sessionId": "…" }`。服务端在此创建会话行并初始化该会话的空工作区（建立 `/out` 目录约定），**不接收任何网页内容**——source 与截图随首轮 prompt 上传。

这样切分的理由：会话创建是轻量的、可重试的；而上传是重活。把两者合并会让创建端点也要处理 multipart、gzip 与幂等，而失败重试的语义完全不同（建会话重试会产生多余的空会话，上传重试必须幂等）。

一个会话对应一个剪藏任务。**若用户要换一个网页，新建会话**，而不是在原会话里替换 source——工作区里已有的中间产物与 `/out` 对新网页没有意义，复用只会让上下文混淆。

#### `POST /prompt` 的请求与响应

纯文本的后续轮次用 JSON：

```http
POST /v1/sessions/{sessionId}/prompt
Content-Type: application/json

{
  "turnId": "9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01",
  "text":   "把折线图改成柱状图",
  "since":  41
}
```

**首轮携带网页内容时用 `multipart/form-data`**，`request.formData()` 在 Workers 原生可用：

```http
POST /v1/sessions/{sessionId}/prompt
Content-Type: multipart/form-data; boundary=…

--…
Content-Disposition: form-data; name="turnId"
9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01
--…
Content-Disposition: form-data; name="text"
把这个页面做成 widget
--…
Content-Disposition: form-data; name="file"; filename="source.html"
Content-Type: text/html
Content-Encoding: gzip          ← 可选，服务端按此解压
<gzip 字节>
--…
Content-Disposition: form-data; name="file"; filename="screenshot.png"
Content-Type: image/png
<png 字节>
--…
```

每个 `file` 部分被写入该会话工作区的根目录（`source.html`、`screenshot.png`）。**截图同时作为图片输入进入模型上下文**，不只是工作区里的一个文件。

**用 gzip，不用 zip。** `DecompressionStream("gzip")` 在 Workers 原生可用（已实测：30 KB 的重复 HTML 压到 87 字节，往返无损），而 zip 是容器格式，需要自行解析中央目录、引入依赖。多个文件由 multipart 承载，不需要再套一层归档。

体积不成问题：Workers 的入站请求体上限为 100 MB（Free/Pro），而输入是 5 MB 量级的 HTML 加一张截图。

| 字段 | 必填 | 说明 |
|---|---|---|
| `turnId` | 是 | 客户端生成的 **UUIDv4**，小写带连字符的标准形式。服务端在 session 内查找；客户端须保证「同一次提交重试给出同一个 id」在本地状态丢失后仍成立——见下 |
| `text` | 二选一 | 提示文本；与 `images` 至少有其一非空 |
| `images` | 二选一 | 图片输入，沿用 edge-mac-widget 的 `PromptImage` 与其尺寸/数量上限 |
| `since` | 否 | 仅在重试时有意义：服务端从该 `seq` 之后开始补发，而不是从头。省略则视为 `0` |
| `file` | 否 | 仅 multipart 形态。可重复，每个写入工作区根目录。`Content-Encoding: gzip` 时服务端解压后再落盘 |

**重试同一个 `turnId` 时不必重传文件。** 服务端命中已有 turn 即接流，不再读取 multipart 的文件部分——这正是幂等在此处的实际价值：5 MB 的上传不会因为一次超时而重来。

模型与思考等级不在此处设置——它们属于会话，由 `POST /v1/sessions` 创建时确定，并随会话持久化。

响应恒为 `200` + `text/event-stream`，错误在流内以事件形式下发，而不是用状态码。唯一的例外是下面这些**请求本身就不合法**的情况：

| 状态码 | 条件 |
|---|---|
| `400` | `turnId` 缺失或不是合法 UUIDv4；`text` 与 `images` 同时为空 |
| `404` | `sessionId` 不存在 |
| `409` | 该会话已有**另一个** `turnId` 处于 `running`（响应体给出该 `turnId`） |

`409` 意味着 **v1 不支持在一轮进行中插入新提示**。edge-mac-widget 的协议里有 `streamingBehavior: "steer" | "followUp"`，本版本不实现：steer 会把新提示注入正在运行的那一轮，使得"一个 `turnId` 对应一轮"不再成立，条目的 `turn_id` 分组语义随之模糊。客户端在本地排队、待 `stream_end` 后再提交即可——对一个本就可能离线的移动端，本地排队是自然的做法。**若将来需要 steer，`turnId` 的语义要从"标识一轮"改为"标识一次提交"，届时条目分组需要另设字段。**

#### 产物：`/out` 目录与它的两条回传通道

agent 把最终产物写进工作区的 `/out` 目录（`out/widget.html`、`out/extra.js`）。客户端通过两条互补的通道获得它们。

**通道一：`out_file` 事件，只带元数据。**

```
id: 58
event: out_file
data: {"path":"out/extra.js","bytes":2431,"sha256":"a3f…"}
```

该事件**由文件系统层发出，不由工具层发出**。这一点是刻意的：agent 未必用 `write` 工具写文件，它完全可能用 shell 重定向（`sed … > out/extra.js`）或 `edit` 工具。挂在工具层会漏掉前者，而 `edit` 的参数是 `old_string` / `new_string`，客户端**无法据此重建文件内容**。挂在文件系统层则覆盖全部写入路径，且不依赖任何工具的参数格式。

事件不携带内容，因为 agent 会反复改：一轮里 `out/extra.js` 可能被写五次（预览、发现报错、修、再预览），内容跟着每次写入走就是把同一个文件发五遍，而只有最后一遍有用；断线重连补发时还要再发五遍。

**通道二：`turn_end` 携带最终清单，小文件内联。**

```
event: turn_end
data: {
  "turnId": "9f2c…", "reason": "completed",
  "out": [
    {"path":"out/widget.html","bytes":8120,"sha256":"…","content":"<!doctype html>…"},
    {"path":"out/extra.js",  "bytes":2431,"sha256":"…","content":"document.get…"}
  ]
}
```

**没有大小阈值，内容一律内联。** 客户端无需任何额外往返即可拿到最终产物。

**但内容不存进事件日志。** `turn_end` 落盘时只保留 `path` / `bytes` / `sha256`；`GET /history` 投影时**从工作区读取当前内容**贴上去：

```
events 表        turn_end → {path, bytes, sha256}     小记录
files / chunks   out/extra.js 的当前内容               分块存储
                          ↓
GET /history     投影时 join，把当前内容附到最后一条 turn_end 上
```

这样安排消掉了四件事：

- **不受 2 MB 行上限约束**——内容在 `chunks` 里，那套分块机制实测可承载 50 MB；若内容直接写进 `events.payload`，一个数百 KB 的 `widget.html` 就已经逼近上限
- **不需要大小阈值**——没有"超过多少就退化"的分支，也就没有那个分支的测试与失败模式
- **不需要独立的产物读取端点**——`GET /history` 永远携带当前内容
- **不需要"按路径取最新"的投影规则**——工作区里本来就只有当前版本，被取代的旧版本并不存在

最后一条是顺带的收益：上一版设计需要在投影时判断哪条 `turn_end` 是某路径的最新一条，现在这个判断消失了。

**语义随之明确：历史里的产物永远是当前状态，不是"当时那一版"的快照。** 这符合客户端的实际需要——它要的是能渲染的 widget，不是历史版本考古。若某路径在后续轮次中被删除，历史中它只剩元数据，这是忠实的呈现。

**本版本不提供独立的产物读取端点。** 两条通道已经覆盖全部场景：在线时 `turn_end` 内联，离线或换设备时 `GET /history` 携带当前内容。再加一个 `GET /out/{path}` 只是第三种拿同一份数据的方式，而多一个端点就多一套鉴权、错误处理与测试。

它在一种情况下会变得必要：**客户端只想取产物而不想拉整个会话历史**。目前没有这个需求——iOS 客户端打开会话时本来就要渲染对话。若将来出现（例如做一个"我的 widget"列表页，不展示对话），再加。

客户端可据 `sha256` 判断本地缓存是否最新，避免重复写入。

**`/out` 是强制约定而非建议。** `preview_widget` 渲染的是 `out/widget.html`；产物的判定以该目录下的实际文件为准，不以 agent 在回答里的声明为准。

#### 幂等：turnId 由客户端生成

`POST /prompt` 发出后、响应头返回前断线，是移动端的常规情形。此时客户端无法判断这一轮是否已经启动，而直接重试会开出第二轮并为同一次请求付两次 LLM 费用。

因此 `turnId` 由**客户端**生成并随请求提交，服务端据此判重：

| `turnId` 状态 | 服务端行为 |
|---|---|
| 不存在 | 启动新一轮，返回流 |
| 存在且进行中 | **不启动新轮**，把流接到该轮上 |
| 存在且已结束 | 按 `since` 补发该轮之后的条目，随即 `stream_end` 并关闭 |

客户端可以安全地重试同一个 `turnId`。重试时带上 `since` 可避免重复接收已有的条目。

**`turnId` 要保证的性质不是"唯一"，而是：同一次提交的重试给出同一个 id，不同的提交给出不同的 id。** "唯一"只是这个性质的后半；前半"重试要能对上"才是 `turnId` 存在的理由。

由此得出两条不同的义务：

- **服务端**只需在 session 内查找（`WHERE session_id = ? AND turn_id = ?`），因此唯一性范围是 session
- **客户端**必须保证上述性质在**本地状态丢失后依然成立**，因此不能使用计数器。**统一使用 UUIDv4**（iOS 侧 `UUID().uuidString` 即可，无需额外依赖）

计数器满足不了第二条，因为 **session 由服务端持有，而计数器由客户端持有，两者寿命不同**：

```
Day 1  客户端在 session "abc" 中发出 5 轮，turnId = 1..5
       服务端在幂等窗口内保留这些 turn 行

       用户重装 app：本地计数器归零，但 session "abc" 仍在服务端

       客户端拉回会话列表，用户输入新需求
       客户端发送 { turnId: "1", text: "新需求" }

服务端  命中 turn_id = "1"，status = completed
       → 按幂等规则补发那一轮的历史事件后关闭
       → 新需求从未执行，且没有任何错误
```

**用户输入被静默吞掉**，比报错严重得多。

改用服务端发号不能解决问题：客户端需要先请求一个 id，而那次请求同样可能超时——客户端依然无法判断 id 是否已生成，歧义只是从 prompt 挪到了发号。客户端生成随机值不需要往返、不需要持久化状态，天然满足该性质，与 `Idempotency-Key` 的通行做法一致。

#### 寻址：turnId 管幂等，seq 管续传

两个标识故意分开，且**生成方相反**：

| | 由谁生成 | 回答什么 | 出现在 |
|---|---|---|---|
| `turnId` | **客户端** | 这次重试是否为同一轮 | `POST /prompt` 请求体 |
| `seq` | **服务端** | 我落下了哪些事件 | SSE 的 `id:` 字段 |

客户端生成 `turnId`，因为只有它知道一次请求是不是重试；服务端生成 `seq`，因为只有它知道条目的全局顺序。客户端对 `seq` 只做原样回传，不解释其数值。

`seq` 在一个 session 内单调递增，跨 turn 连续。因此重连时客户端**按 session 寻址即可**，不需要记住自己当时在哪一轮：

```
app 启动
  → GET /v1/sessions                     看到某会话仍在跑（由 turns 推导）
  → GET /v1/sessions/{id}/events?since=41
       先补发断线期间已完成的条目，再接上实时增量
       轮结束 → turn_end 事件；连接终止 → stream_end，流关闭
```

若让客户端按 `turnId` 重连，它必须先判断自己属于哪一轮、那一轮结束没有、之后又跑了几轮；按 `seq` 则只需记住一个数字。离线时间越长，前者越容易出错。

**分组信息随数据下发，不进 URL。** 一次跨多轮的补发会把若干轮的条目混在一起，客户端仍需知道哪些属于同一轮——这由 `events.turn_id` 提供，随每条事件下发。寻址用 `session + seq`，分组用载荷里的 `turn_id`。

#### 一轮完整的线缆示例

首轮携带网页内容，到产物回到客户端为止：

```http
POST /v1/sessions/abc/prompt
Content-Type: multipart/form-data; boundary=…
  turnId=9f2c7b1e-…   text=把这个页面做成 widget
  file=source.html (Content-Encoding: gzip)   file=screenshot.png

HTTP/1.1 200 OK
Content-Type: text/event-stream
```

```
event: stream
data: {"events":[{"k":"text_delta","text":"我先读一下页面"}]}

event: tool_start
data: {"toolCallId":"t1","name":"read","args":{"path":"/source.html"}}

event: tool_end
data: {"toolCallId":"t1","name":"read","isError":false,"output":"…"}

id: 55
event: entry
data: {"kind":"tool_result","toolCallId":"t1",…}

event: tool_start
data: {"toolCallId":"t2","name":"write","args":{"path":"/out/extra.js","content":"…"}}

id: 57
event: out_file
data: {"path":"out/extra.js","bytes":2431,"sha256":"a3f…"}

id: 58
event: out_file
data: {"path":"out/widget.html","bytes":8120,"sha256":"b71…"}

id: 59
event: turn_end
data: {
  "turnId":"9f2c7b1e-…","reason":"completed",
  "out":[
    {"path":"out/widget.html","bytes":8120,"sha256":"b71…","content":"<!doctype html>…"},
    {"path":"out/extra.js",  "bytes":2431,"sha256":"a3f…","content":"document.getEl…"}
  ]
}

event: stream_end
data: {"sessionBusy":false}
```

客户端读到 `turn_end` 即把 `out[].content` 写入本地缓存，整轮结束，**没有第二个请求**。

`id: 59` 落盘时只保留 `out` 里的元数据，`content` 不进事件日志。后续 `GET /history` 回放时，投影会从工作区读取各路径的**当前**内容重新附上——因此新设备一次拉历史即可得到可渲染的 widget。

过程中的两条 `out_file` 让客户端在 turn 结束前就能显示"已生成 extra.js"。它们不带内容，因为 agent 常常反复改同一个文件（写 → 预览 → 发现报错 → 改 → 再预览），内容跟着每次写入走就是把同一个文件发很多遍。`turn_end` 的清单**只含最终版本**。

#### 事件清单

流中只出现下列事件类型。带 `id:` 的推进 `Last-Event-ID`，不带的不推进（见下）。

| `event:` | 带 `id:` | 载荷 | 用途 |
|---|---|---|---|
| `stream` | 否 | `{events:[…]}` | 合帧后的 token 与思考增量（`text_delta` / `thinking_delta`），渲染用 |
| `entry` | 是 | pi 条目的投影 | 完成的消息、工具调用、工具结果 |
| `tool_start` | 否 | `{toolCallId,name,args}` | agent 开始执行某工具——**客户端据此知道它在干什么** |
| `tool_update` | 否 | `{toolCallId,text}` | 工具的流式输出（如 bash 的 stdout） |
| `tool_end` | 否 | `{toolCallId,name,isError,output}` | 工具结束；完整结果另以 `entry` 落盘 |
| `out_file` | 是 | `{path,bytes,sha256}` | `/out` 下的文件被写入 |
| `compaction` | 否 | `{phase:"start"\|"end"}` | 上下文压缩，可能持续数秒，用于向用户解释停顿 |
| `turn_end` | 是 | `{turnId,reason,out:[…]}` | 一轮结束，携带最终产物清单 |
| `error` | 是 | 见下 | 本轮失败 |
| `stream_end` | 否 | `{sessionBusy}` | 连接终止符 |

`tool_*` 三类不带 `id:`，因为它们是同一份事实的瞬时视图——权威记录是随后落盘的 `entry`。客户端用 `tool_*` 做实时呈现，断线重连后从 `entry` 得到同样的信息，不会因为漏了 `tool_start` 而丢失状态。

#### 错误事件

```
id: 61
event: error
data: {
  "turnId": "9f2c…",
  "code":   "llm_failed",
  "message":"上游返回 429，已重试 3 次",
  "retryable": true
}
```

`code` 取自封闭集合，客户端据此决定行为，不解析 `message`：

| `code` | 含义 | 客户端应当 |
|---|---|---|
| `llm_failed` | 上游调用失败 | 提示并允许重试（新 `turnId`） |
| `turn_timeout` | 超过最长时限被强制结束 | 同上 |
| `recovery_exhausted` | 恢复次数超上限 | 同上 |
| `internal` | 未分类的服务端错误 | 提示，不自动重试 |

`error` 之后必定紧跟 `stream_end`。错误**不使用 HTTP 状态码**，因为响应头在第一个 token 之前就已发出——状态码那时还不知道。仅请求本身不合法的情况用状态码（见上表）。

工具执行失败**不产生 `error` 事件**：它作为 `isError` 的工具结果回给模型，由模型决定怎么办，整轮继续。

#### 流的终止：`stream_end` 与 `turn_end` 是两回事

一次跨多轮的补发里本来就含有多个"轮结束"，因此轮边界与流终止必须是不同的事件，否则客户端无法判断读到哪个才该停：

```
id: 55
event: turn_end               // 数据事件：某一轮结束，带 id，推进游标
data: {"turnId":"9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01","reason":"completed"}

id: 56
event: entry                  // 下一轮的条目继续
data: {…}

event: stream_end             // 终止符：无 id，不推进游标
data: {"sessionBusy":false}
```

- **`turn_end`** 是流中的一个数据事件，标记一轮结束，携带 `turnId` 与结束原因（`completed` / `aborted` / `failed`）
- **`stream_end`** 是连接的终止符，含义是"这条连接不会再有内容"

**客户端只看 `stream_end` 决定是否重连**：收到它之后关闭即为干净结束；未收到它就关闭即为掉线，带 `Last-Event-ID` 重连。缺少这个区分，客户端面对一条关闭的流无法判断该不该重试——要么无限重连一个已结束的 turn，要么在真掉线时过早放弃。

#### `GET /events` 在 turn 已结束时的行为

补发、发终止事件、关闭。**不返回错误。**

| `since=N` 时的状态 | 行为 |
|---|---|
| turn 进行中，`N` 落后 | 补发 `N` 之后的条目 → 接入实时流 → 轮结束发 `turn_end` → `stream_end` → 关闭 |
| turn 进行中，`N` 已是最新 | 直接接入实时流 → 轮结束发 `turn_end` → `stream_end` → 关闭 |
| **turn 已结束** | 补发 `N` 之后的条目（含其中各轮的 `turn_end`）→ 立即 `stream_end` → 关闭 |

三种情况对客户端是同一条代码路径。

这样设计是为了消除一个真实竞态：客户端开 app 的流程是 `GET /sessions` 看到该会话繁忙，再开 `/events`——而这两步之间 turn 完全可能结束。若 `/events` 对已结束的 turn 报错（404 或 409），客户端就必须处理这个竞态；现在它只是拿到补发与终止事件，与正常路径无异。

代价是 `/events` 在这种情况下退化为"用 SSE 传输的 history"，与 `GET /history` 有功能重叠。接受这份冗余，换取客户端的单一路径。

#### 请求处理器与 pi 事件的连接

`POST /prompt` 必须立即返回一个 `Response`，而正文由 pi 的事件回调持续产生。两者用 `TransformStream` 连接：处理器返回 readable 一端，事件回调写 writable 一端。

```ts
async handlePrompt(sessionId: string, turnId: string, text: string, since: number): Promise<Response> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const sub = this.hub.subscribe(sessionId, writable.getWriter())

  const existing = this.store.getTurn(sessionId, turnId)   // 复合主键
  if (!existing) {
    this.store.beginTurn(sessionId, turnId, text)            // 调用前已排除"另一轮在跑"（否则 409）
    this.scheduleKeepAlive()                                 // 30 秒后的保活 alarm
    // 不 await：turn 在 DO 内自行运行，与这条响应的生命周期无关。
    this.runTurn(sessionId, turnId, text)
      .catch(err => this.hub.fail(sessionId, err))
      .finally(() => this.hub.endTurn(sessionId, turnId))
  } else {
    await sub.backfill(this.store.eventsSince(sessionId, since))   // 同 turnId 重试，从客户端游标补
  }

  return new Response(readable, { headers: { "content-type": "text/event-stream" } })
}
```

**`runTurn` 不能被 await**，否则响应要等整轮结束才返回，流式就没有了。turn 的存活因此不依赖这条响应，而由[保活 alarm](#第一层turn-期间的保活-alarm) 承担。

pi 一侧无需改动：`session.subscribe(handler)` 照旧，只是 `Outbox` 的 `send` 回调从"写单个 WebSocket"变为"向订阅者集合广播"。

#### 多个读者

`POST /prompt` 的流尚未关闭时，同一客户端可能又开了一条 `GET /events`（例如重试逻辑误触发）。DO 维护一个订阅者集合并向全体广播，不拒绝第二条连接——拒绝会把一个无害的竞态变成一个需要客户端处理的错误。每条连接各自按自己的 `since` 先补齐再接入实时流。

**广播不等待任何订阅者。** 向订阅者写入时不 `await`，并为每个订阅者设积压上限；超限即关闭该订阅者并将其移出集合。慢消费者被直接丢弃而不做流控，因为重连是无损的：客户端带 `since=` 回来即可从条目补齐。让 agent 循环去等一个可能已进入后台的 iOS 客户端，代价远大于让它重连。

#### `id:` 只打在有条目支撑的事件上

SSE 规范中，不带 `id:` 的事件不推进 `Last-Event-ID`。利用这一点：完成条目（`message_end`、`tool_execution_end` 等）的帧带 `id: <seq>`，而 token 增量帧**不带 `id:`**。

```
id: 41
event: entry
data: {…}

event: stream          ← 增量批，无 id，不推进游标
data: {"events":[{"k":"text_delta","text":"…"}]}

id: 42
event: entry
data: {…}
```

于是客户端的游标自动停在最后一条完整条目上，恰好等于本设计的续传粒度。不需要两套 id 空间，也不需要客户端判断哪些 id 可以作为断点。这是"不持久化增量"这一决定在协议层的直接推论。

## 客户端协议：SSE 还是 WebSocket

edge-mac-widget 选了 WebSocket，理由充分：那一版工具在客户端执行，服务端必须能主动发起 `op.call` 并等待 `op.result`，这是真正的双向 RPC。

**这次那个理由消失了。** 工具全部在服务端，服务端不需要向客户端发起任何请求。流量形状退化为：

| 方向 | 内容 | 形状 |
|---|---|---|
| 客户端 → 服务端 | 建会话、发 prompt、中止、拉历史 | 低频、客户端发起、请求/响应 |
| 服务端 → 客户端 | token 增量、工具事件、turn 结束 | 高频、服务端发起、单向流 |

这正是 SSE 的形状。具体到本设计：提交与接收合并为一个 `POST`（响应体即流），`GET` 只在断线重连时使用。

### 逐条对比

**续传。** SSE 规范内置 `Last-Event-ID`：连接断开后客户端自动重连并带上最后收到的事件 id，服务端从那里续。WebSocket 没有等价物，edge-mac-widget 因此手写了 `sinceSeq`。对一个每天断线多次的移动端，这是协议自带 vs 自己实现且自己维护的差别。

**客户端复杂度。** SSE 是普通 HTTP，iOS 端用 `URLSession.bytes(for:)` 按行解析即可，没有握手、没有心跳、没有重连状态机。WebSocket 需要库、ping/pong 保活、以及一套自己的重连与去重逻辑。

**DO 存活与计费。** 这一项需要小心，因为两种协议对 DO 生命周期的影响不同：

- SSE 的 GET 是一个**在途入站请求**，使 DO 保持 active/非可休眠，期间计费
- 标准 WebSocket API 同样使 DO 无法休眠
- 只有 **WebSocket Hibernation API**（`ctx.acceptWebSocket()`，不是 `ws.accept()`）能让 DO 在连接保持的同时休眠，从而不计费

看起来 Hibernation 占优，但这个优势只在"客户端连着却没有 turn 在跑"时兑现。**本设计的流是 turn 作用域的**：有 turn 才连，turn 期间 DO 本来就在跑 agent 循环、本来就计费。空闲客户端根本不持有连接。于是 Hibernation 的收益归零。

### 为什么流是 turn 作用域而不是 session 作用域

一个自然的替代是"客户端打开会话即建立连接，关闭会话才断"。它更简单，也没有发起/接收的竞态。否决它的是成本：

DO 按 wall-clock 时长乘以固定的 128 MB 计费，与实际内存用量无关（$12.50 / 百万 GB-s，每月含 400,000 GB-s）。一条挂着的 SSE 连接使 DO 非可休眠，即 **0.128 GB-s 每秒**。

| 连接策略 | 单次时长 | 单次消耗 | 免费额度内 |
|---|---|---|---|
| turn 作用域 | 约 2 分钟 | 15 GB-s | 约 26,000 轮 / 月 |
| session 作用域 | 假设停留 10 分钟 | 77 GB-s | 约 5,200 次 / 月 |

相差约五倍，且 session 作用域多花的部分**全部是纯等待**——用户在读历史、在斟酌下一句、或把 app 切到后台忘了关，DO 都被钉在内存里计费。

WebSocket 没有更好：定价页脚注明确指出，对 WebSocket 调用 `accept()` 会使整个连接期间都产生 duration 费用，除非改用 Hibernation API。

session 作用域唯一的实质优势是消除竞态，而那个问题由"`POST /prompt` 直接返回流"免费解决了。

反过来，SSE 的在途请求在 turn 期间**顺带**把 DO 钉在内存里，与保活 alarm 叠加。客户端离线那条路由 alarm 独立覆盖，因此传输层的选择不影响 turn 的存活。

**双向能力。** SSE 不支持服务端主动请求客户端。当前不需要。若将来要做设备侧验证（iOS 在真实 WKWebView 里渲染并回报结果——见文件系统篇的渲染引擎风险），需要服务端发起调用。那时仍可在 SSE 上实现：`op.call` 作为一条 SSE 事件下发，客户端用 `POST /v1/ops/{callId}/result` 回填。比 WebSocket 多一跳，但不需要换协议。**这是本决定最可能被将来需求挑战的一点，记在此处。**

### 结论

选 **SSE**。决定性的是续传由协议提供、以及客户端复杂度显著更低；Hibernation 的成本优势在 turn 作用域流下不成立。

## 曾考虑的替代方案

**沿用 edge-mac-widget 的 WebSocket。** 最省事——协议、合帧、游标补发的代码都现成。否决它的是那套代码有一半是为客户端执行工具服务的（`op.call` / `op.result` / `op.abort` / `op.update` 四种消息、`OpRpc` 的超时与取消），这次全部用不上；剩下的一半（`sinceSeq` 补发）正是 SSE 免费给的。把一套双向 RPC 协议裁剪成单向流，不如直接用为单向流设计的协议。复用的诱惑在这里是负债。

**WebSocket + Hibernation API。** 若客户端会长时间连着而不发起 turn，这是成本最优解。否决理由是流的作用域：本设计不存在"连着但空闲"的连接。如果将来产品形态变成"常驻连接 + 服务端主动推送"（例如多设备同步或服务端发起的提醒），这条要重新评估。

**session 作用域的常驻连接。** 见上。成本约为 turn 作用域的五倍，且多出的开销全部花在用户不产生任何工作的时间上。它换来的竞态消除已由 `POST /prompt` 直接返回流取得。**若产品形态需要空闲会话具备实时性**（例如显示另一台设备正在该会话中工作），这条要重新评估——那时 WebSocket + Hibernation API 会比常驻 SSE 更合适。

**长轮询。** 比 SSE 更简单、兼容性更好，但每轮 turn 要几十上百次请求，每次都重新唤醒 DO 并重建上下文。对一个会持续几分钟的流式 turn 是错误的形状。

**把 turn 跑在 SSE 请求的上下文里。** 这样在途请求会一直保活 DO，看起来省掉了看门狗。否决它的是这恰好把"客户端离线"变成"turn 被杀"——正是本设计要消除的那个失败模式。Workers 的文档也明确：客户端断开后，与该请求关联的任务可能被取消，`ctx.waitUntil()` 只能再延 30 秒。turn 必须独立于任何一条客户端连接。

**为客户端事件单独建一张 `events` 表并持久化 token 增量。** 能做到字节级续传，但写入量比条目高一到两个数量级，而移动端断线数分钟后需要的是完成的结果而非错过的字。条目级续传已满足需求。

## 验收标准

分层归属见[测试策略](../testing/2026-09-28-test-strategy.md)；每条标注承担它的层（U 单元 / I 集成 / E 部署后 e2e）。

### 会话与存储

- **U** 历史投影从 pi 条目中剥除 operating brief：构造一条含 brief 的首条用户消息，投影结果不含 brief 的任何片段
- **U** 投影只透出 user / assistant / tool_call / tool_result 四类，内部条目类型（`model_change`、`thinking_level_change`）不出现在客户端历史中
- **I** 恢复的会话保留原本的模型与思考等级，不回退到默认值（验证落盘游标初值规则：新会话落盘引导条目，恢复的会话跳过）
- **U** `BriefProvider.system()` 对同一入参连续调用一千次返回完全相同的字节
- **I** 恢复会话后发往上游的请求前缀与中断前一致：含 thinking part 的 assistant 消息连同 `thinkingSignature` 原样出现，不因投影而丢失
- **I** 同一会话连续两次恢复后，`kind='pi_entry'` 的记录数不增长（引导条目未被重复追加）
- **I** `GET /sessions` 推导出的繁忙状态与 `turns` 表一致；不存在独立的 `sessions.status` 列可供漂移
- **I** `POST /sessions` → `GET /sessions` → `DELETE /sessions/{id}` 后该会话不再出现，其条目与工作区一并清除

### turn 生命周期与持久性

- **I** 一批记录的落盘是单个事务：在写入中途注入异常后，该批记录要么全部可见要么全部不可见
- **I** turn 开始时排出保活 alarm；用 `runDurableObjectAlarm` 触发后，若仍有 `running` 的 turn 则再次排出下一个
- **I** turn 结束后该行置为 `completed` / `aborted` / `failed` 并填 `ended_at`，**行不被删除**，且不再续排 alarm
- **I** 将 `last_progress_at` 强制改旧后触发 alarm：**从已落盘条目继续该轮**而非标记失败，最终产物与未中断时一致
- **I** 同一 turn 的恢复次数超过上限后判失败，不再重试
- **I** turn 超过最长时限被强制结束并标记失败，保活 alarm 随之停止续排
- **E** turn 运行超过 70 秒且客户端全程离线时不被中断，跑完并产出完整结果
- **E** turn 结束后 DO 在正常驱逐窗口内离开计费状态（无残留 alarm 续排）

### 幂等与错误

- **I** 用同一 `turnId` 重复 `POST /prompt` 不启动第二轮：第二次接到同一轮的流上，打桩计数确认只发生一次 LLM 调用
- **I** 对已结束的 `turnId` 提交：按 `since` 补发该轮之后的条目，随即 `stream_end` 并关闭
- **I** 对已完成的 `turnId` 提交**不同的** `text`：服务端按幂等规则补发原轮事件而**不执行新文本**——此行为刻意如此，客户端有责任不重用 id（本例验证该风险确实存在，而非验证服务端会纠正它）
- **I** 一轮进行中提交**不同的** `turnId` 返回 `409`，响应体给出进行中的 `turnId`，且不影响该轮运行
- **I** 缺失或非 UUIDv4 形式的 `turnId` 返回 `400`，不产生任何 turn 行
- **I** `text` 与 `images` 同时为空返回 `400`
- **I** 不存在的 `sessionId` 返回 `404`
- **I** LLM 调用失败时：该轮置为 `failed`，流中发出错误事件后 `stream_end`，而非静默关闭
- **I** 工具抛出异常时该轮继续（错误作为 tool_result 回给模型），不整轮失败
- **I** 超过保留期的已结束 `turns` 行被清理路径删除；保留期内的行不被删除

### 流与协议

- **I** `POST /prompt` 的响应从第一个 token 起即为流式；助手回复开头逐字到达，而非整条完成后一次性出现
- **I** `id:` 只出现在有条目支撑的事件上；增量帧不带 `id:`，因而不推进 `Last-Event-ID`
- **I** 每条流都以 `stream_end` 结束；强制断开时客户端观察到"无 `stream_end` 的关闭"
- **I** 对已结束的 turn 调用 `GET /events?since=N`：返回 `N` 之后的条目与一个 `stream_end` 后关闭，而非错误状态码
- **I** 跨多轮的补发中出现多个 `turn_end` 但只有一个 `stream_end`；每条事件携带的 `turn_id` 使客户端可正确分组
- **I** `POST` 流与 `GET /events` 流同时存在时，两条都收到完整事件，各自按自身 `since` 正确补齐
- **I** 客户端在 turn 中途停止读取（模拟进入后台）：该订阅者在积压超限后被关闭，而 turn 继续运行至完成
- **U** Outbox 合并连续的 `text_delta`：N 个增量事件产生的帧数显著少于 N，且拼接后文本与逐个发送一致
- **E** CLI 在指定事件序号处断开并带 `Last-Event-ID` 重连，导出的事件序列与不断开时逐条相同——无缺口、无重复、无乱序
- **E** 客户端发出 prompt 后**立即杀掉进程**，turn 在服务端跑完；重开后历史完整，会话不再繁忙
- **I** 断线期间完成的消息在重连后可见；断线期间半截的消息在其完成后作为完整条目出现
- **I** 消息流到一半中断时 `events` 中不出现截断的 assistant 消息；恢复后该消息以完整形态出现且仅出现一次
- **I** `GET /history` 的返回完全来自已落盘条目：关闭实时流后立即调用，助手消息正文与流式过程中累加所得一致
- **I** `abort` 在 turn 中途生效：该 `turns` 行置为 `aborted` 且不被删除，保活 alarm 停止续排，中断检测不再重启该轮

### 上传与产物

- **I** 首轮以 multipart 上传 `source.html` 与 `screenshot.png`：两者落入该会话工作区根目录，截图同时作为图片输入进入模型上下文
- **I** 带 `Content-Encoding: gzip` 的文件部分被解压后落盘，字节与压缩前一致
- **I** 用同一 `turnId` 重试携带文件的 prompt：服务端不重复读取文件部分，工作区内容不变，且不产生第二轮
- **I** `turn_end` 的 `out` 清单包含 `/out` 下全部文件、其 sha256 与 `content`，无大小阈值
- **I** 落盘的 `turn_end` 记录中 `out[]` 不含 `content`：直接查 `events` 表确认内容未写入日志
- **I** `GET /history` 返回的最后一条 `turn_end` 携带从工作区读出的**当前**内容；其 sha256 与工作区中该文件一致
- **I** 某路径在后续轮次中被删除后，`GET /history` 中该路径只剩元数据，不返回陈旧内容
- **I** agent 在一轮内多次写同一个 `/out` 文件：产生多个 `out_file` 事件，但 `turn_end` 的清单只含最终版本
- **I** 一个 1 MB 的 `out/widget.html` 经 `turn_end` 与 `GET /history` 均完整返回——不存在退化为元数据的分支
- **U** 事件清单中只出现规定的十种 `event:` 类型；`entry` / `out_file` / `turn_end` / `error` 带 `id:`，其余不带
- **I** 新设备仅调用 `GET /sessions` 与 `GET /history` 即可得到对话历史与当前产物内容，无需额外请求
- **I** 恢复 pi 会话只读取 `kind='pi_entry'` 的记录；`out_file` / `turn_end` / `error` 不进入模型上下文


### 错误

- **I** LLM 调用失败产生 `error` 事件（`code: "llm_failed"`）后紧跟 `stream_end`，而非用 HTTP 状态码
- **I** 工具执行失败**不**产生 `error` 事件：作为 `isError` 的工具结果回给模型，整轮继续
- **I** `error` 的 `code` 取自封闭集合；客户端仅据 `code` 决策，`message` 仅供展示

### 安全与并发

- **I** 工具调用时 `LLM_API_KEY` 不出现在传给 bash 的环境中；只有 `PI_*` 前缀的变量被转发
- **I** 同一用户开两个会话并发 streaming 时互不串流，且受 `MAX_CONCURRENT_TURNS` 约束
- **I** 超出并发上限的 prompt 被明确拒绝或排队，而非静默丢弃

## 风险

**保活 alarm 失效时的退化是静默的。** 已实测保活有效（见问题一节），但若将来某次改动让 alarm 停止续排（例如 turn 结束判断有误，提前把 `turns` 行置为非 `running`），turn 会退回 70 秒被杀的行为，而症状是"偶尔有些长 turn 重新生成过内容"——不会报错，只会变慢变贵。**恢复次数必须作为指标暴露出来**，否则这类退化要很久才会被发现。

**turn 无限期挂起会被保活 alarm 永久续命。** 保活的续排条件是"仍有进行中的 turn"；若某轮因上游不响应而永不结束，alarm 会一直续下去，DO 一直计费。**必须设置 turn 的最长时限**，超时即强制结束并标记失败。

**批量落盘必须包在事务里。** 实测确认任务会在 70 秒被硬终止，但终止点是否可能落在一次多语句写入的中间，无法用可控的方式验证——强制在精确时刻驱逐 DO 不在我们的控制范围内。

由于代价极低而后果是"条目日志写了一半"，这里不把它留作开放问题，而是直接定为实现要求：**一批条目的落盘必须是单个事务**，要么全部可见，要么全部不可见。残留风险仅在于事务本身被撕裂，那属于 SQLite 与平台的保证范围，不再由本设计承担。

**中断重发对用户可见，且内容可能不同。** 用户可能眼看着正文逐字出现，随后 DO 被驱逐、该消息消失并重新生成，而重发不保证复现原内容。这个瑕疵无法通过持久化增量消除（见上），只能通过缩短落盘间隔缓解——而落盘间隔由 pi 的事件粒度决定，不由本设计控制。若实测中断频率高到让这个现象常见，应重新考虑 turn 的切分方式，而不是改持久化策略。

**恢复会重复付费。** 每次中途恢复都要重发一次 LLM 调用，前一次的 token 已付费且结果丢弃。若 turn 很长或落盘很稀疏，可能反复中断反复重发，在极端情况下形成一个昂贵的循环。**必须为同一 turn 的恢复次数设上限，超过即判失败**，而不是无限重试。

**SSE 在 iOS 上的后台行为需要验证。** app 进入后台后连接会断，这是预期的；但需要确认 iOS 不会在短暂切换时反复建连断连，形成对 DO 的唤醒风暴。可能需要客户端侧的重连退避。

**`Last-Event-ID` 依赖客户端正确实现。** 浏览器的 `EventSource` 自动处理，而 iOS 的 `URLSession` 不提供 SSE 解析，重连与 `Last-Event-ID` 都要客户端自己写。这抵消了一部分"协议自带续传"的优势——协议定义了语义，但 iOS 端仍需实现。**它仍比 WebSocket 简单（无握手、无心跳、无二进制帧），但不是零成本。**

**只有一份日志意味着投影逻辑是关键路径。** 客户端历史是 pi 条目的投影，投影出错（例如没剥干净 operating brief、或把内部条目类型透出去）会直接暴露服务端提示词。这类缺陷在测试里容易漏掉，因为它不影响功能。验收标准里为此单列了一条。

**`turnId` 的幂等窗口需要定期清理。** 已结束的 `turnId` 必须保留一段时间才能正确回答重试，但不能无限保留，否则 `turns` 表会单调增长。需要一个保留期（例如 24 小时）与清理路径；清理过早会让一次迟到的重试误开新轮。

**本版本没有鉴权，`userId` 由请求头直接给出且不校验。** 后果是具体的：任何人构造一个请求头即可读取、修改或删除他人的会话与工作区，并以他人身份消耗 LLM 额度。`idFromName(userId)` 是路由的根，因此这不是"少了一层防护"，而是**整个隔离边界建立在一个客户端自称的字符串上**。

这是一个有意接受的临时状态，前提是部署不对外公开。**在任何真实用户接触之前必须补上**：鉴权方案本身是一篇独立的提案，需要决定身份来源、令牌形态与轮换方式。

**未定项。** 多会话并发上限的具体取值；以及 `MAX_CONCURRENT_TURNS` 是否应把 CPU 密集工具计入同一预算（文件系统篇已提出，此处需要给出数值）。
