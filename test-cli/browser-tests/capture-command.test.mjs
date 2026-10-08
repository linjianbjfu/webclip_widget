import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {bounded} from '../browser.mjs';

test('actual prompt --url captures source and image before posting multipart and saves the bundle',{
 skip:process.platform==='win32'?'The browser executable adapter uses a POSIX shebang':false,
},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'webclip-capture-command-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const sessionId=randomUUID();let captured,creates=0,rejectPrompt=false,savedBeforePost=false;
 const files=[['extra.js','(() => ({price:7}))()'],['widget.html','<p>7</p>'],['meta.json','{"size":"small"}']].map(([name,content])=>({path:'out/'+name,content,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')}));
 const server=createServer(async(req,res)=>{
  if(req.url==='/page'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<p id="price">0</p><script>document.querySelector("#price").textContent="7"</script>');return;}
  if(req.url==='/v1/sessions'){creates++;res.writeHead(201,{'content-type':'application/json'}).end(JSON.stringify({sessionId}));return;}
  if(!req.url.endsWith('/prompt')){res.writeHead(204).end();return;}
  const parts=[];for await(const part of req)parts.push(part);
  const form=await new Response(Buffer.concat(parts),{headers:{'content-type':req.headers['content-type']}}).formData();captured=form;
  try {
   const debug=join(dir,'downloads',sessionId,'capture');
   savedBeforePost=JSON.stringify(JSON.parse(await readFile(join(debug,'capture.json'),'utf8')))===JSON.stringify(JSON.parse(form.get('capture')));
  } catch { savedBeforePost=false; }
  if(rejectPrompt){res.writeHead(500,{'content-type':'application/json'}).end('{"error":"fixture_failure"}');return;}
  const data={turnId:form.get('turnId'),reason:'completed',out:files};
  res.writeHead(200,{'content-type':'text/event-stream'}).end(`event: turn_end\ndata: ${JSON.stringify(data)}\n\nevent: stream_end\ndata: {"sessionBusy":false}\n\n`);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const url=`http://127.0.0.1:${server.address().port}`;
 const chrome=process.env.CHROME_EXECUTABLE??(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'chromium');
 const launcher=join(dir,'headless-chrome');await writeFile(launcher,`#!${process.execPath}\nconst{spawn}=require('node:child_process');const c=spawn(${JSON.stringify(chrome)},['--headless',...process.argv.slice(2)],{stdio:'inherit'});process.on('SIGTERM',()=>c.kill());c.on('close',code=>{process.exitCode=code??0;});\n`,{mode:0o755});
 const child=spawn(process.execPath,[fileURLToPath(new URL('../index.mjs',import.meta.url)),'prompt','capture price','--url',url+'/page'],{cwd:dir,env:{...process.env,CHROME_EXECUTABLE:launcher,WEBCLIP_URL:url,WEBCLIP_TOKEN:'fixture'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{output+=bytes;});
 const closed=once(child,'close');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed;});
 const [code,signal]=await bounded(closed,{timeout:60000,label:'capture CLI'});assert.equal(signal,null);assert.equal(code,0,output);assert.equal(creates,1);
 assert.equal(savedBeforePost,true);assert.match(output,/Capture saved:/);
 const capture=JSON.parse(captured.get('capture'));assert.equal(capture.mode,'page');assert.equal(capture.images.length,1);assert.equal(captured.get('text'),'capture price');
 const uploads=captured.getAll('file');const source=uploads.find(f=>f.name==='source.html');assert.match(await source.text(),/>7<\/p>/);assert.doesNotMatch(await source.text(),/data-webclip-ui/);
 assert.equal(capture.version,2);assert.equal(capture.dom,'source.dom.json');
 const domFile=uploads.find(f=>f.name===capture.dom);assert.ok(domFile);
 const {validateDomSnapshot}=await import('../../backend/src/dom-snapshot.ts');
 await validateDomSnapshot(await source.text(),await domFile.text());
 assert.ok(uploads.find(f=>f.name===capture.images[0].file));
 for(const file of files)assert.equal(await readFile(join(dir,'downloads',sessionId,file.path.slice(4)),'utf8'),file.content);
 const debug=join(dir,'downloads',sessionId,'capture');
 assert.equal(await readFile(join(debug,'source.html'),'utf8'),await source.text());
 assert.equal(await readFile(join(debug,'source.dom.json'),'utf8'),await domFile.text());
 const uploadedImage=uploads.find(f=>f.name===capture.images[0].file);
 assert.deepEqual(await readFile(join(debug,capture.images[0].file)),Buffer.from(await uploadedImage.arrayBuffer()));
 rejectPrompt=true;savedBeforePost=false;
 const failed=spawn(process.execPath,[fileURLToPath(new URL('../index.mjs',import.meta.url)),'prompt',sessionId,'capture again','--url',url+'/page'],{cwd:dir,env:{...process.env,CHROME_EXECUTABLE:launcher,WEBCLIP_URL:url,WEBCLIP_TOKEN:'fixture'},stdio:['ignore','pipe','pipe']});
 let failureOutput='';failed.stdout.on('data',bytes=>{failureOutput+=bytes;});failed.stderr.on('data',bytes=>{failureOutput+=bytes;});
 const failureClosed=once(failed,'close');t.after(async()=>{if(failed.exitCode===null&&failed.signalCode===null)failed.kill();await failureClosed;});
 const [failureCode,failureSignal]=await bounded(failureClosed,{timeout:60000,label:'failed capture CLI'});
 assert.equal(failureSignal,null);assert.equal(failureCode,1,failureOutput);assert.match(failureOutput,/Capture saved:/);assert.match(failureOutput,/Prompt failed: 500/);assert.equal(savedBeforePost,true);
 const retryCapture=JSON.parse(captured.get('capture'));
 assert.deepEqual(JSON.parse(await readFile(join(debug,'capture.json'),'utf8')),retryCapture);
 assert.equal(await readFile(join(debug,'source.html'),'utf8'),await captured.getAll('file').find(f=>f.name==='source.html').text());

});
