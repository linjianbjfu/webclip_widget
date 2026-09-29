import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { UserAgentDO } from "../src/do/user-agent-do.ts";
import { MAX_RECOVERIES, MAX_TURN_MS } from "../src/do/turns.ts";

/**
 * Drive the alarm without waiting for one.
 *
 * `runDurableObjectAlarm` fires whatever is scheduled immediately, which is
 * the only way to cover the keepalive and recovery branches: a real alarm
 * would mean a thirty-second wait per case, and the recovery branch would
 * additionally require the object to actually lose its host.
 */
function stub(name: string): DurableObjectStub<UserAgentDO> {
  return env.AGENT.get(env.AGENT.idFromName(name));
}

/** Backdate a turn's progress so the alarm classifies it as interrupted. */
async function ageTurn(
  s: DurableObjectStub<UserAgentDO>,
  sessionId: string,
  turnId: string,
  fields: { progressMsAgo?: number; startedMsAgo?: number; recoveries?: number },
): Promise<void> {
  await runInDurableObject(s, async (instance: UserAgentDO) => {
    const now = Date.now();
    instance.sqlForTest.exec(
      `UPDATE turns SET last_progress_at = ?, started_at = ?, recoveries = ?
       WHERE session_id = ? AND turn_id = ?`,
      now - (fields.progressMsAgo ?? 0),
      now - (fields.startedMsAgo ?? 0),
      fields.recoveries ?? 0,
      sessionId,
      turnId,
    );
  });
}

describe("keepalive alarm", () => {
  it("re-arms while a turn is running and stops once it ends", async () => {
    const s = stub("rearm");
    await runInDurableObject(s, async (instance: UserAgentDO) => {
      instance.turnRunner = async () => {};
      instance.storeForTest.createSession("s1");
      instance.storeForTest.beginTurn("s1", "t1", "work");
    });
    await runInDurableObject(s, async (_i, state) => {
      await state.storage.setAlarm(Date.now() + 1000);
    });

    // Firing with a turn still running must leave another alarm behind.
    expect(await runDurableObjectAlarm(s)).toBe(true);
    await runInDurableObject(s, async (_i, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await runInDurableObject(s, async (instance: UserAgentDO) => {
      instance.storeForTest.endTurn("s1", "t1", "completed");
    });
    await runDurableObjectAlarm(s);
    await runInDurableObject(s, async (_i, state) => {
      // Nothing left to keep alive: the object may now leave memory.
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe("interruption recovery", () => {
  it("resumes a stale turn instead of failing it", async () => {
    const s = stub("resume");
    const resumed: string[] = [];
    await runInDurableObject(s, async (instance: UserAgentDO) => {
      instance.turnRunner = async ({ turnId }) => {
        resumed.push(turnId);
      };
      instance.storeForTest.createSession("s1");
      instance.storeForTest.beginTurn("s1", "t1", "work");
    });
    await ageTurn(s, "s1", "t1", { progressMsAgo: 200_000, startedMsAgo: 200_000 });
    await runInDurableObject(s, async (_i, state) => state.storage.setAlarm(Date.now() + 1000));

    await runDurableObjectAlarm(s);

    await runInDurableObject(s, async (instance: UserAgentDO) => {
      expect(resumed).toEqual(["t1"]);
      const turn = instance.storeForTest.turn("s1", "t1");
      // Still running, with the recovery counted against its budget.
      expect(turn?.status).toBe("running");
      expect(turn?.recoveries).toBe(1);
    });
  });

  it("abandons a turn that exhausted its recoveries", async () => {
    const s = stub("exhausted");
    let started = 0;
    await runInDurableObject(s, async (instance: UserAgentDO) => {
      instance.turnRunner = async () => {
        started += 1;
      };
      instance.storeForTest.createSession("s1");
      instance.storeForTest.beginTurn("s1", "t1", "work");
    });
    await ageTurn(s, "s1", "t1", {
      progressMsAgo: 200_000,
      startedMsAgo: 200_000,
      recoveries: MAX_RECOVERIES,
    });
    await runInDurableObject(s, async (_i, state) => state.storage.setAlarm(Date.now() + 1000));

    await runDurableObjectAlarm(s);

    await runInDurableObject(s, async (instance: UserAgentDO) => {
      // Each recovery re-issues a paid model call; an unbounded retry is a
      // loop that spends money to keep failing.
      expect(started).toBe(0);
      expect(instance.storeForTest.turn("s1", "t1")?.status).toBe("failed");
      const events = instance.storeForTest.eventsSince("s1", 0);
      const error = events.find(e => e.kind === "error");
      expect(JSON.parse(error!.payload).code).toBe("recovery_exhausted");
      expect(events.some(e => e.kind === "turn_end")).toBe(true);
    });
  });

  it("abandons a turn past the hard time limit", async () => {
    const s = stub("timeout");
    await runInDurableObject(s, async (instance: UserAgentDO) => {
      instance.turnRunner = async () => {};
      instance.storeForTest.createSession("s1");
      instance.storeForTest.beginTurn("s1", "t1", "work");
    });
    await ageTurn(s, "s1", "t1", {
      progressMsAgo: 200_000,
      startedMsAgo: MAX_TURN_MS + 60_000,
    });
    await runInDurableObject(s, async (_i, state) => state.storage.setAlarm(Date.now() + 1000));

    await runDurableObjectAlarm(s);

    await runInDurableObject(s, async (instance: UserAgentDO) => {
      expect(instance.storeForTest.turn("s1", "t1")?.status).toBe("failed");
      const error = instance.storeForTest.eventsSince("s1", 0).find(e => e.kind === "error");
      expect(JSON.parse(error!.payload).code).toBe("turn_timeout");
    });
  });

  it("leaves a turn that is still making progress alone", async () => {
    const s = stub("healthy");
    let started = 0;
    await runInDurableObject(s, async (instance: UserAgentDO) => {
      instance.turnRunner = async () => {
        started += 1;
      };
      instance.storeForTest.createSession("s1");
      instance.storeForTest.beginTurn("s1", "t1", "work");
    });
    await runInDurableObject(s, async (_i, state) => state.storage.setAlarm(Date.now() + 1000));

    await runDurableObjectAlarm(s);

    await runInDurableObject(s, async (instance: UserAgentDO) => {
      expect(started).toBe(0);
      expect(instance.storeForTest.turn("s1", "t1")?.status).toBe("running");
      expect(instance.storeForTest.eventsSince("s1", 0)).toHaveLength(0);
    });
  });
});
