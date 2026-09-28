/**
 * Enforce Agent Note headers, lifecycle-specific sections, and the mandatory
 * alternatives section. Classification and filenames belong to the sibling tree
 * gate. The exact format lives in `.agents/notes/README.md` § 文件格式.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentNoteRoot, walkAgentNoteTree } from './agent-note-tree.ts'

/** Status-line grammar per lifecycle folder. The token itself stays English so it is machine-checkable. */
const STATUS: Record<string, RegExp> = {
  proposed: /^Status: proposed$/,
  implemented: /^Status: implemented$/,
  rejected: /^Status: rejected — .+$/,
}

/** The universal opening section every Agent Note carries. */
const PROBLEM = '## 问题'

/** The mandatory section recording what the decision beat. */
const ALTERNATIVES = '## 曾考虑的替代方案'

/** Required `##` headings per lifecycle, beyond the universal `## 问题` opener. */
const REQUIRED: Record<string, string[]> = {
  proposed: ['## 方案', '## 验收标准', '## 风险'],
  implemented: ['## 决策', '## 后果'],
  rejected: ['## 方案'],
}

/** Headings banned in `implemented/` — proposal-era spec-speak describing plans rather than shipped state. */
const BANNED_IMPLEMENTED = /^## (?:方案|计划|迁移计划|验收标准)\s*$/

const { notes, errors } = walkAgentNoteTree()

for (const note of notes) {
  const fail = (msg: string): void => {
    errors.push(`format: ${note.rel} — ${msg}`)
  }
  const lines = readFileSync(resolve(agentNoteRoot, note.rel), 'utf8').split('\n')
  // Format tokens inside fenced examples are not document structure.
  let inFence = false
  const prose = lines.filter((l) => {
    if (l.startsWith('```')) {
      inFence = !inFence
      return false
    }
    return !inFence
  })

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail('line 1 must be `# Agent Note: <标题>`')
  if (lines[1] !== '') fail('line 2 must be blank')
  const status = STATUS[note.lifecycle]
  if (status !== undefined && !status.test(lines[2] ?? '')) {
    fail(`line 3 must match the ${note.lifecycle} status grammar (${String(status)})`)
  }
  if (lines[3] !== '') fail('line 4 must be blank')
  const statusLines = prose.filter(l => l.startsWith('Status:') && l !== lines[2])
  if (statusLines.length > 0 || prose.filter(l => l === lines[2]).length > 1) {
    fail('the line-3 `Status:` line must be the only one in the file')
  }

  const h2s = prose.filter(l => l.startsWith('## ')).map(l => l.trimEnd())
  if (h2s[0] !== PROBLEM) fail(`the first section must be \`${PROBLEM}\` (got ${JSON.stringify(h2s[0] ?? '<none>')})`)
  for (const required of REQUIRED[note.lifecycle] ?? []) {
    if (!h2s.includes(required)) fail(`missing the required \`${required}\` section`)
  }
  if (note.lifecycle === 'implemented') {
    for (const h2 of h2s.filter(h => BANNED_IMPLEMENTED.test(h))) {
      fail(`\`${h2}\` is a proposal-era heading; an implemented Agent Note states what is (fold it into 决策/后果/验证)`)
    }
  }

  if (!h2s.includes(ALTERNATIVES)) {
    fail(`missing \`${ALTERNATIVES}\` — a decision recorded without what it beat invites re-litigation`)
  }
}

if (errors.length === 0) {
  console.log(`verify-agent-note-format: ${notes.length} Agent Note(s) checked, all conform to .agents/notes/README.md § 文件格式.`)
  process.exit(0)
}

console.error('verify-agent-note-format: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
