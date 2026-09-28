# AGENTS.md — webclip_widget

本文件是仓库的根指令，对所有 coding agent 生效。Claude Code 通过 `CLAUDE.md` 符号链接读到同一份；Codex 和 GitHub Copilot 直接读 `AGENTS.md`。

## 仓库结构

```
.agents/
  skills/          唯一的 skill 源目录（Codex 与 Copilot 原生发现）
  notes/           Agent Notes：决策与提案记录
.claude/
  skills -> ../.agents/skills    Claude Code 的发现路径
scripts/           Agent Note 门禁脚本（Node 原生跑 .ts，无第三方依赖）
```

## Skills

`.agents/skills/<name>/SKILL.md` 是唯一的源。三个工具各自原生发现它：

| 工具 | 发现路径 |
|---|---|
| Claude Code | `.claude/skills/`（符号链接到 `.agents/skills/`） |
| Codex CLI | `.agents/skills/` |
| GitHub Copilot（CLI / VS Code / cloud agent） | `.agents/skills/` |

不要把 skill 内容复制到第二个目录。要新增 skill，就在 `.agents/skills/` 下建一个目录，写一个带 `name` 和 `description` frontmatter 的 `SKILL.md`。`description` 决定模型什么时候会调用它——写清楚触发条件，而不只是主题。

## Agent Notes

影响本代码库的决策和提案记录在 `.agents/notes/` 下，规则见 [.agents/notes/README.md](.agents/notes/README.md)。只有当代码、测试和现有文档解释不了某个持久的决策理由时才写一篇。

## Conventions

- 散文和注释陈述完整的契约与上下文，不是推理过程的记录。用直接、具体的词。判断标准见 [prose-standard](.agents/skills/prose-standard/SKILL.md)，清理推理泄漏见 [trim-cot-leakage](.agents/skills/trim-cot-leakage/SKILL.md)。
- 可机械校验的不变量接进一个实际会执行的顶层门禁，并且证明每一条被改动的验收路径确实会拒绝一个非法输入。
- 用窄的、有理由的例外，而不是全局关掉一条规则。
- 提交信息和 PR 描述陈述改动后的状态，不叙述改动过程。

## Run relevant checks locally

推送前跑覆盖这次 diff 的检查，而不是反射性地跑全量。报告实际执行过的命令和观察到的结果；重试、跳过的测试、还在跑的 CI，都不算通过。

当前可用的门禁：

```bash
npm run verify-notes          # 三个 Agent Note 门禁串跑
npm run verify-agent-note-classification
npm run verify-agent-note-format
npm run verify-archived-agent-notes
npm run verify-archived-agent-notes -- --write   # 只在归档时追加封存哈希
```

需要 Node ≥ 22.6（脚本用原生 TypeScript 剥离直接执行 `.ts`，不装任何依赖）。
