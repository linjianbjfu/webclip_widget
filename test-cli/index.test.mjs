import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL('./index.mjs', import.meta.url));
function out(value = "old") {
  return [['extra.js', 'void 0'], ['widget.html', `<p>中文 ${value}</p>`], ['meta.json', '{"size":"middle"}']]
    .map(([name, content]) => ({ path: `out/${name}`, content, bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex') }));
}
async function run(args, cwd, url, input = '') {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd, env: { ...process.env, WEBCLIP_URL: url, WEBCLIP_TOKEN: 'fixture', WEBCLIP_USER: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.end(input);
  const [status, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  return { status, stdout, stderr };
}

test('prompt, chat and live events publish bundles through actual CLI entry points', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'webclip-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = randomUUID();
  const liveTurn = randomUUID();
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/sessions') {
      res.statusCode = 201;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sessionId }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('content-type', 'text/event-stream');
    const frame = data => res.write(`event: turn_end\ndata: ${JSON.stringify(data)}\n\n`);
    if (req.url.includes('/events')) {
      frame({ turnId: randomUUID(), reason: 'completed', out: out().map(({ content, ...f }) => f) });
      frame({ turnId: liveTurn, reason: 'completed', out: out('events') });
    } else {
      // A backlog from another turn must not be saved by prompt/chat.
      frame({ turnId: randomUUID(), reason: 'completed', out: out() });
      if (body.text !== 'disconnect') {
        const files = out(body.text);
        if (body.text === 'corrupt') files[0].sha256 = 'bad';
        frame({ turnId: body.turnId, reason: 'completed', out: files });
      }
    }
    res.end('event: stream_end\ndata: {"sessionBusy":false}\n\n');
  });

  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const [args, input] of [[['prompt', 'make widget'], ''], [['chat', sessionId], 'first\nsecond\n'],
    [['events', sessionId], '']]) {
    const result = await run(args, root, url, input);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Saved widget:/);
    const folder = join(root, 'downloads', sessionId);
    assert.ok(result.stdout.includes(`Saved widget: ${folder}`));
    assert.deepEqual((await readdir(folder)).sort(), ['extra.js', 'meta.json', 'widget.html']);
    const expected = args[0] === 'events' ? 'events' : args[0] === 'chat' ? 'second' : 'make widget';
    for (const file of out(expected)) {
      assert.equal(await readFile(join(folder, file.path.slice(4)), 'utf8'), file.content);
    }
  }
  for (const text of ['corrupt', 'disconnect']) {
    const result = await run(['prompt', sessionId, text], root, url);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Saved widget:/);
  }
  for (const file of out('events')) {
    assert.equal(await readFile(join(root, 'downloads', sessionId, file.path.slice(4)), 'utf8'), file.content);
  }
});

test("edgewidgets mode rejects unsupported arguments before requiring either service", async () => {
  const cases = [
    [["--api", "unknown", "--url", "https://example.com", "--prompt", "message"], /Unknown API/],
    [["--api", "edgewidgets", "--prompt", "message"], /requires --url/],
    [["--api", "edgewidgets", "--url", "https://example.com"], /requires --prompt/],
    [["--api", "edgewidgets", "--url", "https://example.com", "--file", "page.html", "--prompt", "message"], /does not accept/],
  ];
  for (const [args, expected] of cases) {
    const result = await run(args, process.cwd(), "http://127.0.0.1:1");
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  }
});
