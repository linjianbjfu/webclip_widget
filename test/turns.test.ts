import { describe, expect, it } from "vitest";

import {
  decideAlarm,
  MAX_RECOVERIES,
  MAX_TURN_MS,
  type TurnSnapshot,
} from "../src/do/turns.ts";
import { isValidTurnId, sha256Hex } from "../src/protocol.ts";

const NOW = 1_000_000_000;

function turn(overrides: Partial<TurnSnapshot> = {}): TurnSnapshot {
  return { session_id: "s1", turn_id: "t1", started_at: NOW - 1000, recoveries: 0, ...overrides };
}

describe("alarm decisions", () => {
  it("re-arms while any turn is running", () => {
    expect(decideAlarm([], true, NOW).rearm).toBe(true);
    expect(decideAlarm([], false, NOW).rearm).toBe(false);
  });

  it("resumes a stale turn rather than failing it", () => {
    const decision = decideAlarm([turn()], true, NOW);
    expect(decision.resume).toEqual([{ sessionId: "s1", turnId: "t1" }]);
    expect(decision.abandon).toHaveLength(0);
  });

  it("abandons a turn past the hard time limit", () => {
    const decision = decideAlarm([turn({ started_at: NOW - MAX_TURN_MS - 1 })], true, NOW);
    expect(decision.resume).toHaveLength(0);
    expect(decision.abandon[0]?.reason).toBe("turn_timeout");
  });

  it("abandons a turn that exhausted its recoveries", () => {
    const decision = decideAlarm([turn({ recoveries: MAX_RECOVERIES })], true, NOW);
    expect(decision.abandon[0]?.reason).toBe("recovery_exhausted");
  });

  it("prefers the time limit when both bounds are exceeded", () => {
    const decision = decideAlarm(
      [turn({ started_at: NOW - MAX_TURN_MS - 1, recoveries: MAX_RECOVERIES })],
      true,
      NOW,
    );
    // A turn running far too long is abandoned for that reason regardless of
    // how many times it was resumed.
    expect(decision.abandon[0]?.reason).toBe("turn_timeout");
  });

  it("decides per turn across several sessions", () => {
    const decision = decideAlarm(
      [
        turn({ session_id: "a", turn_id: "ok" }),
        turn({ session_id: "b", turn_id: "old", started_at: NOW - MAX_TURN_MS - 1 }),
      ],
      true,
      NOW,
    );
    expect(decision.resume).toEqual([{ sessionId: "a", turnId: "ok" }]);
    expect(decision.abandon).toEqual([
      { sessionId: "b", turnId: "old", reason: "turn_timeout" },
    ]);
  });
});

describe("turn id validation", () => {
  it("accepts a lowercase UUIDv4", () => {
    expect(isValidTurnId("9f2c7b1e-4a83-4d15-9c60-7e3b2a5f8d01")).toBe(true);
  });

  it("rejects anything a counter would produce", () => {
    // A client that resets its counter after a reinstall could otherwise
    // collide with a finished turn and have its prompt silently swallowed.
    expect(isValidTurnId("1")).toBe(false);
    expect(isValidTurnId("turn-1")).toBe(false);
  });

  it("rejects uppercase, wrong version and malformed values", () => {
    expect(isValidTurnId("9F2C7B1E-4A83-4D15-9C60-7E3B2A5F8D01")).toBe(false);
    expect(isValidTurnId("9f2c7b1e-4a83-1d15-9c60-7e3b2a5f8d01")).toBe(false);
    expect(isValidTurnId("")).toBe(false);
    expect(isValidTurnId(undefined)).toBe(false);
  });
});

describe("artifact hashing", () => {
  it("is stable and distinguishes content", async () => {
    const a = await sha256Hex(new TextEncoder().encode("const a = 1;"));
    const again = await sha256Hex(new TextEncoder().encode("const a = 1;"));
    const b = await sha256Hex(new TextEncoder().encode("const a = 2;"));
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
