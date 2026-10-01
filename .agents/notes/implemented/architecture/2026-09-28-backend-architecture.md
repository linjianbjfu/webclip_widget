# Agent Note: 后端架构——pi 接入、会话管理、存储与客户端协议

Status: implemented

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

## 决策

本篇的验收标准如何分层承担，见[测试策略](../testing/2026-09-28-test-strategy.md)。

### 组件切分

```
iOS app
  │  POST  /v1/sessions/{id}/prompt   ──►  响应体即 SSE 流，从第一个 token 起
  │  POST  /v1/sessions/{id}/abort
  │
  │  GET   /v1/sessions/{id}/events?since=   历史读取与断线重连
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
| `import.meta.url` | `backend/wrangler.jsonc` 的 `define` 里给一个常量 | pi 的 `config.ts` 在模块作用域调 `fileURLToPath(import.meta.url)`，打包后为 `undefined`，Worker 一启动就崩 |
| 会话存储 | `SessionManager.inMemory()` + 增量落盘 | Workers 的 `node:fs` 是按请求隔离的内存 VFS，文件版 SessionManager 不可用 |
| 落盘触发 | 自持 `SessionManager` 引用，在 `message_end` / `turn_end` / `tool_execution_end` / `compaction_end` 后 drain `getEntries()` | `entry_appended` **只在扩展调用 `pi.appendEntry()` 时触发**，不是通用持久化钩子；订阅它会得到一个空的 SQLite |
| 落盘游标初值 | `history.length > 0 ? getEntries().length : 0` | 每次打开会话 pi 都会写入 `model_change` / `thinking_level_change` 两条引导条目。新会话必须落盘它们，恢复的会话必须跳过。恒为 `length` 会导致恢复时读不到模型与思考等级并静默回退；恒为 0 会每恢复一次重复追加两条 |
| 扩展 | `noExtensions: true` | jiti 动态加载 TS 在 Workers 不可用 |
| 模型接入 | `ModelRuntime.create({ credentials: InMemoryCredentialStore, modelsPath: null })`，只注册当前选中的 provider | 全内存，密钥留在 Workers Secret；未使用的 provider 无需配置 key |
| 事务 | 用 `ctx.storage.transactionSync()`，**不要 SQL 的 `BEGIN`** | 平台直接拒绝裸 `BEGIN`/`SAVEPOINT`："please use the state.storage.transaction() … APIs instead"。JavaScript API 会在异常时自动回滚，并与 Durable Object 的自动写合并正确交互，而裸 `BEGIN` 会绕过后者 |
| 工具接入 | 经 `createXToolDefinition(cwd, { operations })` 注册为 `customTools` | `*Operations` 的入口是每个工具的定义工厂，不是 `createAgentSession` 的参数。把 operations 直接交给会话不会报错也不生效——内置工具原样保留，`write` 撞上 pi 自己的权限层返回 `operation not permitted`，`bash` 则去调 `child_process.spawn`。同名 customTool 覆盖内置，因而 pi 的参数校验、截断与 diff 全部保留，只换掉 IO |
| 工具环境 | 只转发 `PI_*` 前缀的变量 | `nodejs_compat` 把 secrets 一并填进 `process.env`，pi 的 bash 工具用 `getShellEnv()` 构造子进程环境——原样转发等于把网关 key 交出去 |

#### 系统提示词

`BriefProvider.system()` 定义网页提取、三文件产物、自适应尺寸和静态截图要求，内容决策见[静态 widget 决策](../feature/2026-09-30-static-ios-widget-artifacts.md)。接口保持 `system({ sessionId, workspaceRoot, outDir }): string` 与 `strip(text): string`；同一会话的 system 文本必须逐字节稳定，禁止时间戳、随机标识或不稳定的拼装顺序，以保持上游前缀缓存。

`strip()` 用于移除存储文本中的 brief，当前 HTTP 历史路径未调用该投影接口。参考项目中客户端本机路径、shell 和 Windows 实时卡片的约定不适用于本工程。

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

edge-mac-widget 的 `HistoryMessage` 会投影 `StoredEntry` 并剥离 operating brief。本项目当前 HTTP 路径直接发送原始 pi 条目，尚未接入面向用户的投影；不能承诺过滤内部条目或提示词。

### 不持久化 token 增量

一个看似自然但错误的设计是把每个 `text_delta` 也写进日志，让客户端能从任意字节续上。**不这么做。**

增量是渲染用的瞬时数据，不是会话事实。真正的事实是完成后的消息、工具调用与工具结果——它们本来就作为 pi 条目落盘了。`text_delta` 与那条条目是**同一份内容的两种形态**：

```
LLM 流式返回
   ├─→ text_delta ×N   推给当前连着的客户端，渲染用
   └─→ message_end     pi 写入完整 SessionEntry → 落盘 → 历史读取时从这里取
