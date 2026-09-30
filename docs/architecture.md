# 架构与限制

服务端接收网页与截图，在会话工作区中运行 agent 工具，生成供 iOS WebView 使用的 widget。客户端可以离线，工具执行和存储均由服务端承担。

```text
iOS / CLI ──HTTP/SSE──► Worker ──► UserAgentDO（每用户一个）
                                   ├── pi AgentSession：模型与工具编排
                                   ├── SQLite：会话、事件、turn、工作区
                                   ├── just-bash：工作区内的 shell 命令
                                   ├── Browser Run：preview_widget
                                   └── alarm：保活、无进展检测与恢复
```

## 组件职责

[Worker 路由](../src/router.ts)检查共享密钥和用户标识格式，通过 `idFromName(userId)` 选择 DO。[HTTP 处理器](../src/do/handlers.ts)管理会话、提示与 SSE；[turn 执行器](../src/agent/run-turn.ts)创建 pi 会话、保存完成条目并广播实时事件。[协议文档](protocol.md)定义客户端可观察的行为与限制。

[工作区文件系统](../src/fs/workspace-fs.ts)按会话隔离，在 DO SQLite 中按 512 KB 分块存储。读取接口重组完整字节，因此 shell 命令不需要知道分块方式。pi 的文件与 bash 工具通过 operations 接入服务端工作区，不能使用客户端本机文件系统。

[preview_widget](../src/agent/preview.ts)用 Browser Run 检查渲染错误并截图。截图可以发现语法、运行和加载错误，不能证明数据来自原网页；Chromium 的结果也不能替代真实 WKWebView 验证。文件系统与渲染方案的取舍见[工作区决策](../.agents/notes/implemented/architecture/2026-09-28-server-workspace-filesystem.md)。

## 持久化与恢复

[Store](../src/do/store.ts)维护会话、turn 和一份有序事件日志。`busy` 根据 turn 状态推导；pi 完成的条目增量落盘，token 增量只广播给在线客户端。恢复模型上下文时读取 pi 条目，HTTP 历史接口读取协议事件。

turn 在 SSE 响应返回后继续执行。[alarm 策略](../src/do/turns.ts)每 30 秒续排保活，对超过 95 秒无进展的 turn 判定恢复或失败。无进展检查分支会拒绝超过 15 分钟或已经恢复 3 次的 turn；这不是独立于进展检查的硬截止计时器。恢复会重新调用模型，可能重复消耗 token 或执行工具。

设计动机、平台实验与替代方案保存在[后端架构决策](../.agents/notes/implemented/architecture/2026-09-28-backend-architecture.md)。实时产物和历史记录的交付差异见[协议](protocol.md#产物)。

## 系统提示词

[BriefProvider](../src/agent/brief.ts)目前提供基础任务说明，提取质量仍需独立完善。同一会话的 `system()` 必须保持字节稳定；时间戳、随机值或不稳定顺序会影响上游前缀缓存。`strip()` 提供移除 brief 的接口，但 HTTP 历史当前直接发送 pi 条目，没有调用该投影接口。

## 使用边界

- 共享密钥不验证用户身份，用户之间尚无可信的安全隔离。
- 同一会话同时只接受一个 turn；跨会话并发上限尚未执行。
- 中止和删除尚未联动取消模型执行，长历史补发受订阅队列限制。
- 离线客户端可以回放事件元数据，但没有取回产物内容的接口。
- 上传图片只落盘，不自动作为模型图片输入；渲染通过也不代表提取结果正确。

这些限制在[客户端协议](protocol.md)中给出具体行为；运行、验证与部署见[开发指南](development.md)。
