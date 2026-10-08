/** Opt-in capture v2 validation through the real model, server preview and local replay. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {capturePage} from './capture-page.mjs';
import {saveCaptureDebug} from './capture-debug.mjs';
import {saveArtifacts} from './artifacts.mjs';
import {Client} from './client.mjs';
import {launchBrowser} from './browser.mjs';
import {previewInputs,loadAndExtract} from './local-preview.mjs';
import {extractionExpression} from '../backend/src/agent/extraction.ts';
import {renderWidgetPreview} from '../backend/src/agent/preview-render.ts';

const {WEBCLIP_URL:baseUrl,WEBCLIP_TOKEN:token}=process.env;
if(!baseUrl||!token)throw Error('WEBCLIP_URL and WEBCLIP_TOKEN must be set');
await mkdir('downloads',{recursive:true});const root=await mkdtemp(resolve('downloads/dom-structure-check-'));
const client=new Client({baseUrl,token,userId:basename(root)}),results=[];
function populate(kind){
 const main=document.querySelector('main');main.replaceChildren();
 const el=(tag,text)=>{const node=document.createElement(tag);if(text)node.textContent=text;return node;};
 main.append(el('h1',kind==='table'?'热门话题':'今日新闻'));
 const records=[['北岸步道开放','128','林青'],['图书馆夜间开放','76','陈宁'],['城市木作展览','35','何云']];
 if(kind==='table'){
  const table=el('table');for(const [title,count] of records){const row=el('tr');row.append(el('td',title),el('td',count));table.append(row);}main.append(table);
 }else for(const [title,,author] of records){const outer=el('a');outer.href='/story/'+title;const box=el('div'),inner=el('a',author);inner.href='/author/'+author;box.append(inner);outer.append(el('h2',title),box);main.append(outer);}
}
const server=createServer((req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><meta charset="utf-8"><style>body{font:18px sans-serif}main{width:600px;margin:20px}td{padding:8px}a{display:block}</style><main></main><script>(${populate.toString()})(${JSON.stringify(req.url==='/table'?'table':'cards')})</script>`));
server.listen(0,'127.0.0.1');await once(server,'listening');
let owned;
try{
 owned=await launchBrowser({headless:true});
 for(const kind of ['table','cards']){
  let captured,sessionId,interaction;
  const url=`http://127.0.0.1:${server.address().port}/${kind}`;
  try{
   captured=await capturePage({url,select:true},{headless:true,report:()=>{},onPage:page=>{
    interaction=(async()=>{
     await page.evaluate(()=>{window.__webclipCapture.state.regions=[{id:'r1',el:document.querySelector('main')}];document.querySelector('[data-webclip-ui]').shadowRoot.querySelector('#finish').click();});
     await page.waitForFunction(()=>window.__webclipCapture.state.status==='preview',{polling:100});
     await page.evaluate(()=>document.querySelector('[data-webclip-ui]').shadowRoot.querySelector('#send').click());
    })();interaction.catch(()=>{void page.close();});
   }});await interaction;assert.ok(captured);assert.equal(captured.capture.version,2);
   const created=await client.createSession('DOM structure '+kind);assert.equal(created.status,201);sessionId=created.body.sessionId;
   const debug=await saveCaptureDebug({sessionId,captured,root});
   const result=await client.prompt({sessionId,files:captured.files,capture:captured.capture,text:kind==='table'?'用大号 widget 展示热门话题的全部三条标题与热度。':'用大号 widget 展示全部三条新闻标题和作者。',onFrame:f=>{if(f.event==='tool_end')console.log(kind,f.data.name,f.data.isError?'error':'ok');}});
   await writeFile(join(debug,'turn.json'),JSON.stringify(result));assert.equal(result.status,200);
   const end=result.frames.find(f=>f.event==='turn_end'&&f.data.turnId===result.turnId);assert.equal(end?.data.reason,'completed');
   const preview=result.frames.filter(f=>f.event==='entry'&&f.data?.message?.toolName==='preview_widget').at(-1)?.data.message;
   assert.equal(preview?.details?.valid,true);assert.match(JSON.stringify(preview.content),/captured DOM v2/);
   const out=await saveArtifacts({sessionId,out:end.data.out,root});
   const [source,dom,extra,html]=await Promise.all([join(debug,'source.html'),join(debug,'source.dom.json'),join(out,'extra.js'),join(out,'widget.html')].map(path=>readFile(path,'utf8')));
   const live=await owned.browser.newPage();await live.goto(url,{waitUntil:'load'});
   const liveData=await live.evaluate(extractionExpression(extra));await live.close();
   const offline=await owned.browser.newPage();const input=await previewInputs({out,snapshot:true});
   const offlineData=await loadAndExtract(offline,input,{report:()=>{}});await offline.close();assert.deepEqual(JSON.parse(offlineData),JSON.parse(liveData));
   for(const value of kind==='table'?['北岸步道开放','128','图书馆夜间开放','76','城市木作展览','35']:['北岸步道开放','林青','图书馆夜间开放','陈宁','城市木作展览','何云'])assert.ok(liveData.includes(value),value);
   const rendered=await renderWidgetPreview(owned.browser,{source,dom,extra,html,size:'large'});assert.deepEqual(rendered.errors,[]);
   await writeFile(join(out,'widget.png'),Buffer.from(rendered.screenshotBase64,'base64'));await writeFile(join(out,'data.json'),liveData);
   results.push({kind,sourceBytes:Buffer.byteLength(source),domBytes:Buffer.byteLength(dom),out,data:JSON.parse(liveData)});console.log('PASS',kind,out);
  }finally{await captured?.dispose();if(sessionId)await client.deleteSession(sessionId);}
 }
}finally{await owned?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await writeFile(join(root,'results.json'),JSON.stringify(results,null,2));console.log('Evidence:',root);}
