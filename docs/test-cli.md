# CLI 使用

CLI 用于驱动服务端、执行端到端检查及本地预览 widget。[本地预览](#本地预览-widget)不需要服务端或凭据；其余服务端命令先完成[本地运行](development.md)，配置 `WEBCLIP_URL`、`WEBCLIP_TOKEN` 和 `WEBCLIP_USER`。前两项必填，用户标识默认是 `cli`。以下命令在仓库根目录执行；`<session>` 替换为创建会话返回的 ID。

```bash
export WEBCLIP_URL=http://localhost:8787
export WEBCLIP_TOKEN=$(grep AUTH_TOKEN .dev.vars | cut -d= -f2-)
export WEBCLIP_USER=me
```

连接本地服务也需要 `WEBCLIP_TOKEN`。将上面的占位文字替换为 `backend/.dev.vars` 中的真实 `AUTH_TOKEN`；连接远端时使用远端服务配置的 `AUTH_TOKEN`。test-cli 不会自动读取 `.dev.vars`，也不使用模型网关的 `LLM_API_KEY`。这些环境变量在执行命令的同一个终端中设置。

```bash
npm run test-cli -- new "某个页面"          # 建会话
npm run test-cli -- prompt "…"              # 跑一轮，流式打印；会话自动建
npm run test-cli -- prompt <session> "…"    # 接着某个会话跑
echo "你好啊" | npm run test-cli -- chat     # 一句话就说完，会话自动建
npm run test-cli -- chat                    # 连续对话，每行一轮
npm run test-cli -- chat <session>          # 接着已有会话聊
npm run test-cli -- events <session> 0      # 回放并跟随
npm run test-cli -- timeline <session>      # 这一轮的时间花在哪
npm run test-cli -- sessions                # 列表
npm run test-cli -- abort <session>
npm run test-cli -- rm <session>           # 删除会话
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
| `/abort` | 标记当前轮次为中止 |
| `/rm [session]` | 删除会话，默认当前 |
| `/quit` | 退出 |

交互命令与别名以 `/help` 为准，它由 [CLI 的命令定义](../test-cli/index.mjs)生成。切换会话会把游标归零：序号只在产生它的那条日志里有意义。


**首轮带上网页与截图**：仓库提供 [HTML 样例](../test-cli/fixtures/source.html)，截图需要自行准备；也可以把两处路径替换为自己的文件。

```bash
npm run test-cli -- prompt \
  --file ./test-cli/fixtures/source.html --file ./screenshot.png --gzip \
  "读 source.html，把报价做成 widget"
```

会话可省：不给就新建一个并打印它的 id。首个位置上的裸 UUID 当作会话，`--session <id>` 是它的显式写法。

`--file` 可给零个、一个或多个，文件写入工作区根目录：路径中的目录部分会被剥掉，`./a/b/source.html` 落成 `/source.html`，所以提示词里直接按文件名引用。`--gzip` 只压缩文本类扩展名——服务端解压后再落盘，因此 `grep` 看到的是真实字节；PNG 之类不会被再压一遍。


`abort` 的执行限制、回放与重连语义见[客户端协议](protocol.md)。CLI 的 `events` 读取一次流；网络断开后需要再次调用并传入已收到的游标。

## 框选页面内容并生成 widget

```bash
npm run test-cli -- prompt "帮我做个微软股价的 widget" --url "https://example.com/quote" --select
npm run test-cli -- prompt "把这几个区域做成 widget" --file ./source.html --select
```

`--url` 只接受 HTTP/HTTPS，与 --file 中的 HTML 来源互斥；非 HTML 附件可继续通过 --file 上传。多个 HTML 来源、缺失 URL、没有页面来源的 --select 会报错。

浏览器正常运行原网页脚本，load 后等 3 秒进入框选。拖框吸附完整 DOM 区块，可多选、删除、清空及切换浏览模式；父/子区块按钮用于调整范围。最多 8 个区域，同一元素不会重复添加。浏览模式可先登录或关闭弹窗；整页导航后旧选区清空。iframe 和 Shadow DOM 内部暂不支持，小图表不能靠截图像素生成可更新数据提取。

每个区域保留 XPath 和 DOM 文本，短小纯文本可省略截图；有图区域缩放到不超过 768px 后拼成一张不超过 1200×1200px 的编号图。点击预览检查清晰度，可返回重选，再点击确认发送。capture、当前 DOM 规范化为 source.html、拼图和 prompt 同轮提交；本地原文件不覆盖。数据定位与格式见[Capture 协议](protocol.md#capture区域与图片)。

HTML 解析器可能修复页面脚本生成的嵌套链接等结构。CLI 在克隆文档中追踪选区，确认区域唯一且文字、链接和图片引用保留，不要求实时 DOM 与捕获 HTML 逐字相同。`xpath` 定位捕获 HTML；位置有变时，`sourceXPath` 另行记录实时网页路径。真实网页不因规范化而修改。选区本身被拆分或内容移出范围时，错误会标明区域编号和路径；可点击该区域的“父区块”选择完整新闻卡片后重试。

**不加 --select 的唯一 HTML/URL 输入也会启动浏览器，自动捕获并发送一张整页截图**；在选择界面直接确认且无选区也发送整页。整页图宽高不超过 768px，不拆图，不通过无限滚动扩展页面；长页文字可能过小，需要精细视觉信息时应框选区域。浏览器不可用会报错，不能静默作为无图请求发送。无页面来源的普通文本对话保持原流程。

关闭选择浏览器或取消会结束捕获，不创建新会话、不发送模型请求。浏览器使用独立临时 profile，不共享日常登录态，捕获不单独导出 cookie、localStorage 或请求头。截图前后 DOM 或区域位置变化会自动重采一次，持续变化则提示重选；快速持续变化的页面可能无法稳定捕获。图片编码后超过 2 MiB 时提示调整区域。

确认捕获、取得 sessionId 后，CLI 在发送生成请求前保存 `downloads/<sessionId>/capture/`，并打印 `Capture saved: <绝对路径>`。目录含：

- `source.html`：与提交内容一致的捕获 DOM。
- `regions.png` 或 `regions.jpg`：最终编号拼图；整页模式为 `page.png` 或 `page.jpg`；纯文本选区没有图片。
- `capture.json`：与请求一致的 XPath、区域文本、拼图坐标和页面 URL 元数据。

同一会话再次捕获会更新这一专用目录，并移除其中旧截图；该目录不要存放需要保留的手工文件。widget 的三个产物及运行时 data.json 不受影响。副本保存失败时不发送 prompt，后续 HTTP/模型失败时副本仍保留。新会话创建失败时还没有 sessionId，不会生成此目录。

生成完成后，可以使用这份源页面调试提取：

```bash
npm run test-cli -- preview --out ./downloads/SESSION_ID
```

该模式复用本地预览的 CHROME_EXECUTABLE 和临时浏览器管理，需要 Chrome/Chromium；只有服务端真正接受并完成生成后，CLI 才按既有规则保存三个产物。

## 自动保存 widget

`prompt` 和 `chat` 收到本轮成功完成的三个文件后，自动保存到当前目录下的 `downloads/<sessionId>/`，并打印 `Saved widget: <绝对路径>`。目录内是 `extra.js`、`widget.html`、`meta.json`；文件职责、数据注入方式和三档尺寸见[产物协议](protocol.md#widget-文件与截图)。目录不存在时自动创建；同一会话的后续产物覆盖这三个文件，路径不变。客户端的 data.json、其他文件及原有旧轮次子目录保留。

CLI 校验文件集合、UTF-8 字节数、sha256 和 metadata，先将全部文件写入临时目录，再逐个替换会话目录中的产物。缺文件、内容损坏、写入失败、失败/中止轮次或本轮完成事件缺失会报错并以非零状态退出，不会宣称保存成功。无产物的普通对话不创建目录。三个产物即使被本地修改也会覆盖；每个文件单独替换，若替换过程中发生 IO 故障，可能已更新部分文件，CLI 会报错。

`events` 跟随到实时完成事件时也会保存。历史完成事件只有 metadata，没有文件内容，CLI 会提示 `historical content unavailable`；目前无法补下载断线期间已完成的文件。

保存目录包含服务端生成的三个文件。运行时的 `data.json` 由 iOS 客户端执行提取后写入同目录；本地调试也需准备该文件，再用 HTTP server 打开 `widget.html`。HTML 不内嵌数据，缺少 data.json 时显示静态错误状态，详情见[数据加载约定](protocol.md#widget-文件与截图)。

## 本地预览 widget

已有网页 HTML 和生成的产物目录时，直接运行：

```bash
npm run test-cli -- preview --out ./downloads/SESSION_ID
npm run test-cli -- preview --out ./downloads/SESSION_ID --source ./source.html
npm run test-cli -- preview --help
```

`--out` 必填，`--source` 可选，路径相对于命令的工作目录。未传 --source 时使用 `<out>/capture/source.html`；显式传入时优先使用指定文件。找不到选定的源文件会报错，不搜索其他目录。out 必须已有 `extra.js`、`widget.html`、`meta.json`；可以含有 data.json 或其他文件。该命令不调用 backend 或模型，也不需要 WEBCLIP 环境变量。

CLI 启动独立的可见 Chrome/Chromium，以 file URL 打开 source.html，正常执行原页面脚本；等待页面 load 后固定再等 **3 秒**，执行 extra.js 的完整内容。同步 JSON 对象通过校验后写入 out/data.json，已有数据文件被覆盖，其他文件保留。提取、校验或写入失败不会替换原数据。固定 3 秒不保证所有网站的异步数据都已到达，提取使用当时的 DOM；没有选择器或等待时长参数。

随后 CLI 启动仅监听 `127.0.0.1` 的 HTTP server，自动选择空闲端口，并在同一浏览器中打开 widget.html。页面按 meta 的参考尺寸显示，并从磁盘上的 data.json 读取数据。等 widgetReady、字体和图片完成后，终端打印 `Data saved:` 和 `Preview ready:`；只有这些步骤成功才报告就绪。渲染失败会退出并报告错误，已成功生成的 data.json 保留。

终端持续运行供查看；按 Ctrl-C、发送 SIGTERM、关闭预览标签页或关闭该浏览器会结束命令，关闭 HTTP 服务并删除临时浏览器 profile。再次提取时重新运行命令。命令不借用日常浏览器的登录态；本地 file URL 也不能恢复原网站的 origin 或缺失资源。

浏览器可执行文件通过 `CHROME_EXECUTABLE` 指定。未设置时，macOS 使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，其他平台使用 PATH 中的 `chromium`。需要图形桌面环境；CLI 不自动下载浏览器。完整浏览器配置和测试入口见[开发指南](development.md)。
