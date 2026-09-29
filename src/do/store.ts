/**
 * Session, turn and event-log access over the Durable Object's SQLite.
 *
 * `events` is the single ordered log and `seq` is both the SSE `id:` and the
 * resume cursor. pi entries are one `kind` among several: `out_file`,
 * `turn_end` and `error` are produced here and pi knows nothing about them,
 * yet they need a seq to take part in resumption. Rebuilding a pi session
 * therefore reads `kind = 'pi_entry'` only, while resumption reads everything.
 */

export type EventKind = "pi_entry" | "out_file" | "turn_end" | "error";
export type TurnStatus = "running" | "completed" | "aborted" | "failed";

export interface SessionRow extends Record<string, SqlStorageValue> {
  id: string;
  title: string | null;
  model: string | null;
  thinking_level: string | null;
  created_at: number;
  updated_at: number;
}

export interface TurnRow extends Record<string, SqlStorageValue> {
  session_id: string;
  turn_id: string;
  status: TurnStatus;
  started_at: number;
  last_progress_at: number;
  ended_at: number | null;
  prompt: string;
  recoveries: number;
}

/** A session as the client sees it: stored columns plus a derived busy flag. */
export interface SessionSummary {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
  busy: boolean;
}

export interface EventRow extends Record<string, SqlStorageValue> {
  seq: number;
  turn_id: string;
  kind: EventKind;
  payload: string;
}

export interface AppendInput {
  turnId: string;
  kind: EventKind;
  payload: unknown;
}

export class Store {
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  readonly #transaction: <T>(body: () => T) => T;

