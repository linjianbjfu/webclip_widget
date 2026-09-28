# AGENTS.md — 归档的 Agent Notes

kind 目录下的归档 Agent Note 是冻结的历史快照，不是当前行为的依据。永远不要编辑、重排、翻译、修复、删除或移动一个已封存的文件；新的决策和事实请使用活跃的 Agent Note 或当前文档。

一次归档改动只被允许做四件事：移动文件、在 `Status: implemented` 正下方插入一行 `Archived: YYYY-MM-DD`、修复或删除指向它的入链。不要检查、校验或修复从归档笔记出去的链接。

执行 [`archive-agent-notes`](../../skills/archive-agent-notes/SKILL.md) 工作流，并用 `npm run verify-archived-agent-notes -- --write` 追加新文件的哈希。普通模式的校验器会拒绝被改动或缺失的封存文件、未知的 kind 目录，以及无效的归档元数据。
