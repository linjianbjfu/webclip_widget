/**
 * Incremental SSE parser.
 *
 * Written by hand because `EventSource` only issues GET requests, and this
 * protocol's main entry point is a POST whose response body is the stream.
 * Frames are split on a blank line; a field spanning two chunks must survive,
 * so the tail of an incomplete frame is carried over rather than discarded.
 */

/** @typedef {{ id?: string, event: string, data: unknown, raw: string }} Frame */

export class SseParser {
  #buffer = "";

  /**
   * Feed one chunk of text. Returns whole frames only; a partial trailing
   * frame stays buffered until its terminating blank line arrives.
   * @param {string} chunk
   * @returns {Frame[]}
   */
  push(chunk) {
    this.#buffer += chunk;
    const frames = [];
    let split;
    while ((split = this.#buffer.indexOf("\n\n")) !== -1) {
      const block = this.#buffer.slice(0, split);
      this.#buffer = this.#buffer.slice(split + 2);
      const frame = parseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

/** @param {string} block @returns {Frame | null} */
function parseBlock(block) {
  let id;
  let event = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (data.length === 0 && id === undefined) return null;
  const joined = data.join("\n");
  let parsed = joined;
  try {
    parsed = JSON.parse(joined);
  } catch {
    // Leave non-JSON payloads as text; the protocol sends JSON, but a proxy
    // error page reaching the parser should surface rather than throw.
  }
  return { ...(id === undefined ? {} : { id }), event, data: parsed, raw: block };
}
