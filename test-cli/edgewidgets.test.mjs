import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureInputImage,
  computeGecToken,
  edgeWidgetOutputId,
  generateEdgeWidget,
  saveEdgeWidgetOutput,
} from "./edgewidgets.mjs";

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "webclip-edgewidgets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function captureFixture(root) {
  const input = join(root, "capture-input");
  await mkdir(input);
  const source = join(input, "source.html");
  await writeFile(source, "<!doctype html><p>captured</p>");
  return {
    capture: {
      version: 1,
      mode: "regions",
      source: "source.html",
      pageUrl: "https://example.com/final",
      viewport: { width: 1280, height: 900 },
      regions: [{
        id: "r1",
        xpath: "/html[1]/body[1]/p[1]",
        rect: { x: 0, y: 0, width: 100, height: 20 },
        text: "captured",
      }],
      images: [],
    },
    files: [source],
  };
}

async function imageCaptureFixture(root, name, bytes) {
  const input = await mkdtemp(join(root, "image-capture-"));
  const source = join(input, "source.html");
  const image = join(input, name);
  await writeFile(source, "<!doctype html><p>captured image</p>");
  await writeFile(image, bytes);
  return {
    capture: {
      version: 1,
      mode: "regions",
      source: "source.html",
      pageUrl: "https://example.com/final",
      viewport: { width: 1280, height: 900 },
      regions: [{
        id: "r1",
        xpath: "/html[1]/body[1]/p[1]",
        rect: { x: 0, y: 0, width: 100, height: 20 },
        text: "captured image",
        imageId: "regions-image",
        imageRect: { x: 0, y: 0, width: 1, height: 1 },
      }],
      images: [{
        id: "regions-image",
        file: name,
        width: 1,
        height: 1,
        originalWidth: 1,
        originalHeight: 1,
        mimeType: name.endsWith(".png") ? "image/png" : "image/jpeg",
        bytes: bytes.length,
        role: "montage",
      }],
    },
    files: [source, image],
  };
}

test("computes the Bruno-compatible GEC token and local output id", async () => {
  assert.equal(
    await computeGecToken("fixture-key", new Date("2026-10-08T07:25:00.000Z")),
    "EFF3D75731BA38E3C123CD6776AB52D3EBF6CBB31810A8F96CB8A366F8DC241C",
  );
  assert.equal(edgeWidgetOutputId(new Date(2016, 6, 20, 18, 18, 18)), "api-20160720-181818");
});

test("posts the captured page with GEC headers and validates the success response", async t => {
  let received;
  const inputImageBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const inputImage = `data:image/png;base64,${inputImageBytes.toString("base64")}`;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "Success",
      size: "Medium",
      width: 360,
      height: 440,
      extractScript: "(() => ({value: 7}))()",
      widgetHtml: "<p>7</p>",
      warnings: ["fixture warning"],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const serviceUrl = `http://127.0.0.1:${server.address().port}/`;
  const result = await generateEdgeWidget({
    serviceUrl,
    apiKey: "fixture-key",
    userQuery: "make a widget",
    url: "https://example.com/final",
    pageTitle: "Example",
    htmlContent: "<!doctype html><p>7</p>",
    inputImage,
    date: new Date("2026-10-08T07:25:00.000Z"),
  });
  assert.deepEqual(result, {
    callRecord: {
      endpoint: `${serviceUrl.replace(/\/$/, "")}/api/edgewidgets/generate`,
      requestBody: {
        userQuery: "make a widget",
        url: "https://example.com/final",
        pageTitle: "Example",
        history: [],
        htmlContent: "<!doctype html><p>7</p>",
        input_image: inputImage,
      },
      responseBody: {
        status: "Success",
        size: "Medium",
        width: 360,
        height: 440,
        extractScript: "(() => ({value: 7}))()",
        widgetHtml: "<p>7</p>",
        warnings: ["fixture warning"],
      },
    },
    extractScript: "(() => ({value: 7}))()",
    meta: { size: "middle", width: 360, height: 440 },
    widgetHtml: "<p>7</p>",
    warnings: ["fixture warning"],
  });
  assert.equal(received.method, "POST");
  assert.equal(received.url, "/api/edgewidgets/generate");
  assert.equal(received.headers["content-type"], "application/json");
  assert.equal(received.headers["sec-ms-gec-version"], "1-153.0.4197.0");
  assert.equal(received.headers["sec-ms-gec"], "EFF3D75731BA38E3C123CD6776AB52D3EBF6CBB31810A8F96CB8A366F8DC241C");
  assert.deepEqual(received.body, {
    userQuery: "make a widget",
    url: "https://example.com/final",
    pageTitle: "Example",
    history: [],
    htmlContent: "<!doctype html><p>7</p>",
    input_image: inputImage,
  });
  assert.match(received.body.input_image, /^data:image\/png;base64,/);
});

