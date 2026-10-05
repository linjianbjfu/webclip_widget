import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounded } from '../browser.mjs';

// This executable adapter affects only the child CLI; production still opens a visible browser.
test('actual CLI opens HTTP output without credentials and SIGINT/SIGTERM dispose resources', {
  skip: process.platform === 'win32' ? 'The test-only Chrome executable adapter uses a POSIX shebang' : false,
}, async t => {
  const root=await mkdtemp(join(tmpdir(),'webclip-preview-command-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const out=join(root,'out'); await mkdir(out);
  const profiles=join(root,'profiles'); await mkdir(profiles);
  const source=join(root,'source.html');
  await writeFile(source,'<p id="value">0</p><script>document.querySelector("#value").textContent="19"</script>');
  await writeFile(join(out,'extra.js'),'(() => ({value:Number(document.querySelector("#value").textContent)}))()');
  await writeFile(join(out,'meta.json'),'{"size":"small"}');
  await writeFile(join(out,'widget.html'),'<main id="widget-root"></main><script>window.widgetReady=fetch("./data.json").then(r=>r.json()).then(d=>document.querySelector("#widget-root").textContent=d.value);</script>');
  const chrome=process.env.CHROME_EXECUTABLE ?? (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'chromium');
  const launcher=join(root,'chrome-headless');
  await writeFile(launcher,`#!${process.execPath}\nconst {spawn}=require('node:child_process');
const child=spawn(${JSON.stringify(chrome)},['--headless',...process.argv.slice(2)],{stdio:'inherit'});
process.on('SIGTERM',()=>child.kill());process.on('SIGINT',()=>child.kill());
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('close',code=>{process.exitCode=code??0;});\n`,{mode:0o755});
  const env={...process.env,CHROME_EXECUTABLE:launcher,TMPDIR:profiles};
  delete env.WEBCLIP_URL; delete env.WEBCLIP_TOKEN;
  for (const [signal,stage] of [['SIGINT','ready'],['SIGTERM','waiting']]) {
    const child=spawn(process.execPath,[fileURLToPath(new URL('../index.mjs',import.meta.url)),'preview','--source',source,'--out',out],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    const closed=new Promise((resolve,reject)=>{child.once('close',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
    t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;});
    let reached;
    const checkpoint=new Promise(resolve=>{reached=resolve;});
    child.stdout.on('data',bytes=>{
      stdout+=bytes;
      if(stage==='ready'&&stdout.includes('Preview ready:'))reached();
      if(stage==='waiting'&&stdout.includes('waiting 3 seconds'))reached();
    });
    child.stderr.on('data',bytes=>{stderr+=bytes;});
    await bounded(Promise.race([checkpoint,closed.then(()=>{throw Error(`CLI exited early: ${stderr}`);})]),{timeout:60_000,label:'CLI ready'});
    const url=stdout.match(/Preview ready: (http:\/\/\S+)/)?.[1];
    if(url) {
      assert.equal((await fetch(url)).status,200);
      assert.deepEqual(await (await fetch(new URL('data.json',url))).json(),{value:19});
    }
    child.kill(signal);
    const exit=await bounded(closed,{timeout:15_000,label:'CLI shutdown'});
    assert.deepEqual(exit,{code:0,signal:null},stderr);
    if(url)await assert.rejects(fetch(url));
    assert.deepEqual((await readdir(profiles)).filter(name=>name.startsWith('webclip-browser-')),[]);
  }
  assert.deepEqual(JSON.parse(await readFile(join(out,'data.json'),'utf8')),{value:19});
});
