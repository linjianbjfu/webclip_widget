# 开发、测试与部署

以下命令在仓库根目录执行。需要满足 [package.json](../package.json) 声明的 Node 版本（≥ 22.6），以及模型网关的地址和凭据。开发服务由 Wrangler 启动。

## 目录与配置归属

[backend/](../backend/) 是 npm workspace，包含服务端源码、并置测试、Wrangler 配置、生成类型和后端专用脚本；依赖声明在 [backend/package.json](../backend/package.json)。根目录维护统一的 package-lock.json，安装在根目录执行。

[test-cli/](../test-cli/) 是无第三方依赖的 Node 客户端，通过 HTTP 访问后端。它使用 `WEBCLIP_URL`、`WEBCLIP_TOKEN`、`WEBCLIP_USER`，不读取后端模型密钥。输入文件路径相对于启动 CLI 的当前目录。

根目录的 dev、test、typecheck、types、deploy 和 verify-model-limits 命令转发到 backend，后端工具的工作目录是 backend。也可以在该目录直接执行对应 npm 命令。未来 iOS 与 Web 应用使用独立目录及配置；共享协议仍由 [protocol.md](protocol.md)维护。

## 本地运行

```bash
npm install
cp backend/.dev.vars.example backend/.dev.vars
```

[backend/.dev.vars.example](../backend/.dev.vars.example) 是可提交的模板；真实的 `.dev.vars` 及其环境变体被 Git 忽略。在 `backend/.dev.vars` 填入 `LLM_BASE_URL`、`LLM_API_KEY` 和 `AUTH_TOKEN`，然后启动：

```bash
npm run dev
```

`AUTH_TOKEN` 是访问本服务的共享密钥，与模型网关的 `LLM_API_KEY` 不同。未配置 `AUTH_TOKEN` 时所有 HTTP 请求返回 503；缺失或错误的 Bearer token 返回 401。客户端接入方式见[协议](protocol.md)。

[wrangler.jsonc](../backend/wrangler.jsonc) 声明 DO、Browser Run 绑定、provider 和默认模型；模型注册表由 [model.ts](../backend/src/agent/model.ts) 维护。`MAX_CONCURRENT_TURNS` 虽已声明，目前执行路径没有读取它，不能据此认为跨会话并发受到限制。

## 验证

| 命令 | 覆盖范围 |
|---|---|
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | Workers runtime 中的测试 |
| `npm run test:agent` | 真实 pi SDK 的 prompt 加载、UTF-8 读取和编辑 |
| `npm run test:cli` | Node 中的 bundle 保存及真实 CLI 命令入口测试 |
| `npm run test:browser` | 本地 Chrome 中的提取、三档布局、溢出与动画检查 |
| `npm run verify-docs` | README、根指令和 docs 中的本地 Markdown 链接目标 |
| `npm run verify-notes` | Agent Note 分类、格式与归档封存 |
| `npm run verify-model-limits` | 模型注册表与网关公布的上限 |
| `npm run check` | 上述检查的串行聚合，任一失败即停止 |

单元与模块集成测试与实现放在一起，命名为 `backend/src/**/<模块>.test.ts`。例如 [store.test.ts](../backend/src/do/store.test.ts) 测试同目录的 Store，[user-agent-do.test.ts](../backend/src/do/user-agent-do.test.ts) 测试 DO alarm 与恢复分支。Vitest 默认发现这些文件，无需维护文件清单。

CLI 测试与实现并置于 `test-cli/*.test.mjs`，使用独立临时目录与随机监听端口。SDK 接入测试位于 `backend/src/agent/*.node.test.mjs`，在 Node 中直接调用真实 pi SDK 验证 resource loader 和工具 IO，不替代 Workers 平台验证。浏览器测试与渲染实现并置于 `backend/src/agent/*.browser.test.mjs`，不进入 Workers 测试池。`test:browser` 使用 `CHROME_EXECUTABLE` 指定的浏览器；未设置时，macOS 使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，其他平台使用 PATH 中的 `chromium`。缺少浏览器会失败，需安装 Chromium 或设置该变量。浏览器测试每次分配独立配置目录和调试端口，并在结束时关闭进程。

