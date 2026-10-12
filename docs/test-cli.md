# CLI 使用

CLI 用于驱动服务端、执行端到端检查及本地预览 widget。[本地预览](#本地预览-widget)不需要服务端或凭据；`--api edgewidgets` 使用[独立配置](#调用-edge-widgets-api)；其余服务端命令先完成[本地运行](development.md)，配置 `WEBCLIP_URL`、`WEBCLIP_TOKEN` 和 `WEBCLIP_USER`。前两项必填，用户标识默认是 `cli`。以下命令在仓库根目录执行；`<session>` 替换为创建会话返回的 ID。

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
npm run test-cli -- -- --api edgewidgets --url "https://example.com" --prompt "…" # 调外部生成 API
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

`preview_widget` 在实时输出和历史回放中显示 `validation: passed` 或 `validation: failed`，并列出尺寸、语法检查和错误原因；重复的错误合并显示，截图与页面全文不打印。浏览器启动等工具执行异常显示 `ERROR`。其他工具的 `ok` 仅表示执行未报错。

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

## 调用 Edge Widgets API

`--api edgewidgets` 不创建 webclip_widget 会话，也不读取 `WEBCLIP_URL`、`WEBCLIP_TOKEN` 或 `WEBCLIP_USER`。新模式需要独立配置：

复制根目录的 `.env.example`：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`：

```dotenv
SERVICE_URL=https://你的服务根地址
GEC_API_KEY=你的GEC-API-Key
CHROME_EXECUTABLE="C:\Program Files\Google\Chrome\Application\chrome.exe"
```

CLI 启动时自动读取仓库根 `.env`。当前终端、CI 或父进程已经设置的同名变量优先，不会被文件覆盖；`.env` 不存在时，所选命令仍按原有规则报告缺失配置。真实 `.env` 已被 Git 忽略，不要把密钥写入 `.env.example`。

也可以只在当前终端设置：

```bash
export SERVICE_URL=https://example.edgewidgets.service
export GEC_API_KEY=<service-api-key>
```

`GEC_API_KEY` 只用于计算请求的 `sec-ms-gec` 头，不写入输出或日志。CLI 同时发送 `sec-ms-gec-version: 1-153.0.4197.0`。

新模式只接受一个 HTTP/HTTPS `--url` 和一个非空 `--prompt`；session ID、位置参数消息、`--file`、`--select`、`--gzip` 均会报错。CLI 会显示使用独立临时 profile 的 Chrome/Chromium 窗口，并打开原有区域选择界面。手动框选一个或多个目标区域，点击预览并确认发送；可返回重选或取消。确认后 CLI 读取重定向后的最终 URL、`document.title` 和裁剪后的 `source.html`，关闭窗口并调用：

```bash
node test-cli/index.mjs --api edgewidgets --url "https://www.baidu.com" --prompt "根据当前页面创建一个百度首页热搜头条 Widget"
```

`test-cli` 是目录，因此 Node 入口需要写成 `test-cli/index.mjs`。使用 npm 时，命令是：

```bash
npm run test-cli -- -- --api edgewidgets --url "https://www.baidu.com" --prompt "根据当前页面创建一个百度首页热搜头条 Widget"
```

npm 11 会消费第一层之后的选项名，因此该入口需要写成：

```bash
npm run test-cli -- -- --api edgewidgets --url "https://www.baidu.com" --prompt "根据当前页面创建一个百度首页热搜头条 Widget"
```

第一个 `--` 结束 npm 自己的参数解析，第二个 `--` 作为脚本参数保留下来并由 CLI 忽略。推荐直接使用上面的 `node test-cli/index.mjs`，避免 npm 的额外参数层。

```text
POST ${SERVICE_URL}/api/edgewidgets/generate
```

请求字段为 `userQuery`、`url`、`pageTitle`、空数组 `history`、`htmlContent`，以及可选 `input_image`。有区域拼图或整页截图时，CLI 按 capture MIME 生成完整 `data:image/png;base64,...` 或 `data:image/jpeg;base64,...` Data URI。EdgeServices 解码后校验大小，并要求 URI MIME 与 JPEG/PNG/GIF/WebP magic bytes 一致，再把该 Data URI 原样交给 vision 模型。纯文本选区没有图片时省略该字段。HTTP 或响应校验失败时命令返回非零，不保存 widget 产物。

`htmlContent` 只保留通往选区的必要结构、选区内容及 XPath 稳定性需要的前方元素，不是整页自动快照。选择阶段生成的截图和 capture metadata 用于本地预览与裁剪，不发送给当前外部 API。取消选择时不调用 API，也不创建输出目录。

每次实际发出 API 请求后，CLI 都保存调用记录。成功响应另将 `extractScript` 和 `widgetHtml` 原样保存：

```text
downloads/api-YYYYMMDD-HHmmss/
  api-url.txt
  request.json
  response.json
  extra.js
  widget.html
  meta.json
  capture/
    capture.json
    source.html
    regions.png | regions.jpg
```

`api-url.txt` 是实际 endpoint；`request.json` 是实际请求体；`response.json` 是实际响应体。JSON 使用两个空格缩进。记录不包含请求头、GEC token 或 `GEC_API_KEY`，但有图时 `request.json` 会包含完整图片 Data URI。`meta.json` 保留 API 的逻辑 size；响应同时提供合法 `width`、`height` 时也写入并用于预览，否则按 size 使用项目原三档画布。

`capture/` 保存确认时的 metadata、裁剪 source.html 和可选区域拼图，文件名与 capture.json 引用一致。HTTP 错误、业务 `status` 失败、非 JSON 响应或响应缺少产物字段时，目录包含三份调用记录和 capture，不包含三个 widget 产物，命令仍返回非零。非 JSON body 作为 JSON 字符串保存在 `response.json`；网络或响应流在取得 body 前失败时保存 `null`。捕获取消或发请求前失败不创建目录。

目录时间使用执行 CLI 的本地时区，精确到秒；同名目录已经存在时命令失败，不覆盖旧结果。响应的 `warnings` 打印到 stderr。

Edge Widgets CLI 根据响应的 `size`、`width`、`height` 生成 `meta.json`，但不自动改写 `extra.js` 或 `widget.html`。外部代码仍可能不满足本仓库的同步 IIFE、`widgetReady`、静态无动画或 `#widget-root` 约定；metadata 只让预览使用正确画布，不等于通过三文件质量检查。调用记录包含裁剪 HTML、页面数据、图片 base64 和生成结果，是本机明文调试材料；`downloads/` 已被 Git 忽略，分享前仍需检查敏感内容。

## 框选页面内容并生成 widget

```bash
npm run test-cli -- prompt "帮我做个微软股价的 widget" --url "https://example.com/quote" --select
npm run test-cli -- prompt "把这几个区域做成 widget" --file ./source.html --select
```

`--url` 只接受 HTTP/HTTPS，与 --file 中的 HTML 来源互斥；非 HTML 附件可继续通过 --file 上传。多个 HTML 来源、缺失 URL、没有页面来源的 --select 会报错。

浏览器正常运行原网页脚本，load 后等 3 秒进入框选。拖框吸附完整 DOM 区块，可多选、删除、清空及切换浏览模式；父/子区块按钮用于调整范围。最多 8 个区域，同一元素不会重复添加。浏览模式可先登录或关闭弹窗；整页导航后旧选区清空。iframe 和 Shadow DOM 内部暂不支持，小图表不能靠截图像素生成可更新数据提取。

每个区域保留从文档根开始的正向绝对 XPath 和 DOM 文本，短小纯文本可省略截图；有图区域缩放到不超过 768px 后拼成一张不超过 1200×1200px 的编号图。点击预览检查清晰度，可返回重选，再点击确认发送。capture、当前 DOM 规范化为 source.html、拼图和 prompt 同轮提交；本地原文件不覆盖。数据定位与格式见[Capture 协议](protocol.md#capture区域与图片)。

有选区时，source.html 完整保留选区、祖先链及沿途前方兄弟元素的结构和属性，清空选区外的文本、注释及 script/style 正文；逐层删除最后一个包含选区的分支之后的无关兄弟节点。多选保留通往全部选区的路径，重叠部分不复制。选区内部的数据和 SVG 保留；无选区时不裁剪页面。正向 XPath 精简前后必须命中同一区域，不能根据删减后的文档推断全局 id 唯一性或倒序位置。

HTML 解析器可能修复页面脚本生成的嵌套链接等结构。CLI 在克隆文档中追踪选区，确认区域唯一且文字、链接和图片引用保留，不要求实时 DOM 与捕获 HTML 逐字相同。`xpath` 定位捕获 HTML；位置有变时，`sourceXPath` 另行记录实时网页路径。真实网页不因规范化而修改。选区本身被拆分或内容移出范围时，错误会标明区域编号和路径；可点击该区域的“父区块”选择完整新闻卡片后重试。

**不加 --select 的唯一 HTML/URL 输入也会启动浏览器，自动捕获并发送一张整页截图**；在选择界面直接确认且无选区也发送整页。整页图宽高不超过 768px，不拆图，不通过无限滚动扩展页面；长页文字可能过小，需要精细视觉信息时应框选区域。浏览器不可用会报错，不能静默作为无图请求发送。无页面来源的普通文本对话保持原流程。

关闭选择浏览器或取消会结束捕获，不创建新会话、不发送模型请求。浏览器使用独立临时 profile，不共享日常登录态，捕获不单独导出 cookie、localStorage 或请求头。截图前后保留的 DOM、实时选区内容或区域位置变化会自动重采一次，持续变化则提示重选；已清空内容或已删除后方分支的变化若不影响选区，则不会阻止捕获；快速持续变化的页面可能无法稳定捕获。图片编码后超过 2 MiB 时提示调整区域。

确认捕获、取得 sessionId 后，CLI 在发送生成请求前保存 `downloads/<sessionId>/capture/`，并打印 `Capture saved: <绝对路径>`。目录含：

- `source.html`：与提交内容一致的捕获 DOM；有选区时为精简版本。
- `regions.png` 或 `regions.jpg`：最终编号拼图；整页模式为 `page.png` 或 `page.jpg`；纯文本选区没有图片。
- `capture.json`：与请求一致的 XPath、区域文本、拼图坐标和页面 URL 元数据；其中 pageUrl 是默认 preview 的来源地址。

同一会话再次捕获会更新这一专用目录，并移除其中旧截图；该目录不要存放需要保留的手工文件。widget 的三个产物及运行时 data.json 不受影响。副本保存失败时不发送 prompt，后续 HTTP/模型失败时副本仍保留。新会话创建失败时还没有 sessionId，不会生成此目录。

生成完成后，可以重新打开记录的在线 URL 调试提取：

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

已有捕获记录和生成的产物目录时，直接运行；离线调试可显式指定原始 HTML：

```bash
npm run test-cli -- preview --out ./downloads/SESSION_ID
npm run test-cli -- preview --out ./downloads/api-YYYYMMDD-HHmmss
npm run test-cli -- preview --out ./downloads/SESSION_ID --source ./source.html
npm run test-cli -- preview --help
```

`--out` 必填，路径相对于命令的工作目录。默认从 `<out>/capture/capture.json` 读取 `pageUrl` 和 viewport，打开该 HTTP/HTTPS 地址，使用捕获时的视口尺寸及 DPR 1。旧捕获只要有这些字段即可使用；无需 capture/source.html。缺少或非法 URL、viewport 或损坏的 metadata 会报错。默认不会退回 source.html，也不用 requestUrl 或 baseUrl 代替 pageUrl。

`--source <原始 HTML>` 是显式离线入口：以 file URL 打开指定文件，优先于保存的 URL，不要求 capture.json。out 必须已有 `extra.js`、`widget.html`、`meta.json`；可以含有 data.json 或其他文件。该命令不调用 backend 或模型，也不需要 WEBCLIP 环境变量。

CLI 启动独立的可见 Chrome/Chromium，正常执行网页脚本；等待页面 load 后固定再等 **5 秒**，执行 extra.js 的完整内容。同步 JSON 对象通过校验后写入 out/data.json，已有数据文件被覆盖，其他文件保留。加载失败、HTTP 4xx/5xx、提取、校验或写入失败不会替换原数据。固定 5 秒不保证所有网站的异步数据都已到达，提取使用当时的 DOM；没有选择器或等待时长参数。

目录同时包含 `api-url.txt`、`request.json`、`response.json` 时，CLI 自动识别为 Edge Widgets 兼容预览；三个标记缺一会报损坏。该模式允许 extra.js 返回 Promise，等待完成后仍要求结果是 JSON 对象。普通 bundle 不含这些标记，继续拒绝异步 extra.js，标准提取契约不放宽。

提取结果可含选区图片的 base64 data URI，widget 直接从 data.json 显示，不再次请求原图 URL。跨域像素不可读或图片未就绪时可省略图片；服务端捕获 DOM 预览不能替代这条在线路径。renderer 已移除或隐藏的可选坏图不阻止就绪，仍可见的图片解码失败会报错。图片预算与支持边界见[产物协议](protocol.md#widget-文件与截图)。

随后 CLI 启动仅监听 `127.0.0.1` 的 HTTP server，自动选择空闲端口，并在同一浏览器中打开 widget.html。页面按 meta 的最终 viewport 显示，并从磁盘上的 data.json 读取数据。标准模式等待 widgetReady、字体和图片完成后打印 `Preview ready:`。Edge 兼容模式要求 data.json HTTP/JSON 成功，等待 DOM 稳定及字体、图片完成后打印 `Edge Widgets compatibility preview ready:`；它不要求外部页面提供 widgetReady 或 `#widget-root`，也不执行标准 bundle 的同步提取、静态无动画和重复渲染保证。两种模式都会先打印 `Data saved:`，失败不报告 ready，已成功生成的 data.json 保留。

终端持续运行供查看；按 Ctrl-C、发送 SIGTERM、关闭预览标签页或关闭该浏览器会结束命令，关闭 HTTP 服务并删除临时浏览器 profile。再次提取时重新运行命令。命令不借用日常浏览器的登录态，不恢复捕获时的滚动位置或点击状态。在线列表内容可能已变化；显式 file URL 不能恢复原网站 origin 或缺失资源，精简的捕获 HTML 也不是完整网站存档。

浏览器可执行文件通过 `CHROME_EXECUTABLE` 指定。未设置时，macOS 使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，其他平台使用 PATH 中的 `chromium`。需要图形桌面环境；CLI 不自动下载浏览器。完整浏览器配置和测试入口见[开发指南](development.md)。