test("encodes capture PNG/JPEG bytes and omits images for text-only captures", async t => {
  const root = await temporary(t);
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
  for (const [name, bytes] of [["regions.png", png], ["regions.jpg", jpeg]]) {
    const captured = await imageCaptureFixture(root, name, bytes);
    const encoded = await captureInputImage(captured);
    const mime = name.endsWith(".png") ? "image/png" : "image/jpeg";
    assert.equal(encoded, `data:${mime};base64,${bytes.toString("base64")}`);
  }
  assert.equal(await captureInputImage(await captureFixture(root)), undefined);
});

test("rejects missing, duplicate and empty capture image files before request construction", async t => {
  const root = await temporary(t);
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const missing = await imageCaptureFixture(root, "missing.png", png);
  missing.files = missing.files.slice(0, 1);
  await assert.rejects(captureInputImage(missing), /missing or duplicated/);

  const duplicate = await imageCaptureFixture(root, "duplicate.png", png);
  const duplicateDir = await mkdtemp(join(root, "duplicate-"));
  const duplicatePath = join(duplicateDir, "duplicate.png");
  await writeFile(duplicatePath, png);
  duplicate.files.push(duplicatePath);
  await assert.rejects(captureInputImage(duplicate), /missing or duplicated/);

  const empty = await imageCaptureFixture(root, "empty.png", Buffer.alloc(0));
  await assert.rejects(captureInputImage(empty), /is empty/);
});

test("failed API calls retain request and response records without echoing generated code", async () => {
  const base = {
    serviceUrl: "https://service.example",
    apiKey: "secret",
    userQuery: "query",
    url: "https://example.com",
    pageTitle: "Example",
    htmlContent: "<p>source</p>",
  };
  const response = (body, status = 200) => async () => new Response(
    typeof body === "string" ? body : JSON.stringify(body),
    { status, headers: { "content-type": "application/json" } },
  );
  await assert.rejects(
    generateEdgeWidget({
      ...base,
      fetchImpl: response({ status: "Blocked", explanation: "policy", blockedReasons: ["reason"] }),
    }),
    error => /did not return Success: policy; reason/.test(error.message)
      && error.callRecord.responseBody.status === "Blocked",
  );
  await assert.rejects(
    generateEdgeWidget({
      ...base,
      fetchImpl: response({ status: "Success", size: "Small", extractScript: "sensitive-code" }),
    }),
    error => error.message === "Edge Widgets API response is missing widgetHtml"
      && !error.message.includes("sensitive-code")
      && error.callRecord.responseBody.extractScript === "sensitive-code",
  );
  await assert.rejects(
    generateEdgeWidget({
      ...base,
      fetchImpl: response({
        status: "Success",
        size: "Large",
        width: 360,
        extractScript: "script",
        widgetHtml: "html",
      }),
    }),
    /width and height must be provided together/,
  );
  await assert.rejects(
    generateEdgeWidget({ ...base, fetchImpl: response("<html>failure</html>", 502) }),
    error => /non-JSON response \(502\)/.test(error.message)
      && error.callRecord.responseBody === "<html>failure</html>",
  );
  await assert.rejects(
    generateEdgeWidget({
      ...base,
      fetchImpl: async () => { throw new Error("network unavailable"); },
    }),
    error => /network unavailable/.test(error.message)
      && error.callRecord.responseBody === null,
  );
  await assert.rejects(
    generateEdgeWidget({
      ...base,
      fetchImpl: async () => ({
        status: 200,
        text: async () => { throw new Error("response interrupted"); },
      }),
    }),
    error => /response interrupted/.test(error.message)
      && error.callRecord.responseBody === null,
  );
});

test("rejects incomplete or unsupported input image data URIs before fetch", async () => {
  const base = {
    serviceUrl: "https://service.example",
    apiKey: "secret",
    userQuery: "query",
    url: "https://example.com",
    pageTitle: "Example",
    htmlContent: "<p>source</p>",
    fetchImpl: async () => { throw new Error("fetch must not run"); },
  };
  for (const inputImage of [
    "iVBORw0KGgo=",
    "data:image/avif;base64,AAAA",
    "data:image/png,AAAA",
    "data:image/png;base64,",
  ]) {
    await assert.rejects(
      generateEdgeWidget({ ...base, inputImage }),
      /complete JPEG, PNG, GIF or WebP base64 data URI/,
    );
  }
});

test("maps external sizes and falls back when pixel dimensions are absent", async () => {
  const base = {
    serviceUrl: "https://service.example",
    apiKey: "secret",
    userQuery: "query",
    url: "https://example.com",
    pageTitle: "Example",
    htmlContent: "<p>source</p>",
  };
  for (const [external, expected] of [["Small", "small"], ["medium", "middle"], ["Middle", "middle"], ["LARGE", "large"]]) {
    const result = await generateEdgeWidget({
      ...base,
      fetchImpl: async () => Response.json({
        status: "Success",
        size: external,
        extractScript: "script",
        widgetHtml: "html",
      }),
    });
    assert.deepEqual(result.meta, { size: expected });
    assert.equal(Object.hasOwn(result.callRecord.requestBody, "input_image"), false);
  }
});

