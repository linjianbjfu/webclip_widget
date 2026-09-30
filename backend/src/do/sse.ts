/**
 * Server-sent event framing.
 *
 * `id:` appears only on records the log can replay. Per the SSE
 * specification an event without `id:` leaves `Last-Event-ID` untouched, so
 * token deltas do not advance the client's cursor and a reconnect never
 * resumes from the middle of a message. That falls straight out of the
 * decision not to persist deltas.
 */

import type { EventKind } from "./store.ts";

/** Event names that carry a `seq`, i.e. everything the log can replay. */
const REPLAYABLE: ReadonlySet<string> = new Set<EventKind>(["pi_entry", "out_file", "turn_end", "error"]);

export interface Frame {
  /** SSE event name. `pi_entry` is published as `entry`. */
  event: string;
  data: unknown;
  /** Present only for replayable records. */
  seq?: number;
}

const encoder = new TextEncoder();

export function kindToEvent(kind: EventKind): string {
  return kind === "pi_entry" ? "entry" : kind;
}

export function isReplayable(event: string): boolean {
  return REPLAYABLE.has(event === "entry" ? "pi_entry" : event);
}

export function encodeFrame(frame: Frame): Uint8Array {
  const lines: string[] = [];
  if (frame.seq !== undefined) lines.push(`id: ${frame.seq}`);
  lines.push(`event: ${frame.event}`);
  // A data payload must never contain a raw newline: SSE would read it as a
  // field break. JSON.stringify escapes them, so one `data:` line suffices.
  lines.push(`data: ${JSON.stringify(frame.data)}`);
  return encoder.encode(`${lines.join("\n")}\n\n`);
}

/** The terminator. Absent it, a closed stream means "dropped", not "finished". */
export function streamEndFrame(sessionBusy: boolean): Frame {
  return { event: "stream_end", data: { sessionBusy } };
}