```

因此读取历史时不需要也不应该累加增量。edge-mac-widget 的 `toHistoryMessages` 正是这样做的：输入是 `StoredEntry[]`，直接从 `entry.message.content` 抽取完整正文，不经过任何增量累加。自行 merge 会把 pi 已经给出的内容重拼一遍，且拼出的版本可能与 pi 的不一致——thinking 块与工具调用的结构化参数并不出现在 `text_delta` 里。

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

恢复会话走的是 `buildSessionContext(原始条目)`，不经过任何投影，因此 thinking 与其签名原样回到上下文，发给上游的请求与当初一致，缓存前缀不因恢复而断裂。当前 HTTP 历史发送原始 pi 条目，包含 thinking 内容；CLI 自己选择呈现哪些部分，不能把 CLI 的过滤理解为服务端协议保证。

这意味着**续传粒度是条目而非 token**：断线期间半截的消息，客户端要等它完成才看得到。对一个本来就会离线几分钟的移动端，这是正确的取舍——它需要的是结果，不是错过的字。代价是省掉了数量级更高的写入。

**被中断的半截消息不落盘，靠重发补回。** DO 若在消息流到一半时被驱逐，`message_end` 未触发、条目未写入，已经推给用户的那部分正文丢失；看门狗恢复时重发该次 LLM 调用，消息重新生成。

这是有意为之：一条截断的 assistant 消息不应进入对话历史，否则后续推理会建立在模型没说完的句子上。持久化半截消息只是把一个 UX 瑕疵换成上下文污染。

### 打开旧会话时上下文怎么重建

只读 `events` 一张表，且只取 `kind='pi_entry'` 的行。`turns` 不参与——它只管幂等、保活与中断检测。

```
SELECT payload FROM events WHERE session_id = ? AND kind = 'pi_entry' ORDER BY seq
        ↓  JSON.parse → SessionEntry[]
        ↓  线性重链 parentId
        ↓  buildSessionContext(entries, leafId)
SessionContext { messages, thinkingLevel, model, activeToolNames }
        ↓  createAgentSession(…) 用这些条目播种 SessionManager
        ↓  追加本次 prompt → 发往上游
