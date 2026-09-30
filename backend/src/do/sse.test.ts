import { describe, expect, it } from "vitest";

import { encodeFrame, isReplayable, kindToEvent } from "./sse.ts";

const decoder = new TextDecoder();

describe("framing", () => {
  it("emits id only for replayable records", () => {
    const withId = decoder.decode(encodeFrame({ event: "entry", data: { a: 1 }, seq: 41 }));
    expect(withId).toContain("id: 41");
    const withoutId = decoder.decode(encodeFrame({ event: "stream", data: { events: [] } }));
    expect(withoutId).not.toContain("id:");
  });

  it("classifies which events carry a cursor", () => {
    expect(isReplayable("entry")).toBe(true);
    expect(isReplayable("out_file")).toBe(true);
    expect(isReplayable("turn_end")).toBe(true);
    expect(isReplayable("error")).toBe(true);
    // Deltas and the terminator must not advance Last-Event-ID.
    expect(isReplayable("stream")).toBe(false);
    expect(isReplayable("stream_end")).toBe(false);
    expect(isReplayable("tool_start")).toBe(false);
  });

  it("publishes pi_entry under the wire name entry", () => {
    expect(kindToEvent("pi_entry")).toBe("entry");
    expect(kindToEvent("out_file")).toBe("out_file");
  });

  it("keeps a newline in the payload from breaking the frame", () => {
    const text = decoder.decode(encodeFrame({ event: "stream", data: { text: "a\nb" } }));
    // One data line; the newline survives as an escape inside the JSON.
    expect(text.split("\n").filter(l => l.startsWith("data: "))).toHaveLength(1);
    expect(text).toContain("\\n");
  });
});
