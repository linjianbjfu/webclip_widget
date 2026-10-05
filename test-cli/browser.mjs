/** Own a local Chrome process and temporary profile for CLI previews and browser tests. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "@cloudflare/puppeteer";

/** Bounds a browser operation; callers close the owned browser to cancel timed-out work. */
export async function bounded(operation, { signal, timeout = 30_000, label = "Browser operation" } = {}) {
  let timer, abort;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
        abort = () => reject(signal.reason ?? new Error("Preview stopped"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

/** close() is idempotent and waits for process exit before removing its profile. */
export async function launchBrowser({ headless = false, signal, executable = process.env.CHROME_EXECUTABLE } = {}) {
  signal?.throwIfAborted();
  const profile = await mkdtemp(join(tmpdir(), "webclip-browser-"));
  let child, browser, closing, closed;
  const close = () => closing ??= (async () => {
    try {
      if (browser?.connected) await bounded(browser.close(), { timeout: 5_000, label: "Browser shutdown" }).catch(() => {});
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      if (closed) {
        await bounded(closed, { timeout: 5_000, label: "Chrome exit" }).catch(async () => {
          child.kill("SIGKILL");
          await closed;
        });
      }
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  })();
  const abortProcess = () => child?.kill();
  try {
    signal?.throwIfAborted();
    const path = executable ?? (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "chromium");
    child = spawn(path, [
      ...(headless ? ["--headless"] : []), "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    closed = new Promise(resolve => child.once("close", resolve));
    // Chrome helpers can retain inherited stderr after the browser exits. Release our read end
    // so process cleanup does not wait for unrelated updater/crash-reporting lifetimes.
    child.once("exit", () => child.stderr.destroy());
    signal?.addEventListener("abort", abortProcess, { once: true });
    const endpoint = await bounded(new Promise((resolve, reject) => {
      let stderr = "";
      child.once("error", error => reject(new Error(`Cannot start Chrome (${path}): ${error.message}. Set CHROME_EXECUTABLE to a Chrome/Chromium executable.`)));
      child.once("exit", () => reject(new Error(`Chrome exited before startup: ${stderr.slice(-1000)}`)));
      child.stderr.on("data", bytes => {
        stderr = (stderr + bytes.toString()).slice(-8000);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) resolve(match[1]);
      });
    }), { signal, label: "Chrome startup" });
    // Keep the connection promise owned even if cancellation arrives while connecting.
    browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 30_000 });
    signal?.throwIfAborted();
    return { browser, close, closed, profile, pid: child.pid };
  } catch (error) {
    await close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortProcess);
  }
}
