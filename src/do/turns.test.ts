import { describe, expect, it } from "vitest";

import {
  decideAlarm,
  MAX_RECOVERIES,
  MAX_TURN_MS,
  type TurnSnapshot,
} from "./turns.ts";

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
