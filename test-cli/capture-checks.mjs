/** Opt-in live model validation of selected montage and full-page image inputs. */
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomInt} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {capturePage} from './capture-page.mjs';
import {Client} from './client.mjs';
import {saveArtifacts} from './artifacts.mjs';

const {WEBCLIP_URL:baseUrl,WEBCLIP_TOKEN:token}=process.env;
if(!baseUrl||!token)throw Error('WEBCLIP_URL and WEBCLIP_TOKEN must be set');
const client=new Client({baseUrl,token,userId:'capture-live-check'});
const server=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;font:22px sans-serif}#quote{margin:30px;padding:20px;width:600px;background:#edf4ff}canvas{display:block}</style><section id="quote"><h2>微软</h2><p>当前股价：<strong id="price">420</strong> 美元</p><canvas id="marker" width="450" height="70"></canvas></section>`));
server.listen(0,'127.0.0.1');await once(server,'listening');
try {
 for(const select of [true,false]) {
  const marker=String(randomInt(100000,999999));let interaction;
  const captured=await capturePage({url:`http://127.0.0.1:${server.address().port}`,select},{headless:true,onPage:async page=>{
   await page.evaluate(marker=>{const ctx=document.querySelector('#marker').getContext('2d');ctx.fillStyle='#163457';ctx.font='bold 42px sans-serif';ctx.fillText(marker,20,50);},marker);
   if(select) {
    interaction=(async()=>{
     const r=await page.$eval('#quote',el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};});
     await page.mouse.move(r.x+3,r.y+3);await page.mouse.down();await page.mouse.move(r.x+r.width-3,r.y+r.height-3,{steps:5});await page.mouse.up();
     await page.evaluate(()=>document.querySelector('[data-webclip-ui]').shadowRoot.querySelector('#finish').click());
     await page.waitForFunction(()=>window.__webclipCapture.state.status==='preview',{polling:100});
     await page.evaluate(()=>document.querySelector('[data-webclip-ui]').shadowRoot.querySelector('#send').click());
    })(); interaction.catch(()=>{});
   }
  }});
  await interaction;
  if(!captured)throw Error('Capture cancelled');
  let sessionId;
  try {
   if((await readFile(captured.files[0],'utf8')).includes(marker)||JSON.stringify(captured.capture).includes(marker))throw Error('Visual marker leaked into text fixture');
   const created=await client.createSession('capture '+(select?'regions':'page'));sessionId=created.body.sessionId;
   console.log('Generating',select?'regions':'page');
   const result=await client.prompt({sessionId,text:'生成小号微软当前股价 widget。截图中的六位数字仅是视觉校验码，不是业务数据；请在最后回复写出你看到的校验码，不要把校验码写入产物。',files:captured.files,capture:captured.capture,onFrame:frame=>{if(frame.event==='tool_end')console.log(frame.data.name,frame.data.isError?'error':'done');}});
   const end=result.frames.find(frame=>frame.event==='turn_end'&&frame.data.turnId===result.turnId);
   if(end?.data.reason!=='completed')throw Error('Turn failed: '+JSON.stringify(result.frames.filter(f=>f.event==='error').map(f=>f.data)));
   const assistants=result.frames.filter(f=>f.event==='entry'&&f.data?.message?.role==='assistant').flatMap(f=>f.data.message.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
   if(!assistants.includes(marker))throw Error('The image-only marker was not recognized');
   const preview=result.frames.filter(f=>f.event==='entry'&&f.data?.message?.toolName==='preview_widget').at(-1)?.data.message;
   if(preview?.details?.valid!==true)throw Error('Final widget preview did not pass');
   console.log('PASS image comprehension and widget:',await saveArtifacts({sessionId,out:end.data.out}));
  } finally {await captured.dispose();if(sessionId)await client.deleteSession(sessionId);}
 }
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
