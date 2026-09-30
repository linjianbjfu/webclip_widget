/**
 * Where a turn's wall-clock time went.
 *
 * Nothing here needs the server to emit anything extra: every pi entry already
 * carries the moment it was recorded, and the order of entries fixes what each
 * interval was spent on. The gap before an assistant message is time the model
 * spent producing it; the gap before a tool result is that tool running. An
 * assistant message that issues several calls is followed by several results,
 * so the results are matched to the calls in the order both were recorded.
 */

/** @param {import("./sse.mjs").Frame[]} frames */
export function timeline(frames) {
  const steps = [];
  let previous = null;
  let pending = [];

  for (const frame of frames) {
    const entry = frame.data;
    if (!entry?.timestamp) continue;
    const at = Date.parse(entry.timestamp);
    const gap = previous === null ? 0 : at - previous;
    previous = at;

    const role = entry.message?.role ?? entry.type;
    const content = entry.message?.content ?? [];

    if (role === "assistant") {
      const calls = content.filter(block => block.type === "toolCall");
      pending = calls.map(block => ({
        name: block.name,
        detail: describe(block.arguments),
      }));
      const said = calls.length > 0 ? `→ ${calls.map(c => c.name).join(" + ")}` : summarise(content);
      steps.push({ ms: gap, kind: "model", label: said });
    } else if (role === "toolResult") {
      const call = pending.shift() ?? { name: "?", detail: "" };
      steps.push({ ms: gap, kind: "tool", label: call.name, detail: call.detail });
    }
  }

  const total = steps.reduce((sum, step) => sum + step.ms, 0);
  const of = kind => steps.filter(step => step.kind === kind);
  return {
    steps,
    total,
    model: { ms: sum(of("model")), count: of("model").length },
    tool: { ms: sum(of("tool")), count: of("tool").length },
  };
}

function sum(steps) {
  return steps.reduce((total, step) => total + step.ms, 0);
}

/** The part of a tool's arguments worth seeing in a timing report. */
function describe(args) {
  if (args === undefined || args === null) return "";
  const text = args.command ?? args.path ?? JSON.stringify(args);
  return String(text).replace(/\s+/g, " ").slice(0, 96);
}

function summarise(content) {
  const chars = content
    .filter(block => block.type === "text")
    .reduce((total, block) => total + (block.text ?? "").length, 0);
  return chars > 0 ? `${chars} char(s) of reply` : "(no text)";
}

export function formatTimeline(report) {
  const secs = ms => `${(ms / 1000).toFixed(1)}s`;
  const lines = [
    `total  ${secs(report.total)}`,
    `  model  ${secs(report.model.ms).padStart(7)}  ${report.model.count} call(s)`,
    `  tools  ${secs(report.tool.ms).padStart(7)}  ${report.tool.count} result(s)`,
    "",
    "slowest steps",
  ];
  const slowest = [...report.steps].sort((a, b) => b.ms - a.ms).slice(0, 10);
  for (const step of slowest) {
    const what = step.kind === "model" ? `model ${step.label}` : `${step.label}  ${step.detail}`;
    lines.push(`  ${secs(step.ms).padStart(7)}  ${what}`);
  }
  return lines.join("\n");
}
