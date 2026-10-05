# Agent Note: extra.js 执行后直接返回提取数据

Status: implemented

## 问题

客户端执行 extra.js 后直接把返回数据写入 data.json。只定义命名函数会返回函数或 undefined，需要额外调用才能取得数据，不符合客户端流程。

## 决策

extra.js 是同步、立即执行并返回 JSON 对象的表达式，例如 `(() => { ...; return data; })()`。脚本直接读取源网页 document，变量留在 IIFE 内，不注册全局入口、不要求参数或第二次函数调用，也不自己写文件。客户端序列化执行结果并保存 data.json，HTML 沿用既有 HTTP 数据加载流程。

服务端预览在独立浏览器页面用 DOMParser 构建捕获文档，将其绑定为 document，直接求值整份 extra.js 并读取完成值。捕获 HTML 的脚本不执行。函数、undefined、Promise、字符串、非普通对象及无法 JSON 序列化的结果不能通过验证，JSON 字段中的 undefined、非有限数字等也不能被静默丢弃或替换。

提取表达式与 JSON 校验由 extraction.ts 共享；[本地 preview 命令](../feature/2026-10-05-cli-local-widget-preview.md)使用真实加载后的源网页 document，服务端使用捕获文档。

此选择替代[静态 widget](../feature/2026-09-30-static-ios-widget-artifacts.md)的命名提取入口；[运行时 data.json](../feature/2026-10-01-widget-runtime-data-json.md)的文件和 HTTP 流程继续适用。相关笔记的独立理由保持活跃并互相链接，没有归档或删除。

## 曾考虑的替代方案

**注册函数后由客户端调用。** 多一次调用和命名约定，用户明确不需要该接口。

**在预览中兼容旧入口。** 会让仍然输出函数定义的产物通过，无法证明客户端直接执行能够取得数据，因此不提供兜底调用。

## 验证

- 浏览器测试通过：同一脚本在源页面直接执行两次均返回正确对象，预览捕获 DOM 得到一致结果，并经 data.json 正确呈现；零值、缺值和源脚本隔离保持有效。
- 旧函数赋值、只有声明、Promise、JSON 字符串、undefined 字段、NaN、BigInt、DOM 节点和循环引用均有拒绝用例。
- 类型检查、brief 测试、3 项 SDK 测试及 5 项 CLI 测试通过，文档与 Notes 门禁通过。
- 真实模型生成的 small widget 经本地 Wrangler/Browser Run 验证成功；下载后的 extra.js 在源页面直接执行及重复执行均返回 `{"failures":0}`，与预览提取结果一致，HTML 的 data.json 渲染通过。
- brief 按 o200k_base 计数由 1,459 增至 1,569 tokens，仅计本文，不包含 SDK、工具 schema 或图片上下文。

## 后果

客户端只需执行脚本并保存结果，不再管理命名提取函数。旧 extra.js 需重新生成，不自动兼容旧入口。预览只有捕获 DOM，没有原网页脚本运行状态，提取必须使用可观察的 DOM 数据。本次未部署生产环境，WKWebView 真机行为仍需客户端验证。
