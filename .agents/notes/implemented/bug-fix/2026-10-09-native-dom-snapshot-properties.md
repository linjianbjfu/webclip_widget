# Agent Note: 快照读取原生 DOM 结构属性

Status: implemented

## 问题

GitHub issues 页的 relative-time 自定义元素将 prefix 定义为日期文案前缀，返回 on，原生 Element.prefix 则为 null。编码器直接读取实例属性，将标签误编码为 on:relative-time，重建一致性检查拒绝捕获。克隆仍会升级成自定义元素，cloneNode 不能隔离属性重名。

## 决策

共享 DOM 编码器通过 Node、Element、CharacterData、Attr 与 HTMLTemplateElement 原型 getter 读取所编码的结构字段；捕获裁剪、选区映射和 XPath 的结构字段读取复用同一方式，避免只修编码后仍按覆盖字段删掉节点或定位错误。保留快照版本、精确相等校验及惰性重建。

本修复补充[实时 DOM 结构保真](../../implemented/bug-fix/2026-10-08-capture-live-dom-structure.md)，不改变其结构依据、传输或隔离决策，原记录保持活跃。

## 曾考虑的替代方案

**只处理 relative-time 标签或删除它。** 属性重名不局限于 GitHub，删除会改变选区结构与时间内容。

**放宽 isEqualNode 校验。** 会接受错误标签并让离线查询与原网页不同，不能满足结构保真。

## 验证

新增浏览器回归在原实现上以 DOM reconstruction changed the captured structure 失败。修复后，整页、父区块、自定义元素本身、其子节点与后方 SVG 选区均通过；同时验证原页面 prefix 仍为 on、原生子树 isEqualNode、真实 SVG 前缀，以及在线与快照提取结果相等。

- `node --test test-cli/browser-tests/dom-structure.test.mjs test-cli/browser-tests/capture-pruning.test.mjs test-cli/browser-tests/capture-snapshot.test.mjs test-cli/browser-tests/capture.test.mjs`：16 项通过。
- `npm run typecheck` 与 `npm test -- src/dom-snapshot.test.ts`：通过，快照校验 3 项。
- GitHub 原页面整页与 main 区域结构检查通过，25 个时间节点的在线/快照提取结果相等；本地证据在 downloads/github-dom-debug/fixed-result.json。此检查未调用模型生成 widget。

## 后果

共享编码器与捕获遍历从浏览器原型读取结构，不调用自定义元素上的同名业务 getter，不改变其业务值。快照版本与传输格式保持兼容；原有结构保真记录继续活跃，无归档或删除。

本方案处理自定义元素实例或子类覆盖，不承诺隔离网页对浏览器原生原型的全局篡改。捕获 UI 的布局、事件和任意方法覆盖不属于通用沙箱保证；Shadow DOM 内部仍不支持。
