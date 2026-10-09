# Agent Note: 捕获与预览保留实时 DOM 结构

Status: implemented

## 问题

雪球 session d5303d77-b942-4e57-8da2-bfa2d64568de 的运行时话题表格由 JavaScript 创建为 table > tr。捕获时 outerHTML 经 DOMParser 重新解析，自动增加 tbody；模型生成 tbody > tr 选择器，离线取得十条话题，在原始结构下返回空列表。

提交 c05a1a5 为接受腾讯页面的嵌套链接，将实时结构相等校验改为文本、链接目标集合和图片引用相等。该判据允许选区内部发生拆分、复制、移动和删除。sourceXPath 只记录选区根路径，不能表达内部变化；连续两次 HTML 解析稳定也不能证明与实时 DOM 相同。

本机 Chromium 的十一类构造样例中，十类发生结构变化且被当前捕获接受：补 tbody、tr、colgroup，拆分或复制嵌套 a，拆开 p/div 并补空 p，删除嵌套 form，将嵌套 button/li/标题改为兄弟节点，把 table 中的 div 移到表格外。select/span 在本机 Chromium 保持不变。证据在本机 downloads/xueqiu-extraction-review/parser-audit.json；这些是机制复现，不是十个网站事故。

## 决策

### 实时 DOM 为结构依据

在 cloneNode 得到的副本上执行既有裁剪，只清理工具节点、允许清理的外围文本和后方分支。选区内部不通过 HTML 解析器修复，不补业务元素，不拆分、复制或删除原有元素。裁剪前后直接对比选区树及保留定位结构。保留原始命名空间、属性、子节点顺序、文本、注释与 template.content。编码、裁剪与 XPath 的结构字段读取原生 getter，避免自定义元素覆盖同名属性；机制与回归见[原生 DOM 结构属性](2026-10-09-native-dom-snapshot-properties.md)。

source.html 由裁剪后的真实树直接序列化，供模型阅读；它不是可以重新解析成完全相同 DOM 的承诺。新捕获同时输出 source.dom.json，保存同一棵树的节点类型、名称、命名空间、属性和子节点。结构快照由工具生成，不让模型重建或修改它。

预览使用 DOM 创建 API 在无 browsing context 的 HTMLDocument 中重建该树，不使用 innerHTML、DOMParser 或页面脚本重放。extra.js 的 document 绑定到重建文档，仍保持脚本与网络隔离。图片 helper 的 inert-document 判断继续有效。

### 文件与输入归属

