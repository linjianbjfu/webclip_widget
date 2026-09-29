/**
 * Durable Object SQLite schema.
 *
 * Every table is scoped by `session_id`: one Durable Object holds all of a
 * user's sessions, and each session is an independent clipping task that
 * writes the same paths (`source.html`, `out/widget.html`). A globally unique
 * `path` would let two live sessions overwrite each other.
 */

/** Bytes per stored chunk. Four times under the 2 MB row limit, leaving room for the row's other columns. */
export const CHUNK_BYTES = 512 * 1024;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id             TEXT PRIMARY KEY,
     title          TEXT,
     model          TEXT,
     thinking_level TEXT,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   )`,

  // The single ordered log. `seq` is the SSE `id:` and the resume cursor.
  // pi entries are one kind of record among several: out_file, turn_end and
  // error are produced by this service and pi knows nothing about them, yet
  // they need a seq to take part in resumption.
  `CREATE TABLE IF NOT EXISTS events (
     session_id TEXT    NOT NULL,
     seq        INTEGER NOT NULL,
     turn_id    TEXT    NOT NULL,
     kind       TEXT    NOT NULL,
     payload    TEXT    NOT NULL,
     PRIMARY KEY (session_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS events_pi ON events (session_id, kind, seq)`,

  // Finished turns are retained: the idempotency window answers late retries
  // from these rows. A separate cleanup path deletes them past the retention.
  `CREATE TABLE IF NOT EXISTS turns (
     session_id       TEXT    NOT NULL,
     turn_id          TEXT    NOT NULL,
     status           TEXT    NOT NULL,
     started_at       INTEGER NOT NULL,
     last_progress_at INTEGER NOT NULL,
     ended_at         INTEGER,
     prompt           TEXT    NOT NULL,
     recoveries       INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (session_id, turn_id)
   )`,
  `CREATE INDEX IF NOT EXISTS turns_by_status ON turns (session_id, status)`,

  `CREATE TABLE IF NOT EXISTS files (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT    NOT NULL,
     path       TEXT    NOT NULL,
     kind       TEXT    NOT NULL,
     size       INTEGER NOT NULL,
     mode       INTEGER NOT NULL,
     mtime      INTEGER NOT NULL,
     target     TEXT,
     UNIQUE (session_id, path)
   )`,
  `CREATE TABLE IF NOT EXISTS chunks (
     file_id INTEGER NOT NULL,
     idx     INTEGER NOT NULL,
     data    BLOB    NOT NULL,
     PRIMARY KEY (file_id, idx)
   )`,
] as const;

export function initializeSchema(sql: SqlStorage): void {
  for (const statement of STATEMENTS) sql.exec(statement);
}
