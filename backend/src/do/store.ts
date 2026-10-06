/**
 * Session, turn and event-log access over the Durable Object's SQLite.
 *
 * `events` is the single ordered log and `seq` is both the SSE `id:` and the
 * resume cursor. pi entries are one `kind` among several: `out_file`,
 * `turn_end` and `error` are produced here and pi knows nothing about them,
 * yet they need a seq to take part in resumption. Rebuilding a pi session
 * therefore reads `kind = 'pi_entry'` only, while resumption reads everything.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { CHUNK_BYTES } from '../fs/schema.ts';
import type { Capture } from '../capture.ts';

export interface InputFile { name: string; data: Uint8Array }
interface FileReference { name: string; blob: string }

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
    this.#sql.exec(`DELETE FROM input_chunks WHERE session_id = ?`, id);
    this.#sql.exec(`DELETE FROM input_blobs WHERE session_id = ?`, id);
    this.#sql.exec(`DELETE FROM turn_inputs WHERE session_id = ?`, id);
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

  /** Atomically accept immutable decoded inputs and reserve the turn before any workspace writes. */
  acceptTurn(sessionId: string, turnId: string, prompt: string, files: InputFile[], capture: Capture | null): void {
    this.#transaction(() => {
      const refs = files.map(file => ({ name: file.name, blob: this.#putBlob(sessionId, file.data) }));
      this.beginTurn(sessionId, turnId, prompt);
      this.#sql.exec('INSERT INTO turn_inputs (session_id,turn_id,capture,files) VALUES (?,?,?,?)', sessionId, turnId, capture ? JSON.stringify(capture) : null, JSON.stringify(refs));
    });
  }

  turnInput(sessionId: string, turnId: string): { capture: Capture | null; files: InputFile[] } {
    const row = this.#sql.exec<{capture: string | null; files: string}>('SELECT capture,files FROM turn_inputs WHERE session_id=? AND turn_id=?', sessionId, turnId).toArray()[0];
    return row ? { capture: row.capture ? JSON.parse(row.capture) as Capture : null,
      files: (JSON.parse(row.files) as FileReference[]).map(file => ({name: file.name, data: this.#getBlob(sessionId, file.blob)})) } : {capture: null, files: []};
  }

  #putBlob(sessionId: string, bytes: Uint8Array): string {
    const id = createHash('sha256').update(bytes).digest('hex');
    if (!this.#sql.exec('SELECT id FROM input_blobs WHERE session_id=? AND id=?', sessionId, id).toArray().length) {
      this.#sql.exec('INSERT INTO input_blobs (session_id,id,bytes) VALUES (?,?,?)', sessionId, id, bytes.length);
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        this.#sql.exec('INSERT INTO input_chunks (session_id,blob_id,idx,data) VALUES (?,?,?,?)', sessionId, id, offset / CHUNK_BYTES, bytes.slice(offset, offset + CHUNK_BYTES));
      }
    }
    return id;
  }

  #getBlob(sessionId: string, id: string): Uint8Array {
    const row = this.#sql.exec<{bytes: number}>('SELECT bytes FROM input_blobs WHERE session_id=? AND id=?', sessionId, id).toArray()[0];
    if (!row) throw new Error('Missing persisted image/input blob');
    const bytes = new Uint8Array(row.bytes);
    const chunks = this.#sql.exec<{data: ArrayBuffer; idx: number}>('SELECT idx,data FROM input_chunks WHERE session_id=? AND blob_id=? ORDER BY idx', sessionId, id).toArray();
    for (const chunk of chunks) bytes.set(new Uint8Array(chunk.data), chunk.idx * CHUNK_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== id) throw new Error('Persisted image/input integrity mismatch');
    return bytes;
  }

  #imageReferences(sessionId: string, payload: unknown): string {
    return JSON.stringify(payload, (_key, value: unknown) => {
      if (value && typeof value === 'object' && 'type' in value && value.type === 'image'
        && 'data' in value && typeof value.data === 'string' && 'mimeType' in value && typeof value.mimeType === 'string') {
        const {data, ...rest} = value;
        const bytes = Buffer.from(data, 'base64');
        return {...rest, type: 'image_ref', version: 1, sha256: this.#putBlob(sessionId, bytes), bytes: bytes.length};
      }
      return value;
    });
  }

  #restoreImages(sessionId: string, payload: string): unknown {
    return JSON.parse(payload, (_key, value: unknown) => {
      if (value && typeof value === 'object' && 'type' in value && value.type === 'image_ref' && 'version' in value && value.version === 1
        && 'sha256' in value && typeof value.sha256 === 'string') {
        const {sha256, version, bytes, ...rest} = value as Record<string, unknown> & {sha256: string};
        return {...rest, type: 'image', data: Buffer.from(this.#getBlob(sessionId, sha256)).toString('base64')};
      }
      return value;
    });
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
    this.#sql.exec(`DELETE FROM turn_inputs WHERE EXISTS (SELECT 1 FROM turns WHERE turns.session_id=turn_inputs.session_id AND turns.turn_id=turn_inputs.turn_id AND status <> 'running' AND ended_at < ?)`, cutoff);
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
        const payload = input.kind === 'pi_entry' ? this.#imageReferences(sessionId, input.payload) : JSON.stringify(input.payload);
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

  /**
   * Pi entries with image references restored, in order, for rebuilding model context.
   *
   * `excludeTurn` drops one turn's records. Resuming an interrupted turn needs
   * this: `AgentSession.prompt()` is the only way to drive the loop and it
   * appends the user message, so replaying a turn whose message is already in
   * the log would show it twice. The records stay in the log, which is what
   * clients mirror; the model's context is derived and may legitimately differ.
   */
  piEntries(sessionId: string, excludeTurn?: string): Array<{ seq: number; entry: unknown }> {
    const rows =
      excludeTurn === undefined
        ? this.#sql.exec<{ seq: number; payload: string }>(
            `SELECT seq, payload FROM events
             WHERE session_id = ? AND kind = 'pi_entry' ORDER BY seq`,
            sessionId,
          )
        : this.#sql.exec<{ seq: number; payload: string }>(
            `SELECT seq, payload FROM events
             WHERE session_id = ? AND kind = 'pi_entry' AND turn_id <> ? ORDER BY seq`,
            sessionId,
            excludeTurn,
          );
    return rows.toArray().map(row => ({ seq: row.seq, entry: this.#restoreImages(sessionId, row.payload) }));
  }
}
