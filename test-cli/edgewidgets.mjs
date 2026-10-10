import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseWidgetMeta } from "../backend/src/widget-contract.ts";
import { writeCaptureSnapshot } from "./capture-debug.mjs";

const GEC_VERSION = "1-153.0.4197.0";

export class EdgeWidgetApiError extends Error {
  constructor(message, callRecord, options) {
    super(message, options);
    this.name = "EdgeWidgetApiError";
    this.callRecord = callRecord;
  }
}

function tokenFileTime(date) {
  const epochDiffMs = 11644473600000n;
  const unixMs = BigInt(date.getTime());
  let micros = (unixMs + epochDiffMs) * 1000n;
  micros = (micros / 300000000n) * 300000000n;
  return micros * 10n;
}

export async function computeGecToken(apiKey, date = new Date()) {
  if (typeof apiKey !== "string" || apiKey.length === 0) throw new Error("GEC_API_KEY must be set");
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("GEC token date must be valid");
  const bytes = new TextEncoder().encode(String(tokenFileTime(date)) + apiKey);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function diagnosticItems(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => typeof item === "string" && item.length > 0).slice(0, 5);
}

function responseError(body, fallback) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fallback;
  const details = [
    typeof body.explanation === "string" ? body.explanation : "",
    ...diagnosticItems(body.blockedReasons),
    ...diagnosticItems(body.warnings),
  ].filter(Boolean).join("; ");
  return details ? `${fallback}: ${details.slice(0, 1000)}` : fallback;
}

function edgeWidgetMeta(body) {
  if (typeof body.size !== "string") {
    throw new Error("Edge Widgets API response is missing size");
  }
  const size = {
    small: "small",
    medium: "middle",
    middle: "middle",
    large: "large",
  }[body.size.toLowerCase()];
  if (!size) throw new Error(`Edge Widgets API response has unsupported size: ${body.size}`);
  const hasWidth = body.width !== undefined;
  const hasHeight = body.height !== undefined;
  if (hasWidth !== hasHeight) {
    throw new Error("Edge Widgets API response width and height must be provided together");
  }
  return parseWidgetMeta(JSON.stringify({
    size,
    ...(hasWidth ? { width: body.width, height: body.height } : {}),
  }));
}

export async function generateEdgeWidget({
  serviceUrl,
  apiKey,
  userQuery,
  url,
  pageTitle,
  htmlContent,
  date = new Date(),
  fetchImpl = fetch,
}) {
  if (typeof serviceUrl !== "string" || serviceUrl.length === 0) throw new Error("SERVICE_URL must be set");
  const token = await computeGecToken(apiKey, date);
  const endpoint = `${serviceUrl.replace(/\/+$/, "")}/api/edgewidgets/generate`;
  const requestBody = { userQuery, url, pageTitle, history: [], htmlContent };
  const callRecord = { endpoint, requestBody, responseBody: null };
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-ms-gec": token,
        "sec-ms-gec-version": GEC_VERSION,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    throw new EdgeWidgetApiError(String(error), callRecord, { cause: error });
  }
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new EdgeWidgetApiError(String(error), callRecord, { cause: error });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    callRecord.responseBody = text;
    throw new EdgeWidgetApiError(
      `Edge Widgets API returned non-JSON response (${response.status})`,
      callRecord,
    );
  }
  callRecord.responseBody = body;
  if (!response.ok) {
    throw new EdgeWidgetApiError(
      responseError(body, `Edge Widgets API returned ${response.status}`),
      callRecord,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || body.status !== "Success") {
    throw new EdgeWidgetApiError(
      responseError(body, "Edge Widgets API did not return Success"),
      callRecord,
    );
  }
  let meta;
  try {
    meta = edgeWidgetMeta(body);
  } catch (error) {
    throw new EdgeWidgetApiError(error.message, callRecord, { cause: error });
  }
  if (typeof body.extractScript !== "string" || body.extractScript.length === 0) {
    throw new EdgeWidgetApiError("Edge Widgets API response is missing extractScript", callRecord);
  }
  if (typeof body.widgetHtml !== "string" || body.widgetHtml.length === 0) {
    throw new EdgeWidgetApiError("Edge Widgets API response is missing widgetHtml", callRecord);
  }
  return {
    callRecord,
    extractScript: body.extractScript,
    meta,
    widgetHtml: body.widgetHtml,
    warnings: diagnosticItems(body.warnings),
  };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function edgeWidgetOutputId(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Output date must be valid");
  return `api-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export async function saveEdgeWidgetOutput({
  outputId,
  callRecord,
  captured,
  extractScript,
  meta,
  widgetHtml,
  root = resolve("downloads"),
}) {
  if (!/^api-\d{8}-\d{6}$/.test(outputId)) throw new Error("Invalid Edge Widgets output directory");
  if (!callRecord || typeof callRecord.endpoint !== "string") throw new Error("Missing Edge Widgets call record");
  if (!captured) throw new Error("Missing Edge Widgets capture");
  const hasArtifacts = extractScript !== undefined || widgetHtml !== undefined || meta !== undefined;
  if (hasArtifacts && (typeof extractScript !== "string" || typeof widgetHtml !== "string" || !meta)) {
    throw new Error("Edge Widgets artifacts must include extra.js, widget.html and meta.json");
  }
  const target = join(root, outputId);
  const lock = `${target}.lock`;
  await mkdir(root, { recursive: true });
  await mkdir(lock);
  let staging;
  try {
    try {
      await lstat(target);
      throw new Error(`Edge Widgets output already exists: ${target}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    staging = await mkdtemp(join(root, ".edgewidgets-"));
    const files = [
      ["api-url.txt", `${callRecord.endpoint}\n`],
      ["request.json", `${JSON.stringify(callRecord.requestBody, null, 2)}\n`],
      ["response.json", `${JSON.stringify(callRecord.responseBody, null, 2)}\n`],
      ...(hasArtifacts ? [
        ["extra.js", extractScript],
        ["widget.html", widgetHtml],
        ["meta.json", `${JSON.stringify(meta)}\n`],
      ] : []),
    ];
    await Promise.all(files.map(([name, content]) =>
      writeFile(join(staging, name), content, { flag: "wx" })));
    await writeCaptureSnapshot(join(staging, "capture"), captured);
    await rename(staging, target);
    staging = undefined;
    return target;
  } catch (error) {
    if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") {
      throw new Error(`Edge Widgets output already exists: ${target}`);
    }
    throw error;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
