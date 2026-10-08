# Agent Note: 网页多区域框选与图片、XPath 联合输入

Status: implemented

## 问题

用户需要从指定网页区域生成 widget。只有 source.html 和一句文本不足以表达关注的范围与视觉语义；框选时页面脚本可能已改变 DOM，单独使用原始 HTML 的 XPath 容易错位。图片也必须进入模型请求，不能仅作为工作区文件保存。

## 决策

### 捕获与范围

prompt 支持 --url 在线页面或唯一的 HTML --file，二者互斥；--select 打开浏览器多选。页面正常运行原脚本，在 load 后等待 3 秒进入框选，拖框吸附普通 DOM 区块，并提供父/子区块调整、删除、清空、浏览模式和拼图确认。取消不创建新 session 或发送 prompt。无 --select 的单一页面输入自动发送整页图；已有 preview 命令独立保留。

区域最多 8 个。发送的是捕获时主文档 DOM 的 UTF-8 source.html 副本（有选区时精简，无选区时完整）、XPath 和文本、编号拼图及用户原始 prompt。工具节点从 HTML 和截图中排除，v2 以配对结构快照保留实时层级，XPath 唯一命中且选区树相等；新捕获不生成 sourceXPath，旧 v1 兼容保留。结构取舍见[实时 DOM 结构保真](../../implemented/bug-fix/2026-10-08-capture-live-dom-structure.md)，旧解析器限制见[捕获 XPath 校验](../bug-fix/2026-10-06-capture-xpath-parser-repair.md)。精简策略与正向路径保证见[DOM 精简与原 URL 预览](2026-10-06-pruned-capture-live-url-preview.md)。捕获前后保留 DOM、选区内容/区域位置不同会重采一次，持续变化时提示重选。预览确认发送的是已展示的捕获快照，不把等待用户确认期间页面的新状态混进去。

本地源文件不修改。在线来源记录请求 URL、捕获时最终 URL 和 baseURI；server 不再次抓取页面。临时浏览器 profile 独立，用户可在浏览模式手动登录。整页导航后选择 UI 重新安装，旧目标不继承；脱离 DOM 的目标不能发送。

确认的捕获输入在发送前保存到会话的 capture 子目录；路径、覆盖和失败保留语义由[本地 debug 副本](2026-10-06-local-capture-debug.md)拥有。临时上传文件依旧在结束后清理。

### 图片与关联

小型纯文本区域可只发送 XPath/text，图标和图表仍保留图片。全部选区仅文本时 images 为空，不补整页截图。每区至多一块本地裁图，等比例缩到宽高不超过 768px，然后组成一张宽高不超过 1200px 的拼图；按长宽比在横向、纵向及网格中选择较清楚的布局，编号在最终画布绘制。只有拼图上传，原始裁图不逐个发送。整页图宽高不超过 768px，不分段，不用只截前几屏冒充全页。

默认 PNG，超过预算时尝试 JPEG 质量 0.9，仍超过每轮 2 MiB 则提示调整，不丢区块。为限制本机原始截图资源，完整页面最多 8000 万像素、宽 20000、高 100000 CSS px；超限要求框选，单个区域也受 8000 万像素上限约束。缩放发生在截图后，不改变源页面 viewport 的响应式布局。

