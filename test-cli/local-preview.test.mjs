import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { loadAndExtract, parsePreviewArgs, previewInputs, SOURCE_WAIT_MS, writePreviewData } from './local-preview.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'webclip-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  await mkdir(out);
  const source = join(root, 'source.html');
  await writeFile(source, '<p>source</p>');
  for (const [name, body] of [['extra.js', '(() => ({value:0}))()'], ['widget.html', '<p>widget</p>'], ['meta.json', '{"size":"small"}']]) {
    await writeFile(join(out, name), body);
  }
  return { root, source, out };
}

test('preview arguments require only source and out, without extra wait options', () => {
  assert.deepEqual(parsePreviewArgs(['--out', 'out', '--source', 'source.html']), { out: resolve('out'), source: resolve('source.html') });
  assert.deepEqual(parsePreviewArgs(['--help']), { help: true });
  for (const args of [[], ['--source'], ['--out','--source','x'], ['--source','x'],
    ['--source','x','--source','y','--out','z'], ['--source','x','--out','z','--wait-for-selector','p'],
    ['--source','x','--out','z','extra'], ['--help','--out','z']]) assert.throws(() => parsePreviewArgs(args));
});

test('input checks require the three artifacts, allow existing data and reject invalid metadata', async t => {
  const input = await fixture(t);
  await writeFile(join(input.out, 'data.json'), '{"old":true}');
  assert.equal((await previewInputs(input)).size, 'small');
  await writeFile(join(input.out, 'meta.json'), '{"size":"medium"}');
  await assert.rejects(previewInputs(input), /meta.json/);
  await writeFile(join(input.out, 'meta.json'), '{"size":"small"}');
  for (const name of ['extra.js', 'widget.html', 'meta.json']) {
    const path = join(input.out, name), saved = await readFile(path);
    await rm(path);
    await assert.rejects(previewInputs(input), /ENOENT/);
    await writeFile(path, saved);
  }
  await assert.rejects(previewInputs({ ...input, source: input.out }), /Expected a file/);
  await assert.rejects(previewInputs({ ...input, out: input.source }), /Not a widget directory/);
  assert.equal(await readFile(join(input.out, 'data.json'), 'utf8'), '{"old":true}');
});

test('load completes before the fixed three-second wait and extraction follows the wait', async () => {
  const order = [];
  let finishLoad, finishWait;
  const loading = new Promise(resolve => { finishLoad = resolve; });
  const waiting = new Promise(resolve => { finishWait = resolve; });
  let sawWait;
  const waitStarted = new Promise(resolve => { sawWait = resolve; });
  const page = {
    goto: async (_url, options) => { assert.equal(options.waitUntil, 'load'); await loading; order.push('load'); },
    evaluate: async script => { assert.match(script, /eval\(scriptSource\)/); order.push('extract'); return '{"value":0}'; },
  };
  const result = loadAndExtract(page, { source: resolve('source.html'), extra: '(() => ({value:0}))()' }, {
    report: () => {}, wait: async ms => { assert.equal(ms, 3000); assert.equal(ms, SOURCE_WAIT_MS); order.push('wait'); sawWait(); await waiting; },
  });
  assert.deepEqual(order, []);
  finishLoad();
  await waitStarted;
  assert.deepEqual(order, ['load', 'wait']);
  finishWait();
  assert.equal(await result, '{"value":0}');
  assert.deepEqual(order, ['load', 'wait', 'extract']);
});

test('cancellation during the delay never evaluates the extractor', async () => {
  const stop = new AbortController();
  let evaluated = false;
  await assert.rejects(loadAndExtract({ goto: async () => {}, evaluate: async () => { evaluated = true; } },
    {source: resolve('source.html'), extra: 'invalid'}, {
      signal: stop.signal, report: () => {}, wait: async () => { stop.abort(); },
    }));
  assert.equal(evaluated, false);
});

test('data writes replace only data.json and clean staging on cancellation or rename failure', async t => {
  const {out} = await fixture(t);
  await writePreviewData(out, '{"value":0}');
  await writePreviewData(out, '{"value":"中文"}');
  assert.deepEqual(JSON.parse(await readFile(join(out,'data.json'),'utf8')), {value:'中文'});
  await assert.rejects(writePreviewData(out, '{"bad":true}', AbortSignal.abort()));
  assert.deepEqual(JSON.parse(await readFile(join(out,'data.json'),'utf8')), {value:'中文'});
  await rm(join(out,'data.json'));
  await mkdir(join(out,'data.json'));
  await writeFile(join(out,'data.json','keep'), 'keep');
  await assert.rejects(writePreviewData(out, '{}'));
  assert.equal(await readFile(join(out,'data.json','keep'),'utf8'), 'keep');
  assert.deepEqual((await readdir(out)).sort(), ['data.json','extra.js','meta.json','widget.html']);
});

test('actual preview CLI help and validation work without server credentials', async t => {
  const input = await fixture(t);
  const env = { ...process.env };
  delete env.WEBCLIP_URL; delete env.WEBCLIP_TOKEN;
  for (const [args, expected] of [[['--help'], 0], [[], 1], [['--source', input.source, '--out', join(input.root,'missing')], 1]]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./index.mjs', import.meta.url)), 'preview', ...args], {env, stdio:['ignore','pipe','pipe']});
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const [code, signal] = await once(child,'close');
    assert.equal(signal, null);
    assert.equal(code, expected, output);
    assert.doesNotMatch(output, /WEBCLIP_URL and WEBCLIP_TOKEN must be set/);
  }
});


test('missing Chrome reports the executable and leaves no temporary profile', async t => {
  const input=await fixture(t);
  const profiles=join(input.root,'profiles'); await mkdir(profiles);
  const child=spawn(process.execPath,[fileURLToPath(new URL('./index.mjs',import.meta.url)),'preview','--source',input.source,'--out',input.out],{
    env:{...process.env,CHROME_EXECUTABLE:join(input.root,'missing-chrome'),TMPDIR:profiles,TMP:profiles,TEMP:profiles},
    stdio:['ignore','pipe','pipe'],
  });
  let errors=''; child.stderr.on('data',bytes=>{errors+=bytes;});
  child.stdout.resume();
  const [code,signal]=await once(child,'close');
  assert.equal(signal,null); assert.equal(code,1);
  assert.match(errors,/Cannot start Chrome/);
  assert.match(errors,/CHROME_EXECUTABLE/);
  assert.deepEqual(await readdir(profiles),[]);
});
