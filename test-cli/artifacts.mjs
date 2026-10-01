/** Validate live SSE artifacts and save the current widget in its session folder. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { parseWidgetMeta, validateWidgetPaths } from "../backend/src/widget-contract.ts";

function component(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`Invalid ${label} for artifact folder`);
  }
  return value;
}

export function validateArtifacts(out) {
  if (!Array.isArray(out)) throw new Error("turn_end.out must be an array");
  validateWidgetPaths(out.map(file => file?.path));
  for (const file of out) {
    if (typeof file.content !== "string") {
      throw new Error(`${file.path}: content unavailable; historical events cannot restore files`);
    }
    const bytes = Buffer.from(file.content, "utf8");
    if (bytes.length !== file.bytes) throw new Error(`${file.path}: byte count mismatch`);
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`${file.path}: sha256 mismatch`);
    }
  }
  parseWidgetMeta(out.find(file => file.path === "out/meta.json").content);
  return out;
}

/** Validate and stage all files before replacing each artifact; unrelated files are preserved. */
export async function saveArtifacts({ sessionId, out, root = resolve("downloads") }) {
  const files = validateArtifacts(out);
  const target = join(root, component(sessionId, "sessionId"));
  await mkdir(root, { recursive: true });
  const lock = `${target}.lock`;
  await mkdir(lock);
  let staging;
  try {
    staging = await mkdtemp(join(root, ".widget-"));
    // Finish staging before touching existing artifacts. Each rename replaces one whole file.
    for (const file of files) await writeFile(join(staging, basename(file.path)), file.content, { flag: "wx" });
    await mkdir(target, { recursive: true });
    for (const file of files) await rename(join(staging, basename(file.path)), join(target, basename(file.path)));
    return target;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

/** Only the requested turn can complete prompt/chat; events also accepts live followed turns. */
export function artifactReceiver({ sessionId, turnId, root, report = console.log, warn = console.error }) {
  let completed = false;
  return {
    async onFrame(frame) {
      if (frame.event !== "turn_end" || (turnId !== undefined && frame.data?.turnId !== turnId)) return;
      const data = frame.data;
      completed = true;
      if (data.reason !== "completed") {
        if (turnId !== undefined) throw new Error(`Turn ${data.reason}; no widget saved`);
        return;
      }
      if (Array.isArray(data.out) && data.out.length === 0) return;
      if (turnId === undefined && Array.isArray(data.out) && data.out.length > 0
        && data.out.every(file => file.content === undefined)) {
        warn(`Turn ${data.turnId}: historical content unavailable; no widget saved`);
        return;
      }
      const folder = await saveArtifacts({ sessionId, out: data.out, ...(root ? { root } : {}) });
      report(`Saved widget: ${folder}`);
    },
    finish() {
      if (turnId !== undefined && !completed) throw new Error("Stream ended before the requested turn completed; no widget saved");
    },
  };
}
