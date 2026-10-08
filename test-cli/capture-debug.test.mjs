import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCaptureDebug } from './capture-debug.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'webclip-capture-debug-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input'); await mkdir(input);
  const source = join(input, 'source.html'), picture = join(input, 'regions.png');
  await writeFile(source, '<html><body>微软 420</body></html>');
  await writeFile(picture, Buffer.from([137,80,78,71]));
  return { root: join(root, 'downloads'), source, picture,
    captured: { files: [source, picture], capture: {
      version:1, mode:'regions', source:'source.html', viewport:{width:1280,height:900},
      regions:[{id:'r1',xpath:'/html/body',rect:{x:0,y:0,width:100,height:40},text:'微软 420',imageId:'regions',imageRect:{x:0,y:0,width:100,height:40}}],
      images:[{id:'regions',file:'regions.png',mimeType:'image/png',width:100,height:40,originalWidth:100,originalHeight:40,bytes:4,role:'montage'}],
    } },
  };
}

test('capture debug keeps exact source, image and metadata outside widget artifacts', async t => {
  const f = await fixture(t);
  const folder = await saveCaptureDebug({ sessionId:'session', captured:f.captured, root:f.root });
  assert.equal(folder, join(f.root,'session','capture'));
  assert.deepEqual(await readFile(join(folder,'source.html')),await readFile(f.source));
  assert.deepEqual(await readFile(join(folder,'regions.png')),await readFile(f.picture));
  assert.deepEqual(JSON.parse(await readFile(join(folder,'capture.json'),'utf8')),f.captured.capture);
  await rm(f.source); await rm(f.picture);
  assert.equal((await readFile(join(folder,'source.html'),'utf8')).includes('微软'),true);
  assert.equal((await readFile(join(folder,'regions.png'))).length,4);
});

test('a new text-only capture replaces the snapshot and removes stale images, preserving widget data', async t => {
  const f = await fixture(t);
  f.captured.capture.pageUrl='https://example.com/first';
  const folder = await saveCaptureDebug({ sessionId:'session', captured:f.captured, root:f.root });
  await writeFile(join(f.root,'session','widget.html'),'keep widget');
  await writeFile(join(f.root,'session','data.json'),'keep data');
  await writeFile(f.source,'<p>new capture</p>');
  const textCapture = {files:[f.source], capture:{...f.captured.capture,pageUrl:'https://example.com/final?q=1#news', images:[], regions:f.captured.capture.regions.map(({imageId,imageRect,...region})=>region)}};
  assert.equal(await saveCaptureDebug({sessionId:'session',captured:textCapture,root:f.root}),folder);
  assert.deepEqual((await readdir(folder)).sort(),['capture.json','source.html']);
  assert.equal(await readFile(join(folder,'source.html'),'utf8'),'<p>new capture</p>');
  assert.equal(JSON.parse(await readFile(join(folder,'capture.json'),'utf8')).pageUrl,textCapture.capture.pageUrl);
  assert.equal(await readFile(join(f.root,'session','widget.html'),'utf8'),'keep widget');
  assert.equal(await readFile(join(f.root,'session','data.json'),'utf8'),'keep data');
  assert.deepEqual((await readdir(join(f.root,'session'))).sort(),['capture','data.json','widget.html']);
});

test('missing capture input or invalid destination does not publish a partial snapshot', async t => {
  const f = await fixture(t);
  const folder = await saveCaptureDebug({sessionId:'session',captured:f.captured,root:f.root});
  await rm(f.picture);
  await assert.rejects(saveCaptureDebug({sessionId:'session',captured:f.captured,root:f.root}),/ENOENT/);
  assert.equal((await readFile(join(folder,'regions.png'))).length,4);
  assert.deepEqual(await readdir(join(f.root,'session')),['capture']);
  await assert.rejects(saveCaptureDebug({sessionId:'../escape',captured:f.captured,root:f.root}),/Invalid sessionId/);
  await writeFile(f.picture,Buffer.from([137,80,78,71]));
  await rm(folder,{recursive:true}); await writeFile(folder,'user file');
  await assert.rejects(saveCaptureDebug({sessionId:'session',captured:f.captured,root:f.root}),/not a regular directory/);
  assert.equal(await readFile(folder,'utf8'),'user file');
  assert.deepEqual(await readdir(join(f.root,'session')),['capture']);
});

test('v2 debug requires its DOM companion and v1 replacement removes it',async t=>{
 const f=await fixture(t),dom=join(f.source,'..','source.dom.json');
 await writeFile(dom,'exact snapshot bytes');
 const captured={files:[...f.captured.files,dom],capture:{...f.captured.capture,version:2,dom:'source.dom.json'}};
 const folder=await saveCaptureDebug({sessionId:'v2',captured,root:f.root});
 assert.equal(await readFile(join(folder,'source.dom.json'),'utf8'),'exact snapshot bytes');
 await assert.rejects(saveCaptureDebug({sessionId:'v2',captured:{...captured,files:f.captured.files},root:f.root}),/missing or duplicated/);
 assert.equal(await readFile(join(folder,'source.dom.json'),'utf8'),'exact snapshot bytes');
 await saveCaptureDebug({sessionId:'v2',captured:f.captured,root:f.root});
 assert.ok(!(await readdir(folder)).includes('source.dom.json'));
});
