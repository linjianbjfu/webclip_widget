# webclip_widget

把网页转成 widget 的 agent 服务端。[pi coding agent](https://github.com/earendil-works/pi) 作为 SDK 运行在 Cloudflare Workers + Durable Objects 上。工具在服务端执行，iOS 客户端通过 HTTP/SSE 提交任务并读取结果。

## 目录

- [backend/](backend/)：服务端代码、测试、依赖及运行配置。
- [test-cli/](test-cli/)：驱动服务端的 CLI 和端到端检查。
- [docs/](docs/)：使用与开发文档。
- [scripts/](scripts/)：仓库文档和 Agent Note 检查。

在根目录执行 `npm install`；开发、测试和部署命令由根 package.json 转发到 backend。

## 文档

- [开发、测试与部署](docs/development.md)：本地启动、环境配置、检查命令和部署。
- [CLI 使用](docs/test-cli.md)：提交网页、连续对话、读取历史与排查轮次耗时。
- [客户端协议](docs/protocol.md)：HTTP 请求、SSE 事件、幂等、重连及当前限制。
- [架构与限制](docs/architecture.md)：组件职责、存储与 turn 生命周期。

当前行为以文档及其链接的实现为准；持久的选择理由、替代方案和验证证据保存在 [Agent Notes](.agents/notes/README.md)。开发任务遵循 [AGENTS.md](AGENTS.md)。
