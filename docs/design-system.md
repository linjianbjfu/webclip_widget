# Widget Design System

生成模型使用 [design-system](../backend/src/design-system/) 中的设计定义组织 widget。视觉依据是 [widgets](../design/widget-style/widgets.webp)、[widgets2](../design/widget-style/widgets2.webp)、[StepCounter](../design/widget-style/StepCounter.webp) 和 [instagramAndThread](../design/widget-style/instagramAndThread.webp)：清晰主次、白色主背景、浅灰信息分区、少量强调色，以及适量线条、图形或图片。参考图中的按钮和外部展示框不属于静态 widget。

## 定义与归属

| 定义 | 负责内容 |
| --- | --- |
| [core.ts](../backend/src/design-system/core.ts) | 常驻内容取舍、用户偏好、图形与图像优先及 canvas 支持边界 |
| [tokens.ts](../backend/src/design-system/tokens.ts) | 明暗语义颜色、字体、间距、线宽、圆角和各尺寸建议值 |
| [components](../backend/src/design-system/components/index.ts) | 信息组、主信息、信息行、状态、进度、趋势图、图片和分隔线的语义规范 |
| [patterns](../backend/src/design-system/patterns/index.ts) | 布局用途、数据前提、组件引用和三档构图建议 |
| [examples](../backend/src/design-system/examples/index.ts) | 参考图的短构图分析 |
| [images.ts](../backend/src/design-system/images.ts) | 图片使用政策、预算及提供给模型的异步提取代码 |
| [review.ts](../backend/src/design-system/review.ts) | 模型检查真实渲染截图时的视觉问题 |
| [catalog.ts](../backend/src/design-system/catalog.ts) | 稳定索引、工具参数、上下文组合及目录校验 |

这些文件静态打包进 Worker。组件是生成 HTML 的规范，不是宿主 API 或运行时组件库；token 是可适配的默认设计值，明确的用户风格优先。三文件交付、真实数据及静态截图要求始终适用。已有下载 HTML 自包含，不会随目录更新自动改变。

## 白底、分区与图片层次

浅色主题以白色为主画布，相关辅助字段或当前事项可以用浅灰底区分；底色与分区圆角分别引用 tokens 中的 surface、surfaceMuted 和 radius.group。深色主题有对应的分区底色，明确的用户配色优先。group 组件描述平面信息组：内边距经济、文字对齐，不给每行套卡片，不层层嵌套。纯文本密集列表或单一信息可以保持白底。

图片可作主体、行内识别图，也可作整个或局部背景。背景适合放在顶部、边缘或文字较少的一侧，通过裁切、独立透明度或向底色渐隐的遮罩保护正文；不把文字放入一起变淡的父层。用定位在正文后方的 img 复用加载、解码和失败检查，CSS background-image 不作为独立加载通道。图片变化时背景同步更新，缺失或损坏时移除图片层，底色和文字仍可阅读。图片承载识别任务时应保留足够细节；装饰不挤占必要正文。

用户参考图提供不同的组织方式：[会议详情](../design/widget-style/meeting-details.png)将辅助信息放入浅灰区，[应用用时](../design/widget-style/app-usage.png)用图标辅助扫读，[药品背景](../design/widget-style/medicine-background.png)示范局部淡图，[位置背景](../design/widget-style/parking-background.png)示范图片向白底过渡，[当前与下一项](../design/widget-style/current-next.png)用底色区分状态，[并列日程](../design/widget-style/paired-routines.png)用一条细线区分同级信息。参考中的操作按钮、外部展示框和业务素材不直接照搬，也不要求每个 widget 都有色块或背景图。

图片来源继续遵循下方的现有提取规则：普通 img 或已提供的合适静态素材，不新增源网页 CSS 背景采集、图片搜索/生成或远程地图服务。没有对应素材时用文字、分区和简单主题图形构图，不能虚构地图位置、人物或商品。

## 模型如何使用

brief 常驻核心原则及自动生成的模式摘要。模型读取源网页后，在首次构建或实质性改变布局前调用 `get_design_context`，例如：

```json
{"pattern":"image-text","size":"middle","include_examples":false}
```

工具返回所选构图、尺寸 tokens、依赖的组件规范、统一用图政策、可复制的提取代码与评审要点。`include_examples` 默认为 false，开启时最多返回两份文字分析；不发送整个参考图库。模型使用当前轮已加载的相同设计上下文，避免重复请求。普通对话不需要设计工具。

可用模式由目录拥有，目前包括主指标、指标与趋势、状态进度、列表、图文组合及自由组合。模型以用户目的选出一个主要数值、状态、事件或主题，再保留必要背景。普通框选限定候选来源，不要求逐项复刻；列表不自动添加「精选」「展示前 N 条」「共 M 条」、N/M 或「全部 N 条」等覆盖提示，也不在标题或底部为它们预留空间。来源中的业务数量、排名和用户明确要求的覆盖信息可正常展示；显式点名和「全部」要求仍受保护。指定尺寸无法容纳这些要求时，模型应说明冲突并请用户选择减少内容或增大尺寸。

模型先理解页面内容、用户目的和来源图片所表达的含义。图片有助于识别主题、理解信息或扫读时，优先使用，并按实际作用安排为主图或辅助图，留出足够的可辨认空间。这一判断适用于任何主题，用户不必选择模式或明确要求图片；无关装饰图不因存在于页面就被采用。有真实数据支持且表达更清楚时，采用数据图形。素材不足、实际尺寸下图形难辨或用户要求不用图时，采用文字布局。目录没有覆盖的主题可用 freeform 组合。