```

三点需要注意：

**恢复的消息在会话构造之后赋给 `session.agent.state.messages`。** `createAgentSession` 不接受上下文参数，传一个进去既不报错也不生效——每一轮都从空白开始，模型看不到此前说过的任何话。症状不是错误而是失忆，且只有在第二轮引用第一轮的内容时才暴露，因此端到端检查中有一条专门让模型复述上一轮才知道的数字。这与工具接入是同一类错误：把配置交给一个不读它的参数。

**重链是必须的。** pi 的会话是树（`parentId` / `leafId`，支持 fork），而本设计持久化的是线性序列。恢复时须把 `parentId` 按 `seq` 顺序重新串成一条链。v1 没有分支功能，线性重链因此是精确的；**若将来支持 fork，这一步要改**。

**模型与思考等级也来自条目。** `model_change` 与 `thinking_level_change` 是两种 `SessionEntry`，同属 `kind='pi_entry'`。这正是[落盘游标初值](#pi-接入)那条规则的意义所在。

**压缩过的会话不会被"解压"。** 把全部条目传给 `buildSessionContext` 是安全的：`defaultContextEntryTransform` 会定位最后一条 `compaction` 条目，只保留它及其之后（或 `firstKeptEntryId` 之后）的部分。**前提是压缩条目本身已落盘**——落盘触发的事件集合必须包含 `compaction_end`，否则恢复会把压缩前的条目全部放回，等于每次打开旧会话都撤销一次压缩，上下文与费用同时膨胀。

### prompt 缓存的前缀稳定性

上游的 prompt 缓存按**前缀逐字节相同**命中。恢复会话本身不破坏它（见上），但有四件事会：

| 威胁 | 后果 |
|---|---|
| operating brief 不稳定 | 每一轮都未命中 |
| 工具定义变更 | 一次部署作废全部在跑会话的缓存 |
| 切换 provider 或模型 | 必然失效 |
| 缓存 TTL 过期 | 隔时较久恢复的会话无论如何都是冷的 |

pi 一侧已核实是干净的（`0.82.1`）：

- 系统提示词只注入 `${cwd}`，**不注入日期或时间**；固定用 `/workspace` 即稳定
- 条目的 `timestamp` / `id` / `parentId` 不上线——`buildSessionContext` 只返回 `messages`
- thinking **会**回传：`openai-completions` 适配器把 `thinkingSignature` 当作**字段名**使用（DeepSeek 下即 `reasoning_content`），把落盘的 thinking 写进该字段；另有 `compat.requiresThinkingAsText` 分支将其转为纯文本前置到 assistant content。两条分支都依赖落盘的 thinking，不存则都走不通

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

HTTP 请求、SSE 载荷、状态码和当前限制由[客户端协议](../../../../docs/protocol.md)维护。本节保存决定这些接口的理由；工作区与存储事实分别见[架构](../../../../docs/architecture.md)和[实现](../../../../backend/src/do/store.ts)。

#### 发起提示与接收合并

`POST /prompt` 直接返回 SSE，避免“先返回 202、再另开 GET”期间丢失未持久化的 token 增量。iOS 使用支持 POST 的流式 HTTP 客户端，不依赖只支持 GET 的浏览器 `EventSource`。

创建会话与上传分开，因为建会话是轻量操作，重试可能产生新的空会话；上传则需要 turn 的幂等约束。换一个网页时新建会话，避免旧工作区与产物混入新任务。

历史与跟随共用 `GET /events`：补发后有 turn 就跟随，没有就终止，不增加 `follow` 开关或单独的 JSON 历史接口。客户端打开会话需要同一条处理路径；即使列表查询后 turn 已结束，读事件仍能正常返回，消除“先查忙碌、再订阅”之间的竞态。会话列表负责摘要，当前没有后台预取需求。

#### 上传编码

多个文件由 multipart 承载，压缩用 Workers 原生的 gzip 解码，不增加需要中央目录解析和额外依赖的 zip 容器。已有实测中 30 KB 的重复 HTML 压缩到 87 字节并无损还原。当前按 `.gz` 后缀或 `application/gzip` MIME 类型识别；截图只落盘，不自动作为图片输入注入模型。

相同 `turnId` 的重试不再写入文件，客户端可以改用 JSON 重试，避免重复上传。新 turn 的文件写入先于空提示与并发检查，所以被拒绝的 multipart 请求仍可能改变工作区。

#### 幂等、续传与分组

客户端生成 `turnId`，因为只有它知道一次请求是不是重试；服务端生成 `seq`，因为只有它知道日志顺序。`turnId` 标识提交，`seq` 标识会话日志位置，跨 turn 连续。按 session 与 seq 重连，不要求离线客户端先判断自己错过了哪些轮次。

同一次提交的重试复用同一个小写 UUIDv4，不同提交用不同 UUID。计数器不能满足要求：服务端会话仍在，而客户端重装后计数归零，会命中旧 turn，导致新输入被静默忽略。服务端发号也不能解决发号请求超时后的歧义。随机 UUID 避免计数器复用；客户端仍须保存待重试提交的 ID，丢失它就不能保证重试去重。

`since` 同时用于历史、幂等重试和新提示，补齐“读历史响应关闭”到“提交提示到达”之间的记录。当前服务端读取查询参数或请求字段，不读取 `Last-Event-ID` 请求头。

日志内部的 `turn_id` 可用于分组，但当前 SSE 不统一包装这个字段；客户端不能假设每个 `entry` 都包含 turn 标识。未来提供统一投影时需要定义分组字段。

进行中拒绝不同 `turnId`，客户端本地排队。引入 steer 会把新提示注入已有轮次，使“一个提交对应一轮”的关系失效；若支持它，需要把 `turnId` 明确定义为提交 ID，并另设条目的轮次分组字段。

幂等依赖保留的 turn 行，不能结束后立即删除；无限保留则会让表持续增长。当前 alarm 按 24 小时保留期清理，迟到重试不能依赖清理后的去重。

#### 产物交付与未完成的恢复路径

产物以 `/out` 实际文件为准，不以模型回答里的声明为准；`preview_widget` 使用 `out/widget.html`。实时 `turn_end` 内联内容，避免在线客户端再发一次请求。事件日志仅保存路径、字节数与哈希，避免每轮把完整内容塞进 SQLite 单行，也避免历史随文件反复修改而膨胀。内容交付没有大小阈值，减少了按大小分支的行为与测试。

原设计为离线客户端选择“从工作区取当前内容并附到历史投影”，而不是保存每一轮的文件快照：客户端需要可渲染的当前 widget；工作区已经拥有最新版本，不必在事件中再做按路径取最新的判断。删除后的路径只剩历史元数据。这个投影目前未实现；当前回放只有元数据，且没有下载端点，不能从历史恢复产物内容。

独立产物读取端点曾因与完整历史读取重叠而未采用；如果产品需要只展示 widget 的列表而不读取对话，应重新评估独立端点。当前缺少历史内容投影也使产物恢复成为实际接入缺口。客户端可保存实时内容和 sha256，但缓存不能代替离线恢复接口。

`out_file` 的设计用途是只通知元数据，避免一轮里五次写入就发送五份完整文件。若实现，应接在文件系统层以覆盖 write、edit 与 shell 重定向；工具参数不能可靠重建内容。当前日志类型保留该事件，但执行路径没有发布，不能作为已交付的通知通道。

#### 连接终止与多个读者

`turn_end` 是可回放的轮次事件，`stream_end` 是当前连接的结束信号。一次历史回放可能跨多轮，因此不能在遇到首个 `turn_end` 时停止。未收到 `stream_end` 就关闭意味着需从已保存的 seq 重连；否则客户端会在真实掉线时提前放弃，或对正常结束无限重试。

同一会话允许多个独立订阅者。网络切换时，服务端可能尚未发现旧 TCP 已断，而客户端已建立新连接；拒绝第二条连接会把这个常见状态变成额外错误。每条连接有自己的 since 和队列，共享 DO 内存中的 Hub 广播。

补发与注册在一个无 await 的同步块中完成：先补发再异步注册可能漏事件，先注册再补发可能乱序；SQLite exec 同步返回使快照与注册之间不会插入广播。真实写出异步执行，补发仍先于实时事件入队。

写入与关闭都不能等待订阅者。TransformStream 的 close 需要读端排空队列；等待可能把 agent 卡在已进入后台的客户端上。队列超限时丢弃慢订阅者以保护执行端；可靠续传依赖持久化记录。当前同一队列也限制历史补发，长历史可能截断，这个缺口尚未解决。

只有可回放事件带 `id:`，增量不推进客户端游标。这让客户端续传位置停留在完整条目上，不需要第二套 ID 空间，也不会从半条消息中间恢复。

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

## 验证

分层归属见[测试策略](../testing/2026-09-28-test-strategy.md)。不依赖 pi 的层由 `backend/src/` 中与实现并置的自动化用例钉住，跑在真实 workerd 内；pi 接入与保活只能由部署后的实跑覆盖。

### 自动化覆盖

**事件日志**（`backend/src/do/store.test.ts`）：`seq` 会话内单调且跨 turn 连续，两个会话的序号空间互不干扰；重建上下文只读 `kind='pi_entry'`，而续传读取全部；批量追加是单个事务——一条无法序列化的载荷使整批不可见，`lastSeq` 不前进；游标返回无缺口无重复。

**turn 表**：已结束的行保留且带 `ended_at`，幂等窗口据此回答迟到的重试；会话繁忙由 `turns` 推导，不存在可漂移的冗余列；陈旧 turn 可被发现，恢复次数递增；清理只删除超过保留期的已结束行。

**恢复**：被中断的 turn 重建上下文时排除自己的记录——`prompt()` 会追加用户消息，否则模型会看到它两次；记录仍留在日志中。

**SSE 与广播**（`backend/src/do/sse.test.ts`、`backend/src/do/hub.test.ts`）：`id:` 只出现在可回放的记录上，增量帧不带因而不推进 `Last-Event-ID`；载荷中的换行不破坏帧结构；补发先于实时送达；两个订阅者收到同一份广播且各自按自身游标补齐；停止读取的订阅者在积压超限后被移除而广播继续；有限流发完即关闭，后续广播到不了它。

**turn 生命周期**（`backend/src/do/turns.test.ts`）：保活在仍有 turn 运行时续排；陈旧 turn 被恢复而非判失败；超过时限或恢复次数上限的被放弃，且时限优先于次数；多会话逐个判定。

**turnId**（`backend/src/protocol.test.ts`）：只接受小写 UUIDv4；计数器形式的值被拒绝。

**密钥门禁**（`backend/src/auth.test.ts`）：未配置 token 时拒绝一切请求；缺失、格式错误、值错误均 401；token 的前缀与超集都被拒绝，比较为常数时间；错误响应不含 token。

**上传**（`backend/src/do/upload.test.ts`）：multipart 部分写入工作区根；gzip 部分解压后落盘；上传名去掉目录成分。

### 部署后实跑

在 `https://webclip-widget.linjsd.workers.dev` 上执行：

