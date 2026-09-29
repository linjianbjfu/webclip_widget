/**
 * One Durable Object per user, holding every session that user owns.
 *
 * Addressed by `idFromName(userId)`, so all of a user's requests reach the
 * same instance and can share the subscriber hub and the live pi sessions in
 * its memory. Nothing in memory is durable: the object is evicted routinely
 * and rebuilt from SQLite.
 */

import { DurableObject } from "cloudflare:workers";

import { handle, type HandlerDeps, type StartTurn } from "./handlers.ts";
import { Hub } from "./hub.ts";
import { streamEndFrame } from "./sse.ts";
import { Store } from "./store.ts";
import { decideAlarm, KEEPALIVE_MS, STALE_MS, TURN_RETENTION_MS } from "./turns.ts";
import { initializeSchema } from "../fs/schema.ts";
import { WorkspaceFs } from "../fs/workspace-fs.ts";

export type Env = Cloudflare.Env;

export class UserAgentDO extends DurableObject<Env> {
  readonly #sql: SqlStorage;
  readonly #store: Store;
  readonly #hub = new Hub();
  readonly #workspaces = new Map<string, WorkspaceFs>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    initializeSchema(this.#sql);
    this.#store = new Store(this.#sql, body => ctx.storage.transactionSync(body));
  }

  /** Test seam: the schema handle is private but tests build their own façades. */
  get sqlForTest(): SqlStorage {
    return this.#sql;
  }

  workspace(sessionId: string): WorkspaceFs {
    let fs = this.#workspaces.get(sessionId);
    if (!fs) {
      fs = new WorkspaceFs(this.#sql, sessionId);
      this.#workspaces.set(sessionId, fs);
    }
    return fs;
  }

  override async fetch(request: Request): Promise<Response> {
    return handle(request, this.#deps());
  }

  #deps(): HandlerDeps {
    return {
      store: this.#store,
      hub: this.#hub,
      workspace: id => this.workspace(id),
      startTurn: this.#startTurn,
      newSessionId: () => crypto.randomUUID(),
      scheduleKeepalive: () => void this.#scheduleKeepalive(),
    };
  }

  /**
   * Turn execution is injected rather than imported so the HTTP surface stays
   * free of pi: the Workers test pool cannot load pi's package root.
   */
  #startTurn: StartTurn = async ({ sessionId, turnId }) => {
    const { runTurn } = await import("../agent/run-turn.ts");
    await runTurn({
      env: this.env,
      store: this.#store,
      hub: this.#hub,
      fs: this.workspace(sessionId),
      sessionId,
      turnId,
    });
  };

  /**
   * Re-arm while any turn is running.
   *
   * The firing itself is the point: an alarm is an inbound event, and inbound
   * events are what reset the object's inactivity timer. A detached turn with
   * neither an inbound request nor an alarm is killed at 70 seconds.
   */
  async #scheduleKeepalive(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }

  override async alarm(): Promise<void> {
    const stale = this.#store.staleTurns(STALE_MS);
    const decision = decideAlarm(stale, this.#store.hasRunningTurn(), Date.now());

    for (const { sessionId, turnId, reason } of decision.abandon) {
      this.#store.endTurn(sessionId, turnId, "failed");
      const rows = this.#store.append(sessionId, [
        {
          turnId,
          kind: "error",
          payload: { turnId, code: reason, message: `turn ${reason}`, retryable: true },
        },
        { turnId, kind: "turn_end", payload: { turnId, reason: "failed", out: [] } },
      ]);
      for (const row of rows) {
        this.#hub.broadcast(sessionId, {
          event: row.kind === "pi_entry" ? "entry" : row.kind,
          data: JSON.parse(row.payload) as unknown,
          seq: row.seq,
        });
      }
      this.#hub.closeAll(sessionId, streamEndFrame(false));
    }

    for (const { sessionId, turnId } of decision.resume) {
      this.#store.countRecovery(sessionId, turnId);
      void this.#startTurn({ sessionId, turnId, text: "" });
    }

    this.#store.pruneTurns(TURN_RETENTION_MS);
    if (decision.rearm) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
  }
}
