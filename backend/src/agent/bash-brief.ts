/**
 * What the bash tool says about itself.
 *
 * This shell is not the one the model was trained against, and the gap is
 * expensive rather than merely surprising. The facts live on the tool instead
 * of in the system prompt because the description travels with the tool's own
 * schema: the model reads it where it is about to write a command, not pages
 * earlier among instructions about the task.
 *
 * Must stay byte-stable. The description is part of the cached request prefix,
 * so text that varies per session makes every turn a cache miss — no error,
 * only a slower first token and a larger bill.
 */

/** Appended to pi's own description, which already covers truncation limits. */
const WORKSPACE_SHELL = [
  "",
  "This shell is an in-process implementation, not a system bash:",
  "- Available: grep, rg, find, sed, awk, jq, cut, tr and the usual text tools.",
  "- Absent: node, npm, python and js-exec. Transform text with the tools above.",
  "- Regular expressions are RE2. Backreferences and lookaround are unsupported.",
  "",
  "RE2 has no counters, so `{0,N}` is compiled into N copies of whatever it",
  "repeats. A pattern that opens with `.{0,N}` has no literal to anchor on and",
  "runs that enlarged automaton from every position in the file: on a megabyte",
  "of HTML it costs tens of seconds, and a loop over a dozen keywords costs",
  "minutes. `.*` is a single state and is free by comparison.",
  "",
  "So put the literal first — `grep -o 'PRICE.{0,300}'` is milliseconds where",
  "`grep -o '.{0,160}PRICE'` is seconds. To read what comes *before* a literal,",
  "use awk: `awk '{i=index($0,\"PRICE\"); if(i>0){print substr($0,i>200?i-200:1,500); exit}}'`.",
  "grep has no -b, so byte offsets are not available that way.",
].join("\n");

/** Return the definition with the workspace's own shell facts appended. */
export function withWorkspaceShellBrief<T extends { description: string }>(definition: T): T {
  return { ...definition, description: `${definition.description}\n${WORKSPACE_SHELL}` };
}
