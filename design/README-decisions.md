# 图片模板选择测试

在 macOS 上使用 Python 3 和系统自带的 `sips`，无需安装 Python 包。在 `backend/.dev.vars` 中配置 `OPENROUTER_API_KEY`。脚本按自身位置定位该文件，不依赖终端当前目录。

在 design 目录运行：

```bash
python3 test_openrouter_decisions.py /Users/jian/Desktop/1.png
```

原图支持 PNG、JPEG 和 WebP。脚本默认读取 `widget-style/widgets-numbered-sized.png`，该图是六行五列的固定模板目录。`--templates /path/to/sheet.png` 可以指定同一目录的其它图片版本，必须保留 30 个模板及排列。

每次运行通过 OpenRouter 发起两次 API 请求并产生费用。第一次用 `openai/gpt-6.1-sol` 分析原图，以严格 JSON 格式返回数据结构、主要条目数量和一句话中文摘要 `summary`（最多 120 字符），推理强度为 low，`max_tokens=512`（包含推理 token）。第一阶段完成后立即在终端打印其 JSON 结果。程序据此筛选 4–5 个候选，再将包含摘要的完整分析结果、原图与候选裁切图交给 `openai/gpt-6-luna-decisions` 选择。模板图只在临时目录中裁切，不修改原文件。进度和第一阶段结果写到 stderr，最终结果 JSON 写到 stdout，可通过 `> result.json` 保存。

| 输出字段 | 含义 |
|---|---|
| `template_id` | 最终编号，对应总览中的红色编号 |
| `source_analysis` | `structure`、`item_count`、`summary` 三个字符串；第一阶段不返回概率或置信度 |
| `candidate_ids` | 第一阶段分类所对应的候选集合 |
| `probabilities` | 最终候选之间的概率，不是全部 30 个模板的排名 |
| `confidence` | 最终选择的接口置信度 |
| `composition_policy` | 保留全部记录，允许重复卡片或延展列表行 |
| `usage` | 两次请求合计的 token 用量和美元费用 |
| `stages` | 各阶段的请求 ID、模型、用量和耗时 |
| `elapsed_seconds` | 两阶段及候选裁切的总耗时 |

条目计数区分 1–20、超过 20 和无法判断；一个带图表的指标、一条列表记录、一场双方对阵分别算一条，可辨识的部分可见记录也计入。第一阶段判断会影响候选，结果不理想时先核对 `source_analysis` 和 `candidate_ids`。

脚本选择可复用的布局样式，不生成重新排版后的图片。第一阶段截断、拒答或返回无效 JSON 时停止，不调用第二阶段。输入、图片处理、网络或响应校验失败时非零退出，不自动重试。
