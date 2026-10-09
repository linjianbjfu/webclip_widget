# Agent Note: 通过异步 fetch 提取来源图片字节

Status: implemented

## 问题

豆瓣 f40f183b 与 Nintendo 54f0b639 两个下载 session 的图片均为 null，脚本只尝试同步 canvas。普通跨域 img 可显示但 canvas 不可读，并不表示 CORS fetch 一定失败；直接拒绝 Promise 的执行器也无法接收图片请求结果。

## 决策

extra.js 保持无参数、自包含 IIFE，允许异步返回普通 JSON 对象；执行器先等待结果，仍兼容同步脚本。选中 img 的 currentSrc/src 为 HTTP(S) URL 时，以 cors、omit credentials、reload 和支持的栅格 Accept 请求真实字节，优先保留预算内 PNG/JPEG/WebP 原图。超预算的可读图片缩至最长边 512px，PNG 仍超限时以 WebP 压缩；请求失败可尝试已加载且可读的 canvas，失败返回 null，不输出远程展示 URL。

[列表图标批处理](../feature/2026-10-09-content-icons-and-backgrounds.md)支持最多 24 个候选、3 路并发及首个调用起 6 秒整批时限；每次读取及异步解码最多 3 秒、响应体最多 2 MiB，保留原有 URI 与总字符预算。捕获 DOM 不发网络请求，异步提取整体 15 秒超时。公开客户端流程需等待脚本的 Promise 才序列化；本仓库不包含 iOS 宿主实现。

部分替代[直接执行提取脚本](../simplification/2026-10-01-direct-extraction-script.md)的同步限制，以及[设计系统](../feature/2026-10-06-minimal-widget-design-style.md)与[按内容用图](2026-10-08-contextual-image-priority.md)的图片读取机制。[CLI 本地预览](../feature/2026-10-05-cli-local-widget-preview.md)同步等待结果。无参数入口、内容选择与 base64 传递决策仍保留，旧笔记继续活跃并互链。

[图片格式协商与视觉层级](2026-10-09-image-format-and-visual-priority.md)拥有 Accept 与缓存策略，防止 CDN 协商为丢失透明度的 JPEG；本记录继续拥有异步字节获取与失败降级机制。

## 曾考虑的替代方案

继续只用 canvas 无法处理普通模式加载、但允许 CORS fetch 的图片。直接返回图片 URL 会重现防盗链问题。增加宿主代理超出当前请求，且本仓库无法完成 iOS 接口实现。

## 验证

真实浏览器测试证明非 CORS 模式 img 的 canvas 失败时，授权 fetch 仍能取得原始字节；无 CORS、HTTP 错误、超时、超大或伪造内容有界失败，不影响文本。同步与异步对象均可通过，异步非法结果、拒绝和挂起均拒绝。捕获预览不请求源图片，最终 widget 只使用 data URI。两个真实 session 的图片 URL 已在原页面来源下验证。

- Nintendo 三张目标封面均成功，压缩后 URI 分别为 85,831、105,247、99,835 字符；豆瓣三张海报两张成功，原始 WebP 字节保留，URI 为 43,127、28,827 字符，另一张 fetch 失败。证据在本机 `downloads/widget-image-review/*-selected-fetch.json`；这不是所有图片可读或旧产物已修复的承诺。
- `node --test backend/src/agent/images.browser.test.mjs` 三项通过，覆盖跨域原图、凭据省略、字符与响应体预算、超时、MIME/文件头、压缩和离线无请求；`preview-render.browser.test.mjs` 两项通过。新增 `extraction.node.test.mjs` 验证异步结果、错误与期限；`npm run test:agent` 六项通过。
- `node --test test-cli/browser-tests/local-preview.test.mjs` 六项通过；`test-cli/local-preview.test.mjs` 八项通过。旧测试将异步图片字段直接写入对象的失败已由 await 修正。brief/catalog 五项、typecheck、verify-design-system、verify-docs、verify-notes 与 diff 检查通过。
- 真实模型 `DESIGN_CASES=image-plant` 通过，证据在 `downloads/design-check-dlxYyP/`。模型生成 async IIFE，并正确 await 图片提取；同一脚本在实际 HTTP 图片来源下保留原始字节。图片替换、缺失和损坏仍有可读布局，截图已检查。
- 相同测量参数下 brief 14,969 → 15,164 UTF-8 字节，增量按字节数/4 估算约 49 tokens，非供应商分词。设计上下文为 8,568–9,659 字节，未超过 18,000 字节门禁；记录在 `downloads/widget-image-review/fetch-prompt-size.json`。

## 后果

fetch 仍受 CORS、CSP、防盗链及响应格式限制，不能保证任意可见图片可读。外部客户端需同步支持等待 Promise；未验证 WKWebView。已有下载产物需重新生成或明确更新。本次未部署生产环境。
