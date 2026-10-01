import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactReceiver, saveArtifacts, validateArtifacts } from "./artifacts.mjs";

export function bundle(value = 0) {
  return [
    ["extra.js", `(() => ({value: ${value}}))()`],
    ["widget.html", `<!doctype html><p>数值 ${value}</p>`],
    ["meta.json", JSON.stringify({size: value === 0 ? "small" : "middle"})],
  ].map(([name, content]) => ({ path: `out/${name}`, content, bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex") }));
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "webclip-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("creates a session folder and replaces all artifacts while preserving runtime files", async t => {
  const root = await temporary(t);
  const out = bundle();
  const folder = await saveArtifacts({ root, sessionId: "session", out });
  assert.equal(folder, join(root, "session"));
  for (const file of out) assert.equal(await readFile(join(folder, file.path.slice(4)), "utf8"), file.content);
  await writeFile(join(folder, "data.json"), '{"value":42}');
  await writeFile(join(folder, "notes.txt"), "keep");
  await mkdir(join(folder, "old-turn"));
  await writeFile(join(folder, "widget.html"), "local edit");
  const next = bundle(7);
  assert.equal(await saveArtifacts({ root, sessionId: "session", out: next }), folder);
  for (const file of next) assert.equal(await readFile(join(folder, file.path.slice(4)), "utf8"), file.content);
  assert.equal(await readFile(join(folder, "data.json"), "utf8"), '{"value":42}');
  assert.equal(await readFile(join(folder, "notes.txt"), "utf8"), "keep");
  assert.deepEqual((await readdir(folder)).sort(), ["data.json", "extra.js", "meta.json", "notes.txt", "old-turn", "widget.html"]);
  assert.deepEqual(await readdir(root), ["session"]);
  assert.equal(await saveArtifacts({ root, sessionId: "session", out: next }), folder);
  const corrupt = next.map(file => ({ ...file, sha256: "bad" }));
  await assert.rejects(saveArtifacts({ root, sessionId: "session", out: corrupt }), /sha256 mismatch/);
  for (const file of next) assert.equal(await readFile(join(folder, file.path.slice(4)), "utf8"), file.content);
});

test("rejects incomplete, corrupt or unsafe bundles before creating output", async t => {
  const root = await temporary(t);
  const cases = [
    bundle().slice(1), [...bundle(), bundle()[0]],
    bundle().map((f, i) => i ? f : { ...f, path: "../extra.js" }),
    bundle().map((f, i) => i ? f : { ...f, content: undefined }),
    bundle().map((f, i) => i ? f : { ...f, bytes: 0 }),
    bundle().map((f, i) => i ? f : { ...f, sha256: "bad" }),
    bundle().map(f => f.path.endsWith("meta.json") ? {
      ...f, content: '{"size":"wrong"}', bytes: 16,
      sha256: createHash("sha256").update('{"size":"wrong"}').digest("hex"),
    } : f),
  ];
  for (const out of cases) {
    assert.throws(() => validateArtifacts(out));
    await assert.rejects(saveArtifacts({ root, sessionId: "session", out }));
  }
  await assert.rejects(saveArtifacts({ root, sessionId: "../escape", out: bundle() }));
  assert.deepEqual(await readdir(root), []);
});

test("filesystem failure cleans staging and lock without reporting success", async t => {
  const root = await temporary(t);
  await writeFile(join(root, "blocked"), "file");
  await assert.rejects(saveArtifacts({ root, sessionId: "blocked", out: bundle() }));
  assert.deepEqual(await readdir(root), ["blocked"]);
  assert.equal(await readFile(join(root, "blocked"), "utf8"), "file");
});

test("receiver selects current turn, distinguishes history and refuses premature or failed completion", async t => {
  const root = await temporary(t);
  const messages = [];
  const opts = { root, sessionId: "session", report: text => messages.push(text), warn: text => messages.push(text) };
  const current = artifactReceiver({ ...opts, turnId: "current" });
  await current.onFrame({ event: "turn_end", data: { turnId: "old", reason: "completed", out: bundle() } });
  assert.throws(() => current.finish(), /before/);
  await current.onFrame({ event: "turn_end", data: { turnId: "current", reason: "completed", out: bundle() } });
  current.finish();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Saved widget:/);
  for (const reason of ["failed", "aborted"]) {
    const receiver = artifactReceiver({ ...opts, turnId: reason });
    await assert.rejects(receiver.onFrame({ event: "turn_end", data: { turnId: reason, reason, out: [] } }), /no widget saved/);
  }
  const events = artifactReceiver(opts);
  await events.onFrame({ event: "turn_end", data: { turnId: "history", reason: "completed",
    out: bundle().map(({ content, ...f }) => f) } });
  assert.match(messages.at(-1), /historical content unavailable/);
  await events.onFrame({ event: "turn_end", data: { turnId: "live", reason: "completed", out: bundle(9) } });
  assert.deepEqual((await readdir(join(root, "session"))).sort(), ["extra.js", "meta.json", "widget.html"]);
  assert.equal(await readFile(join(root, "session", "widget.html"), "utf8"), bundle(9)[1].content);
  const chat = artifactReceiver({ ...opts, turnId: "chat" });
  await chat.onFrame({ event: "turn_end", data: { turnId: "chat", reason: "completed", out: [] } });
  chat.finish();
  assert.deepEqual((await readdir(join(root, "session"))).sort(), ["extra.js", "meta.json", "widget.html"]);
  assert.equal(await readFile(join(root, "session", "widget.html"), "utf8"), bundle(9)[1].content);
});
