import { describe, expect, it } from "vitest";

import { Hub } from "../src/do/hub.ts";
import { encodeFrame, isReplayable, kindToEvent, streamEndFrame } from "../src/do/sse.ts";

const decoder = new TextDecoder();

/** Drain a stream to text, with a bound so a hung stream fails rather than hangs. */
async function drain(stream: ReadableStream<Uint8Array>, limitMs = 2000): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  const deadline = Date.now() + limitMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error("stream did not close");
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value);
  }
}

function parse(text: string): Array<{ id?: string; event?: string; data?: string }> {
  return text
    .split("\n\n")
    .filter(block => block.trim().length > 0)
    .map(block => {
      const frame: { id?: string; event?: string; data?: string } = {};
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) frame.id = line.slice(4);
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
      }
      return frame;
    });
}

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

describe("hub", () => {
  it("delivers the backlog before any live frame", async () => {
    const hub = new Hub();
    const stream = hub.subscribe("s1", [
      { event: "entry", data: { n: 1 }, seq: 1 },
      { event: "entry", data: { n: 2 }, seq: 2 },
    ]);
    hub.broadcast("s1", { event: "entry", data: { n: 3 }, seq: 3 });
    hub.closeAll("s1", streamEndFrame(false));

    const frames = parse(await drain(stream));
    expect(frames.map(f => f.id)).toEqual(["1", "2", "3", undefined]);
    expect(frames.at(-1)?.event).toBe("stream_end");
  });

  it("feeds two subscribers the same live frames", async () => {
    const hub = new Hub();
    const a = hub.subscribe("s1", []);
    const b = hub.subscribe("s1", [{ event: "entry", data: { old: true }, seq: 1 }]);
    expect(hub.count("s1")).toBe(2);
    hub.broadcast("s1", { event: "entry", data: { live: true }, seq: 2 });
    hub.closeAll("s1", streamEndFrame(false));

    const [fa, fb] = [parse(await drain(a)), parse(await drain(b))];
    // A joined with no backlog, B with one record; both see the live frame.
    expect(fa.map(f => f.id)).toEqual(["2", undefined]);
    expect(fb.map(f => f.id)).toEqual(["1", "2", undefined]);
  });

  it("drops a subscriber that stops reading and keeps the rest running", async () => {
    const hub = new Hub();
    const stalled = hub.subscribe("s1", []);
    const healthy = hub.subscribe("s1", []);
    // Consume `healthy` concurrently; never read `stalled`, so its writes
    // queue until the cap trips and it is dropped.
    const collected = drain(healthy, 5000);
    // Yield for real between batches so the live reader keeps up; the
    // unread one accumulates until its cap trips.
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 20; i++) {
        hub.broadcast("s1", { event: "entry", data: { i }, seq: batch * 20 + i + 1 });
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(hub.count("s1")).toBe(1);
    hub.closeAll("s1", streamEndFrame(false));
    const frames = parse(await collected);
    expect(frames.at(-1)?.event).toBe("stream_end");
    void stalled;
  });

  it("closes a finite stream without a live tail", async () => {
    const hub = new Hub();
    const stream = hub.finite([{ event: "entry", data: { n: 1 }, seq: 1 }], streamEndFrame(false));
    // Not registered, so a later broadcast cannot reach it.
    hub.broadcast("s1", { event: "entry", data: { n: 2 }, seq: 2 });
    const frames = parse(await drain(stream));
    expect(frames.map(f => f.event)).toEqual(["entry", "stream_end"]);
  });

  it("reports busy state on the terminator", async () => {
    const hub = new Hub();
    const stream = hub.finite([], streamEndFrame(true));
    const frames = parse(await drain(stream));
    expect(JSON.parse(frames[0]!.data!)).toEqual({ sessionBusy: true });
  });
});
