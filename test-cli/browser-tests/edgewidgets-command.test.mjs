import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { capturePage } from "../capture-page.mjs";
import { captureInputImage, generateEdgeWidget } from "../edgewidgets.mjs";

async function button(page, id) {
  await page.evaluate(buttonId => {
    document.querySelector("[data-webclip-ui]").shadowRoot.querySelector(`#${buttonId}`).click();
  }, id);
}

test("selected regions become the Edge Widgets API page inputs", async t => {
  let request;
  const server = createServer(async (incoming, response) => {
    if (incoming.url === "/page") {
      response.writeHead(302, { location: "/final" }).end();
      return;
    }
    if (incoming.url === "/final") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html><head><title>Captured title</title></head><body>
        <section id="wanted"><h2>热搜头条</h2><p>目标内容</p></section>
        <section id="discarded"><h2>其它内容</h2><p>不要发送</p></section>
      </body></html>`);
      return;
    }
    if (incoming.url !== "/api/edgewidgets/generate") {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    request = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      status: "Success",
      size: "Large",
      width: 360,
      height: 440,
      extractScript: "(() => ({value: 42}))()",
      widgetHtml: "<p>forty-two</p>",
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const serviceUrl = `http://127.0.0.1:${server.address().port}`;
  let interaction;
  const captured = await capturePage({ url: `${serviceUrl}/page`, select: true }, {
    headless: true,
    report: () => {},
    onPage: page => {
      interaction = (async () => {
        await page.evaluate(() => {
          window.__webclipCapture.state.regions = [{ id: "r1", el: document.querySelector("#wanted") }];
        });
        await button(page, "finish");
        await page.waitForFunction(
          () => window.__webclipCapture.state.status === "preview",
          { polling: 100 },
        );
        await button(page, "send");
      })();
      interaction.catch(() => { void button(page, "cancel").catch(() => {}); });
    },
  });
  await interaction;
  assert.ok(captured);
  t.after(() => captured.dispose());
  const htmlContent = await readFile(captured.files[0], "utf8");
  assert.match(htmlContent, /热搜头条/);
  assert.doesNotMatch(htmlContent, /不要发送/);
  assert.equal(captured.pageTitle, "Captured title");
  assert.equal(captured.capture.pageUrl, `${serviceUrl}/final`);

  const generated = await generateEdgeWidget({
    serviceUrl,
    apiKey: "fixture-key",
    userQuery: "make a widget",
    url: captured.capture.pageUrl,
    pageTitle: captured.pageTitle,
    htmlContent,
    inputImage: await captureInputImage(captured),
  });
  assert.equal(generated.extractScript, "(() => ({value: 42}))()");
  assert.deepEqual(generated.meta, { size: "large", width: 360, height: 440 });
  assert.deepEqual(request, {
    userQuery: "make a widget",
    url: `${serviceUrl}/final`,
    pageTitle: "Captured title",
    history: [],
    htmlContent,
    input_image: request.input_image,
  });
  assert.match(request.input_image, /^data:image\/png;base64,/);
  const imageBytes = Buffer.from(request.input_image.split(",", 2)[1], "base64");
  assert.ok(imageBytes.length > 0);
  assert.equal(imageBytes[0], 0x89);
  assert.equal(imageBytes[1], 0x50);
  assert.equal(imageBytes[2], 0x4E);
  assert.equal(imageBytes[3], 0x47);
});
