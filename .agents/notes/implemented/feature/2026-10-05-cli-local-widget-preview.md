# Agent Note: CLI 从本地源网页提取数据并预览 widget

Status: implemented

## 问题

已有 source.html 和生成的 widget 目录时，开发者需要一条命令执行源页面脚本、提取数据、保存 data.json 并打开 HTTP widget，复现客户端运行流程。该过程无需创建服务端会话或重新调用模型。

## 决策

`preview --out <目录> [--source <HTML>]` 是独立 CLI 命令，在服务端配置和 Client 初始化前分流，不依赖 WEBCLIP 环境变量。默认使用 capture.json 的 pageUrl 和 viewport 打开在线页面，显式 --source 则使用指定的本地文件；缺失时直接报错，不自动回退。默认来源和等待约定由[DOM 精简与原 URL 预览](2026-10-06-pruned-capture-live-url-preview.md)拥有。out 必须已有 extra.js、widget.html、meta.json，允许包含 data.json 和其他文件；输入路径相对于工作目录，输出不追加会话或轮次目录。用法与浏览器配置由[CLI 文档](../../../../docs/test-cli.md#本地预览-widget)拥有。

源页面在独立、可见 Chrome/Chromium 中加载，正常执行网页脚本；在线入口使用捕获视口及 DPR 1，显式本地文件通过 file URL 加载。load 之后固定等待 5 秒，再直接求值 extra.js；没有选择器或等待时长参数。等待可中止。提取结果与 backend 使用同一 extractionExpression 校验，在浏览器中等待对象或 Promise 结果，拒绝超时、失败和非 JSON 对象；异步返回约定见[图片字节提取](../bug-fix/2026-10-08-fetch-image-bytes.md)。backend 使用惰性捕获 DOM，CLI 使用实际加载后的 document，各自保留页面加载方式。

结果在 out 内暂存后重命名为 data.json，覆盖旧数据，其他产物保持不变。提取、校验或写入失败不覆盖原数据，也不启动结果服务。提取成功后关闭源页面，并启动仅监听 127.0.0.1、自动分配端口的静态 HTTP server，服务范围限定在 out。根请求打开 widget.html，禁止目录索引、路径穿越及符号链接越界，响应禁用缓存。

结果页在同一浏览器中按 meta 的参考尺寸打开，真正通过 HTTP 读取磁盘 data.json。widgetReady、字体、图片成功后才打印就绪。Ctrl-C/SIGTERM、关闭结果标签页或浏览器都会结束流程；浏览器和服务关闭完成后删除临时 profile。渲染失败返回非零，但保留已提取的数据。

### 资源与依赖归属

浏览器启动、连接、有界操作及进程清理由 test-cli/browser.mjs 拥有，CLI 和 backend 的 Node 浏览器测试共用。每次运行原子分配临时 profile 和调试端口；HTTP 使用 listen(0)，不扫描并抢占预测端口。test-cli 作为 npm workspace 显式声明 Puppeteer 依赖，共享根 lockfile，不依赖 backend 的偶然依赖提升，也不自动下载浏览器。

Chrome 辅助进程可能在主进程退出后继续持有继承的 stderr。启动器在主进程 exit 时关闭自己持有的 stderr 读取端，再等待 close，避免清理被独立的更新/崩溃报告进程寿命拖住。Puppeteer 的可移除生命周期监听使用 on/off 配对，源页面的主动关闭不触发整条预览退出。

## 曾考虑的替代方案

**给 prompt/chat 加预览开关。** 已有本地文件不需要服务端凭据或模型调用，独立命令可重复验证同一产物。

**直接调用 backend renderWidgetPreview。** 其惰性 DOM、虚拟数据响应与截图流程不执行原页面脚本，也不写本地 data.json，因此仅共享提取结果校验。

**无头提取后打开默认浏览器。** 无法统一 viewport、widgetReady 检查和关闭生命周期，采用 CLI 自己管理的可见浏览器，不借用日常 profile。

**按选择器等待，或禁用源网页脚本。** 用户选择正常执行源脚本，并在 load 后固定等待几秒，采用固定等待，不增加等待参数。

## 验证

- `npm run test:cli`：13 项通过，覆盖实际 CLI 无凭据入口、参数、必需文件、非法 meta、固定等待顺序与取消、data.json 覆盖/失败保留、暂存清理及 HTTP GET/HEAD、状态码、实时文件内容与路径/符号链接越界。
- `npm run test:browser`：7 项通过，覆盖原有 backend 渲染、源脚本执行后的值、直接提取、三档 viewport、HTTP 数据读取、重复运行、并发独立端口/profile、提取与渲染失败、超时取消及标签页/浏览器/信号退出。POSIX 实际 CLI 适配器与继承 stderr 的确定性回归均通过；Windows 不运行这两个 POSIX 可执行文件测试。
- 继承 stderr 用例让浏览器替身退出、后代保持管道打开，验证启动失败仍能完成进程清理并删除 profile。此前的挂起轮次和被终止轮次不计为通过。
- 可见模式通过 `npm run test-cli -- preview` 使用实际生成的 small widget 实跑，HTTP data.json 返回 `{"failures":0}`；Ctrl-C 后该 HTTP 端口不再可访问。npm 包装命令在此次终端中断返回 1；直接 CLI 子进程的 SIGINT/SIGTERM 用例返回 0 并完成清理。
- 类型检查、文档、Notes 与 diff 门禁通过。无模型调用或服务端部署要求。

离线 `--snapshot` 使用 capture v2 的配对结构文件，不执行源脚本；HTML 文件 `--source` 仍按浏览器解析。结构等价与兼容边界由[实时 DOM 结构保真](../../implemented/bug-fix/2026-10-08-capture-live-dom-structure.md)拥有。

## 后果

本地复现从原网页到 widget 的完整数据路径只需一条命令，代价是需要已安装的 Chrome/Chromium 与图形桌面。file URL 不恢复原网站 origin、登录态或缺失资源；固定 5 秒也不保证任意异步数据全部到达。它是 Chromium 调试流程，不能替代 iOS WKWebView 真机验证。

每次运行只提取一次；重新提取通过再次执行命令触发。没有文件监听、轮询、模型重生成、截图导出或局域网公开服务。

[直接执行脚本](../simplification/2026-10-01-direct-extraction-script.md)、[运行时数据文件](2026-10-01-widget-runtime-data-json.md)、[会话目录覆盖](../simplification/2026-10-01-cli-session-output.md)及[测试分层](../testing/2026-09-28-test-strategy.md)的独立理由仍然有效，保持活跃并同步相关事实，没有完全取代、归档或删除的笔记。
