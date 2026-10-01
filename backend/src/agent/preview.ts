/** Validate the widget bundle and run extraction and rendering in Browser Run. */
import puppeteer from "@cloudflare/puppeteer";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkspaceFs } from "../fs/workspace-fs.ts";
import { OUT_DIR } from "../shell/bash.ts";
import { parseWidgetMeta, validateWidgetPaths } from "../widget-contract.ts";
import { renderWidgetPreview } from "./preview-render.ts";

const EXTRACTED_PATH = "/widget-preview-data.json";

export async function renderPreview(browserBinding: BrowserRun, fs: WorkspaceFs) {
  const entries = await fs.readdirWithFileTypes(OUT_DIR);
  validateWidgetPaths(entries.map(entry => `out/${entry.name}`));
  if (entries.some(entry => !entry.isFile)) throw new Error("Widget artifacts must be files");
  const { size } = parseWidgetMeta(await fs.readFile(`${OUT_DIR}/meta.json`));
  const [html, extra, source] = await Promise.all([
    fs.readFile(`${OUT_DIR}/widget.html`), fs.readFile(`${OUT_DIR}/extra.js`), fs.readFile("/source.html"),
  ]);
  const browser = await puppeteer.launch(browserBinding, { keep_alive: 600_000 });
  try {
    const result = await renderWidgetPreview(browser, { html, extra, source, size });
    if (result.extractedData !== null) await fs.writeFile(EXTRACTED_PATH, result.extractedData);
    return result;
  } finally {
    await browser.disconnect();
  }
}

export function createPreviewTool(browserBinding: BrowserRun, fs: WorkspaceFs) {
  return defineTool({
    name: "preview_widget",
    label: "Preview widget",
    description:
      "Check the three out/ artifacts, evaluate extra.js directly against source.html and use its returned object without executing captured scripts, " +
      "serve the result as data.json and wait for widgetReady at the meta.json size. Returns loading, syntax/runtime/resource errors, data " +
      "mismatches, viewport/root bounds, overflow and motion findings, text and a screenshot. " +
      `Extracted JSON is saved to ${EXTRACTED_PATH}; read it to check the extractor/renderer data fields.`,
    promptSnippet: "preview_widget — verify data.json loading, extraction and static layout at the selected size",
    parameters: Type.Object({}),
    async execute() {
      let result;
      try {
        result = await renderPreview(browserBinding, fs);
      } catch (error) {
        // Pi marks thrown failures as tool errors; an isError return property is ignored.
        throw new Error(`preview failed: ${String(error).split("\n")[0]?.slice(0, 300)}`);
      }
      const valid = result.syntaxError === null && result.errors.length === 0;
      const lines = [
        `validation: ${valid ? "passed" : "failed"}`,
        `size: ${result.size}; viewport: ${result.viewport.width}x${result.viewport.height}; root: ${JSON.stringify(result.root)}`,
        result.syntaxError ? `syntax error in extra.js: ${result.syntaxError}` : "syntax: ok",
        result.errors.length ? `errors:\n${result.errors.join("\n")}` : "errors: none",
        `rendered text: ${result.text.slice(0, 500)}`,
        result.extractedData === null ? "extraction: failed" : `extracted data: ${EXTRACTED_PATH}`,
      ];
      return {
        content: [
          { type: "text" as const, text: lines.join("\n") },
          { type: "image" as const, data: result.screenshotBase64, mimeType: "image/png" },
        ],
        details: { valid },
      };
    },
  });
}