  /**
   * `transaction` must be the Durable Object's `storage.transactionSync`.
   * SQL `BEGIN` is rejected outright by the platform: the JavaScript API
   * rolls back on exception and interacts correctly with the object's
   * automatic write coalescing, which a bare `BEGIN` would bypass.
   */
  constructor(
    sql: SqlStorage,
    transaction: <T>(body: () => T) => T,
    now: () => number = Date.now,
  ) {
    this.#sql = sql;
    this.#transaction = transaction;
    this.#now = now;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  createSession(id: string, title?: string): SessionRow {
    const now = this.#now();
    this.#sql.exec(
      `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      id,
      title ?? null,
      now,
      now,
    );
    return this.session(id)!;
  }

  session(id: string): SessionRow | undefined {
    return this.#sql.exec<SessionRow>(`SELECT * FROM sessions WHERE id = ?`, id).toArray()[0];
  }

  /**
   * Sessions with a derived busy flag.
   *
   * Busy is computed from `turns`, never stored on the session. A duplicated
   * column would drift, and the symptom of drift is a session stuck as busy
   * that can never accept another prompt.
   */
  listSessions(): SessionSummary[] {
    const sessions = this.#sql
      .exec<SessionRow>(`SELECT * FROM sessions ORDER BY updated_at DESC`)
      .toArray();
    const busy = new Set(
      this.#sql
        .exec<{ session_id: string }>(`SELECT DISTINCT session_id FROM turns WHERE status = 'running'`)
        .toArray()
        .map(row => row.session_id),
    );
    return sessions.map(session => ({
      id: session.id,
      title: session.title,
      model: session.model,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      busy: busy.has(session.id),
    }));
  }

  deleteSession(id: string): void {
    this.#transaction(() => this.#deleteSessionRows(id));
  }

  #deleteSessionRows(id: string): void {
    const files = this.#sql
      .exec<{ id: number }>(`SELECT id FROM files WHERE session_id = ?`, id)
      .toArray();
    for (const file of files) this.#sql.exec(`DELETE FROM chunks WHERE file_id = ?`, file.id);
    this.#sql.exec(`DELETE FROM files WHERE session_id = ?`, id);
    this.#sql.exec(`DELETE FROM events WHERE session_id = ?`, id);
    this.#sql.exec(`DELETE FROM turns WHERE session_id = ?`, id);
    this.#sql.exec(`DELETE FROM sessions WHERE id = ?`, id);
  }

  touchSession(id: string): void {
    this.#sql.exec(`UPDATE sessions SET updated_at = ? WHERE id = ?`, this.#now(), id);
  }

  setSessionModel(id: string, model: string, thinkingLevel: string): void {
    this.#sql.exec(
      `UPDATE sessions SET model = ?, thinking_level = ?, updated_at = ? WHERE id = ?`,
      model,
      thinkingLevel,
      this.#now(),
      id,
    );
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  turn(sessionId: string, turnId: string): TurnRow | undefined {
    return this.#sql
      .exec<TurnRow>(`SELECT * FROM turns WHERE session_id = ? AND turn_id = ?`, sessionId, turnId)
      .toArray()[0];
  }

  runningTurn(sessionId: string): TurnRow | undefined {
    return this.#sql
      .exec<TurnRow>(`SELECT * FROM turns WHERE session_id = ? AND status = 'running'`, sessionId)
      .toArray()[0];
  }

  /** Any session with work in flight, used to decide whether to re-arm the keepalive alarm. */
  hasRunningTurn(): boolean {
    return this.#sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM turns WHERE status = 'running'`)
      .toArray()[0]!.n > 0;
  }

  beginTurn(sessionId: string, turnId: string, prompt: string): TurnRow {
    const now = this.#now();
    this.#sql.exec(
      `INSERT INTO turns (session_id, turn_id, status, started_at, last_progress_at, prompt)
       VALUES (?, ?, 'running', ?, ?, ?)`,
      sessionId,
      turnId,
      now,
      now,
      prompt,
    );
    return this.turn(sessionId, turnId)!;
  }

  markProgress(sessionId: string, turnId: string): void {
    this.#sql.exec(
      `UPDATE turns SET last_progress_at = ? WHERE session_id = ? AND turn_id = ?`,
      this.#now(),
      sessionId,
      turnId,
    );
  }

  /**
   * Close a turn by status rather than deleting the row: the idempotency
   * window answers late retries from finished rows. A separate cleanup path
   * removes them past the retention period.
   */
  endTurn(sessionId: string, turnId: string, status: Exclude<TurnStatus, "running">): void {
    this.#sql.exec(
      `UPDATE turns SET status = ?, ended_at = ? WHERE session_id = ? AND turn_id = ?`,
      status,
      this.#now(),
      sessionId,
      turnId,
    );
    this.touchSession(sessionId);
  }

  countRecovery(sessionId: string, turnId: string): number {
    this.#sql.exec(
      `UPDATE turns SET recoveries = recoveries + 1, last_progress_at = ? WHERE session_id = ? AND turn_id = ?`,
      this.#now(),
      sessionId,
      turnId,
    );
    return this.turn(sessionId, turnId)?.recoveries ?? 0;
  }

  /** Turns whose last progress is older than `staleMs`, i.e. interrupted. */
  staleTurns(staleMs: number): TurnRow[] {
    return this.#sql
      .exec<TurnRow>(
        `SELECT * FROM turns WHERE status = 'running' AND last_progress_at < ?`,
        this.#now() - staleMs,
      )
      .toArray();
  }

  /** Drop finished turns past the idempotency retention window. */
  pruneTurns(retentionMs: number): number {
    const cutoff = this.#now() - retentionMs;
    const doomed = this.#sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM turns WHERE status <> 'running' AND ended_at IS NOT NULL AND ended_at < ?`,
        cutoff,
      )
      .toArray()[0]!.n;
    this.#sql.exec(
      `DELETE FROM turns WHERE status <> 'running' AND ended_at IS NOT NULL AND ended_at < ?`,
      cutoff,
    );
    return doomed;
  }

  // -------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------

  lastSeq(sessionId: string): number {
    return (
      this.#sql
        .exec<{ seq: number | null }>(
          `SELECT MAX(seq) AS seq FROM events WHERE session_id = ?`,
          sessionId,
        )
        .toArray()[0]?.seq ?? 0
    );
  }

  /**
   * Append a batch as one transaction.
   *
   * All-or-nothing matters because a Durable Object is terminated without
   * warning: a half-written batch would leave the log describing a message
   * that never completed.
   */
  append(sessionId: string, inputs: readonly AppendInput[]): EventRow[] {
    if (inputs.length === 0) return [];
    return this.#transaction(() => {
      const written: EventRow[] = [];
      let seq = this.lastSeq(sessionId);
      for (const input of inputs) {
        seq += 1;
        // Serialize before inserting: a payload that cannot be stringified
        // must abort the whole batch, not leave earlier rows behind.
        const payload = JSON.stringify(input.payload);
        this.#sql.exec(
          `INSERT INTO events (session_id, seq, turn_id, kind, payload) VALUES (?, ?, ?, ?, ?)`,
          sessionId,
          seq,
          input.turnId,
          input.kind,
          payload,
        );
        written.push({ seq, turn_id: input.turnId, kind: input.kind, payload });
      }
      return written;
    });
  }

  eventsSince(sessionId: string, since: number): EventRow[] {
    return this.#sql
      .exec<EventRow>(
        `SELECT seq, turn_id, kind, payload FROM events
         WHERE session_id = ? AND seq > ? ORDER BY seq`,
        sessionId,
        since,
      )
      .toArray();
  }

  /** Raw pi entries, in order — the only input to rebuilding a session's context. */
  piEntries(sessionId: string): Array<{ seq: number; entry: unknown }> {
    return this.#sql
      .exec<{ seq: number; payload: string }>(
        `SELECT seq, payload FROM events
         WHERE session_id = ? AND kind = 'pi_entry' ORDER BY seq`,
        sessionId,
      )
      .toArray()
      .map(row => ({ seq: row.seq, entry: JSON.parse(row.payload) as unknown }));
  }
}