选中的来源图片由 extra.js 提取实际内容，作为栅格 base64 经 data.json 传递，widget 不直接加载原站图片 URL，读取失败也不回退 URL。离线预览的 null 不代表源页面没有图片，模型应保留适用的图片提取、显示与文字降级能力，并区分已取得、未验证和读取失败的图片。HTTP(S) 来源图优先 fetch 原始字节再编码，预算内保留原图，失败才尝试可读 img 的 canvas 转换；异步提取与资源预算见[产物协议](protocol.md#widget-文件与截图)。base64 不能解除 CORS 或 CSP 限制；技术预览、视觉判断与在线图片提取结果分别说明。

## 扩展与验证

增加模式时，在 patterns 定义中提供唯一 ID、summary、requires、guidance、components、examples 和 small/middle/large 的 sizes 建议。所需组件和案例各自放入对应定义；catalog 的同一数据自动生成 brief 索引、工具枚举及返回内容，无需修改加载逻辑。新增模式可以拆到单独文件，再由 patterns 入口静态导出。

调整视觉值只改 tokens；调整图片传递或加载行为则同时更新[产物协议](protocol.md#widget-文件与截图)。不要把数值手抄进多个提示词或文档。核心原则应保持紧凑，案例保存可复用的构图分析，而非示例业务数值。

正文与辅助标签的默认字号由 tokens 单点维护；caption 不用于承载整张列表。拥挤时先移除冗余标签和装饰，合理压紧标题、内边距与行距，再调整构图或减少可省略内容，不靠降低字号或整体缩放塞入更多信息。列表容量由实际可用高度、正文行高、标题换行和图文占比决定，不按预设条数截断。来源还有同等相关记录且能完整放下时，增加条目；不要用过大间距或装饰掩盖过早省略。少数据时根据主题调整主体位置与视觉比例，保留必要留白，不补无关内容。

纯文本提取保留数量有界且足够评估布局的候选记录，渲染端按当前内容选出能完整放下的有序前缀，放不下的记录直接省略，不增加截取说明。需要适配换行时可在 renderWidget 内同步、有界地测量行高，不缩字、不截断主标题、不靠隐藏溢出或定时更新。显式条数与全量要求优先；图片仍受已有数量和字节预算限制。内容取舍需随每次数据更新，不能硬编码捕获时的摘要、所选记录。

运行 `npm run verify-design-system` 校验唯一 ID、引用、尺寸、tokens 和上下文预算；该命令接入 `npm run check`。模式摘要上限为 2,500 UTF-8 字节，单次工具结果上限为 18,000 字节。相关单元负例和真实 SDK 测试验证扩展与拒绝路径。浏览器测试验证图片编码、跨域读取限制、图片就绪与缺图显示。

`npm run e2e:design` 使用真实服务和模型，保存各案例的产物、截图、事件与 token/耗时记录到独立的 `downloads/design-check-*` 目录。需要 WEBCLIP_URL、WEBCLIP_TOKEN 和可用的 Browser Run，有模型费用；检查入口与环境见[开发指南](development.md)。可用 `DESIGN_CASES=small,progress` 只运行指定案例。

`space-list` 使用雪球案例的十条市场热点标题，检查足够空间下完整展示十条、长标题、两条和空数据的自适应，以及所有状态下不自动添加覆盖提示；`space-limited` 保护明确只展示五条的要求。生成结果保留候选数据、原尺寸截图和文字几何测量。场景中的条数/空间检查只适用于该夹具，不是生产 HTML 的统一空白比例门禁。

`dense-metrics`、`long-list`、`paragraphs` 分别覆盖三档密集选区，重跑生成的提取与渲染以检查数据变化、变短和空数据；`overfull` 检查小尺寸与明确全量要求的冲突回复。现有 `list` 保留六篇标题和栏目全量请求，`image` 检查自动选图、坏图降级和后续不用图。截图、提取数据、可见文本和回复随案例保留；usage 是模型实际报告的用量。

`style-meeting`、`style-agenda` 检查默认白底和有意义的浅灰分区；`style-background` 检查默认选图、后续明确要求的局部淡背景、图片变化与缺图降级，以及深色不用图偏好。保存的原尺寸截图用于评估遮罩、正文与图片关系；颜色和图层检查仅用于这些已知场景，不是任意页面的统一审美门禁。

`image-plant`、`image-movies` 使用可重复生成的来源插图，检查用户未要求用图时的内容判断，以及记录与图片一起更新、缺图、坏图和离线不可读远程图的降级；`image-decoration` 检查纯指标页面中的无关广告图被省略。这些案例经真实模型生成，但图片素材是测试插图，不代表第三方网站的图片读取已通过。在线同源、CORS 与防盗链的浏览器检查由 [images.browser.test.mjs](../backend/src/agent/images.browser.test.mjs) 覆盖。

目视检查原尺寸截图的主信息、正文字号、留白、图文关系及更新后的列表容量，确认没有自动节选计数提示。拥挤与无意义空白都需调整后再次预览；技术预览成功不能替代这项检查。一次通过不保证所有生成都符合审美要求。
