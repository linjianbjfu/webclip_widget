# Widget Design System

生成模型使用 [design-system](../backend/src/design-system/) 中的设计定义组织 widget。视觉依据是 [widgets](../design/widget-style/widgets.webp)、[widgets2](../design/widget-style/widgets2.webp)、[StepCounter](../design/widget-style/StepCounter.webp) 和 [instagramAndThread](../design/widget-style/instagramAndThread.webp)：清晰主次、充足留白、中性色底、少量强调色，以及适量线条、图形或图片。参考图中的按钮和外部展示框不属于静态 widget。

## 定义与归属

| 定义 | 负责内容 |
| --- | --- |
| [core.ts](../backend/src/design-system/core.ts) | 常驻核心原则、用户偏好、主动选图与 canvas 支持边界 |
| [tokens.ts](../backend/src/design-system/tokens.ts) | 明暗语义颜色、字体、间距、线宽、圆角和各尺寸建议值 |
| [components](../backend/src/design-system/components/index.ts) | 主信息、信息行、状态、进度、趋势图、图片和分隔线的语义规范 |
| [patterns](../backend/src/design-system/patterns/index.ts) | 布局用途、数据前提、组件引用和三档构图建议 |
| [examples](../backend/src/design-system/examples/index.ts) | 四张参考图的短构图分析 |
| [images.ts](../backend/src/design-system/images.ts) | 图片使用政策、预算及提供给模型的同步提取代码 |
| [review.ts](../backend/src/design-system/review.ts) | 模型检查真实渲染截图时的视觉问题 |
| [catalog.ts](../backend/src/design-system/catalog.ts) | 稳定索引、工具参数、上下文组合及目录校验 |

这些文件静态打包进 Worker。组件是生成 HTML 的规范，不是宿主 API 或运行时组件库；token 是可适配的默认设计值，明确的用户风格优先。三文件交付、真实数据及静态截图要求始终适用。已有下载 HTML 自包含，不会随目录更新自动改变。

## 模型如何使用

brief 常驻核心原则及自动生成的模式摘要。模型读取源网页后，在首次构建或实质性改变布局前调用 `get_design_context`，例如：

```json
{"pattern":"image-text","size":"middle","include_examples":false}
```

工具返回所选构图、尺寸 tokens、依赖的组件规范、统一用图政策、可复制的提取代码与评审要点。`include_examples` 默认为 false，开启时最多返回两份文字分析；不发送整个参考图库。模型使用当前轮已加载的相同设计上下文，避免重复请求。普通对话不需要设计工具。

可用模式由目录拥有，目前包括主指标、指标与趋势、状态进度、列表、图文组合及自由组合。模型自主判断布局和是否用图，用户不必选择模式或明确要求图片。目录没有覆盖的主题可用 freeform 组合。最终仍由现有 `preview_widget` 渲染，技术检查结果与视觉判断分别说明。

## 扩展与验证

增加模式时，在 patterns 定义中提供唯一 ID、summary、requires、guidance、components、examples 和 small/middle/large 的 sizes 建议。所需组件和案例各自放入对应定义；catalog 的同一数据自动生成 brief 索引、工具枚举及返回内容，无需修改加载逻辑。新增模式可以拆到单独文件，再由 patterns 入口静态导出。

调整视觉值只改 tokens；调整图片传递或加载行为则同时更新[产物协议](protocol.md#widget-文件与截图)。不要把数值手抄进多个提示词或文档。核心原则应保持紧凑，案例保存可复用的构图分析，而非示例业务数值。

运行 `npm run verify-design-system` 校验唯一 ID、引用、尺寸、tokens 和上下文预算；该命令接入 `npm run check`。模式摘要上限为 2,500 UTF-8 字节，单次工具结果上限为 18,000 字节。相关单元负例和真实 SDK 测试验证扩展与拒绝路径。浏览器测试验证图片编码、跨域读取限制、图片就绪与缺图显示。

`npm run e2e:design` 使用真实服务和模型，保存各案例的产物、截图、事件与 token/耗时记录到独立的 `downloads/design-check-*` 目录。需要 WEBCLIP_URL、WEBCLIP_TOKEN 和可用的 Browser Run，有模型费用；检查入口与环境见[开发指南](development.md)。可用 `DESIGN_CASES=small,progress` 只运行指定案例。目视检查实际尺寸的层级、留白、图文关系、数据变化和用户偏好；一次通过不保证所有生成都符合审美要求。