- **真实 turn**：模型经 `write` 工具写入 `out/extra.js`（`isError=false`），`turn_end` 带 sha256 与内容返回；同一条经 `GET /events` 回放时只有元数据
- **保活**：一轮 turn 运行 **129.9 秒**而客户端在第 4 秒即断开，跨过 70 秒死线仍跑完，三次 40 秒的 shell 调用全部执行、产物写出。**该用例自证跨过了死线**——先前一版只跑了 17.2 秒就"通过"，而那个时长本就不会触发驱逐
- **密钥门禁**：无 token 与错 token 均 401，正确 token 201

### 尚未覆盖

- `409`（一轮进行中提交不同 `turnId`）、幂等命中、`POST` 与 `GET` 双流并存，均只有实现没有用例
- 恢复路径未在部署上触发过：陈旧判定与续排逻辑有单元覆盖，但"DO 真被驱逐后从日志继续"没有端到端证据
- LLM 打桩、错误路径（`llm_failed` / 工具抛异常）、并发上限，都还没有用例

## 风险

**保活 alarm 失效时的退化是静默的。** 已实测保活有效（见问题一节），但若将来某次改动让 alarm 停止续排（例如 turn 结束判断有误，提前把 `turns` 行置为非 `running`），turn 会退回 70 秒被杀的行为，而症状是"偶尔有些长 turn 重新生成过内容"——不会报错，只会变慢变贵。**恢复次数必须作为指标暴露出来**，否则这类退化要很久才会被发现。

