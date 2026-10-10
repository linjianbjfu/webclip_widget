import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { launchBrowser } from "../../../test-cli/browser.mjs";
import { renderWidgetPreview } from "./preview-render.ts";
import { WIDGET_SIZES } from "../widget-contract.ts";

const source = '<html><body><script>throw new Error("captured script executed")</script><img src="https://capture.example/asset.png"><p id="value">0</p><p id="label">Long captured title with missing secondary field</p></body></html>';
const extra = `(() => {
  const region = document.body;
  return {
    value: Number(region.querySelector('#value').textContent),
    label: region.querySelector('#label').textContent,
    missing: region.querySelector('#absent')?.textContent ?? null
  };
})()`;
const data = { value: 0, label: "Long captured title with missing secondary field", missing: null };
const loadData = `window.widgetReady = (async () => {
  try {
    const response = await fetch('./data.json', {cache:'no-store'});
    if (!response.ok) throw new Error('data.json HTTP ' + response.status);
    const data = await response.json();
    renderWidget(data);
  } catch (error) {
    document.querySelector('#widget-root').textContent = 'Data unavailable';
    throw error;
  }
})();
window.widgetReady.catch(() => {});`;
function widget({ css = "", script = "", load = loadData } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * {box-sizing:border-box} html,body{margin:0;width:100%;height:100%}
  #widget-root{width:100%;height:100%;padding:12px;overflow:hidden;font:14px sans-serif}
  h1{margin:0;font-size:20px} p{margin:4px 0} ${css}
  </style></head><body><main id="widget-root"></main><script>
  window.renderWidget = data => {
    const root = document.querySelector('#widget-root'); root.replaceChildren();
    for (const value of [data.value,data.label,data.missing ?? 'Unavailable']) {
      const row=document.createElement('p'); row.textContent=value; root.append(row);
    }
  };
  ${load} ${script}
  </script></body></html>`;
}

async function browserFixture(t) {
  const owned = await launchBrowser({ headless: true });
  t.after(() => owned.close());
  return owned.browser;
}

test("real browser verifies all sizes, source isolation, HTTP data loading, overflow and motion", async t => {
  const browser = await browserFixture(t);
  for (const size of Object.keys(WIDGET_SIZES)) {
    const result = await renderWidgetPreview(browser, { size, source, extra, html: widget() });
    assert.equal(result.syntaxError, null);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.viewport, WIDGET_SIZES[size]);
    assert.deepEqual(result.root, { x: 0, y: 0, ...WIDGET_SIZES[size] });
    assert.deepEqual(JSON.parse(result.extractedData), data);
    assert.ok(result.text.includes("0"));
    assert.ok(result.screenshotBytes > 100);
  }
  const custom = await renderWidgetPreview(browser, {
    size: "large", width: 360, height: 440, source, extra, html: widget(),
  });
  assert.deepEqual(custom.viewport, { width: 360, height: 440 });
  assert.deepEqual(custom.root, { x: 0, y: 0, width: 360, height: 440 });
  for (const [change, expected] of [
    [{ css: "#widget-root{width:500px}" }, /fill the viewport|overflow/],
    [{ css: "#widget-root p{height:300px}" }, /overflow|clipped/],
    [{ css: "#widget-root{animation:pulse 1s infinite}@keyframes pulse{to{opacity:.5}}" }, /motion/],
    [{ css: "#widget-root{transition:opacity 1s}" }, /motion/],
    [{ css: '#widget-root::before{content:"x";animation:pulse 1s}@keyframes pulse{to{opacity:0}}' }, /motion/],
    [{ script: "document.querySelector('#widget-root').animate([{opacity:0},{opacity:1}],{duration:100000})" }, /motion/],
    [{ load: `renderWidget(${JSON.stringify(data)}); window.widgetReady=Promise.resolve();` }, /must fetch/],
    [{ load: `window.widgetReady=fetch('./data.json').then(r=>r.json()).then(()=>renderWidget(${JSON.stringify({...data,value:999})}));` }, /not fully rendered/],
    [{ load: `fetch('./data.json').then(r=>r.json()).then(renderWidget);` }, /must assign window.widgetReady/],
    [{ load: "fetch('./data.json'); window.widgetReady=new Promise(()=>{});" }, /widgetReady timed out/],
    [{ load: loadData.replace("'./data.json'", "'./missing.json'") }, /HTTP 404/],
    [{ script: "window.renderWidget = () => document.querySelector('#widget-root').append('duplicate')" }, /replace previous/],
    [{ script: "throw new Error('widget broken')" }, /widget broken/],
    [{ script: "const img=new Image(); img.src='https://example.test/missing.png'; document.body.append(img)" }, /embed resources/],
  ]) {
    const result = await renderWidgetPreview(browser, { size: "small", source, extra, html: widget(change) });
    assert.match(result.errors.join("\n"), expected);
  }
  const changed = await renderWidgetPreview(browser, {
    size: "small", source: source.replace('id="value">0', 'id="value">37'), extra, html: widget(),
  });
  assert.deepEqual(changed.errors, []);
  assert.match(changed.text, /37/);
  const failedExtraction = await renderWidgetPreview(browser, {
    size: "small", source, extra: "(() => {throw new Error('cannot extract')})()", html: widget(),
  });
  assert.match(failedExtraction.errors.join("\n"), /HTTP 500/);
  assert.match(failedExtraction.text, /Data unavailable/);
  const invalid = await renderWidgetPreview(browser, { size: "small", source, extra: "function {", html: widget() });
  assert.ok(invalid.syntaxError);
  for (const script of [
    "window.extractWidget = () => ({value: 0})",
    "function extractWidget() { return {value: 0}; }",
    "void 0", "(async () => ({value: 0}))()", "(() => JSON.stringify({value: 0}))()",
    "(() => ({value: undefined}))()", "(() => ({value: NaN}))()", "(() => ({value: 1n}))()",
    "(() => ({value: document.body}))()", "(() => {const data={};data.self=data;return data;})()",
  ]) {
    const rejected = await renderWidgetPreview(browser, { size: "small", source, extra: script, html: widget() });
    assert.equal(rejected.extractedData, null, script);
    assert.ok(rejected.errors.some(error => error.startsWith('extraction:')), script);
  }
  const live = await browser.newPage();
  await live.setContent(`<p id="value">0</p><p id="label">${data.label}</p>`);
  assert.deepEqual(await live.evaluate(extra), data);
  assert.deepEqual(await live.evaluate(extra), data, 'the same script can be executed again without global declarations');
  assert.equal(await live.evaluate('typeof window.extractWidget'), 'undefined');
  await live.close();
  assert.equal((await browser.browserContexts()).length, 1, "each preview disposes its isolated context");
});


test("HTTP loader waits for data and rejects missing or malformed JSON without fallback", async t => {
  const browser = await browserFixture(t);
  let status = 200, body = JSON.stringify(data), release;
  let requested;
  const requestSeen = new Promise(resolve => { requested = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === '/widget.html') {
      res.writeHead(200, {'content-type':'text/html'}).end(widget());
    } else if (req.url === '/data.json') {
      requested();
      await barrier;
      res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}).end(body);
    } else res.writeHead(204).end();
  });
  t.after(async () => {
    release();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/widget.html`, {waitUntil:'load'});
  await requestSeen;
  assert.equal(await page.evaluate(() => {
    window.settled = false;
    window.widgetReady.then(() => { window.settled = true; });
    return document.querySelector('#widget-root').innerText;
  }), '');
  assert.equal(await page.evaluate(() => window.settled), false);
  release();
  await page.evaluate(() => window.widgetReady);
  assert.match(await page.evaluate(() => document.body.innerText), /0/);
  body = JSON.stringify({...data,value:73});
  await page.reload({waitUntil:'load'});
  await page.evaluate(() => window.widgetReady);
  assert.match(await page.evaluate(() => document.body.innerText), /73/);
  for (const invalid of [{status:404, body:'missing'}, {status:200, body:'invalid JSON'}]) {
    status = invalid.status; body = invalid.body;
    await page.reload({waitUntil:'load'});
    await assert.rejects(page.evaluate(() => window.widgetReady));
    assert.equal(await page.evaluate(() => document.querySelector('#widget-root').innerText), 'Data unavailable');
  }
});
