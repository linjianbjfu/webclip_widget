/** Own local Chrome; visible CLI browsers retain a dedicated profile, headless checks are isolated. */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/** close() is idempotent, waits for process exit and removes only temporary profiles. Explicit userDataDir is retained. */
export async function launchBrowser({
  headless = false, signal, executable = process.env.CHROME_EXECUTABLE,
  userDataDir = headless ? undefined : (process.env.WEBCLIP_BROWSER_USER_DATA_DIR || join(homedir(), ".webclip-widget", "browser-profile")),
} = {}) {
  signal?.throwIfAborted();
  const persistent = Boolean(userDataDir);
  const profile = persistent ? resolve(userDataDir) : await mkdtemp(join(tmpdir(), "webclip-browser-"));
  if (persistent) await mkdir(profile, { recursive: true });
  let child, browser, closing, closed;
  const close = () => closing ??= (async () => {
    try {
      const graceful = browser?.connected && await bounded(browser.close(), { timeout: 5_000, label: "Browser shutdown" }).then(() => true, () => false);
      // Chrome flushes cookies after acknowledging Browser.close; wait for exit before using signals.
      if (!graceful && child && child.exitCode === null && child.signalCode === null) child.kill();
      if (closed) {
        await bounded(closed, { timeout: 5_000, label: "Chrome exit" }).catch(async () => {
          child.kill("SIGKILL");
          await closed;
        });
      }
    } finally {
      if (!persistent) await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
      child.once("exit", () => reject(new Error(`Chrome exited before startup (user-data-dir: ${profile}).${persistent ? " If the directory is in use, close its Chrome or choose another user-data directory (WEBCLIP_BROWSER_USER_DATA_DIR for the CLI)." : ""} ${stderr.slice(-1000)}`)));
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
