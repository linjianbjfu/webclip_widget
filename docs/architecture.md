# 架构与限制

服务端接收网页与截图，在会话工作区中运行 agent 工具，生成在 iOS WebView 中渲染、截图后用作桌面背景的 widget。客户端可以离线，工具执行和存储均由服务端承担。

```text
iOS / CLI ──HTTP/SSE──► Worker ──► UserAgentDO（每用户一个）
                                   ├── pi AgentSession：模型与工具编排
                                   ├── SQLite：会话、事件、turn、工作区
                                   ├── just-bash：工作区内的 shell 命令
                                   ├── Browser Run：preview_widget
                                   └── alarm：保活、无进展检测与恢复
```

## 组件职责

[Worker 路由](../backend/src/router.ts)检查共享密钥和用户标识格式，通过 `idFromName(userId)` 选择 DO。[HTTP 处理器](../backend/src/do/handlers.ts)管理会话、提示与 SSE；[turn 执行器](../backend/src/agent/run-turn.ts)创建 pi 会话、保存完成条目并广播实时事件。[协议文档](protocol.md)定义客户端可观察的行为与限制。

[工作区文件系统](../backend/src/fs/workspace-fs.ts)按会话隔离，在 DO SQLite 中按 512 KB 分块存储。读取接口重组完整字节，因此 shell 命令不需要知道分块方式。pi 的文件与 bash 工具通过 operations 接入服务端工作区，不能使用客户端本机文件系统。

[preview_widget](../backend/src/agent/preview.ts)用 Browser Run 执行提取和渲染，提供同源 data.json、等待数据加载完成，按 metadata 的尺寸检查数据渲染一致性、布局溢出和可检测的动画，并将截图返回模型。数据与尺寸约定见[产物协议](protocol.md#widget-文件与截图)。通过检查不能证明提取区域正确；Chromium 的结果也不能替代真实 WKWebView 验证。文件系统与渲染方案的取舍见[工作区决策](../.agents/notes/implemented/architecture/2026-09-28-server-workspace-filesystem.md)。

## 持久化与恢复

[Store](../backend/src/do/store.ts)维护会话、turn 和一份有序事件日志。`busy` 根据 turn 状态推导；pi 完成的条目增量落盘，token 增量只广播给在线客户端。恢复模型上下文时读取 pi 条目，HTTP 历史接口读取协议事件。

turn 在 SSE 响应返回后继续执行。[alarm 策略](../backend/src/do/turns.ts)每 30 秒续排保活，对超过 95 秒无进展的 turn 判定恢复或失败。无进展检查分支会拒绝超过 15 分钟或已经恢复 3 次的 turn；这不是独立于进展检查的硬截止计时器。恢复会重新调用模型，可能重复消耗 token 或执行工具。

设计动机、平台实验与替代方案保存在[后端架构决策](../.agents/notes/implemented/architecture/2026-09-28-backend-architecture.md)。实时产物和历史记录的交付差异见[协议](protocol.md#产物)。

## 系统提示词

[BriefProvider](../backend/src/agent/brief.ts)定义源网页提取、三文件交付、尺寸自动选择和静态截图要求；具体契约见[产物协议](protocol.md#widget-文件与截图)。同一会话的 `system()` 必须保持字节稳定；时间戳、随机值或不稳定顺序会影响上游前缀缓存。`strip()` 提供移除 brief 的接口，但 HTTP 历史发送 pi 条目和 image_ref 图片引用，未调用 brief 的文本投影接口。

[Design System](design-system.md)独立维护核心原则、tokens、组件与布局模式。brief 包含核心原则和自动生成的模式摘要；只读工具 `get_design_context` 按需提供完整设计上下文，复用 pi 的工具调用与会话恢复流程。定义静态打包进 Worker，不访问开发机目录，也不要求 widget 加载运行时组件库。

## 使用边界

- 共享密钥不验证用户身份，用户之间尚无可信的安全隔离。
- 同一会话同时只接受一个 turn；跨会话并发上限尚未执行。
- 中止和删除尚未联动取消模型执行，长历史补发受订阅队列限制。
- 离线客户端可以回放事件元数据，但没有取回产物内容的接口。
- capture 声明的图片进入模型，普通附件只落盘；截图理解和渲染通过仍不代表提取结果正确。

这些限制在[客户端协议](protocol.md)中给出具体行为；运行、验证与部署见[开发指南](development.md)。

## 区域与多模态输入

[Capture 协议](protocol.md#capture区域与图片)关联当前 source.html、区域 XPath 和编号拼图。HTTP 接收器在冲突检查后原子保存本轮输入，执行器在初次运行或恢复时物化相同文件；不会把后续同名文件当成旧轮输入。Store 使用内容哈希和 512 KiB 分块保存不可变输入及消息图片，普通工作区文件仍由 WorkspaceFs 拥有。新增表通过 CREATE TABLE IF NOT EXISTS 接入已有数据库；session 删除清理相关输入和图片。

模型请求通过 SDK images 参数附图；图片持久化为引用，重建模型上下文时还原，HTTP entry 使用引用投影。首次调用、多轮及恢复各自保持本轮 capture 关联。来源 URL 仅用于说明和链接解析，server 不再次抓取原网站。
