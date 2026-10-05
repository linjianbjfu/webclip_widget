/** Reproduce the client's source-page extraction and local HTTP widget display. */
import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { extractionExpression } from "../backend/src/agent/extraction.ts";
import { parseWidgetMeta, WIDGET_SIZES } from "../backend/src/widget-contract.ts";
import { bounded, launchBrowser } from "./browser.mjs";
import { startPreviewServer } from "./preview-server.mjs";

export const SOURCE_WAIT_MS = 3_000;
export const PREVIEW_USAGE = 'usage: webclip preview --source <source.html> --out <widget-directory>';

export function parsePreviewArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name !== '--source' && name !== '--out') throw new Error(`Unknown preview argument: ${name}\n${PREVIEW_USAGE}`);
    const key = name.slice(2);
    if (options[key] !== undefined) throw new Error(`Duplicate preview argument: ${name}\n${PREVIEW_USAGE}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a path\n${PREVIEW_USAGE}`);
    options[key] = resolve(value);
  }
  if (!options.source || !options.out) throw new Error(PREVIEW_USAGE);
  return options;
}

export async function previewInputs({ source, out }) {
  const sourcePath = await realpath(source);
  const directory = await realpath(out);
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a widget directory: ${out}`);
  for (const path of [sourcePath, ...['extra.js', 'widget.html', 'meta.json'].map(name => join(directory, name))]) {
    if (!(await stat(path)).isFile()) throw new Error(`Expected a file: ${path}`);
  }
  const meta = parseWidgetMeta(await readFile(join(directory, 'meta.json'), 'utf8'));
  const extra = await readFile(join(directory, 'extra.js'), 'utf8');
  return { source: sourcePath, out: directory, extra, size: meta.size };
}

/** Preserves existing data on validation, staging or rename failure. */
export async function writePreviewData(out, json, signal) {
  signal?.throwIfAborted();
  const staging = await mkdtemp(join(out, '.data-'));
  try {
    const file = join(staging, 'data.json');
    await writeFile(file, `${json}\n`, { flag: 'wx' });
    signal?.throwIfAborted();
    const target = join(out, 'data.json');
    await rename(file, target);
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The fixed delay starts after load, and stays interruptible. */
export async function loadAndExtract(page, input, { signal, wait = delay, report = console.log } = {}) {
  await bounded(page.goto(pathToFileURL(input.source).href, { waitUntil: 'load', timeout: 30_000 }), { signal, label: 'Source loading' });
  report('Source loaded; waiting 3 seconds before extraction.');
  await wait(SOURCE_WAIT_MS, undefined, { signal });
  signal?.throwIfAborted();
  return bounded(page.evaluate(extractionExpression(input.extra)), { signal, label: 'extra.js execution' });
}

/** Owns all resources until abort, browser closure or widget-tab closure. */
export async function runLocalPreview(options, { signal, headless = false, report = console.log, onReady } = {}) {
  const stop = new AbortController();
  const cancel = () => stop.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let owned, server, sourcePage, widgetPage;
  const stopped = new Promise(resolve => stop.signal.addEventListener('abort', resolve, { once: true }));
  try {
    stop.signal.throwIfAborted();
    const input = await previewInputs(options);
    stop.signal.throwIfAborted();
    owned = await launchBrowser({ headless, signal: stop.signal });
    owned.browser.on('disconnected', cancel);
    sourcePage = await owned.browser.newPage();
    sourcePage.on('close', cancel);
    for (const page of await owned.browser.pages()) if (page !== sourcePage) await page.close();
    sourcePage.on('pageerror', error => report(`Source page error: ${error.message.slice(0, 300)}`));
    const json = await loadAndExtract(sourcePage, input, { signal: stop.signal, report });
    const dataPath = await writePreviewData(input.out, json, stop.signal);
    stop.signal.throwIfAborted();
    // Keep a page open while switching so closing the source cannot exit a visible browser.
    widgetPage = await owned.browser.newPage();
    widgetPage.on('close', cancel);
    sourcePage.off('close', cancel);
    await sourcePage.close();
    stop.signal.throwIfAborted();
    server = await startPreviewServer(input.out);
    stop.signal.throwIfAborted();
    const url = `${server.url}/widget.html`;
    await widgetPage.setViewport({ ...WIDGET_SIZES[input.size], deviceScaleFactor: 1 });
    await bounded(widgetPage.goto(url, { waitUntil: 'load', timeout: 30_000 }), { signal: stop.signal, label: 'Widget loading' });
    await bounded(widgetPage.evaluate(`(async () => {
      if (!window.widgetReady || typeof window.widgetReady.then !== 'function') {
        throw new Error('widget.html must expose window.widgetReady');
      }
      await window.widgetReady;
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode()));
    })()`), { signal: stop.signal, label: 'Widget readiness' });
    stop.signal.throwIfAborted();
    report(`Data saved: ${dataPath}`);
    report(`Preview ready: ${url}`);
    report('Press Ctrl-C or close the preview browser/tab to stop.');
    await onReady?.({ url, dataPath, page: widgetPage, browser: owned.browser, profile: owned.profile, pid: owned.pid });
    await stopped;
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    sourcePage?.off('close', cancel);
    widgetPage?.off('close', cancel);
    owned?.browser.off('disconnected', cancel);
    // Closing Chrome also cancels pending navigation/evaluation after a timeout or signal.
    try { await owned?.close(); }
    finally { await server?.close(); }
  }
}

export async function runPreviewCommand(args) {
  const options = parsePreviewArgs(args);
  if (options.help) { console.log(PREVIEW_USAGE); return; }
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try { await runLocalPreview(options, { signal: stop.signal }); }
  finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
