/**
 * just-bash's `IFileSystem` backed by one session's slice of the Durable
 * Object's SQLite.
 *
 * Two properties carry the design:
 *
 * 1. **Chunking is invisible above this interface.** `readFileBuffer` joins
 *    every chunk before returning, so `grep`, `rg` and `sed` always see a
 *    whole file. Chunk size therefore cannot affect the correctness of any
 *    command — a pattern spanning a chunk boundary takes the same code path
 *    as one that does not.
 * 2. **`getAllPaths()` is synchronous.** Glob matching depends on it, and the
 *    Durable Object's `sql.exec()` returns synchronously, so the path index
 *    can be served without a promise.
 *
 * Chunks hold bytes, never text: splitting a UTF-8 string by character would
 * cut multi-byte sequences in half and corrupt the rejoined file.
 */

import { CHUNK_BYTES } from "./schema.ts";

export type FileKind = "file" | "directory" | "symlink";

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

interface FileRow extends Record<string, SqlStorageValue> {
  id: number;
  path: string;
  kind: FileKind;
  size: number;
  mode: number;
  mtime: number;
  target: string | null;
}

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;
const ROOT = "/";

/** Normalize to an absolute POSIX path with no trailing slash (except root). */
export function normalizePath(input: string): string {
  const absolute = input.startsWith("/") ? input : `/${input}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length === 0 ? ROOT : `/${parts.join("/")}`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? ROOT : path.slice(0, idx);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function fsError(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

export class WorkspaceFs {
  readonly sessionId: string;
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  /** Reassembled file contents, keyed by path. Invalidated on write. */
  readonly #cache = new Map<string, Uint8Array>();
  /** Paths under `/out` written since construction, for out_file notification. */
  readonly #outWrites = new Set<string>();

  constructor(sql: SqlStorage, sessionId: string, now: () => number = Date.now) {
    this.#sql = sql;
    this.#sessionGuard(sessionId);
    this.sessionId = sessionId;
    this.#now = now;
    this.#ensureDir(ROOT);
  }

  #sessionGuard(sessionId: string): void {
    if (sessionId.length === 0) throw new Error("WorkspaceFs requires a session id");
  }

  // -------------------------------------------------------------------------
  // Row access
  // -------------------------------------------------------------------------

  #row(path: string): FileRow | undefined {
    const rows = this.#sql
      .exec<FileRow>(
        `SELECT id, path, kind, size, mode, mtime, target FROM files WHERE session_id = ? AND path = ?`,
        this.sessionId,
        path,
      )
      .toArray();
    return rows[0];
  }

  #requireRow(path: string): FileRow {
    const row = this.#row(path);
    if (!row) throw fsError("ENOENT", `no such file or directory, '${path}'`);
    return row;
  }

  #ensureDir(path: string): void {
    if (this.#row(path)) return;
    if (path !== ROOT) this.#ensureDir(dirnameOf(path));
    this.#sql.exec(
      `INSERT OR IGNORE INTO files (session_id, path, kind, size, mode, mtime) VALUES (?, ?, 'directory', 0, ?, ?)`,
      this.sessionId,
      path,
      DEFAULT_DIR_MODE,
      this.#now(),
    );
  }

  /**
   * Resolve symlinks in the final component only. The shell's own path
   * handling walks intermediate components, so a single hop is enough here
   * and keeps the loop bound obvious.
   */
  #resolve(path: string, depth = 0): string {
    if (depth > 16) throw fsError("ELOOP", `too many symbolic links, '${path}'`);
    const row = this.#row(path);
    if (!row || row.kind !== "symlink" || row.target === null) return path;
    const target = row.target.startsWith("/")
      ? normalizePath(row.target)
      : normalizePath(`${dirnameOf(path)}/${row.target}`);
    return this.#resolve(target, depth + 1);
  }

  // -------------------------------------------------------------------------
  // Chunked content
  // -------------------------------------------------------------------------

  #readChunks(row: FileRow): Uint8Array {
    const rows = this.#sql
      .exec<{ data: ArrayBuffer }>(`SELECT data FROM chunks WHERE file_id = ? ORDER BY idx`, row.id)
      .toArray();
    const out = new Uint8Array(row.size);
    let offset = 0;
    for (const chunk of rows) {
      const bytes = new Uint8Array(chunk.data);
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return out;
  }

  #writeChunks(fileId: number, bytes: Uint8Array): void {
    this.#sql.exec(`DELETE FROM chunks WHERE file_id = ?`, fileId);
    for (let idx = 0, offset = 0; offset < bytes.byteLength; idx++, offset += CHUNK_BYTES) {
      const slice = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
      // `slice()` copies: a subarray shares its parent's buffer and SQLite
      // would otherwise be handed the whole file for every chunk.
      this.#sql.exec(
        `INSERT INTO chunks (file_id, idx, data) VALUES (?, ?, ?)`,
        fileId,
        idx,
        slice.slice().buffer,
      );
    }
  }

  // -------------------------------------------------------------------------
  // IFileSystem — reads
  // -------------------------------------------------------------------------

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const resolved = this.#resolve(normalizePath(path));
    const cached = this.#cache.get(resolved);
    if (cached) return cached;
    const row = this.#requireRow(resolved);
    if (row.kind === "directory") throw fsError("EISDIR", `illegal operation on a directory, '${path}'`);
    const bytes = this.#readChunks(row);
    this.#cache.set(resolved, bytes);
    return bytes;
  }

  async readFile(path: string, options?: { encoding?: string | null } | string): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    const encoding = typeof options === "string" ? options : (options?.encoding ?? "utf8");
    if (encoding === "binary" || encoding === "latin1") {
      let out = "";
      for (const byte of bytes) out += String.fromCharCode(byte);
      return out;
    }
    return new TextDecoder().decode(bytes);
  }

  /** latin1-shaped bytes: one char per byte, for callers that pipe bytes onward unchanged. */
  async readFileBytes(path: string): Promise<string> {
    return this.readFile(path, "binary");
  }

  async exists(path: string): Promise<boolean> {
    return this.#row(this.#resolve(normalizePath(path))) !== undefined;
  }

  async stat(path: string): Promise<FsStat> {
    return this.#statRow(this.#requireRow(this.#resolve(normalizePath(path))));
  }

  async lstat(path: string): Promise<FsStat> {
    return this.#statRow(this.#requireRow(normalizePath(path)));
  }

  #statRow(row: FileRow): FsStat {
    return {
      isFile: row.kind === "file",
      isDirectory: row.kind === "directory",
      isSymbolicLink: row.kind === "symlink",
      mode: row.mode,
      size: row.size,
      mtime: new Date(row.mtime),
    };
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithFileTypes(path)).map(entry => entry.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const dir = this.#resolve(normalizePath(path));
    const row = this.#requireRow(dir);
    if (row.kind !== "directory") throw fsError("ENOTDIR", `not a directory, '${path}'`);
    const prefix = dir === ROOT ? "/" : `${dir}/`;
    const rows = this.#sql
      .exec<{ path: string; kind: FileKind }>(
        `SELECT path, kind FROM files WHERE session_id = ? AND path LIKE ? AND path <> ? ORDER BY path`,
        this.sessionId,
        `${prefix}%`,
        dir,
      )
      .toArray();
    const entries: DirentEntry[] = [];
    for (const child of rows) {
      const rest = child.path.slice(prefix.length);
      if (rest.includes("/")) continue; // grandchild
      entries.push({
        name: rest,
        isFile: child.kind === "file",
        isDirectory: child.kind === "directory",
        isSymbolicLink: child.kind === "symlink",
      });
    }
    return entries;
  }

  async readlink(path: string): Promise<string> {
    const row = this.#requireRow(normalizePath(path));
    if (row.kind !== "symlink" || row.target === null) {
      throw fsError("EINVAL", `invalid argument, readlink '${path}'`);
    }
    return row.target;
  }

  async realpath(path: string): Promise<string> {
    const resolved = this.#resolve(normalizePath(path));
    this.#requireRow(resolved);
    return resolved;
  }

  /**
   * Synchronous by contract: just-bash's glob matching calls it inline.
   * The Durable Object's SQL API returns synchronously, which is what makes
   * this implementable at all.
   */
  getAllPaths(): string[] {
    return this.#sql
      .exec<{ path: string }>(
        `SELECT path FROM files WHERE session_id = ? AND path <> '/' ORDER BY path`,
        this.sessionId,
      )
      .toArray()
      .map(row => row.path);
  }

  resolvePath(base: string, path: string): string {
    return path.startsWith("/") ? normalizePath(path) : normalizePath(`${base}/${path}`);
  }

  // -------------------------------------------------------------------------
  // IFileSystem — writes
  // -------------------------------------------------------------------------

  async writeFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: string } | string,
  ): Promise<void> {
    const target = this.#resolve(normalizePath(path));
    const bytes = this.#toBytes(content, options);
    this.#ensureDir(dirnameOf(target));
    const existing = this.#row(target);
    if (existing?.kind === "directory") {
      throw fsError("EISDIR", `illegal operation on a directory, '${path}'`);
    }
    const now = this.#now();
    if (existing) {
      this.#sql.exec(`UPDATE files SET size = ?, mtime = ? WHERE id = ?`, bytes.byteLength, now, existing.id);
      this.#writeChunks(existing.id, bytes);
    } else {
      this.#sql.exec(
        `INSERT INTO files (session_id, path, kind, size, mode, mtime) VALUES (?, ?, 'file', ?, ?, ?)`,
        this.sessionId,
        target,
        bytes.byteLength,
        DEFAULT_FILE_MODE,
        now,
      );
      this.#writeChunks(this.#requireRow(target).id, bytes);
    }
    this.#invalidate(target);
  }

  async appendFile(
    path: string,
    content: string | Uint8Array,
    options?: { encoding?: string } | string,
  ): Promise<void> {
    const target = this.#resolve(normalizePath(path));
    const addition = this.#toBytes(content, options);
    const existing = this.#row(target);
    if (!existing) return this.writeFile(path, addition);
    const current = this.#readChunks(existing);
    const merged = new Uint8Array(current.byteLength + addition.byteLength);
    merged.set(current, 0);
    merged.set(addition, current.byteLength);
    await this.writeFile(path, merged);
  }

  #toBytes(content: string | Uint8Array, options?: { encoding?: string } | string): Uint8Array {
    if (typeof content !== "string") return content;
    const encoding = typeof options === "string" ? options : options?.encoding;
    if (encoding === "binary" || encoding === "latin1") {
      const out = new Uint8Array(content.length);
      for (let i = 0; i < content.length; i++) out[i] = content.charCodeAt(i) & 0xff;
      return out;
    }
    if (encoding === "base64") {
      const binary = atob(content);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(content);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const target = normalizePath(path);
    if (this.#row(target)) {
      if (options?.recursive) return;
      throw fsError("EEXIST", `file already exists, mkdir '${path}'`);
    }
    if (!options?.recursive && !this.#row(dirnameOf(target))) {
      throw fsError("ENOENT", `no such file or directory, mkdir '${path}'`);
    }
    this.#ensureDir(target);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const target = normalizePath(path);
    const row = this.#row(target);
    if (!row) {
      if (options?.force) return;
      throw fsError("ENOENT", `no such file or directory, rm '${path}'`);
    }
    if (row.kind === "directory") {
      const children = await this.readdirWithFileTypes(target);
      if (children.length > 0 && !options?.recursive) {
        throw fsError("ENOTEMPTY", `directory not empty, rm '${path}'`);
      }
      const prefix = target === ROOT ? "/" : `${target}/`;
      const descendants = this.#sql
        .exec<{ id: number; path: string }>(
          `SELECT id, path FROM files WHERE session_id = ? AND path LIKE ?`,
          this.sessionId,
          `${prefix}%`,
        )
        .toArray();
      for (const child of descendants) {
        this.#sql.exec(`DELETE FROM chunks WHERE file_id = ?`, child.id);
        this.#invalidate(child.path);
      }
      this.#sql.exec(
        `DELETE FROM files WHERE session_id = ? AND path LIKE ?`,
        this.sessionId,
        `${prefix}%`,
      );
    } else {
      this.#sql.exec(`DELETE FROM chunks WHERE file_id = ?`, row.id);
    }
    this.#sql.exec(`DELETE FROM files WHERE id = ?`, row.id);
    this.#invalidate(target);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const from = this.#resolve(normalizePath(src));
    const row = this.#requireRow(from);
    if (row.kind === "directory") {
      if (!options?.recursive) throw fsError("EISDIR", `illegal operation on a directory, cp '${src}'`);
      const to = normalizePath(dest);
      this.#ensureDir(to);
      for (const entry of await this.readdirWithFileTypes(from)) {
        await this.cp(`${from}/${entry.name}`, `${to}/${entry.name}`, options);
      }
      return;
    }
    await this.writeFile(dest, await this.readFileBuffer(from));
  }

  async mv(src: string, dest: string): Promise<void> {
    const from = normalizePath(src);
    const to = normalizePath(dest);
    const row = this.#requireRow(from);
    this.#ensureDir(dirnameOf(to));
    const existing = this.#row(to);
    if (existing) await this.rm(to, { recursive: true, force: true });
    if (row.kind === "directory") {
      const prefix = `${from}/`;
      const descendants = this.#sql
        .exec<{ id: number; path: string }>(
          `SELECT id, path FROM files WHERE session_id = ? AND path LIKE ?`,
          this.sessionId,
          `${prefix}%`,
        )
        .toArray();
      for (const child of descendants) {
        const moved = `${to}/${child.path.slice(prefix.length)}`;
        this.#sql.exec(`UPDATE files SET path = ? WHERE id = ?`, moved, child.id);
        this.#invalidate(child.path);
        this.#invalidate(moved);
      }
    }
    this.#sql.exec(`UPDATE files SET path = ?, mtime = ? WHERE id = ?`, to, this.#now(), row.id);
    this.#invalidate(from);
    this.#invalidate(to);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const row = this.#requireRow(this.#resolve(normalizePath(path)));
    this.#sql.exec(`UPDATE files SET mode = ? WHERE id = ?`, mode, row.id);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const link = normalizePath(linkPath);
    if (this.#row(link)) throw fsError("EEXIST", `file already exists, symlink '${linkPath}'`);
    this.#ensureDir(dirnameOf(link));
    this.#sql.exec(
      `INSERT INTO files (session_id, path, kind, size, mode, mtime, target) VALUES (?, ?, 'symlink', 0, ?, ?, ?)`,
      this.sessionId,
      link,
      DEFAULT_FILE_MODE,
      this.#now(),
      target,
    );
  }

  /**
   * Hard links have no representation in this store: a row is identified by
   * its path, so two names cannot share one inode. Fail loudly rather than
   * silently producing a copy that diverges on the next write.
   */
  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw fsError("ENOSYS", "hard links are not supported");
  }

  /** The store has no atime/mtime columns a caller may set; accepted and ignored. */
  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {}

  // -------------------------------------------------------------------------
  // Out-directory notification
  // -------------------------------------------------------------------------

  #invalidate(path: string): void {
    this.#cache.delete(path);
    if (path.startsWith("/out/")) this.#outWrites.add(path);
  }

  /**
   * Paths under `/out` written since the last drain.
   *
   * Notification hangs off the filesystem rather than the tool layer because
   * the agent does not necessarily write through the `write` tool: a shell
   * redirect (`sed … > out/extra.js`) produces no tool call at all, and
   * `edit`'s arguments are old/new fragments a client cannot rebuild a file
   * from. Every write path funnels through here.
   */
  drainOutWrites(): string[] {
    const paths = [...this.#outWrites].sort();
    this.#outWrites.clear();
    return paths;
  }
}