test("publishes successful artifacts and API records atomically", async t => {
  const root = await temporary(t);
  const imageBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const captured = await imageCaptureFixture(root, "regions.png", imageBytes);
  const outputId = "api-20160720-181818";
  const callRecord = {
    endpoint: "https://service.example/api/edgewidgets/generate",
    requestBody: {
      userQuery: "query",
      url: "https://example.com",
      pageTitle: "Example",
      history: [],
      htmlContent: "<p>source</p>",
      input_image: `data:image/png;base64,${imageBytes.toString("base64")}`,
    },
    responseBody: {
      status: "Success",
      size: "Large",
      width: 360,
      height: 440,
      extractScript: "(() => ({value: 1}))()",
      widgetHtml: "<p>one</p>",
    },
  };
  const folder = await saveEdgeWidgetOutput({
    root,
    outputId,
    callRecord,
    captured,
    extractScript: "(() => ({value: 1}))()",
    meta: { size: "large", width: 360, height: 440 },
    widgetHtml: "<p>one</p>",
  });
  assert.equal(folder, join(root, outputId));
  assert.deepEqual((await readdir(folder)).sort(), [
    "api-url.txt",
    "capture",
    "extra.js",
    "meta.json",
    "request.json",
    "response.json",
    "widget.html",
  ]);
  assert.equal(
    await readFile(join(folder, "api-url.txt"), "utf8"),
    "https://service.example/api/edgewidgets/generate\n",
  );
  assert.deepEqual(JSON.parse(await readFile(join(folder, "request.json"), "utf8")), callRecord.requestBody);
  assert.deepEqual(JSON.parse(await readFile(join(folder, "response.json"), "utf8")), callRecord.responseBody);
  assert.match(await readFile(join(folder, "request.json"), "utf8"), /^\{\n  "userQuery"/);
  assert.equal(await readFile(join(folder, "extra.js"), "utf8"), "(() => ({value: 1}))()");
  assert.deepEqual(
    JSON.parse(await readFile(join(folder, "meta.json"), "utf8")),
    { size: "large", width: 360, height: 440 },
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(folder, "capture", "capture.json"), "utf8")),
    captured.capture,
  );
  assert.equal(
    await readFile(join(folder, "capture", "source.html"), "utf8"),
    "<!doctype html><p>captured image</p>",
  );
  assert.deepEqual(await readFile(join(folder, "capture", "regions.png")), imageBytes);
  assert.deepEqual(
    Buffer.from(
      JSON.parse(await readFile(join(folder, "request.json"), "utf8")).input_image.split(",", 2)[1],
      "base64",
    ),
    imageBytes,
  );
  assert.equal(await readFile(join(folder, "widget.html"), "utf8"), "<p>one</p>");
  await assert.rejects(
    saveEdgeWidgetOutput({
      root,
      outputId,
      callRecord,
      captured,
      extractScript: "replace",
      meta: { size: "small" },
      widgetHtml: "replace",
    }),
    /already exists/,
  );
  assert.equal(await readFile(join(folder, "extra.js"), "utf8"), "(() => ({value: 1}))()");
  const rootEntries = (await readdir(root)).sort();
  assert.equal(rootEntries[0], outputId);
  assert.match(rootEntries[1], /^image-capture-/);

  const blockedRoot = join(root, "blocked");
  await writeFile(blockedRoot, "file");
  await assert.rejects(saveEdgeWidgetOutput({
    root: blockedRoot,
    outputId: "api-20160720-181819",
    callRecord,
    captured,
    extractScript: "x",
    meta: { size: "small" },
    widgetHtml: "y",
  }));
});

test("publishes failed JSON, text and network call records without artifacts", async t => {
  const root = await temporary(t);
  const captured = await captureFixture(root);
  const requestBody = {
    userQuery: "query",
    url: "https://example.com",
    pageTitle: "Example",
    history: [],
    htmlContent: "<p>source</p>",
  };
  const cases = [
    ["api-20160720-181820", { status: "Blocked", explanation: "policy" }],
    ["api-20160720-181821", "<html>failure</html>"],
    ["api-20160720-181822", null],
  ];
  for (const [outputId, responseBody] of cases) {
    const folder = await saveEdgeWidgetOutput({
      root,
      outputId,
      callRecord: {
        endpoint: "https://service.example/api/edgewidgets/generate",
        requestBody,
        responseBody,
      },
      captured,
    });
    assert.deepEqual((await readdir(folder)).sort(), [
      "api-url.txt",
      "capture",
      "request.json",
      "response.json",
    ]);
    assert.deepEqual(JSON.parse(await readFile(join(folder, "response.json"), "utf8")), responseBody);
  }
  const contents = await Promise.all(
    cases.flatMap(([outputId]) => ["api-url.txt", "request.json", "response.json"]
      .map(name => readFile(join(root, outputId, name), "utf8"))),
  );
  assert.ok(contents.every(content => !content.includes("fixture-key") && !content.includes("sec-ms-gec")));
});
