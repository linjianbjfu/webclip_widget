/**
 * `preview_widget` — render the generated widget and report what went wrong.
 *
 * `extra.js` runs in a browser, not in Node, so `node --check` would validate
 * the wrong parser and catch only syntax errors. This project's real failure
 * mode is a selector resolving to null, which only a render exposes. One call
 * therefore returns three things: a deterministic syntax verdict, the runtime
 * and load errors the page produced, and a screenshot.
 *
 * Requests are intercepted so `<script src="extra.js">` resolves from the
 * workspace: the page is rendered as the files actually are, rather than from
 * a string assembled here, which would not exercise the reference at all.
 * Paths outside the workspace — `/favicon.ico` above all — answer 204 rather
 * than aborting, because an aborted request surfaces as a `requestfailed`
 * entry and a console error, and the model would read that as a fault in its
 * own widget.
 */

import puppeteer from "@cloudflare/puppeteer";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { WorkspaceFs } from "../fs/workspace-fs.ts";
import { OUT_DIR } from "../shell/bash.ts";

/** Idle timeout for the browser instance. Upstream caps it at ten minutes. */
const BROWSER_KEEP_ALIVE_MS = 600_000;
const NAV_TIMEOUT_MS = 15_000;
const ORIGIN = "https://widget.local";
const MAX_ERRORS = 25;

export interface PreviewResult {
  syntaxError: string | null;
  errors: string[];
  text: string;
  screenshotBytes: number;
  screenshotBase64: string;
}

function mimeFor(path: string): string {
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".json")) return "application/json";
  return "text/html";
}

export async function renderPreview(
  browserBinding: BrowserRun,
  fs: WorkspaceFs,
  entry = "widget.html",
): Promise<PreviewResult> {
  const browser = await puppeteer.launch(browserBinding, { keep_alive: BROWSER_KEEP_ALIVE_MS });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    const note = (line: string): void => {
      if (errors.length < MAX_ERRORS) errors.push(line);
    };

    page.on("pageerror", error => note(`uncaught: ${String(error.message).slice(0, 200)}`));
    page.on("console", message => {
      if (message.type() === "error") note(`console: ${message.text().slice(0, 200)}`);
    });
    page.on("requestfailed", request => note(`failed: ${new URL(request.url()).pathname}`));

    await page.setRequestInterception(true);
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      const workspacePath = `${OUT_DIR}${path}`;
      void (async () => {
        try {
          if (await fs.exists(workspacePath)) {
            const body = await fs.readFile(workspacePath);
            await request.respond({ status: 200, contentType: mimeFor(path), body });
            return;
          }
          // Not part of the widget: answer empty rather than abort, so the
          // browser's own probes do not pollute the error list.
          await request.respond({ status: 204, body: "" });
        } catch {
          await request.respond({ status: 500, body: "" });
        }
      })();
    });

    await page.goto(`${ORIGIN}/${entry}`, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });

    // The page's own parser gives a verdict that does not depend on how a
    // parse failure happens to surface as an event.
    const extraPath = `${OUT_DIR}/extra.js`;
    const syntaxError = (await fs.exists(extraPath))
      ? await page.evaluate((source: string) => {
          try {
            new Function(source);
            return null;
          } catch (error) {
            return String((error as Error).message);
          }
        }, await fs.readFile(extraPath))
      : null;

    // Runs in the page, where `document` exists; this project's lib does not
    // include DOM types because the Worker itself has no document.
    const text = await page.evaluate(
      "document.body ? document.body.innerText.slice(0, 2000) : ''",
    ) as string;
    const shot = (await page.screenshot({ type: "png" })) as Uint8Array;
    await page.close();

    return {
      syntaxError,
      errors,
      text,
      screenshotBytes: shot.byteLength,
      screenshotBase64: btoa(String.fromCharCode(...shot)),
    };
  } finally {
    // `disconnect`, not `close`: the instance stays warm for the next call in
    // this turn instead of paying a cold start each time.
    try {
      await browser.disconnect();
    } catch {
      // Already gone; nothing further to release.
    }
  }
}

/** The one line of a launch failure worth showing the model. */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? "").slice(0, 200);
}

export function createPreviewTool(browserBinding: BrowserRun, fs: WorkspaceFs) {
  return defineTool({
    name: "preview_widget",
    label: "Preview widget",
    description:
      "Render out/widget.html in a real browser. Returns syntax errors from the browser's own " +
      "parser, uncaught runtime errors, failed resource loads, and the rendered text. Use this " +
      "instead of node to check generated JavaScript.",
    promptSnippet: "preview_widget — render the widget and report syntax, runtime and load errors",
    parameters: Type.Object({
      entry: Type.Optional(
        Type.String({ description: "Entry file under out/, default widget.html" }),
      ),
    }),
    async execute(_toolCallId, params) {
      let result: PreviewResult;
      try {
        result = await renderPreview(browserBinding, fs, params.entry ?? "widget.html");
      } catch (error) {
        // A browser that will not start is an environment fact, not something
        // the model can repair. Pi would otherwise hand it the raw Node stack,
        // which fills the context with local paths and suggests no next step.
        return {
          content: [{ type: "text" as const, text: `preview unavailable: ${reason(error)}` }],
          isError: true,
          details: undefined,
        };
      }
      const lines = [
        result.syntaxError ? `syntax error in extra.js: ${result.syntaxError}` : "syntax: ok",
        result.errors.length > 0 ? `errors:\n${result.errors.join("\n")}` : "errors: none",
        `rendered text: ${result.text.slice(0, 500)}`,
        `screenshot: ${result.screenshotBytes} bytes`,
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        isError: result.syntaxError !== null || result.errors.length > 0,
        details: undefined,
      };
    },
  });
}