**turn 无限期挂起会被保活 alarm 永久续命。** 保活的续排条件是"仍有进行中的 turn"；若某轮因上游不响应而永不结束，alarm 会一直续下去，DO 一直计费。**必须设置 turn 的最长时限**，超时即强制结束并标记失败。

**批量落盘必须包在事务里。** 实测确认任务会在 70 秒被硬终止，但终止点是否可能落在一次多语句写入的中间，无法用可控的方式验证——强制在精确时刻驱逐 DO 不在我们的控制范围内。

由于代价极低而后果是"条目日志写了一半"，这里不把它留作开放问题，而是直接定为实现要求：**一批条目的落盘必须是单个事务**，要么全部可见，要么全部不可见。残留风险仅在于事务本身被撕裂，那属于 SQLite 与平台的保证范围，不再由本设计承担。

**中断重发对用户可见，且内容可能不同。** 用户可能眼看着正文逐字出现，随后 DO 被驱逐、该消息消失并重新生成，而重发不保证复现原内容。这个瑕疵无法通过持久化增量消除（见上），只能通过缩短落盘间隔缓解——而落盘间隔由 pi 的事件粒度决定，不由本设计控制。若实测中断频率高到让这个现象常见，应重新考虑 turn 的切分方式，而不是改持久化策略。

