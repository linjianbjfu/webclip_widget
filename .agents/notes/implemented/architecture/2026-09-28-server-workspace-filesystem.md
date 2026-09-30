# Agent Note: 服务端 workspace 文件系统与工具执行层

Status: implemented

## 问题

webclip_widget 的服务端要把 pi coding agent 跑在 Cloudflare Workers 上，让它把一个网页转换成 widget。这个形状已经在 [edge-mac-widget](../../../../AGENTS.md#参考实现edge-mac-widget) 上跑通过一次，但那一版有一个这次不成立的前提：**工具在客户端本机执行**。

那一版的切分是"云端大脑 + 本地手脚"——Workers 只做编排、状态与扇出，`bash` / `read` / `write` / `edit` / `ls` / `find` 通过带 `callId` 的 RPC 下发到客户端，由客户端的 Node 进程在真实文件系统上执行。这个切分依赖一个隐含契约：**发起 tool 调用时客户端必须在线，并且会一直在线到这次调用返回**。

这次的客户端是 iOS app，不保证稳定在线。契约不成立，后果是具体的：模型在第 3 个工具调用时客户端进了后台，RPC 永远等不到 `op.result`，这一轮 turn 挂死，而此时 LLM 的 token 已经花掉了。把超时调短只是把挂死换成失败，不解决问题。

所以工具必须移到服务端。这带来三个必须回答的问题（pi 接入、会话管理、存储布局与客户端协议属于[后端架构](2026-09-28-backend-architecture.md)，不在本篇）：

1. **workspace 放哪。** 工具要读写文件，Workers 的 `node:fs` 是按请求隔离的内存 VFS，写进 `/tmp` 的东西在下一个请求里就不存在了。需要一个真正持久、且能被工具访问的文件系统。
2. **`grep` / `rg` / `find` 怎么实现。** pi 的 grep 实现在任何情况下都会 spawn ripgrep，`GrepOperations` 这个 seam 只提供 `isDirectory` / `readFile` 给上下文行用，拦不住搜索本身。服务端没有进程可以 spawn。
3. **生成结果怎么验证。** 模型写完 `extra.js` 和 `widget.html` 之后需要知道它对不对。习惯性的做法是 `node --check`，而 Workers 里没有 node，这会把 Cloudflare Sandbox（Containers）拉进依赖。下面论证这条路径在本 workload 下是错的。

### workspace 的实际形状

这一节是后续所有取舍的依据，先钉住：

| | 内容 | 量级 |
|---|---|---|
| 输入 | 一个网页的 source 与截图 | source 单文件、**可能超过 1 MB**；随首轮 prompt 以 multipart 上传 |
| 输出 | `out/extra.js` + `out/widget.html` | 各几十 KB，写在约定的 `/out` 目录下 |
| 中间产物 | 选区 manifest 等 | 小 |
| 验证产物 | 渲染截图 | 每次迭代一张，几百 KB |

**一次任务三五个文件，其中恰好有一个大文件，而那个大文件正是模型最需要反复搜索的对象。** 这个分布排除了"大文件溢出到另一层存储"这类设计——见下面的替代方案。

## 决策

两层。R2 不进 v1。

| 层 | 承载 | 存储 | 谁访问 |
|---|---|---|---|
| L1 工作区 | **全部**文件，无论大小 | DO SQLite（分块行） | just-bash + pi 的 `*Operations` |
| L2 验证 | 渲染、语法与运行时错误、截图 | Browser Run（无状态） | `preview_widget` 自定义工具 |

**L1 是唯一的事实来源。** L2 不持有状态，每次调用自成一体。

**没有 Sandbox 层。** 见下面的「验证用浏览器而不是 node」。

本篇的验收标准如何分层承担，见[测试策略](../testing/2026-09-28-test-strategy.md)。

### 分块存储

DO SQLite 的 2 MB 是**单行**上限，不是单 Durable Object 上限（后者是 10 GB）。所以大文件按字节切成多行：

```sql
CREATE TABLE files (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mode       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,
  UNIQUE (session_id, path)     -- 不是 path 全局唯一
);
CREATE TABLE chunks (file_id INTEGER, idx INTEGER, data BLOB, PRIMARY KEY (file_id, idx));
```

**工作区按会话隔离。** 一个 Durable Object 装的是同一用户的**全部会话**，而每个会话是一个独立的剪藏任务，都会写 `source.html`、`out/widget.html` 这些同名文件。若 `path` 在 DO 内全局唯一，两个并存的会话会互相覆盖——这不是边角情况，同一用户同时处理两个网页是常规操作。因此 `IFileSystem` 的每个实例绑定一个 `session_id`，所有查询都带上它。

**分块对 `IFileSystem` 接口以上完全不可见，这是一条不变量而不是优化。** `readFileBuffer()` 做的第一件事就是把所有 chunk 按 `idx` 拼回完整字节再返回：

```ts
const rows = sql.exec("SELECT data FROM chunks WHERE file_id = ? ORDER BY idx", fileId).toArray()
return concatBytes(rows.map(r => r.data))   // 边界在这里消失
```

`grep` / `rg` / `sed` 拿到的永远是完整文件，不知道底下存了几行。因此**分块大小不影响任何命令的正确性**，只影响内存与 IO 粒度：一个跨越分块边界的 pattern 与不跨越的 pattern 走的是同一条码路。读取是一次查询，同进程、零网络、零子请求。

三个实现约束，都来自已验证的平台限制：

- **存 BLOB，按字节切，不要存 TEXT 按字符切。** UTF-8 的多字节字符会被字符串切分从中间劈开，拼回来就是乱码。存 `ArrayBuffer`，拼接完成后再解码。
- **内容必须走 bound parameter。** SQL 语句长度上限 100 KB，内容拼进字面量必然超限。
- **批量写要分批。** 单查询最多 100 个绑定参数。

分块大小取 **512 KB**（对 2 MB 行上限留四倍余量，行里还有 `file_id`、`idx` 两列）。一个 5 MB 的页面是 10 行。生产实测确认该形状可用，且 50 MB / 100 行的单次查询同样成功——余量远大于本 workload 所需。

读取时在 DO 实例内存里缓存重组结果，写入该文件时失效。DO 实例在会话期内常驻，所以同一个 `source.html` 被 grep 十次只重组一次。5 MB 的重组结果在 128 MB 的 isolate 里没有压力。

### 工具层怎么接

pi 在每个内置工具上留了 `*Operations` seam，源码注释写明用途是"Override these to delegate ... to remote systems"。edge-mac-widget 验证过：实现这个 seam 可以保留 pi 自己的参数校验、截断、diff 和提示词文案，只换掉 IO 层。这次照做，只是 IO 的另一端从 WebSocket 变成 DO SQLite——同进程直接调用，连 RPC 都没有。

| pi 的 seam | 这次指向 |
|---|---|
| `ReadOperations` / `EditOperations` / `WriteOperations` / `LsOperations` / `FindOperations` | L1 的 `IFileSystem` 实现 |
| `BashOperations` | just-bash，在 L1 上执行 |
| `GrepOperations` | **不用**。这个 seam 拦不住 ripgrep spawn |

grep 改成用 `createAgentSession({ customTools })` 注册同名工具覆盖内置的——edge-mac-widget 验证过 `_refreshToolRegistry` 里 custom 在 builtin 之后 `set`，同名即覆盖。实现用 [just-bash](https://github.com/vercel-labs/just-bash) 的 `grep` / `rg`。

**必须从 `just-bash/browser` 导入，不能用默认入口。**（该选择已在部署后的 Worker 上实测确认：`grep` / `rg` / `find` / `sed` / `awk` / `jq` 均正常，打包 1.79 MB、gzip 417 KB、启动 17 ms。）

这里的 `browser` 是 npm `exports` 里的**条件名，一个打包目标的标签，与浏览器、与下文的 Browser Run 毫无关系**——这份代码不打开任何浏览器。它的含义是"供没有 Node API 的宿主使用的那份构建"：

```
just-bash          → dist/bundle/index.js     510 KB   假设宿主有 Node API
just-bash/browser  → dist/bundle/browser.js  1.2 MB   不做该假设，依赖全部内联
```

Cloudflare Workers 既不是 Node 也不是浏览器，但其 API 面更接近后者：没有 `node:worker_threads`，没有 `new Worker`，没有真实文件系统。默认入口引入 `node:fs`，其懒加载的 chunk 依赖 `node:worker_threads`、`new Worker` 和 `readFileSync`——Workers 三者皆无。实测 `browser.js` 干净：零 `node:` 导入、零 `new Worker`（其中唯一的 `eval(` 是安全黑名单中被禁止的条目本身，不是调用）。

这条如果搞错，症状出现在部署后而非构建期，且报错指不到根因。

该构建的能力边界（实测 `just-bash@3.4.2`）：

| | 状态 |
|---|---|
| `grep` `rg` `find` `sed` `awk` `jq` `head` `tail` `wc` `sort` `cut` `tr` `xargs` `diff` `uniq` `base64` `tee` `stat` `file` 等 | 可用 |
| `test` / `[ ]` | 可用（shell builtin，不在 PATH 上） |
| `js-exec`（QuickJS）、`python3`、`sqlite3`、`curl` | **不可用** |

后果是模型**无法写一个 JS 或 Python 脚本来转换 HTML**，只能用 `sed` / `awk` / `jq` / `grep` 这套文本工具。对本 workload（读 HTML、抽字段、写两个文件）够用，但必须在系统提示词里写明，否则模型会依次尝试 `node`、`js-exec`、`python3`，每次失败烧掉一轮。

选 just-bash 是因为它正好就是这个形状：纯 TypeScript 的 bash 解释器 + 可插拔文件系统，命令表里已经有 `grep`（含 `egrep`/`fgrep`）、`rg`、`find`、`sed`、`awk`、`jq`、`head`、`tail`、`wc`、`sort`、`cut`、`tr`、`xargs`，以及管道、重定向、`&&`/`||`、变量展开、glob、函数和循环。Node bundle 是 510 KB（另有按需加载的 chunk，合计 6.4 MB），远低于 Workers 的 64 MiB 脚本上限；bundle 里 `new Function` 和 `eval(` 各出现 **0 次**，不会撞上 edge-mac-widget 踩过的 `Code generation from strings disallowed` 那个坑。`undici` 那个 508 KB 的 chunk 是 Node 的 HTTP 客户端，Workers 上应当排除。

### 验证用浏览器而不是 node

模型写完两个文件后需要知道结果对不对。直觉做法是 `node --check extra.js`，那会把 Sandbox 拉进依赖。这条路径在本 workload 下是错的，三条理由：

- **验错了解析器。** `extra.js` 的运行环境是浏览器，不是 Node。两者的 module/script 语义和顶层 await 可用性都不同，而 Node 对 DOM 一无所知。
- **只覆盖语法。** 本项目真正的失败模式是 `querySelector` 返回 null、XPath 在抓取内容里不成立——edge-mac-widget 用一整节记录了这类问题。`node --check` 一个都抓不到。
- **浏览器这一趟本来就要跑。** 用户要求渲染生成的 widget 并截图看效果，那次渲染会同时暴露语法错误、运行时错误和视觉结果。

因此不引入 Sandbox，而是提供一个 `preview_widget` 自定义工具，一次调用返回全部三样：

```ts
const errors = [];
page.on("pageerror",     e => errors.push(`uncaught: ${e.message}`));
page.on("console",       m => m.type() === "error" && errors.push(`console: ${m.text()}`));
page.on("requestfailed", r => errors.push(`failed: ${r.url()}`));

// 请求拦截让 <script src="extra.js"> 从 L1 解析：渲染的是文件真实的样子，
// 而不是把两个文件拼成一段 HTML 喂进去。
await page.setRequestInterception(true);
page.on("request", req => req.respond(readFromWorkspace(req.url())));
await page.goto("https://widget.local/widget.html");

// 用浏览器自己的解析器做确定性语法检查，不依赖解析错误如何冒泡成事件。
// 这个 new Function 在页面上下文里执行，不受 Workers 的代码生成限制约束。
const syntax = await page.evaluate(src => {
  try { new Function(src); return null } catch (e) { return e.message }
}, extraJs);

const shot = await page.screenshot();
```

`pageerror` / `console` / `requestfailed` / `setRequestInterception` / `respond` / `screenshot` 均已在 `@cloudflare/puppeteer@1.4.0` 的类型定义中确认存在。**以 npm 上的版本为准，不要照 Browser Run 文档锁版本**——该页（更新于 2026-04-21）仍称当前版本为 1.1.0 / Puppeteer 22.13.1，而 npm 上已是 1.4.0；上述 API 是对 1.4.0 验证的。

浏览器生命周期用 `keep_alive` 而非 alarm：

```js
const browser = await puppeteer.launch(env.BROWSER, { keep_alive: 600000 })  // 上限 10 分钟
```

这是**空闲**超时而非会话上限（默认 1 分钟，可配到 10 分钟），只要有命令进来就持续存活。一次 turn 内两次 `preview_widget` 的间隔几乎不可能超过 10 分钟，因此浏览器实例在 turn 内无需额外保活动作。

**注意这与 Durable Object 的保活是两件不同的事。** `keep_alive` 只延长 Browser Run 侧浏览器实例的存活，对 DO 自身的驱逐计时器没有任何影响——DO 仍需依靠[后端架构篇](2026-09-28-backend-architecture.md)描述的保活 alarm。两者名字相近但作用于不同的对象，不要互相替代。

跨 turn 复用走会话而非 alarm：`browser.disconnect()`（不是 `close()`）保留会话，下次用 `puppeteer.sessions(env.BROWSER)` 列出空闲会话并 `puppeteer.connect(env.BROWSER, sessionId)` 接上，失败再 `launch`。Workers Paid 档每账号并发 200 个实例、每秒新建 3 个。

**请求拦截已在生产实测通过。** `goto("https://widget.local/widget.html")` 配合 `setRequestInterception(true)` 返回 `200`——拦截在 DNS 解析之前生效，不可解析的域名不构成问题。同一次实测还确认：

- `/widget.html` 与 `/extra.js` 均从工作区提供
- `<script src="extra.js">` **真实加载并执行**（页面文本被该脚本改写，证明走的是解析路径而非拼接）
- 引用一个不存在的文件产生 `requestfailed` 事件
- 页面内 `new Function(src)` 捕获到故意注入的语法错误
- 截图正常返回（8,051 字节 PNG）

因此不需要 `setContent` + `addScriptTag` 的退路，"能测到 `<script src>` 真实解析"这项能力得以保留。

**但拦截器必须处理 `/favicon.ico`。** 浏览器会自动请求它，而工作区里没有；不特殊处理的话它会以一条 `requestfailed` 加一条 `console` 错误的形式进入错误列表，让模型误以为 widget 有问题。对工作区之外的路径应静默响应 `204`，而不是 `abort()`——后者正是产生噪声的原因。

### 挡住模型去敲 node

模型有惯性，看到 JavaScript 就会尝试 `node --check`。让它撞上 `command not found` 会浪费若干轮试错。在 just-bash 里注册一个同名自定义命令，返回可执行的指引而不是沉默失败：

```
node is not available in this environment.
extra.js runs in a browser, not Node. Use the preview_widget tool —
it renders the widget, reports syntax and runtime errors, and returns a screenshot.
```

`npm` / `pnpm` / `npx` 同样处理。`js-exec` 与 `python3` 在该构建里本就不存在或自带排除说明，但它们的默认文案没有指向替代方案，同样值得覆盖成一句"用 `sed`/`awk`/`jq` 处理文本"。

### 截图的上下文预算

每次迭代产生一张截图，而图片在 LLM 上下文里按 token 计费并占用窗口。迭代五六轮就可能把窗口撑满，表现为模型突然开始遗忘早期指令。

策略：**只有最近一次 `preview_widget` 的截图进入出站上下文**，更早的在 `convertToLlm` 的出站视图里替换为一行文字摘要（例如"截图已省略：第 2 轮渲染，2 个 console 错误"），SQLite 里的原始条目不改写。这与 edge-mac-widget 处理重复 brief 的做法同形——改出站视图，不改存储。

截图本身作为二进制存进 L1 的分块表即可，它不参与 grep。若单会话截图累积到影响 DO 存储，再考虑迁往 R2；这是 R2 未来第一个真实用例。

### iOS 离线

工具移到服务端之后，一轮 turn 不再需要客户端参与就能跑完。剩下的是投递问题，沿用 edge-mac-widget 已经验证过的两个机制：

- **outbox 合帧**：事件批量成帧推送，不是一个 token 一帧。Cloudflare 明确建议 batching，否则单 DO 吞吐会被上下文切换吃掉
- **游标补发**：客户端重连时带上最后收到的序号，服务端补发之后的条目。本项目用 SSE 的 `Last-Event-ID` 承载该游标（edge-mac-widget 在 WebSocket 上手写为 `sinceSeq`）

新增的是 turn 期间的 DO 存活保证，而这一点与直觉相反：**调用 LLM 的普通 `fetch()` 并不保活 Durable Object**，即使响应体仍在流式返回（只有出站 TCP 与出站 WebSocket 会延缓驱逐）。因此一轮进行中的 turn 无法靠自身阻止 DO 被逐出内存。

turn 的持久性因此来自 DO 侧的保活 alarm（主力）与增量持久化后的恢复（兜底），完整设计见[后端架构](2026-09-28-backend-architecture.md)。本篇只需要知道其结论：**工具的每一次写入都必须在完成时立即落盘**，不能依赖 turn 结束时统一提交——保活失效时 turn 可能走不到结束。

推送通知（APNs）不进本版本。客户端靠重连后拉增量发现结果。

## 文件系统：为什么是 DO 而不是 R2

在三五个文件的规模下，这个决定对性能是低风险的——两种存储都能工作。真正支撑结论的是三条与规模无关的理由：`getAllPaths()` 的同步签名、R2 的单 key 写入速率、以及少引入一个组件。下面逐条展开，并标明哪些论据依赖规模假设。

### R2 没有搜索原语

这是最根本的一条，也是最容易被"对象存储更适合存大文件"的直觉盖过去的一条。

R2 只提供两个操作：`list()` 拿 key 列表，`get()` 拿整个对象或一段 byte range。**没有内容索引，没有范围搜索，没有条件读取。** 所以"在 R2 上实现 grep"这件事不存在，唯一的实现是把对象 GET 下来、在 Worker 内存里用 JS 正则扫。

而 just-bash 本来就是这么做的。实测 `just-bash@3.4.2`（用 Proxy 记录每一次 FS 调用）：

| 命令 | 读法 | 次数 |
|---|---|---|
| `grep -rn` | `readFile(path)` 整个文件 | 每文件一次 |
| `rg -n` | `readFileBytes(path)` 整个文件 | 每文件一次 |
| `find` | 不读内容 | 0 |

这是结构决定的而非实现选择：`IFileSystem` 的三个读方法都只接受一个 path，**没有任何 offset / length / range 参数**。

因此内容终究要整份进 Worker 内存，两种存储的区别只剩搬运代价：

| | DO SQLite | R2 |
|---|---|---|
| 搬运方式 | 同进程 SQL 读 | HTTP 子请求 |
| 网络往返 | 0 | 每文件 1 次 |
| 子请求消耗 | 0 | 计入 1,000/次调用的上限 |
| 单次延迟 | 微秒级 | 冷路径几十毫秒量级 |

**在本文档假设的三五个文件规模下，这张表的实际差距不大**：R2 下一次 `grep -r` 是三五个子请求，几百毫秒，可以接受。这条论据是按几百文件的 workspace 成立的，对当前 workload 不构成决定性理由。记录在此是因为 workspace 规模若增长，它会重新变成主导因素。

实测中另有一处消耗：`rg` 每次调用会在每一层目录探测 `.gitignore` / `.rgignore` / `.ignore`，两层目录即产生 6 次额外读且全部 miss。DO 上是 6 次 SQL 空查，R2 上是 6 个白扔的子请求加往返。

`find` 稍好——R2 的 `list({ prefix })` 可以当目录遍历用——但 glob 匹配仍要在 Worker 里做。`grep` 和 `rg` 完全没有可利用的服务端能力。

### just-bash 的接口形状也指向 DO

`IFileSystem` 有 21 个方法，20 个返回 `Promise`。唯一的例外是 glob 匹配依赖的：

```ts
getAllPaths(): string[]
```

R2 的 Workers binding 全部异步，无法直接满足它，只能另建一份内存路径表——而那就已经需要一个同步可读的存储了。DO SQLite 恰好同步：

```ts
interface SqlStorage {
  exec<T>(query: string, ...bindings: any[]): SqlStorageCursor<T>;  // 不是 Promise
}
```

（签名取自 `@cloudflare/workers-types@5.20260921.1`。）

### R2 的单 key 写入速率会成为障碍

R2 对**同一个 object key 的并发写上限是 1 次/秒**，超出返回 HTTP 429。agent 迭代 `widget.html` 时在一秒内连续改两次是完全正常的行为，届时写入会被拒绝，而这个失败出现在工具层、对模型表现为一次莫名的写失败。DO SQLite 没有对应限制。

### R2 在 v1 里没有工作

R2 原本在本提案里有两个职责，现在都没了：

- **承载超过 2 MB 的文件**——分块存储解决了，且解决得更好（文件留在可搜索的那一层）
- **作为 Sandbox 的同步介质**——Sandbox 不进 v1

所以 v1 不引入 R2。将来把它加回来的条件有三条，各自明确：

| 触发条件 | R2 承担什么 |
|---|---|
| Sandbox 落地 | 同步介质——`mountBucket` 只认 S3 兼容存储，DO 挂不上 |
| 产物需要公网 URL | **DO 里的文件没有 URL。** 第三方要打开生成的 widget 时，只有把文件 `put` 进 R2 再签一个限时预签名 GET 才能给出可访问的链接 |
| 单文件超出 DO 承载 | 单 DO 上限 10 GB；R2 单对象 5 TiB |

第二条容易被忽略，因为 v1 的客户端是自家 iOS app，走认证过的 API 即可，不需要 URL。`@cloudflare/computer` 正是为此提供了独立的 assets 路径（工作区文件 `put` 进 R2 后返回预签名 URL），而它的权威状态同样在 DO SQLite——**R2 在那套设计里只出现在两端：导入种子数据、导出可分享链接，不在读写搜索的路径上**。这与本篇的结论一致。

## 曾考虑的替代方案

**大文件溢出到 R2（本提案的前一版）。** 设一个 1 MB 阈值，超过的文件存 R2，L1 只留索引。否决它的是 workspace 的实际形状：唯一的大文件是网页 source，而那**正是模型要反复 grep 的对象**。把它放进没有搜索原语的那一层，意味着 `grep -r` 会静默地跳过最重要的文件——这不是性能退化，是正确性错误，而且是隐蔽的（grep 返回 0 结果，看起来像"没匹配到"）。分块存储没有这个缺陷，且实现更简单。

**用 `@cloudflare/computer` 的 isolate shell 而不是自己实现。** 这是 Cloudflare 官方的同形方案：Durable Object SQLite 作为权威状态，`just-bash` 作为 shell，容器 backend 是可选的独立 export，不 import 即不进包。调研（`@cloudflare/computer@0.3.1`）确认它与本篇设计高度重合，**分块常量同为 512 KB**，而其 schema 更成熟——`vfs_nodes` / `vfs_dirents` 是真正的 inode 模型，`vfs_blobs` / `vfs_blob_bytes` 做内容寻址去重，另有按 blob hash 的 LRU 缓存。

它能解决本篇记录的两条风险：

- `grep` / `find` 是 DO 侧的一等 RPC 原语，搜索在 DO 内完成、只回传匹配项，而不是把整个文件拉过边界
- shell 跑在通过 Worker Loader 铸造的独立 isolate 里，其 CPU 与内存不占用 DO——直接缓解「DO 单实例 CPU 串行」那条风险
- `js-exec` / `python` / `sqlite` / `curl` 作为可选命令组可用（各 12–104 KB，未 import 即被打包器丢弃），缓解「模型无法写脚本处理 HTML」那条风险

Worker Loader 绑定已在本账号实测可用，不构成障碍。

**否决理由是其自述的成熟度**：两个包的 README 均写明 "PREVIEW ONLY … It is NOT suitable for production use at this time"，且声明 API 不稳定。此外它要求 `experimental` compatibility flag，而底层的 `@cloudflare/dofs` 与 `@cloudflare/computer-rpc` **未发布到 npm**（仅被打包进 `@cloudflare/computer` 的 dist），因此无法只取文件系统层。

**迁移成本是有界的**：两边的 shell 都实现 just-bash 的 `IFileSystem`，接口相同。因此本篇要求把 `IFileSystem` 的实现与其余代码隔离干净——将来该包稳定后换底层，改动应当局限在这一层。**这条不是可选的工程洁癖，而是本次否决所依赖的前提。**

**纯内存 workspace（`InMemoryFs`）。** 最简单，性能最好，但 DO 驱逐即全丢。保活 alarm 让 turn 内的驱逐变得罕见，却挡不住代码部署强制重启——那时工作区连同未落盘的成果一起消失，而用户的 prompt 已经付过 LLM 费用。Workers 128 MB 的 isolate 上限也是硬顶。**作为 L1 之上的读缓存保留**（见分块存储一节），但不能作为事实来源。

**引入 Sandbox 做 `node --check`。** 这是模型会主动要求的路径，也是最容易顺手答应的一条。否决理由见「验证用浏览器而不是 node」：它验错了解析器、只覆盖语法、而且重复了浏览器这一趟本来就要做的事。代价却是实打实的——一个容器编排层、一套 L1 与容器之间的文件同步、以及按容器运行时间计费的成本模型。**Sandbox 的正当用途是跑构建、装依赖、跑测试；本 workload 三者都没有。** 若将来 widget 生成需要打包或引入 npm 依赖，这条重新评估。

**全程用 Sandbox，不要 L1。** 把 workspace 直接放在容器磁盘上，`grep` / `rg` 用真正的 ripgrep，`node` 也能直接跑——功能上最干净。否决它的是三件事：容器冷启动的延迟落在每一个工具调用的关键路径上；容器 idle 停止后文件全丢，仍然需要一个持久层，于是 L1 并没有被省掉，只是变成了备份层；以及 Containers 按容器运行时间计费，而 agent 的大部分时间在等 LLM，容器空转。Sandbox 适合当按需拉起的计算层，不适合当常驻工作区。

**沿用 edge-mac-widget 的客户端执行工具。** 这正是问题陈述里被否决的那条。补充一点：即使 iOS 端能实现一个文件系统和 bash，App Store 的沙箱限制也让 `node` / `npm` 这类命令不可能在设备上执行。这条路径的上限比服务端方案低。

**用 D1 代替 DO SQLite。** D1 是异步的，同样过不了 `getAllPaths()` 那一关，而且 D1 是跨请求共享的数据库，失去了 DO"单实例即单写者"带来的无锁语义。agent 的会话天然是单写者，DO 的形状更贴合。

## 验证

分层归属见[测试策略](../testing/2026-09-28-test-strategy.md)。下列由 `backend/src/fs/workspace-fs.test.ts`、`backend/src/shell/bash.test.ts` 与 `backend/src/do/upload.test.ts` 中的自动化用例钉住，全部跑在真实 workerd 内：

### 分块存储与 IFileSystem

- 5 MB 文件逐字节往返；断言比对每一个字节而非长度，因为分块顺序错乱仍能通过长度检查
- 多字节 UTF-8 字符恰好跨越 512 KB 边界时解码无误——分块按字节而非按字符切
- `getAllPaths()` 返回数组而非 Promise
- `stat` / `readFileBuffer` / `readdir` / `rm` / `mv` / `cp` 对不存在的路径抛 `ENOENT`；`rm --force` 是无操作；`link` 抛 `ENOSYS`
- 重组结果被缓存，写入后失效
- 两个会话写同名 `source.html` 互不可见、互不覆盖

### shell 命令

- 跨分块边界的 pattern 被 `grep -n` 命中，边界两侧与跨越处三个位置均返回
- `rg` / `find` / `sed` / `awk` / `jq` / 管道 / 重定向在工作区上可用
- shell 重定向写入 `/out` 触发 `out_file` 通知——该通知挂在文件系统层，因此不依赖任何工具调用
- `node` / `npm` / `python3` / `js-exec` 返回指向替代方案的指引文本而非 `command not found`
- `which` 查命令注册表：可用命令返回 0，被引导的命令返回 1，且工作区中不出现 `/usr/bin` 桩

### 上传

- multipart 的 `file` 部分写入工作区根目录；gzip 部分解压后落盘，字节与压缩前一致
- 上传名去掉目录成分：`../../etc/passwd` 落为 `/passwd`，写入不能逃出根

### preview_widget

在生产部署上验证（本地 miniflare 在 Apple Silicon 上取到架构不匹配的 Chromium，`spawn Unknown system error -88`）：

- `out/widget.html` 中的 `<script src="extra.js">` 经请求拦截从工作区加载并**实际执行**——页面文本由 `hello` 变为 `patched`，证明走的是解析路径而非拼接
- 错误列表为空，说明 `/favicon.ico` 的 204 处理生效；若改为 `abort()`，它会以 `requestfailed` 加一条 console 错误的形式进入列表
- 截图返回 5,188 字节

### 尚未覆盖

- `IFileSystem` 实现与其余代码的隔离没有用例守住。这条是[否决 `@cloudflare/computer`](#曾考虑的替代方案) 所依赖的前提：若接口渗透到工具层之外，当初"迁移成本有界"的判断就失效了
- 1 MB 以上单个产物经 `turn_end` 与历史读取完整返回——已实现无阈值分支，但没有用例固定它

## 风险

**无 Node API 构建的命令缺口可能在实际使用中比预期更痛。** 上表是按本 workload 判断"够用"的，但模型面对一个 5 MB 的 HTML 时，用 `awk` 做结构化抽取远比写十行 JS 笨拙，可能产生更多轮次和更长的命令。**这一条需要真实任务观察，不能仅凭命令表在场就认为能力等价。** 若确实成为瓶颈，补救方向是注册自定义命令（`defineCommand` 在 Workers 上可用，因为它执行的是宿主侧 TypeScript 而非 guest JavaScript），把常用的 HTML 抽取操作做成专用命令，而不是引入 Sandbox。

**just-bash 与真实 bash 的语义差异。** 它是 beta 软件，自己的 README 写明"Use at your own risk"。命令表很全，但边角行为（locale、`sed` 的 GNU 扩展、`awk` 的具体方言、正则引擎——它用 re2js 而不是 PCRE）必然与真实环境有差。模型习惯了真 bash 的行为，遇到差异会生成不工作的命令并且不一定能从报错里看出原因。缓解：在系统提示词里明确当前 shell 的能力边界。**注意 re2js 不支持反向引用和前后向断言**，模型写惯了的 PCRE 正则会直接报错——这一条要在提示词里点名。

**单次查询的总量上限已实测，余量充足但不应依赖未记载的部分。** 生产实测：512 KB 分块下，一次 `SELECT … ORDER BY idx` 返回 5 MB（10 行）、20 MB（40 行）、50 MB（100 行）均成功并完成重组。

同时发现**文档标称的 2 MB 单行上限并未被强制**：单行 2 / 3 / 4 / 8 MB 均写读往返成功，16 MB 与 32 MB 则导致 DO 崩溃（空响应），真实边界在 8–16 MB 之间。

**设计仍按 512 KB 分块，不使用这段余量。** 超出文档的部分没有 Cloudflare 的承诺，随时可能收紧；实测值的用途是确认余量存在，而非把它当作设计前提。

**DO 单实例的 CPU 是串行的。** 一个 DO 里跑多个 session 时，grep 这种 CPU 密集操作会互相阻塞——DO 的执行模型是单线程的。每请求 CPU 上限 30 秒（可配置到 5 分钟 active CPU）。5 MB 的正则扫描远在预算内，但要把 CPU 密集工具纳入 `MAX_CONCURRENT_TURNS` 的同一个预算，而不只是限制 streaming 的数量。

**输入页面可能远大于预期。** 5 MB 是按"重型 SPA 的 DOM dump"估的。如果实际遇到几十 MB 的页面，分块存储本身没问题（10 GB 上限），但**全量重组会撞 128 MB isolate 上限**，于是不得不放弃上面那条不变量、改成逐块扫描——而那条路没有简单解：重叠窗口必须不小于最长可能匹配减一，但正则的最长匹配长度一般无界（`<div.*</div>` 可以跨几百 KB），选不出保证正确的窗口。严格正确的做法是把文件当流喂给增量匹配的 DFA，而 re2js 不提供这个接口。按行分块可以让 grep 免于重叠（行内匹配，行不跨块），但压缩过的 HTML 整页可能就一行且超过 2 MB，那时又退化回按字节切。**先按 5 MB 全量重组设计，把实测的页面大小分布作为是否需要重新设计的判据；这是本提案最可能被真实数据推翻的一条。**

**浏览器渲染成功不等于 widget 正确。** `preview_widget` 能抓到语法错误、未捕获异常和加载失败，但抓不到"渲染出来了，数字是错的"。edge-mac-widget 记录过这类失败：主字段全 null 的硬编码摘要、用抓取时看到的数字当缺值兜底、把 52 周高低点插值成一年走势。截图能让模型看见布局，但看不出数据是不是编的。这类正确性只能靠提示词约束和人工检查，不在本层的能力范围内——**不要因为有了截图就以为验证闭环了。**

**渲染引擎与真实运行环境不同。** `widget.html` 的目标运行环境是 iOS app 内的 WebView（WKWebView / WebKit），而 Browser Run 是 headless Chromium。截图和错误报告因此是**近似**：CSS 特性支持、JS 语法可用性、日期解析等都存在已知的 WebKit/Chromium 差异，Chromium 下正常的 widget 可能在设备上不正常。

这不构成选择 Browser Run 的理由缺陷——Sandbox 是 Linux 容器，其中的浏览器同样不是 WebKit，离目标更远。**没有任何服务端方案能验证 WKWebView 的真实行为。** 真正的闭环需要 iOS 端渲染后把结果或 JS 错误回传作为下一轮输入，那是产品层的决定，不在本提案范围内。记在这里是为了防止把服务端截图通过当成验证完成。

**alarm 是 DO 的单一资源。** 浏览器侧的 `keep_alive` 并不减轻这条：它只作用于 Browser Run 的浏览器实例，DO 自身仍需保活 alarm（见[后端架构篇](2026-09-28-backend-architecture.md)的实测——无保活的 turn 在 70 秒被杀）。

因此 DO 的唯一 alarm 槽位已经承载了"turn 保活 + 中断检测"。若本篇将来再引入第三个用途（例如跨 turn 的浏览器会话回收、工作区过期清理），必须并入同一个按最早到期时间设置的调度器，并在触发时判断该做哪件事。两处独立 `setAlarm` 会互相覆盖，症状是间歇性的"该做的事没做"，难以复现。

**放弃 Sandbox 是一个可能需要回退的决定。** 当前 workload 是"读 HTML、写两个文件、渲染截图"，不需要构建或依赖。若后续 widget 需要打包、引入 npm 库、或跑测试，Sandbox 就必须加回来，届时 R2 也一并需要（`mountBucket` 只认 S3 兼容存储，DO 挂不上）。这不是设计缺陷，是范围假设；把它记在这里是为了让回退时能看到当初的判断依据。

## 后果

**换来了什么。** 工作区是 DO 进程内的一张表，因此 `grep` / `rg` / `find` 全程零子请求、零网络往返；文件系统与工具层之间没有 RPC，也没有第二份状态需要同步。v1 因此不引入 R2 与 Containers，Cloudflare 侧只用到 Workers、Durable Objects 与 Browser Run，实现是 2,617 行源码。

**付出了什么。** 三项能力被这个选择排除：

- 工作区容量受单个 Durable Object 的 10 GB 约束，而产物重组进内存又受 128 MB isolate 上限约束——后者是真正的天花板，一个几十 MB 的页面会先撞它
- 无 Node API 的构建丢掉了 `js-exec`、`python3`、`sqlite3` 与 `curl`，模型只能用 sed/awk/jq 这套文本工具改写 HTML，比写十行脚本笨拙
- 没有 Sandbox 就没有真实运行时，任何需要打包或 npm 依赖的流程都做不到

**一个未被消除的缺口。** `preview_widget` 能抓语法错误、未捕获异常与加载失败，抓不到"渲染出来了但数字是编的"；而它渲染用的是 Chromium，产物真正运行在 iOS 的 WebView 里。这两条都不是本篇能解决的，验证闭环需要设备侧参与。
