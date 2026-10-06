# Agent Note: 本地保留捕获输入用于调试

Status: implemented

## 问题

debug 需要与实际请求对应的 source.html、最终拼图及 XPath。临时上传目录在请求结束后被删除，重新访问原 URL 无法可靠复现捕获时内容。

## 决策

取得 sessionId 后、发送 prompt 前，CLI 将 source.html、最终图片（如有）和 capture.json 保存到 `downloads/<sessionId>/capture/`，打印 Capture saved 路径。同一会话更新这个专用目录并清除旧截图，不改动外层 widget 产物、data.json 或其他目录。实际上传仍读取原临时文件，避免 debug 副本被编辑后改变待发送内容。

先完整暂存，已有 capture 目录移入暂存位置，再发布新目录；普通发布失败恢复此前副本，恢复本身失败则保留暂存内容。并发保存通过会话内独立 capture 锁隔离。保存失败不发送 prompt，后续 HTTP/模型失败仍保留副本；新会话创建失败时没有 sessionId，不生成该目录。

仅文本区域只保留 source.html 和 capture.json；整页模式保留整页图。metadata 与请求中的 capture 一致，用户可核对区域编号、XPath、图块坐标和来源 URL。用法由[CLI 文档](../../../../docs/test-cli.md#框选页面内容并生成-widget)拥有。

## 曾考虑的替代方案

**仅在生成成功后保存。** 会丢失最需要排查的失败输入，选择发送前保存。

**保留临时目录路径。** 缺少稳定的会话关联且与退出清理冲突，采用独立会话子目录。

## 验证

`npm run test:cli` 的 17 项测试通过，新增用例验证 source/图片字节和 metadata 一致、删除临时输入后副本仍存在、重新捕获时移除旧图、保留 widget/data.json，以及输入缺失或非法目标不发布半份副本。真实 Chrome 命令入口测试通过，服务端收到 POST 前副本已存在；模拟 HTTP 500 后副本仍完整。文档、Notes 和 diff 门禁通过。

## 后果

每个会话保留最近一次捕获用于 debug，不保存逐轮历史。capture 是 CLI 管理目录，不应存放需要保留的手工文件；已有捕获不会自动回补。目录替换不是跨进程崩溃事务，极端中断时可能需从暂存目录手动恢复。

[多区域捕获](2026-10-05-region-capture-multimodal-widget.md)继续拥有选择、截图和模型输入约定，本记录只增加本地留存，原笔记保持活跃，没有完整取代或归档。
