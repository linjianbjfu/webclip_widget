# Agent Note: CLI 浏览器登录状态持久化

Status: implemented

## 问题

CLI 每次捕获网页都创建并删除临时 profile，用户在选择浏览器中的登录无法用于下次捕获或在线预览。

## 决策

可见 Chrome 默认使用 `~/.webclip-widget/browser-profile`，捕获和预览共用，退出及启动失败不删除。允许通过 `WEBCLIP_BROWSER_USER_DATA_DIR` 指定另一个目录。无头检查继续原子创建并清理临时 profile，测试可通过函数参数指定自己的持久目录。

目录位置、重置方式与同目录不可同时启动的限制由 [CLI 文档](../../../../docs/test-cli.md#浏览器资料目录)拥有。Chrome 自身拥有 profile 锁，启动失败报告目录及原始错误，不连接其他命令的浏览器。

部分取代[本地预览](../../implemented/feature/2026-10-05-cli-local-widget-preview.md)和[区域捕获](../../implemented/feature/2026-10-05-region-capture-multimodal-widget.md)的临时 profile 默认值；两篇的其他决策仍有效，保持活跃。

Chrome 确认 Browser.close 后仍可能正在写 Cookie，退出流程等待进程结束，再按有界超时强制终止；立即发送终止信号会丢失刚写入的 Cookie。

## 曾考虑的替代方案

**所有调用共用固定目录。** 并行无头测试会争用 Chrome 锁，并读写用户数据，因此仅交互式默认持久化。

**复用日常 Chrome profile。** 会耦合用户日常浏览器的进程与配置；专用目录让 CLI 独立管理进程。

## 验证

`node --test test-cli/browser-tests/browser-profile.test.mjs test-cli/browser-tests/browser-lifecycle.test.mjs test-cli/browser-tests/preview-command.test.mjs test-cli/browser-tests/local-preview.test.mjs test-cli/browser-tests/capture.test.mjs test-cli/local-preview.test.mjs`：23 项通过，覆盖真实 Chrome 重启后持久 Cookie/localStorage、同目录占用失败、启动失败数据保留、CLI 信号退出、并行临时目录隔离及捕获/预览回归。最终诊断文本调整后，profile/lifecycle 两项再次通过。

重启测试在立即终止 Chrome 的关闭实现上观察到 Cookie 丢失，等待进程正常退出后通过。浏览器检查使用测试专用目录与本地页面，未验证雪球账号登录或 Windows Chrome 行为。

## 后果

同目录只能运行一个 Chrome，需关闭前一个命令或选择另一个目录。网站仍可使登录失效；磁盘数据持续保留，用户需关闭 CLI 浏览器后手动删除目录来重置。