新 CLI 输出 capture v2，source.html 供模型阅读，source.dom.json 为工具生成的结构依据。版本、紧凑节点编码、SHA-256 配对及字节/节点/深度限额由[Capture 协议](../../../../docs/protocol.md#capture区域与图片)拥有。预览校验配对后重建，缺失、损坏、未知节点、超限或不能精确保留的结构明确拒绝，不降级到 HTML 解析。

来源声明随已接受输入物化到工作区 capture-source.json。替换 source.html 清理旧声明和结构文件；没有新来源的后续轮保留配对。声明文件禁止上传，孤立结构文件不能作为普通附件被接受，工作区残留同名文件不会自动启用 v2。模型默认只读取 source.html，不把整份结构 JSON 加入 prompt，也不修改工具拥有的配对文件。

v1 与普通 HTML 输入继续可读取，预览标明 legacy、实时结构未验证。已有下载无法从规范化 HTML 反推出原始树，需要重新捕获。

### 同步范围

CLI 捕获、上传、debug 留存、server capture 校验、工作区输入归属和 preview_widget 使用同一版本/配对规则。在线 CLI preview 从原网页执行 extra.js；`preview --snapshot` 从保存的配对快照重建惰性文档。直接打开 source.html 或使用 --source 仍经过 HTML 解析器，不能验证结构等价。

新捕获的 xpath 直接指向保留的实时树，不再为解析修复生成 sourceXPath；v1 的 sourceXPath 兼容保留。已有下载无法从规范化 HTML 反推出原始树，需要重新捕获。旧雪球产物可另外将表格遍历改为 table.rows，但不以此代替整体修复。

本记录部分取代[解析修复](../../implemented/bug-fix/2026-10-06-capture-xpath-parser-repair.md)的结构变更容忍，以及[DOM 精简](../../implemented/feature/2026-10-06-pruned-capture-live-url-preview.md)中在规范化树上裁剪的步骤；[多区域捕获](../../implemented/feature/2026-10-05-region-capture-multimodal-widget.md)继续拥有选区与拼图。旧格式兼容、定位命名空间、裁剪和预览理由仍有维护价值，三篇继续活跃，不归档或删除。

## 曾考虑的替代方案

**只把雪球查询改为 table.rows，或在 prompt 列举解析器差异。** 能处理个例，不能消除链接复制、属性删除和父子关系变化，模型仍可能依赖错误结构。

**只取消捕获端 DOMParser。** 服务端预览仍会按 HTML 规则重新解析，继续产生相同差异。

**凡是 HTML round-trip 改变结构就拒绝捕获。** 可以停止假成功，但连雪球和已支持的腾讯卡片都无法使用，不能满足保留这些页面提取能力的目标。

**以 XML/XHTML 替代 HTML。** 可以保留常见非法 HTML 嵌套，但 XML 命名、字符和命名空间规则与任意网页 DOM 不同，还要处理序列化附加的 namespace 声明，不能直接承诺普适无损。

**把完整结构 JSON 嵌入 source.html。** 可以避免第二个文件，但会让模型读取重复的大段结构数据；配对文件把预览重建数据与模型阅读内容分开。

## 验证

- 浏览器回归覆盖十一类解析差异，重建选区 isEqualNode、CSS/XPath 和同一脚本的提取结果一致；同时覆盖多选、重叠、前方结构、后方裁剪、SVG 属性、template、注释与中文转义。不支持的 ProcessingInstruction 节点明确拒绝。
- 服务端相关 7 个测试文件 19 项通过，覆盖 multipart 配对校验、不可变输入恢复、工作区来源替换、BOM 字节 hash、v1 兼容和 brief；字节/深度/节点限额有拒绝用例。CLI 预算检查拒绝单文件超过 16 MiB、合计超过 24 MiB。
- CLI/浏览器/图片/渲染检查 40 项通过；最终捕获、结构、参数补充检查 19 项通过。SDK 检查 6 项通过。缺失、坏 JSON、错误 hash 和旧配对残留均有失败或显式 legacy 路径验证；失败不覆盖旧 data.json。重建未执行源脚本或请求源图片。
- `e2e:dom` 完成真实 capture → multipart → 模型 → preview_widget → 下载/debug → 本地 --snapshot 流程。无 tbody 表格和嵌套链接卡片均由真实模型生成，在线与离线三条业务记录完全相同，最终 Browser Run 预览通过。证据在本机 downloads/dom-structure-check-eNYX9M；两张最终截图经过目视检查。一次先前卡片运行被本地服务热重载中断，不计入通过结果。
- 雪球保存内容按已确认的组件结构恢复直系 tr 后重新捕获，source 为 266644 字节，结构文件 286785 字节；这不是原站重新捕获。结构文件不进入默认模型上下文。brief 从 15164 增至 15436 字节，工具描述增加 10 字节，按 UTF-8 字节除以 2 的保守口径首轮稳定文本约增加 141 token，并非供应商实际计数。
- TypeScript、verify-docs、verify-notes 和 git diff --check 通过。

## 后果

新增配对文件增加上传和存储体积；两份文件独立上限并不放宽既有附件合计上限。生产服务需先支持 capture v2 才能接收新 CLI 输入；本次未部署。iOS 捕获端不在本仓库内，需按协议另行适配，未做 WKWebView 真机验证。

DOM 创建 API 对个别名称或属性有约束；不能精确保留时明确失败，不能用 HTML 解析兜底。原有 charset 属性保留，source.html 是模型输入而非网页重放档案。DOM 属性状态、事件处理器、Shadow DOM、iframe 与 canvas 像素不因结构快照而自动得到支持。

雪球原站访问返回 567，未完成原站端到端重采；组件代码、保存内容与受控浏览器复现共同证明此缺陷机制。旧 extra.js 中依赖 tbody 的选择器仍需重新生成，旧规范化 HTML 本身不能逆推出原始结构。
