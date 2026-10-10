import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(fileURLToPath(new URL("./env.mjs", import.meta.url))).href;

async function runLoader(path, env = {}) {
  const script = `
    const { loadCliEnv } = await import(${JSON.stringify(moduleUrl)});
    loadCliEnv(process.argv[1]);
    console.log(JSON.stringify({
      SERVICE_URL: process.env.SERVICE_URL,
      GEC_API_KEY: process.env.GEC_API_KEY,
      CHROME_EXECUTABLE: process.env.CHROME_EXECUTABLE
    }));
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, path], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const [code, signal] = await once(child, "close");
  assert.equal(signal, null, stderr);
  return { code, stderr, value: stdout ? JSON.parse(stdout) : undefined };
}

test("loads a CLI env file without replacing parent environment values", async t => {
  const root = await mkdtemp(join(tmpdir(), "webclip-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, ".env");
  await writeFile(path, [
    "SERVICE_URL=https://from-file.example",
    "GEC_API_KEY=file-key",
    'CHROME_EXECUTABLE="C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe"',
  ].join("\n"));
  const result = await runLoader(path, {
    SERVICE_URL: "https://from-parent.example",
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.value, {
    SERVICE_URL: "https://from-parent.example",
    GEC_API_KEY: "file-key",
    CHROME_EXECUTABLE: "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe",
  });
});

test("ignores a missing env file and reports other read failures", async t => {
  const root = await mkdtemp(join(tmpdir(), "webclip-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = await runLoader(join(root, "missing.env"), {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
  });
  assert.equal(missing.code, 0, missing.stderr);
  assert.deepEqual(missing.value, {});

  const invalid = await runLoader(root, {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
  });
  assert.notEqual(invalid.code, 0);
});
