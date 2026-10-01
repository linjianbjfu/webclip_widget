# AGENTS.md — webclip_widget

本文件是仓库的根指令，对所有 coding agent 生效。Claude Code 通过 `CLAUDE.md` 符号链接读到同一份；Codex 和 GitHub Copilot 直接读 `AGENTS.md`。

## 工作流（每次任务先执行）

**实质性需求默认按 `调研 → proposed → 用户确认方案 → 实施与验证 → implemented` 推进。方案尚未确认时，先交付可评审的提案，不直接修改实现。**

一个改动是**实质性的**，当它改变行为、架构、共享契约、工具链、测试策略、持久化或线上格式，或者做出维护者以后可能需要重新审视的取舍。新增能力、修复缺陷、调整模型提示词、改变产物格式或 CLI 行为、缩减范围，默认属于这一类。纯机械性或纯局部的改动——重命名、格式化、局部的 UI 呈现和交互——可以直接实施；不能把行为或契约变化当作文案修改豁免。

1. **调研并确定范围。** 读取适用的目录指令、skill、当前实现、测试和文档，区分已有行为与设计目标。用户提出需求或说“帮我实现”不等于确认了 agent 尚未提出的方案；指定目标、产物格式或参考实现也不等于确认实现方案。
2. **先落提案。** 在修改实现前，按下方 [Agent Notes](#agent-notes) 规则查找已有决策与提案；更新已有 `proposed/`，或在 `.agents/notes/proposed/<class>/` 新建提案。说明问题、方案、真实考虑过的替代方案、可观察的验收标准、风险和待确认项。主动放弃或推迟的范围及保持其可逆的约束也写在提案里，不因此缩减用户要求的交付结果。
3. **讨论并确认。** 向用户提供提案链接、推荐方案及需要决定的问题，等待明确确认后再改实现。等待期间可继续只读调研和完善提案。用户已确认的方案不重复确认；用户明确要求跳过提案、直接实施，或已给出实现方案并授权按该方案执行时，按其明确范围推进，不再增加审批步骤。
4. **实施并验证。** 在已确认范围内完成代码、测试、受影响文档与活跃笔记的同步，运行覆盖 diff 的检查。涉及未确认的行为、契约或实质性范围变化时，先更新提案并讨论；普通实现细节自行处理。
5. **完成后更新状态。** 实现完成且相关验证通过后，将对应提案迁到 `implemented/<class>/`，同步状态、正文与入链。开始编码或方案获批都不等于 implemented；部分完成的提案留在 `proposed/`，写清已完成内容和剩余验收项。交付时报告实际改动、执行过的检查与未验证的限制。

## 仓库结构

```
.agents/
  skills/          唯一的 skill 源目录（Codex 与 Copilot 原生发现）
  notes/           Agent Notes：决策与提案记录
.claude/
  skills -> ../.agents/skills    Claude Code 的发现路径
backend/           Worker 服务端、并置测试、Wrangler 配置与服务端环境变量
test-cli/          服务端测试客户端与端到端检查
docs/              使用、协议、架构与开发文档
scripts/           文档与 Agent Note 门禁脚本（Node 原生跑 .ts，无第三方依赖）
```

## 参考实现：edge-mac-widget

前一代产品，同样把 [pi coding agent](https://github.com/earendil-works/pi) 作为 SDK 跑在 Cloudflare Workers + Durable Objects 上，把网页转成 widget。与本项目的关键差异是它的工具在**客户端本机**执行，而本项目的客户端是 iOS app、不保证在线，因此工具下沉到服务端。

- 本地：`/Users/jian/project/edge-mac-widget`
- 仓库：https://github.com/linjianbjfu/edge-mac-widget.git

它的 `README.md` 记录了 pi 在 Workers 上踩过的坑（TypeBox JIT、`import.meta.url`、`entry_appended` 不是持久化钩子、`/tmp` 按请求隔离、`process.env` 泄漏密钥、grep 无法远程化），这些结论**在本项目同样成立**，不要重新推导。需要时直接参考；但注意凡是涉及"工具在客户端执行"的设计，在本项目都不适用。

## Skills

`.agents/skills/<name>/SKILL.md` 是唯一的源。三个工具各自原生发现它：

| 工具 | 发现路径 |
|---|---|
| Claude Code | `.claude/skills/`（符号链接到 `.agents/skills/`） |
| Codex CLI | `.agents/skills/` |
| GitHub Copilot（CLI / VS Code / cloud agent） | `.agents/skills/` |

不要把 skill 内容复制到第二个目录。要新增 skill，就在 `.agents/skills/` 下建一个目录，写一个带 `name` 和 `description` frontmatter 的 `SKILL.md`。`description` 决定模型什么时候会调用它——写清楚触发条件，而不只是主题。

当前可用的 skill：

| Skill | 什么时候用 |
|---|---|
| [archive-agent-notes](.agents/skills/archive-agent-notes/SKILL.md) | 新增、审计、归档或删除 Agent Note；每一篇新笔记的取代检查走这里 |
| [prose-standard](.agents/skills/prose-standard/SKILL.md) | 写或审查散文、注释、提示词、诊断信息和界面文案 |
| [trim-cot-leakage](.agents/skills/trim-cot-leakage/SKILL.md) | 清理读起来像推理记录或评审对话残渣的文字 |
| [code-review](.agents/skills/code-review/SKILL.md) | 评审 PR：本仓库的规范和代码本身看不出来的检查项 |
| [find-simplifications](.agents/skills/find-simplifications/SKILL.md) | 找并提出有证据支撑的简化，删掉死的、重复的、臆测的东西 |
| [ci-test-reliability](.agents/skills/ci-test-reliability/SKILL.md) | 设计或诊断在并发、时钟、进程全局状态下会不确定失败的测试 |
| [speed-up-perf](.agents/skills/speed-up-perf/SKILL.md) | 排查性能、设计基准和 CI 性能门禁 |
| [agent-experience](.agents/skills/agent-experience/SKILL.md) | 改动面向模型的工具定义、skill 或上下文加载方式 |
| [record-browser-gif](.agents/skills/record-browser-gif/SKILL.md) | 录制浏览器交互 GIF 并挂到 PR 上 |
| [merging-stacked-prs](.agents/skills/merging-stacked-prs/SKILL.md) | 落地一串互相依赖的 PR |

## 文档同步

接口、SSE、配置、CLI、部署或可观察行为发生变化时，在同一个改动中更新受影响的文档。先查当前实现与测试，再修改已有正文并同步相关活跃笔记；不要在文末追加与旧说明矛盾的修正。

- [README](README.md) 是项目入口；[开发指南](docs/development.md)拥有运行、测试和部署步骤；[CLI](docs/test-cli.md)拥有命令用法。
- [客户端协议](docs/protocol.md)拥有 HTTP/SSE 契约；[架构](docs/architecture.md)拥有组件职责与当前限制；Agent Notes 保存理由、替代方案和验证证据。详细事实只维护一份，其余位置链接到它。
- 新改的命令和行为描述核对实际执行结果。需要凭据或部署而无法验证时，在交付中明确报告；不把设计目标写成已实现行为。
- 使用 [prose-standard](.agents/skills/prose-standard/SKILL.md) 保留必要契约。移动文档时修复入链，运行 `npm run verify-docs`；改到 Notes 时同时运行 `npm run verify-notes`。

## Agent Notes

影响本代码库的决策和提案记录在 `.agents/notes/` 下，路径是 `{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`。格式、分类、归档和删除规则见 [.agents/notes/README.md](.agents/notes/README.md)，目录本地指令见 [.agents/notes/AGENTS.md](.agents/notes/AGENTS.md)。

提案触发时机和实施顺序由上方[工作流](#工作流每次任务先执行)规定。提案必须在方案确认前可供评审；实施后的笔记保留代码、测试和使用文档解释不了的理由、替代方案、后果与重新考虑条件，不记录逐步操作过程。

动笔前先做取代检查。在活跃树里搜同一个决策或同一个机制：

```bash
rg --hidden -l '<机制>' .agents/notes/ --glob '!.agents/notes/archived/**'
```

已有活跃笔记拥有同一个决策，就更新它，不要另起一篇竞争的记录。改变已实施决策时，另写提案并互相链接，不要把旧笔记改写成它的反面。完全取代、部分取代、以及够格归档的笔记，用 [archive-agent-notes](.agents/skills/archive-agent-notes/SKILL.md) 判定并在同一个改动里处理掉。

一篇 `implemented/` 的笔记随它描述的东西一起维护：后续改动移动了文件、重命名了包、改了某个键或默认值，就在同一个改动里更新事实，但不改决策本身。见 [.agents/notes/implemented/AGENTS.md](.agents/notes/implemented/AGENTS.md)。改到 `.agents/notes/` 的同一个改动里跑 `npm run verify-notes`。

`## 曾考虑的替代方案` 是每一篇笔记的强制小节，并且只记录真实存在过的替代方案。当时确实没考虑过别的，就如实写明这一点及其原因。

## Conventions

- 应用依赖与配置由各自目录拥有；根 package.json 通过 npm workspaces 转发后端命令，共享根 package-lock.json。服务端 `.dev.vars*` 只放在 `backend/`，仅示例模板可提交。

- 单元与模块集成测试放在实现旁，使用 `<模块>.test.ts`；跨服务端到端检查由 `test-cli/checks.mjs` 承担。

- 散文和注释陈述完整的契约与上下文，不是推理过程的记录。用直接、具体的词。判断标准见 [prose-standard](.agents/skills/prose-standard/SKILL.md)，清理推理泄漏见 [trim-cot-leakage](.agents/skills/trim-cot-leakage/SKILL.md)。
- 可机械校验的不变量接进一个实际会执行的顶层门禁，并且证明每一条被改动的验收路径确实会拒绝一个非法输入。
- 用窄的、有理由的例外，而不是全局关掉一条规则。
- 提交信息和 PR 描述陈述改动后的状态，不叙述改动过程。

## Run relevant checks locally

推送前跑覆盖这次 diff 的检查，而不是反射性地跑全量。报告实际执行过的命令和观察到的结果；重试、跳过的测试、还在跑的 CI，都不算通过。

当前可用的门禁：

```bash
npm run verify-docs           # README、根指令与 docs 的本地链接目标
npm run verify-model-limits   # 模型上限与网关声明一致（需网关凭据）
npm run verify-notes          # 三个 Agent Note 门禁串跑
npm run verify-agent-note-classification
npm run verify-agent-note-format
npm run verify-archived-agent-notes
npm run verify-archived-agent-notes -- --write   # 只在归档时追加封存哈希
```

需要 Node ≥ 22.6（脚本用原生 TypeScript 剥离直接执行 `.ts`，不装任何依赖）。
