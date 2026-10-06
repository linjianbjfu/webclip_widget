# Agent Note: 精简选区 DOM 与原 URL 数据预览

Status: proposed

## 问题

框选后仍上传整页 DOM，模型检索会遇到导航、脚本及无关内容。当前 preview 默认加载捕获 HTML；这个副本无法完整恢复原网页的 origin、脚本环境和最新数据，精简 DOM 后更不能作为原网页运行环境。

当前 capture/capture.json 已保存捕获时的最终 pageUrl、初始 requestUrl 和 baseUrl，但 preview 尚未使用。只读裁剪实验在本地一份新闻列表捕获中将 HTML 从 389259 字节、1341 个元素减到 202686 字节、703 个元素；这只是范围剪枝的样本结果，不代表模型延迟同比下降。

## 方案

### 选区及祖先链的联合树

有选区时，source.html 只保留所有选区的完整子树，以及 document 根到每个选区的祖先元素链。共同祖先只保留一次，父子选区重叠时不复制 DOM，各区域 metadata 和截图关联仍分别保留。选区内保留原始属性、文本、链接、图片、SVG 及子节点；祖先保留元素名、命名空间和属性，只留下通往选区的分支，移除其无关兄弟节点与文本。补足 HTML 文档及 UTF-8 charset 所需的最小 head，不保留无关 head 内容。

剪枝只作用于克隆文档。实时页面继续正常运行；截图继续来自实时选区。无选区时仍捕获完整页面，不裁剪整页输入。此次不额外清洗选区内部 SVG、data 属性或脚本，也不插入用于占位的无关兄弟元素。

沿用临时标记的解析映射与内容保留检查：对剪枝后的文档解析、移除标记、生成最终 XPath，并再次验证定位稳定。删掉兄弟节点会改变位置序号和 id 的全局唯一性，因此 region.xpath 定位精简 HTML，sourceXPath 在路径不同时记录真实页面路径，不伪称精简后的绝对 XPath 与原网页相同。

server brief 同步说明输入可能只包含选区与祖先链；不把精简文档中的位置序号、id 唯一性或其他区域缺失当作原网页事实。extra.js 优先使用实际观察到的稳定锚点及字段校验，不能依赖裁剪特有的位置，也不能硬编码样本数据。server preview_widget 仍在捕获 DOM 上验证，CLI 在线 preview 用真实页面验证，二者各有用途。

截图前后比较精简 source、实时选区 fingerprint、路径及 rect，保留选区失效、内容变化或位置变化时的重采/拒绝。已经被剪掉且不影响保留分支的广告等变化不再导致失败。整页模式保留整页稳定性检查。同步维护 source.html、capture.json 与图片的同次快照关系，本地 debug 保存实际提交的精简文件。

### preview 使用捕获时的最终 URL

继续把当前 URL 保存于 downloads/<sessionId>/capture/capture.json 的 pageUrl，作为唯一来源；无需在会话根目录重复写 url.txt 或另一个 JSON。记录的是预览确认所对应快照的最终地址，包含路径、查询和 fragment；不能用相对资源基址 baseUrl 代替导航地址。同一 session 再次捕获沿用现有 capture 目录替换流程，URL 随快照更新。

`preview --out <目录>` 默认读取 pageUrl，校验为 HTTP/HTTPS 后打开在线页面，正常执行页面脚本。等待 load 完成后固定等 5 秒，再直接执行 extra.js，将校验后的结果写入 out/data.json。后续本地 HTTP server、widget.html 的数据加载、meta 画布、就绪检查及关闭清理沿用现有流程，不重新调用模型。源页面 viewport 使用捕获 metadata 中的尺寸及 DPR 1，减少响应式 DOM 与选择时不一致；widget viewport 继续由 meta 决定。

默认路径不读取或要求 capture/source.html 存在，也不在网络失败时退回该文件。缺少 pageUrl、格式非法、导航失败或提取失败时明确报错，并保留已有 data.json。旧会话只要已有合法 pageUrl 即可使用，无需回补新文件。缺少 URL 的本地文件输入保留显式 `--source <原始 HTML>` 作为离线入口；显式输入优先，不读取 capture 配置，该入口也在 load 后等 5 秒。精简后的 source.html 是模型/debug 输入，不能承诺运行它能复原原网页。

### 范围与笔记归属

本方案部分取代[多区域捕获](../../implemented/feature/2026-10-05-region-capture-multimodal-widget.md)的整页 DOM 上传、[XPath 校验](../../implemented/bug-fix/2026-10-06-capture-xpath-parser-repair.md)的完整文档稳定性范围，以及[本地预览](../../implemented/feature/2026-10-05-cli-local-widget-preview.md)的默认文件来源与 3 秒等待。以上笔记其余独立理由继续有效；实施时同步并交叉链接，不归档。[debug 留存](../../implemented/feature/2026-10-06-local-capture-debug.md)继续拥有目录替换和失败保留语义，更新其记录内容及 preview 入口说明。

本次不调整服务端 95 秒恢复机制，不增加 iframe/Shadow DOM、自动滚动加载、登录态持久化或新的等待参数。

## 曾考虑的替代方案

**只复制选区、不保留祖先。** 丢失来源结构和父容器锚点，不满足保留 root 到选区路径的要求。

**用空兄弟节点维持原 XPath 序号。** 产生不属于选区或祖先链的节点，且让模型把占位结构当成网页事实；采用两种 XPath 分别表达捕获与实时定位。

**另写会话根目录 URL 文件。** 当前 capture.json 已拥有对应快照的最终地址，双份记录增加覆盖失败时不一致的可能，因此复用现有记录。

**自动回退到捕获 source.html。** 可能把离线快照预览当作在线提取成功；仅保留用户显式指定的离线入口。

## 验收标准

- 固定浏览器样例含无关导航/脚本/兄弟节点、多选、重叠选区和同标签兄弟；输出只含选区、祖先链及最小文档骨架，原网页不变，目标文本、链接、图片和属性保留。
- 剪枝后 xpath 唯一命中正确区域，sourceXPath 能在原文档定位；重复 id、引号 id、SVG、HTML 解析修复与失败诊断继续覆盖。
- 选区外已删除节点变化不拒绝捕获；选区内容、位置或保留路径变化仍拒绝。无选区维持完整 source/整页图。
- 用脚本驱动的本地 HTTP 页面验证默认 preview 导航到 pageUrl，即使 source.html 缺失或内容不同；load 之后等 5000 ms 才执行提取，HTTP widget 读到新 data.json。
- URL 记录随捕获覆盖；旧 capture.json 可用；缺失/非法 URL、页面加载失败及提取失败均不覆盖旧 data.json。显式 --source 离线入口和资源清理继续通过。
- 使用新闻列表样本复查 DOM 精简大小和原 URL 提取；记录在线页面可重复性限制，不把 Chromium 验证等同于 iOS 真机验证。
- 运行相关 CLI/浏览器、server brief/schema 检查及类型、docs、notes 门禁；同步文档后将本提案迁到 implemented。

## 风险

保留祖先链不等于保持所有 CSS 位置选择器语义；模型必须区分两份 DOM 的索引。选区内部本身很大时，范围剪枝只能减少外围噪声，无法保证较小上下文，也不会解决服务端恢复问题。

固定 5 秒不能保证任意网站已加载全部异步内容，打开原 URL 不会恢复滚动位置、点击状态或临时登录态。重定向、登录页及动态列表可能改变提取结果；失败应如实暴露，不用旧快照数据代替。仅保留选区的 source.html 也不是可重放的完整网站存档。