真实服务端到端检查位于 [test-cli/checks.mjs](../test-cli/checks.mjs)。[模型兼容性测试](../backend/src/agent/model.live.test.ts.skip)保留 `.skip` 后缀，不参与默认测试；其 pi 导入与 Workers 测试池的兼容限制尚未解决。

`verify-model-limits` 从环境变量或 `backend/.dev.vars` 读取网关凭据；缺少凭据时输出未检查并以 0 退出。因此 `check` 成功不代表模型上限一定已核验，报告时应单独说明跳过情况。

文档链接检查只检查本地文件或目录是否存在，不检查 URL 可访问性、标题锚点或行为描述。新改的命令与行为需要相应的执行证据；不能运行的部分应在交付时说明原因。

### 真实服务检查

先运行本地服务或准备已部署的服务，再配置 CLI：

```bash
export WEBCLIP_URL=http://localhost:8787
export WEBCLIP_TOKEN='替换为 backend/.dev.vars 中 AUTH_TOKEN 的实际值'
export WEBCLIP_USER=me
npm run test-cli -- sessions
npm run e2e
```

```bash
npm run e2e:widgets
```

该检查使用[固定网页](../test-cli/fixtures/widget-source.html)，真实生成 small、middle、large 以及两种未指定尺寸的 widget。要求最终 Browser Run 预览成功、metadata 符合预期并保存三个文件到 `downloads/`；会清理测试会话。它需要模型凭据和可用的 Browser Run，产生模型费用，不属于默认 `check`。如果改变 backend 源码触发 Wrangler 重载，正在运行的模型检查会断线，需要待服务就绪后重新运行；断线结果不算通过。

`sessions` 用于确认认证和路由；新服务的列表为空是正常结果。`e2e` 会创建测试会话、调用真实模型并清理会话，产生模型费用。测试检查认证、SSE 续传、幂等、上传和产物交付；其实现位于 [test-cli/checks.mjs](../test-cli/checks.mjs)。

```bash
WEBCLIP_SLOW=1 npm run e2e
```

慢检查用于验证客户端消失后的 turn 存活，默认跳过。它要求实际 turn 超过 70 秒；不足时会重试一次，仍不足则失败。等待期间不能向同一个 DO 轮询，否则轮询本身会保活，掩盖问题。本地 workerd 不能证明线上驱逐行为，保活验证需要部署环境。测试层次及覆盖缺口见[测试策略](../.agents/notes/implemented/testing/2026-09-28-test-strategy.md)。

## 浏览器启动排查

本地 `preview_widget` 依赖 Wrangler 下载的 Chrome for Testing。下载解压被中断时，缓存可能只有启动器而缺少 Frameworks，启动会报 `spawn Unknown system error -88`。可以先检查缓存是否完整：

```bash
find ~/Library/Caches/.wrangler/chrome -type f | wc -l
```

本项目曾观察到完整缓存有两千余文件，而残缺缓存只有个位数；数量仅用于判断是否明显残缺。确认损坏后删除该浏览器缓存，再启动 `npm run dev` 重新下载，等待解压完成：

```bash
rm -rf ~/Library/Caches/.wrangler/chrome
```

工具将浏览器启动失败返回给模型，一次预览失败不直接终止整轮。Chromium 预览不等于 iOS WKWebView 验证；运行环境差异见[架构与限制](architecture.md)。

## 部署

在具备目标 Cloudflare 账户权限的环境执行：

```bash
npx wrangler secret put --config backend/wrangler.jsonc AUTH_TOKEN
npx wrangler secret put --config backend/wrangler.jsonc LLM_API_KEY
npx wrangler secret put --config backend/wrangler.jsonc LLM_BASE_URL
npm run deploy
```

不要把这三个 secret 以空值声明在 `backend/wrangler.jsonc` 的 `vars` 中，空值会覆盖 secret。部署后将 `WEBCLIP_URL` 指向返回的服务地址，再运行上述认证与端到端检查。

共享密钥只限制服务访问，不能验证用户身份。持有密钥的人可以指定任意 `x-webclip-user`；真实用户接入前需要独立的身份验证方案。