**恢复会重复付费。** 每次中途恢复都要重发一次 LLM 调用，前一次的 token 已付费且结果丢弃。若 turn 很长或落盘很稀疏，可能反复中断反复重发，在极端情况下形成一个昂贵的循环。**必须为同一 turn 的恢复次数设上限，超过即判失败**，而不是无限重试。

**SSE 在 iOS 上的后台行为需要验证。** app 进入后台后连接会断，这是预期的；但需要确认 iOS 不会在短暂切换时反复建连断连，形成对 DO 的唤醒风暴。可能需要客户端侧的重连退避。

**`Last-Event-ID` 依赖客户端正确实现。** 浏览器的 `EventSource` 自动处理，而 iOS 的 `URLSession` 不提供 SSE 解析，重连与 `Last-Event-ID` 都要客户端自己写。这抵消了一部分"协议自带续传"的优势——协议定义了语义，但 iOS 端仍需实现。**它仍比 WebSocket 简单（无握手、无心跳、无二进制帧），但不是零成本。**

**只有一份日志意味着投影逻辑是关键路径。** 客户端历史目前直接返回 pi 条目，面向用户的投影尚未接入；过滤 operating brief 和内部条目不能当作已实现保证。这类缺陷在测试里容易漏掉，因为它不影响功能。验收标准里为此单列了一条。

**`turnId` 的幂等窗口需要定期清理。** 已结束的 `turnId` 必须保留一段时间才能正确回答重试，但不能无限保留，否则 `turns` 表会单调增长。需要一个保留期（例如 24 小时）与清理路径；清理过早会让一次迟到的重试误开新轮。

**共享密钥不验证用户身份，`userId` 由请求头直接给出。** 持有 token 的人可以读取、修改或删除任意用户的会话与工作区，并消耗 LLM 额度。`idFromName(userId)` 是路由的根，因此这不是"少了一层防护"，而是**整个隔离边界建立在一个客户端自称的字符串上**。

这是一个有意接受的临时状态，前提是部署不对外公开。**在任何真实用户接触之前必须补上**：鉴权方案本身是一篇独立的提案，需要决定身份来源、令牌形态与轮换方式。

**未定项。** 多会话并发上限的具体取值；以及 `MAX_CONCURRENT_TURNS` 是否应把 CPU 密集工具计入同一预算（文件系统篇已提出，此处需要给出数值）。

## 后果

**换来了什么。** 工具移到服务端后，一轮 turn 不再需要客户端参与即可跑完，客户端断线只是投递问题而非执行问题。协议面收敛为 6 个端点、零开关参数：`POST /prompt` 的响应体本身就是流，`GET /events` 用于历史读取与重连，历史事件由同一个端点提供，离线产物内容恢复仍有缺口。`seq` 是唯一的游标，`stream_end` 是唯一的重连判据。

**付出了什么。**

- **保活是必需品而非兜底。** 实测无保活的 detached 任务在 70 秒被杀，而一轮 turn 是 1–5 分钟。alarm 因此必须在整轮期间持续续排，DO 也就整轮计费
- **一轮进行中无法插入新提示**，返回 `409`，客户端只能本地排队。支持 steer 需要把 `turnId` 的语义从"标识一轮"改为"标识一次提交"，并为条目分组另设字段
- **中断重发对用户可见且内容可能不同。** 恢复会丢弃该轮此前的部分产出并重新发起调用，前一次的 token 已付费
- **pi 接入无法进测试池。** 导入 pi 包根会拉入需要 `node:process` 的扩展加载器，Workers 测试池保留该路径而 wrangler 的打包器剪除它。模型运行时、会话工厂与 turn 编排因此只能由部署后通道验证——这一点是在实现中才发现的，它推翻了本篇原先"集成层覆盖接缝"的假设

**一条仍然敞开的边界。** 共享密钥决定服务是否应答，而 `userId` 未经校验：持有 token 者可读写任意用户的会话。用户之间的边界目前不是安全边界，按用户的身份验证是单独的工作，必须在真实用户接触之前完成。
