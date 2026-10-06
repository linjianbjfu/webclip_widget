# Agent Note: iOS 静态 widget 的尺寸、三文件产物与 CLI 保存

Status: implemented

## 问题

widget 页面用于 iOS 桌面背景截图，需要有明确的尺寸、稳定的可见内容，以及可在源网页重新执行的提取脚本。只要求模型写文件，不能保证画布、数据接入和下载后的行为一致；实时 SSE 中的文件也需要由 CLI 保存。

参考项目的 Windows 实时卡片样式、动画和手动保存 data.json 的流程不适用于本产品。当前提示词独立编写，仅借鉴依据捕获 DOM 定位内容、校验缺值和保持提取与渲染一致的原则。

## 决策

### 产物与尺寸

交付 `extra.js`、`widget.html`、`meta.json`。metadata 只有 `size: small | middle | large`。HTML 自适应宿主 viewport，服务端用 small 160×160、middle 344×160、large 344×360 CSS px 作为预览基准，不把某一机型的尺寸写死进产物。

用户显式尺寸优先；首次未指定时，模型选择能清楚呈现内容的最小档位，后续保留已有尺寸，除非用户或内容需求改变。prompt 不规定配色、字体、圆角或装饰模板；禁止 CSS/JS/SVG 动画、过渡、动图、视频和依赖交互、滚动、定时刷新的内容。详细接口由[产物协议](../../../../docs/protocol.md#widget-文件与截图)拥有。

`extra.js` 的命名函数入口由[直接执行脚本决策](../simplification/2026-10-01-direct-extraction-script.md)替代，脚本执行后直接返回对象；`widget.html` 定义同步的 `renderWidget(data)`，两者共享当前 bundle 的数据结构。该决策最初采用内嵌捕获快照与宿主注入。数据来源及对应预览方式由[运行时 data.json 决策](2026-10-01-widget-runtime-data-json.md)替代，当前客户端负责写入 data.json，HTML 经 HTTP 加载后渲染；三文件交付、尺寸和 SDK 接入理由继续有效。

### SDK 与预览

pi 从已经 reload 的 resource loader 读取 brief。`createAgentSession` 顶层不支持 systemPrompt，因此不能在整个配置对象上用类型断言隐藏字段错误；必要的 SDK 泛型兼容断言只位于工具列表。read/edit 适配器返回 Buffer，因为 SDK 调用 `toString("utf-8")` 或 `toString("base64")`，普通 Uint8Array 会变成十进制字节列表。

`preview_widget` 先校验三文件及 metadata，再在独立浏览器 context 中提取、渲染、截图。捕获 HTML 用 DOMParser 解析，源脚本不运行。数据 HTTP 加载、就绪信号与渲染一致性检查由[运行时数据决策](2026-10-01-widget-runtime-data-json.md)拥有；根边界、溢出及动画检查继续执行。完整提取 JSON 写到交付目录之外供模型检查字段。

SDK 用抛出的异常标记工具执行失败，不读取返回对象上的 isError 属性。预览无法执行时抛出简短错误；已执行的质量检查保留截图，并以 `details.valid` 与文本报告结论。真实模型检查读取该结论，不能把 tool_end 的 ok 当作产物合格。

### 本地保存

CLI 的 prompt/chat 只保存当前 turn 的成功产物；events 也保存跟随到的实时产物。本地每轮目录与不覆盖的选择由[会话目录覆盖决策](../simplification/2026-10-01-cli-session-output.md)替代，当前使用 `downloads/<sessionId>/` 并覆盖三个文件。共享校验继续拒绝缺文件、重复或额外路径、非法 metadata；CLI 校验 UTF-8 字节数与 sha256。

历史事件仍只有元数据，不能补下载断线期间完成的文件。在线保存复用 SSE 内容，不引入新的读取端点。完成事件表示 turn 结束，普通对话不受强制三文件校验；有产物时 CLI 才执行 bundle 校验。

## 曾考虑的替代方案

**仅修改 prompt。** 无法给尺寸和静态布局提供执行证据，也无法完成 CLI 保存，因此同步实现预览和下载。

**固定 HTML 像素宽高。** 预览容易统一，但客户端被迫服从某一画布。用户选择自适应画布，参考尺寸只用于可重复验证。

**extra.js 仅负责渲染。** 能沿用简单页面加载路径，但不能在源网页重新提取。独立提取可在源网页重复执行，渲染数据的传输方式由客户端流程决定。

**为在线保存新增下载端点。** SSE 已携带完整文本内容，额外接口会引入读取版本和重试语义。离线恢复仍是明确缺口；若需要补下载，必须另行定义读取当前文件或历史版本的语义。

## 验证

- `npm test`：88 项通过；metadata 的非法值、额外字段、缺文件及重复路径均有负例。
- `npm run test:agent`：3 项真实 SDK 接入测试通过，覆盖 brief 加载、中文 read/edit 和预览拒绝非法 bundle。旧 Uint8Array 适配器另经负例确认不能通过 UTF-8 读取断言。
- `npm run test:cli`：5 项通过，包含真实 prompt、连续 chat、实时 events 子进程入口，以及历史元数据、错误 turnId、损坏内容、文件系统失败和提前断线。两组独立测试进程并发运行也通过，端口和临时目录互不争用。
- `npm run test:browser`：真实 Chrome 验证三档画布、零值、缺字段、源脚本隔离及 context 清理；越界、裁剪、CSS/JS 动画、数据加载错误、重复渲染、资源和语法错误均有拒绝用例。截图不做像素相等断言。
- `e2e:widgets` 的五个案例在本地 Wrangler、真实模型及 Browser Run 上全部通过：显式三档与自动选择 small/large，最终预览的 valid 为 true，三文件保存并通过哈希校验。浏览器环境修复前的结果与重载中断的轮次不计为通过。
- 下载产物另在独立 Chrome 中复查真实内容和宽高各增加 24 CSS px 的画布；零值、12 条设备名称、缺失时长及自适应根尺寸正确。三档截图经过目视检查。
- brief 本文按 o200k_base 计数由 114 增至 1,225 tokens（481 → 6,166 UTF-8 字节）。旧 brief 未正确接入 SDK，因此这不是实际请求总 token 的前后比较；工具 schema、SDK 附加上下文及截图另计。

## 后果

尺寸与数据接入成为可验证的文件约定，在线 CLI 能保存完整的三个服务端文件，实际查看所需的数据由客户端提供。代价是浏览器检查和更长的任务提示词；每次截图作为工具结果进入上下文，当前不裁掉旧截图；持久化采用[图片引用与分块](../feature/2026-10-05-region-capture-multimodal-widget.md)，恢复模型上下文时还原。

静态检查不能穷尽任意定时 JavaScript 或动图，也不能证明提取区域的事实正确性。尺寸自动选择仍是模型判断；真实样例通过不等于所有页面必然合格。Chromium 验证不能替代 iOS WKWebView 真机检查。本次未部署生产环境，也未验证真机。

相关的[后端架构](../architecture/2026-09-28-backend-architecture.md)、[工作区决策](../architecture/2026-09-28-server-workspace-filesystem.md)和[测试策略](../testing/2026-09-28-test-strategy.md)仍拥有持久化、服务端执行与测试分层的独立理由，保持活跃并同步事实；没有完全被取代的笔记需要归档或删除。
