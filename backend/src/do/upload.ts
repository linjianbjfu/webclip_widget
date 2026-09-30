/**
 * Accepting the captured page.
 *
 * The first turn arrives as `multipart/form-data` so the source and the
 * screenshot travel as binary parts rather than base64 inside JSON, which
 * would inflate a multi-megabyte page by a third. Parts may be gzipped:
 * `DecompressionStream` is native to Workers, whereas a zip container would
 * need its central directory parsed and a dependency to do it. Several files
 * ride in one multipart body, so no archive format is needed on top.
 *
 * Inbound request bodies are capped at 100 MB on the Free and Pro plans,
 * which the expected input — a page of a few megabytes and one screenshot —
 * is nowhere near.
 */

import type { WorkspaceFs } from "../fs/workspace-fs.ts";

export interface UploadedFile {
  name: string;
  bytes: number;
}

export interface ParsedPrompt {
  turnId: string;
  text: string;
  since: number;
  files: UploadedFile[];
}

async function gunzip(data: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Strip any directory component: an uploaded name must not escape the workspace root. */
function safeName(raw: string): string {
  const base = raw.split("/").pop()?.split("\\").pop() ?? "";
  return base.replace(/^\.+/, "").slice(0, 120);
}

export async function parseMultipartPrompt(
  request: Request,
  fs: WorkspaceFs,
): Promise<ParsedPrompt> {
  const form = await request.formData();
  const turnId = String(form.get("turnId") ?? "");
  const text = String(form.get("text") ?? "");
  const since = Number(form.get("since") ?? "0");

  const files: UploadedFile[] = [];
  for (const entry of form.getAll("file")) {
    if (typeof entry === "string") continue;
    const name = safeName(entry.name);
    if (name.length === 0) continue;
    const raw = await entry.arrayBuffer();
    // The part declares its own encoding; the body is stored decoded so every
    // later reader — grep included — sees the real bytes.
    const gzipped = name.endsWith(".gz") || entry.type === "application/gzip";
    const bytes = gzipped ? await gunzip(raw) : new Uint8Array(raw);
    const storedName = gzipped && name.endsWith(".gz") ? name.slice(0, -3) : name;
    await fs.writeFile(`/${storedName}`, bytes);
    files.push({ name: storedName, bytes: bytes.byteLength });
  }

  return { turnId, text, since: Number.isFinite(since) ? since : 0, files };
}

export function isMultipart(request: Request): boolean {
  return (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}
