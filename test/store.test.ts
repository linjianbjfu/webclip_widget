import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { UserAgentDO } from "../src/do/user-agent-do.ts";
import { Store } from "../src/do/store.ts";

async function withStore<T>(name: string, body: (store: Store) => Promise<T>): Promise<T> {
  const stub = env.AGENT.get(env.AGENT.idFromName(name));
  return runInDurableObject(stub, async (instance: UserAgentDO, state) =>
    body(new Store(instance.sqlForTest, body => state.storage.transactionSync(body))),
  );
}

describe("event log", () => {
  it("assigns a session-scoped seq that runs across turns", async () => {
    await withStore("seq", async store => {
      store.createSession("s1");
      store.append("s1", [
        { turnId: "t1", kind: "pi_entry", payload: { a: 1 } },
        { turnId: "t1", kind: "turn_end", payload: { reason: "completed" } },
      ]);
      store.append("s1", [{ turnId: "t2", kind: "pi_entry", payload: { a: 2 } }]);

      const all = store.eventsSince("s1", 0);
      expect(all.map(e => e.seq)).toEqual([1, 2, 3]);
      expect(all.map(e => e.turn_id)).toEqual(["t1", "t1", "t2"]);
      expect(store.lastSeq("s1")).toBe(3);
    });
  });

  it("keeps two sessions' seq spaces apart", async () => {
    await withStore("seq2", async store => {
      store.createSession("a");
      store.createSession("b");
      store.append("a", [{ turnId: "t", kind: "pi_entry", payload: 1 }]);
      store.append("b", [{ turnId: "t", kind: "pi_entry", payload: 2 }]);
      expect(store.lastSeq("a")).toBe(1);
      expect(store.lastSeq("b")).toBe(1);
      expect(store.eventsSince("a", 0)).toHaveLength(1);
    });
  });

  it("rebuilds context from pi_entry rows only", async () => {
    await withStore("kinds", async store => {
      store.createSession("s1");
      store.append("s1", [
        { turnId: "t1", kind: "pi_entry", payload: { type: "message" } },
        { turnId: "t1", kind: "out_file", payload: { path: "out/extra.js" } },
        { turnId: "t1", kind: "error", payload: { code: "llm_failed" } },
        { turnId: "t1", kind: "turn_end", payload: { reason: "failed" } },
      ]);
      const entries = store.piEntries("s1");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.entry).toEqual({ type: "message" });
      // Resumption still needs every record.
      expect(store.eventsSince("s1", 0)).toHaveLength(4);
    });
  });

  it("appends a batch atomically", async () => {
    await withStore("tx", async store => {
      store.createSession("s1");
      const circular: Record<string, unknown> = {};
      circular.self = circular; // JSON.stringify throws on the second item
      expect(() =>
        store.append("s1", [
          { turnId: "t1", kind: "pi_entry", payload: { ok: true } },
          { turnId: "t1", kind: "pi_entry", payload: circular },
        ]),
      ).toThrow();
      // Neither row is visible: the batch is all-or-nothing.
      expect(store.eventsSince("s1", 0)).toHaveLength(0);
      expect(store.lastSeq("s1")).toBe(0);
    });
  });

  it("serves a cursor without gaps or repeats", async () => {
    await withStore("cursor", async store => {
      store.createSession("s1");
      for (let i = 0; i < 5; i++) {
        store.append("s1", [{ turnId: "t1", kind: "pi_entry", payload: i }]);
      }
      expect(store.eventsSince("s1", 2).map(e => e.seq)).toEqual([3, 4, 5]);
      expect(store.eventsSince("s1", 5)).toHaveLength(0);
    });
  });
});

describe("turns", () => {
  it("keeps finished rows so a late retry can be answered", async () => {
    await withStore("retain", async store => {
      store.createSession("s1");
      store.beginTurn("s1", "t1", "do it");
      store.endTurn("s1", "t1", "completed");
      const row = store.turn("s1", "t1");
      expect(row?.status).toBe("completed");
      expect(row?.ended_at).not.toBeNull();
    });
  });

  it("reports at most one running turn per session", async () => {
    await withStore("running", async store => {
      store.createSession("s1");
      store.beginTurn("s1", "t1", "one");
      expect(store.runningTurn("s1")?.turn_id).toBe("t1");
      store.endTurn("s1", "t1", "completed");
      expect(store.runningTurn("s1")).toBeUndefined();
    });
  });

  it("derives busy from turns rather than storing it", async () => {
    await withStore("busy", async store => {
      store.createSession("s1", "title");
      expect(store.listSessions()[0]?.busy).toBe(false);
      store.beginTurn("s1", "t1", "x");
      expect(store.listSessions()[0]?.busy).toBe(true);
      store.endTurn("s1", "t1", "aborted");
      expect(store.listSessions()[0]?.busy).toBe(false);
    });
  });

  it("finds stale turns and counts recoveries", async () => {
    await withStore("stale", async store => {
      store.createSession("s1");
      store.beginTurn("s1", "t1", "x");
      expect(store.staleTurns(60_000)).toHaveLength(0);
      // Backdate the progress marker to simulate an interruption.
      expect(store.staleTurns(-1)).toHaveLength(1);
      expect(store.countRecovery("s1", "t1")).toBe(1);
      expect(store.countRecovery("s1", "t1")).toBe(2);
    });
  });

  it("prunes only finished turns past the retention window", async () => {
    await withStore("prune", async store => {
      store.createSession("s1");
      store.beginTurn("s1", "running-one", "x");
      store.beginTurn("s1", "done-one", "y");
      store.endTurn("s1", "done-one", "completed");
      // Retention of -1 ms makes every finished row older than the cutoff.
      expect(store.pruneTurns(-1)).toBe(1);
      expect(store.turn("s1", "done-one")).toBeUndefined();
      expect(store.turn("s1", "running-one")?.status).toBe("running");
    });
  });
});

describe("sessions", () => {
  it("deletes a session with its workspace and log", async () => {
    await withStore("del", async store => {
      store.createSession("s1");
      store.append("s1", [{ turnId: "t", kind: "pi_entry", payload: 1 }]);
      store.beginTurn("s1", "t", "x");
      store.deleteSession("s1");
      expect(store.session("s1")).toBeUndefined();
      expect(store.eventsSince("s1", 0)).toHaveLength(0);
      expect(store.turn("s1", "t")).toBeUndefined();
    });
  });
});
