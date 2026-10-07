import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import { runLocalPreview } from '../local-preview.mjs';
import { bounded, launchBrowser } from '../browser.mjs';
import { IMAGE_EXTRACTOR } from '../../backend/src/design-system/images.ts';

async function fixture(t, size = 'small', value = 7) {
  const root = await mkdtemp(join(tmpdir(), 'webclip-live-preview-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const out = join(root,'out'); await mkdir(out);
  const source = join(root,'source.html');
  await writeFile(source, `<p id="value">0</p><script>addEventListener('load',()=>document.querySelector('#value').textContent='${value}')</script>`);
  await writeFile(join(out,'extra.js'), `(() => ({value:Number(document.querySelector('#value').textContent),label:'中文',missing:null}))()`);
  await writeFile(join(out,'meta.json'), JSON.stringify({size}));
  await writeFile(join(out,'widget.html'), `<!doctype html><html><style>html,body,#widget-root{margin:0;width:100%;height:100%;box-sizing:border-box}</style>
    <main id="widget-root"></main><script>
      window.widgetReady=fetch('./data.json',{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json()}).then(data=>{
        document.querySelector('#widget-root').textContent=data.label+' '+data.value;
      });widgetReady.catch(()=>{});
    </script></html>`);
  return {root,source,out};
}

function preview(t, input) {
  const stop = new AbortController();
  let ready;
  const received = new Promise(resolve => { ready=resolve; });
  const done = runLocalPreview(input, {headless:true,signal:stop.signal,report:()=>{},onReady:ready});
  // Observe setup failures immediately and make every assertion failure dispose the process.
  done.catch(()=>{});
  t.after(async()=>{stop.abort();await done.catch(()=>{});});
  return {stop,done,ready:bounded(Promise.race([received,done.then(()=>{throw Error('Preview ended before ready');})]),{timeout:60_000,label:'Preview test'})};
}

async function sourceServer(t){
  const requests=[];
  const server=createServer((req,res)=>{
    requests.push(req.url);
    if(req.url==='/missing'){res.writeHead(404).end('not found');return;}
    if(req.url==='/disconnect'){req.socket.destroy();return;}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<p id="value">0</p><script>addEventListener("load",()=>{document.querySelector("#value").textContent="42";window.sourceLoaded=true;});</script>');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {url:`http://127.0.0.1:${server.address().port}`,requests};
}

test('URL preview uses the captured viewport and live data without a source.html file',async t=>{
  const input=await fixture(t), source=await sourceServer(t);
  await mkdir(join(input.out,'capture'));
  await writeFile(join(input.out,'capture','capture.json'),JSON.stringify({pageUrl:source.url+'/final?q=1#news',requestUrl:source.url+'/wrong',baseUrl:source.url+'/assets/',viewport:{width:1111,height:777}}));
  await rm(input.source);
  await writeFile(join(input.out,'extra.js'),`(() => ({value:Number(document.querySelector('#value').textContent),label:'实时',width:innerWidth,height:innerHeight,dpr:devicePixelRatio,loaded:window.sourceLoaded,url:location.href}))()`);
  const run=preview(t,{out:input.out}),info=await run.ready;
  const data=await (await fetch(new URL('data.json',info.url))).json();
  assert.deepEqual(data,{value:42,label:'实时',width:1111,height:777,dpr:1,loaded:true,url:source.url+'/final?q=1#news'});
  assert.equal(await info.page.evaluate(()=>document.querySelector('#widget-root').textContent),'实时 42');
  assert.ok(source.requests.includes('/final?q=1'));assert.ok(!source.requests.includes('/wrong'));
  run.stop.abort();await run.done;
});

test('URL load and extraction failures preserve old data and never use the captured HTML fallback',async t=>{
  const input=await fixture(t), source=await sourceServer(t);
  await mkdir(join(input.out,'capture'));
  await writeFile(join(input.out,'capture','source.html'),'<p id="value">old snapshot</p>');
  await writeFile(join(input.out,'data.json'),'{"previous":true}');
  for(const [path,extra,expected] of [['/missing','(() => ({value:1}))()',/HTTP 404/],['/disconnect','(() => ({value:1}))()',/ERR_/],['/final','(() => {throw Error("bad extraction")})()',/bad extraction/]]){
    await writeFile(join(input.out,'capture','capture.json'),JSON.stringify({pageUrl:source.url+path,viewport:{width:1280,height:900}}));
    await writeFile(join(input.out,'extra.js'),extra);
    await assert.rejects(runLocalPreview({out:input.out},{headless:true,report:()=>{}}),expected);
    assert.equal(await readFile(join(input.out,'data.json'),'utf8'),'{"previous":true}');
  }
});

test('independent browsers execute page scripts, write data and serve all widget sizes', async t => {
  const a=await fixture(t,'small',7), b=await fixture(t,'large',12);
  const first=preview(t,a), second=preview(t,b);
  const [one,two]=await Promise.all([first.ready,second.ready]);
  assert.notEqual(one.url,two.url); assert.notEqual(one.profile,two.profile);
  for (const [info,size,value] of [[one,{width:160,height:160},7],[two,{width:344,height:360},12]]) {
    assert.deepEqual(JSON.parse(await readFile(info.dataPath,'utf8')),{value,label:'中文',missing:null});
    assert.equal(await info.page.evaluate(()=>document.querySelector('#widget-root').textContent),`中文 ${value}`);
    assert.deepEqual(await info.page.evaluate(()=>({width:innerWidth,height:innerHeight})),size);
    assert.equal((await fetch(new URL('data.json',info.url))).status,200);
  }
  await one.page.close(); await first.done;
  second.stop.abort(); await second.done;
  for(const info of [one,two]) {
    await assert.rejects(stat(info.profile),{code:'ENOENT'});
    await assert.rejects(fetch(info.url));
  }
  // A repeated run updates the same out/data.json and normal browser closure ends the CLI lifecycle.
  await writeFile(a.source,'<p id="value">25</p>');
  await writeFile(join(a.out,'meta.json'),'{"size":"middle"}');
  const third=preview(t,a), info=await third.ready;
  assert.equal(JSON.parse(await readFile(info.dataPath,'utf8')).value,25);
  assert.deepEqual(await info.page.evaluate(()=>({width:innerWidth,height:innerHeight})),{width:344,height:160});
  await info.browser.close(); await third.done;
  await assert.rejects(stat(info.profile),{code:'ENOENT'});
  assert.deepEqual((await readdir(a.out)).sort(),['data.json','extra.js','meta.json','widget.html']);
});

test('extraction failure preserves existing data and widget readiness failure is not success', async t => {
  const input=await fixture(t);
  await writeFile(join(input.out,'data.json'),'{"previous":true}');
  await writeFile(join(input.out,'extra.js'),'window.extractWidget = () => ({value:7})');
  const messages=[];
  await assert.rejects(runLocalPreview(input,{headless:true,report:message=>messages.push(message)}),/synchronous JSON object/);
  assert.equal(await readFile(join(input.out,'data.json'),'utf8'),'{"previous":true}');
  await writeFile(join(input.out,'extra.js'),'(() => ({value:0}))()');
  await writeFile(join(input.out,'widget.html'),'<script>window.widgetReady=Promise.reject(new Error("bad widget"));widgetReady.catch(()=>{})</script>');
  await assert.rejects(runLocalPreview(input,{headless:true,report:message=>messages.push(message)}),/bad widget/);
  assert.deepEqual(JSON.parse(await readFile(join(input.out,'data.json'),'utf8')),{value:0});
  assert.ok(messages.every(message=>!message.startsWith('Preview ready:')));
});

test('browser shutdown cancels a timed-out renderer and removes its profile', async t => {
  const owned=await launchBrowser({headless:true});
  t.after(()=>owned.close());
  const page=await owned.browser.newPage();
  await assert.rejects(bounded(page.evaluate('while(true) {}'),{timeout:50,label:'Extraction'}),/Extraction timed out/);
  await owned.close();
  await owned.closed;
  await assert.rejects(stat(owned.profile),{code:'ENOENT'});
});

test('local preview renders extracted image data and accepts optional image removal', async t => {
  const input=await fixture(t);
  await writeFile(input.source,'<p id="value">7</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==">');
  await writeFile(join(input.out,'extra.js'),`(() => {${IMAGE_EXTRACTOR} return {value:7,image:createImageExtractor()(document.querySelector('img'))};})()`);
  await writeFile(join(input.out,'widget.html'),`<main id="widget-root"></main><script>
    window.renderWidget=d=>{const root=document.querySelector('#widget-root');root.replaceChildren();const p=document.createElement('p');p.textContent=d.value;root.append(p);if(d.image){const img=new Image();img.onerror=()=>img.remove();img.src=d.image;root.append(img);}};
    window.widgetReady=fetch('./data.json').then(r=>r.json()).then(renderWidget);window.widgetReady.catch(()=>{});
  </script>`);
  const first=preview(t,input), info=await first.ready;
  assert.match(JSON.parse(await readFile(info.dataPath,'utf8')).image,/^data:image\/png;base64,/);
  assert.equal(await info.page.evaluate(()=>document.querySelector('img')?.naturalWidth),1);
  first.stop.abort();await first.done;
  await writeFile(join(input.out,'extra.js'),'(() => ({value:8,image:"data:image/png;base64,bm90LXBuZw=="}))()');
  const second=preview(t,input), fallback=await second.ready;
  assert.equal(await fallback.page.evaluate(()=>document.querySelectorAll('img').length),0);
  assert.equal(await fallback.page.evaluate(()=>document.querySelector('#widget-root').textContent),'8');
  second.stop.abort();await second.done;
});