capture 的区域编号、XPath、rect、text 与 imageRect 关联同一拼图。server 验证数量、字段、图块边界和重叠，再用 fast-png/jpeg-js 真正解码检查 MIME、实际尺寸和字节数。使用纯 JavaScript PNG 解码器是因为 pngjs 同步解码依赖的 Node zlib 内部实现不能在当前 Workers 环境正确执行。完整线上格式和限额由[协议](../../../../docs/protocol.md#capture区域与图片)拥有。

### 模型和存储

系统 brief 定义选区优先、图像语义与 DOM 数据来源的职责。动态 capture 放在本轮 user 文本中，与唯一的图片通过 session.prompt(text, {images}) 发送。模型利用图片理解内容，但提取脚本必须依靠捕获 HTML 中的真实结构与字段，不能硬编码像素里的数值。直接执行 extra.js、data.json HTTP 渲染、三档静态 widget 的输出约定保持有效。

接收器先完整解析、解压、校验，再检查 session、幂等和 busy，接受时原子保存 turn 与不可变输入。执行器在初次运行或恢复时将该快照写入工作区；400/409/413 不覆盖正在执行的源文件。同名后续附件不会改变旧 turn 的图或 DOM。

Store 使用 input_blobs、input_chunks 和 turn_inputs 保存按内容哈希去重的不可变数据，块大小复用 512 KiB。独立表使输入和事件图片不暴露为模型可写的 WorkspaceFs 路径。新表用 CREATE TABLE IF NOT EXISTS 加入既有数据库；session 删除清理全部相关数据，过期 turn 的索引可清理，历史引用的 blob 保留到 session 删除。

pi 消息图片（包括预览工具返回的图片）持久化为 image_ref v1，图片块与事件在同一同步事务提交。HTTP 实时/回放都提供引用投影；Store.piEntries 恢复完整 SDK image 块，兼容旧内嵌图片记录，thinking、工具调用等其他字段不变。没有新增面向客户端的图片下载端点。

capture 请求发送前计入本轮文字/图片、历史和输出余量，必要时先 compact 一次，仍不足就明确失败。图片以每张 16384 tokens 的保守预留估算，输出预留受模型最大输出约束，另留工具/system 余量；这是应用估算，不能保证等于网关实际 token 计数。分块持久化不减少恢复后模型上下文占用。

## 曾考虑的替代方案

**XPath 混进自然语言、图片作为普通文件。** 当前模型调用不会自动读取未声明图片，关联与恢复也依赖猜测；采用结构化 capture 和显式图片输入。

**上传原始 HTML。** 浏览器运行后 DOM 可能不同，采用同次捕获副本并验证 XPath。

**任意矩形而不吸附 DOM。** 矩形可能对应多个无共同业务意义的节点，用户选择完整区块与多选，必要时调整父/子层级。

**逐区发图或整页分段。** 保留更多局部像素，但增加图片数量与上下文。用户选择单张不超过 1200px 的编号拼图；小文本不截图、整页单图。多区文字清晰度通过最终拼图确认，而非保证任何页面都能缩到可读。

**直接把图片 base64 存进 events 单行。** 即使只发一张 2 MiB 图，编码后也可能超单行容量；用哈希引用和分块恢复，避免为适配日志而过度损害清晰度。

## 验证

- Workers 测试 95 项通过，覆盖 capture schema、PNG/JPEG 解码、伪装/损坏/超限图片、缺图/重名文件、不可变输入、被拒绝/重复请求不覆盖、超过单行容量的图片引用恢复、旧内嵌图兼容及 session 删除。
- SDK 测试 4 项通过；真实 HTTP 网关替身收到 image_url 与 XPath 文本，恢复 session 后旧图保持一次，后续无新图消息不重复附图。上下文测试验证本轮预算、压缩及拒绝路径。
- CLI 测试 14 项通过，保留下载与 preview 回归并验证 URL/HTML 来源互斥。
- 捕获浏览器测试 5 项通过，实际拖框、多选、返回重选、取消、清空、失效目标拒绝、小文本无图、重定向 DOM、8 块不同长宽比拼图及真实 prompt --url multipart/下载入口均有证据；既有 7 项浏览器检查保持通过。
- `e2e:capture` 在本地 Wrangler、真实模型和 Browser Run 上通过 regions/page 两轮。随机六位码只出现在 canvas 像素，不在提交 HTML 或 capture 文本中；模型正确识别，生成的 widget 最终预览 valid 为 true，三文件保存并通过哈希校验。
- 框选、确认界面与最终拼图经过截图目视检查，工具框线和面板没有进入上传拼图；编号与区域对应，文字清晰。
- brief 从 1569 增至 1801 o200k_base tokens（7778 → 8906 UTF-8 字节）。仅计 brief，不含动态 capture、图片或工具 schema。类型检查、文档、Notes 和 diff 门禁通过。

## 后果

框选表达了提取范围，拼图提供视觉语义，模型可从图片与对应 DOM 共同理解内容。代价是页面输入需要本地 Chrome、图片解码与不可变存储，以及 HTTP 历史的 image_ref 投影。输入 HTML 解码后单个最多 16 MiB、全部附件 24 MiB、用户文字 32000 字符，避免接受无限数据后耗尽资源。

文件 URL 不恢复原网站 origin/登录态；在线页面也可能受验证码、反自动化或懒加载影响。DOM 稳定检查不能冻结 canvas 像素或完整网站运行状态。多选区域过多时缩略图文字会变小，用户需在拼图预览中判断清晰度。截图理解与 Chromium 渲染通过不能替代源数据真实性或 iOS WKWebView 真机验证。

### TODO：iframe 与 Shadow DOM

本次仅支持主页面普通 DOM，不进入同源/跨域 iframe 或 open/closed Shadow DOM 内部。已识别的 iframe/开放 shadow root 宿主提示不支持；closed root 不能可靠枚举，不承诺自动识别全部组件。外层普通区域或整页图可能包含这些像素，但模型不得因此生成内部提取逻辑。后续单独提案定义 frame/宿主路径、内部 DOM 捕获及 iOS 分 frame 执行与结果合并；不把跨边界路径塞进本次普通 XPath 字符串。

[服务端架构](../architecture/2026-09-28-backend-architecture.md)、[工作区与预览](../architecture/2026-09-28-server-workspace-filesystem.md)、[静态 widget](2026-09-30-static-ios-widget-artifacts.md)、[本地预览](2026-10-05-cli-local-widget-preview.md)及[测试策略](../testing/2026-09-28-test-strategy.md)的独立理由仍有效。图片只落盘、raw pi_entry 对应的局部选择由本记录替代并交叉链接，其他记录保持活跃，没有完整取代或归档。
