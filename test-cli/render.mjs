/**
 * Turning protocol frames into lines a person reads.
 *
 * Kept apart from the entry point so the checks can import it without running
 * the CLI: `index.mjs` calls `main()` at the top level.
 */

/**
 * Render a frame for a human. The interactive driver is tolerant by design.
 *
 * `replay` selects where the conversation text comes from. A live turn streams
 * it as `stream` deltas and also records it in an `entry`; printing both shows
 * every reply twice. A replay carries no deltas at all — `stream` is not a
 * replayable record — so there the entries are the only text. Preview reports
 * use entries in both modes: tool_end carries execution status, not validation.
 */
function render(frame, { replay = false } = {}) {
  const seq = frame.id ? `#${frame.id} ` : "   ";
  switch (frame.event) {
    case "entry":
    case "pi_entry": {
      const entry = frame.data;
      if (entry?.type !== "message") return; // model and thinking-level records
      if (entry.message?.role === "toolResult" && entry.message.toolName === "preview_widget") {
        renderPreviewResult(entry.message, seq);
        return;
      }
      if (!replay) return;
      const { role, content } = entry.message ?? {};
      for (const block of content ?? []) {
        const line = replayLine(role, block);
        if (line !== null) console.log(`${seq}${line}`);
      }
      return;
    }
    case "stream": {
      // Only `text_delta` is prose. A tool call streams its arguments as
      // `toolcall_delta`, whose delta is a fragment of the argument JSON;
      // taking every delta prints that JSON into the middle of the reply.
      // `text_start` carries its first characters in `partial`, which the
      // following deltas repeat, so the deltas alone reconstruct the text.
      const text = streamProse(frame);
      if (text) process.stdout.write(text);
      return;
    }
    case "tool_start":
      console.log(`\n${seq}→ ${frame.data.name} ${JSON.stringify(frame.data.args ?? {}).slice(0, 120)}`);
      return;
    case "tool_end":
      if (frame.data.name === "preview_widget") return;
      console.log(`${seq}← ${frame.data.name} ${frame.data.isError ? "ERROR" : "ok"}`);
      return;
    case "out_file":
      console.log(`${seq}📄 ${frame.data.path} ${frame.data.bytes}B`);
      return;
    case "turn_end": {
      const out = (frame.data.out ?? []).map(f => `${f.path} (${f.bytes}B)`).join(", ");
      console.log(`\n${seq}turn ${frame.data.reason}${out ? ` — ${out}` : ""}`);
      return;
    }
    case "error":
      console.log(`\n${seq}error ${frame.data.code}: ${frame.data.message}`);
      return;
    case "stream_end":
      console.log(`${seq}stream closed (busy=${frame.data.sessionBusy})`);
      return;
    default:
      console.log(`${seq}${frame.event}`);
  }
}

function renderPreviewResult(message, seq) {
  const lines = (message.content ?? [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .split("\n");
  const end = lines.findIndex(line => /^(rendered text|extracted data):/.test(line));
  const [first, ...details] = lines.slice(0, end < 0 ? lines.length : end);
  console.log(`${seq}← preview_widget ${message.isError ? "ERROR " : ""}${first || "result unavailable"}`);
  for (const line of new Set(details)) {
    if (line) console.log(`   ${line}`);
  }
}

/**
 * The prose carried by one `stream` frame.
 *
 * Only `text_delta` is prose. A tool call streams its arguments as
 * `toolcall_delta`, whose delta is a fragment of the argument JSON; taking
 * every delta prints that JSON into the middle of the reply. `text_start`
 * carries its first characters in `partial`, which the following deltas
 * repeat, so the deltas alone reconstruct the text exactly.
 */
function streamProse(frame) {
  let text = "";
  for (const event of frame.data?.events ?? []) {
    if (event.type === "text_delta") text += event.delta ?? "";
  }
  return text;
}

/**
 * One line of replayed history, or null for a block a reader does not need.
 *
 * The block and role names are pi's: a call is `toolCall`, and its result
 * comes back as a whole message whose role is `toolResult`. Thinking blocks
 * fall through as null.
 */
function replayLine(role, block) {
  if (block.type === "toolCall") {
    return `→ ${block.name} ${JSON.stringify(block.arguments ?? {}).slice(0, 100)}`;
  }
  if (block.type !== "text" || !block.text) return null;
  if (role === "toolResult") return `← ${block.text.split("\n")[0].slice(0, 100)}`;
  if (role === "user") return `> ${block.text}`;
  return block.text;
}

/**
 * Render a stream that starts as history and may run on into a live turn.
 *
 * Entries carry the conversation text while the backlog drains; past that
 * point the live deltas carry it, and rendering both prints every reply twice.
 * The crossing is marked by the first frame without an `id`: only replayable
 * records are numbered, so an unnumbered frame cannot have come from the log.
 * `stream_end` is unnumbered too, but it always arrives last.
 */
function followRenderer() {
  let live = false;
  return frame => {
    if (frame.id === undefined) live = true;
    render(frame, { replay: !live });
  };
}

export { followRenderer, render, replayLine, streamProse };
