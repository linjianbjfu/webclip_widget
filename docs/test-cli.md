# CLI 使用

CLI 用于驱动服务端、执行端到端检查及本地预览 widget。[本地预览](#本地预览-widget)不需要服务端或凭据；其余服务端命令先完成[本地运行](development.md)，配置 `WEBCLIP_URL`、`WEBCLIP_TOKEN` 和 `WEBCLIP_USER`。前两项必填，用户标识默认是 `cli`。以下命令在仓库根目录执行；`<session>` 替换为创建会话返回的 ID。

```bash
export WEBCLIP_URL=http://localhost:8787
export WEBCLIP_TOKEN='替换为 backend/.dev.vars 中 AUTH_TOKEN 的实际值'
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

## 自动保存 widget

`prompt` 和 `chat` 收到本轮成功完成的三个文件后，自动保存到当前目录下的 `downloads/<sessionId>/`，并打印 `Saved widget: <绝对路径>`。目录内是 `extra.js`、`widget.html`、`meta.json`；文件职责、数据注入方式和三档尺寸见[产物协议](protocol.md#widget-文件与截图)。目录不存在时自动创建；同一会话的后续产物覆盖这三个文件，路径不变。客户端的 data.json、其他文件及原有旧轮次子目录保留。

CLI 校验文件集合、UTF-8 字节数、sha256 和 metadata，先将全部文件写入临时目录，再逐个替换会话目录中的产物。缺文件、内容损坏、写入失败、失败/中止轮次或本轮完成事件缺失会报错并以非零状态退出，不会宣称保存成功。无产物的普通对话不创建目录。三个产物即使被本地修改也会覆盖；每个文件单独替换，若替换过程中发生 IO 故障，可能已更新部分文件，CLI 会报错。

`events` 跟随到实时完成事件时也会保存。历史完成事件只有 metadata，没有文件内容，CLI 会提示 `historical content unavailable`；目前无法补下载断线期间已完成的文件。

保存目录包含服务端生成的三个文件。运行时的 `data.json` 由 iOS 客户端执行提取后写入同目录；本地调试也需准备该文件，再用 HTTP server 打开 `widget.html`。HTML 不内嵌数据，缺少 data.json 时显示静态错误状态，详情见[数据加载约定](protocol.md#widget-文件与截图)。

## 本地预览 widget

已有网页 HTML 和生成的产物目录时，直接运行：

```bash
npm run test-cli -- preview --source ./source.html --out ./downloads/SESSION_ID
npm run test-cli -- preview --help
```

`--source` 和 `--out` 均必填，路径相对于命令的工作目录。out 必须已有 `extra.js`、`widget.html`、`meta.json`；可以含有 data.json 或其他文件。该命令不调用 backend 或模型，也不需要 WEBCLIP 环境变量。

CLI 启动独立的可见 Chrome/Chromium，以 file URL 打开 source.html，正常执行原页面脚本；等待页面 load 后固定再等 **3 秒**，执行 extra.js 的完整内容。同步 JSON 对象通过校验后写入 out/data.json，已有数据文件被覆盖，其他文件保留。提取、校验或写入失败不会替换原数据。固定 3 秒不保证所有网站的异步数据都已到达，提取使用当时的 DOM；没有选择器或等待时长参数。

随后 CLI 启动仅监听 `127.0.0.1` 的 HTTP server，自动选择空闲端口，并在同一浏览器中打开 widget.html。页面按 meta 的参考尺寸显示，并从磁盘上的 data.json 读取数据。等 widgetReady、字体和图片完成后，终端打印 `Data saved:` 和 `Preview ready:`；只有这些步骤成功才报告就绪。渲染失败会退出并报告错误，已成功生成的 data.json 保留。

终端持续运行供查看；按 Ctrl-C、发送 SIGTERM、关闭预览标签页或关闭该浏览器会结束命令，关闭 HTTP 服务并删除临时浏览器 profile。再次提取时重新运行命令。命令不借用日常浏览器的登录态；本地 file URL 也不能恢复原网站的 origin 或缺失资源。

浏览器可执行文件通过 `CHROME_EXECUTABLE` 指定。未设置时，macOS 使用 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，其他平台使用 PATH 中的 `chromium`。需要图形桌面环境；CLI 不自动下载浏览器。完整浏览器配置和测试入口见[开发指南](development.md)。
