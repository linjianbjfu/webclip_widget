# Agent Note: widget 从客户端 data.json 加载运行时数据

Status: implemented

## 问题

iOS 客户端在源网页 WebView 中执行提取，将结果写入 widget 目录的 data.json，再通过本地 HTTP server 加载 widget.html。内嵌捕获快照不能呈现该运行时数据，直接注入渲染函数的预览也不能证明这条加载路径有效。

## 决策

服务端只交付 extra.js、widget.html、meta.json；data.json 由客户端生成。HTML 每次加载时 fetch 同目录的 ./data.json，禁用缓存、检查 HTTP 状态并解析 JSON 后渲染，不内嵌业务数据，也不使用硬编码兜底。加载失败显示静态错误状态。三档尺寸、自适应布局及无动画约束继续适用。提取脚本的直接执行与返回值由[直接执行脚本决策](../simplification/2026-10-01-direct-extraction-script.md)拥有。详细客户端流程由[产物协议](../../../../docs/protocol.md#widget-文件与截图)拥有。

HTML 在同步初始化阶段公开 window.widgetReady Promise，fetch、解析及 renderWidget 完成后 resolve；失败时显示错误并 reject。这个信号使异步数据加载具有可观察的截图时机。客户端还需等待字体、图片完成，不靠固定延迟猜测页面就绪。

预览将源网页的提取结果作为同源 data.json 的 HTTP 响应，要求页面实际请求该文件，等待 widgetReady，检查画面并截图。截图发生在诊断性的 renderWidget 调用之前，避免检查代码替页面修好显示内容。加载后的文本必须与同一数据的渲染结果一致；缺少 Promise、加载失败或超过 15 秒不能通过检查。完整提取 JSON 仍放在交付目录之外供模型查看字段。

CLI 的服务端命令只保存三个服务端文件；[本地 preview 命令](../feature/2026-10-05-cli-local-widget-preview.md)在源网页执行 extra.js、生成 data.json 并通过 HTTP 打开页面。[静态 widget 决策](2026-09-30-static-ios-widget-artifacts.md)的数据来源和对应预览选择被本决策替代；尺寸、SDK 接入、存储和 CLI 保存理由保持活跃。相关笔记同步事实并交叉链接，没有完整取代或归档的笔记。

## 曾考虑的替代方案

**内嵌快照并由宿主调用 renderWidget。** 能让下载的 HTML 直接展示捕获时内容，但不符合用户明确的客户端文件与本地 HTTP 流程，也会让写入 data.json 后的刷新失效。

**仅修改 prompt。** 原预览会拒绝 data.json 请求并检查内嵌快照，因此必须同步预览执行路径和浏览器样例。

## 验证

- `npm run test:browser` 两项真实 Chrome 测试通过，覆盖三档、零值、缺值、数据变化和既有布局/动画检查。HTTP 404、提取失败对应的 500、非法 JSON、缺少数据请求、忽略响应、缺少就绪 Promise、Promise 超时均有失败证据。
- 使用独立 HTTP server 和响应屏障验证：数据未返回时 Promise 尚未完成；响应返回后正确渲染；同一页面重新加载读取新数据；请求或 JSON 失败只显示静态错误，不回退到先前数值。
- 类型检查、brief 测试及 3 项真实 SDK 接入测试通过；文档、Notes 与 diff 门禁通过。
- 一次真实模型生成的 middle widget 经本地 Wrangler/Browser Run 验证 valid 为 true，三个产物保存成功。对同一份生成 HTML 替换数据后再验证，故障数/设备数从 0/12 正确变为 7/25。
- brief 按 o200k_base 计数由 1,225 增至 1,459 tokens；计数仅覆盖 brief 本文，未包含 SDK、工具 schema 和图片上下文。

## 后果

数据来源与用户的 iOS 客户端流程一致，页面可在不重新生成 HTML 的情况下显示客户端最新数据。代价是 HTML 需要本地 HTTP server 和客户端写入的 data.json，不能承诺 file:// 直接打开即可显示业务内容。

已有下载目录中的旧 HTML 不会被修改，需要重新生成才能使用新约定。Chromium 检查不能替代 WKWebView 真机验证；本次没有部署生产环境或验证真机，单次布局检查也不能证明任意生成脚本永远静止。
