import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile,stat} from 'node:fs/promises';
import {capturePage} from '../capture-page.mjs';
import {launchBrowser,bounded} from '../browser.mjs';
import {composeCaptureImage} from '../capture-images.mjs';

const html=`<!doctype html><html><head><style>body{margin:0;font:20px sans-serif}section{width:600px;height:180px;margin:20px;background:#eef}#tiny{margin:20px;font:16px sans-serif;height:24px}canvas{width:300px;height:100px}</style></head><body>
<section id="quote"><h2>微软股价</h2><p>价格 <span id="price">0</span></p></section><section id="chart"><h2>趋势区域</h2><canvas id="canvas" width="300" height="100"></canvas></section><p id="tiny">单行文本 0</p><iframe id="frame" srcdoc="<p>frame</p>"></iframe><div id="shadow"></div>
<script>document.querySelector('#price').textContent='420';document.querySelector('#canvas').getContext('2d').fillRect(10,10,60,60);document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>shadow content</p>';</script></body></html>`;
async function serverFixture(t,source=html){
 const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'/page'}).end();return;}res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end(source);});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));return `http://127.0.0.1:${server.address().port}`;
}
async function button(page,id){await page.evaluate(id=>document.querySelector('[data-webclip-ui]').shadowRoot.querySelector('#'+id).click(),id);}
async function drag(page,id){const rect=await page.$eval(id,el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};});await page.mouse.move(rect.x+3,rect.y+3);await page.mouse.down();await page.mouse.move(rect.x+rect.width-3,rect.y+rect.height-3,{steps:5});await page.mouse.up();}

test('nested news card reaches preview with unchanged live structure in capture v2',async t=>{
 const url=await serverFixture(t,`<!doctype html><html><head><style>article{margin:20px;width:600px;height:180px;background:#eef}</style></head><body><article id="card"></article><script>
 const outer=document.createElement('a');outer.href='/news';outer.innerHTML='<h2>新闻标题</h2><div class="author"></div>';
 const author=document.createElement('a');author.href='/author';author.textContent='作者';outer.querySelector('div').append(author);document.querySelector('#card').append(outer);
 </script></body></html>`);
 let interaction;const reports=[];
 const result=await capturePage({url,select:true},{headless:true,report:message=>reports.push(message),onPage:page=>{
  interaction=(async()=>{
   await page.evaluate(()=>{window.__webclipCapture.state.regions=[{id:'r1',el:document.querySelector('#card > a')},{id:'r2',el:document.querySelector('a[href="/author"]')}];});
   await button(page,'finish');
   await page.waitForFunction(()=>window.__webclipCapture.state.status==='preview',{polling:100});await button(page,'send');
  })();interaction.catch(()=>{void button(page,'cancel').catch(()=>{});});
 }});
 await interaction;assert.ok(result);t.after(()=>result.dispose());
 assert.equal(result.capture.regions.length,2);assert.equal(result.capture.images.length,1);
 assert.equal(result.capture.version,2);assert.equal(result.capture.dom,'source.dom.json');assert.equal(result.capture.regions[1].sourceXPath,undefined);
 const source=await readFile(result.files[0],'utf8');assert.match(source,/新闻标题/);assert.match(source,/href="\/author"/);assert.doesNotMatch(source,/data-webclip-region-map/);
 assert.ok(!reports.some(message=>message.includes('拆分')));assert.ok(reports.every(message=>!message.includes('pptr:')));
});

test('real region UI captures current DOM, montage and optional text without crossing frames/shadow',async t=>{
 const url=await serverFixture(t);let completed;
 const run=capturePage({url:url+'/redirect',select:true},{headless:true,report:()=>{},onPage:page=>{
  completed=(async()=>{
   await drag(page,'#quote');await drag(page,'#chart');await drag(page,'#tiny');
   await drag(page,'#frame');await drag(page,'#shadow');
   assert.equal(await page.evaluate(()=>window.__webclipCapture.state.regions.length),3);
   await button(page,'finish');await page.waitForFunction(()=>window.__webclipCapture.state.status==='preview',{polling:100});
   await button(page,'back');await button(page,'finish');await page.waitForFunction(()=>window.__webclipCapture.state.status==='preview',{polling:100});await button(page,'send');
  })();completed.catch(error=>{console.error(error);void button(page,'cancel').catch(()=>{});});
 }});
 const result=await bounded(run,{timeout:60000});await completed;assert.ok(result);t.after(()=>result.dispose());
 assert.equal(result.capture.pageUrl,url+'/page');assert.equal(result.capture.requestUrl,url+'/redirect');
 assert.equal(result.capture.images.length,1);assert.equal(result.capture.images[0].role,'montage');
 assert.equal(result.capture.regions.length,3);assert.equal(result.capture.regions[2].imageId,undefined);
 assert.equal(result.capture.regions[0].imageId,result.capture.regions[1].imageId);
 assert.ok(result.capture.images[0].width<=1200&&result.capture.images[0].height<=1200);
 const source=await readFile(result.files[0],'utf8');assert.match(source,/420/);assert.doesNotMatch(source,/data-webclip-ui|id="shadow"|id="frame"/);
 const png=await readFile(result.files[1]);assert.equal(png.readUInt32BE(16),result.capture.images[0].width);
 await result.dispose();await assert.rejects(stat(result.files[0]));
});

test('no selection produces one full-page image and cancellation produces no upload',async t=>{
 const url=await serverFixture(t);
 const page=await capturePage({url,select:false},{headless:true,report:()=>{}});t.after(()=>page.dispose());
 assert.equal(page.capture.mode,'page');assert.deepEqual(page.capture.regions,[]);assert.equal(page.capture.images.length,1);assert.ok(page.capture.images[0].width<=768&&page.capture.images[0].height<=768);
 const cancelled=await capturePage({url,select:true},{headless:true,report:()=>{},onPage:p=>button(p,'cancel')});assert.equal(cancelled,null);
});

test('montage fits eight mixed-aspect tiles and never enlarges small full-page images',async t=>{
 const owned=await launchBrowser({headless:true});t.after(()=>owned.close());const page=await owned.browser.newPage();
 const data=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1536;c.height=768;return c.toDataURL().split(',')[1];});
 const tall=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=600;c.height=1200;return c.toDataURL().split(',')[1];});
 const tiles=Array.from({length:8},(_,i)=>({id:'r'+(i+1),data:i%2?tall:data}));
 const image=await composeCaptureImage(page,tiles,'regions',{width:1536,height:768});assert.equal(image.boxes.length,8);assert.ok(image.width<=1200&&image.height<=1200);
 for(const [i,box] of image.boxes.entries()){assert.ok(box.x+box.width<=image.width&&box.y+box.height<=image.height);assert.ok(Math.abs(box.width/box.height-(i%2?.5:2))<.03);}
 const whole=await composeCaptureImage(page,[tiles[0]],'page',{width:1536,height:768});assert.equal(whole.width,768);assert.equal(whole.height,384);
});


test('stale targets cannot submit and clearing/reselecting pure text sends no image',async t=>{
 const url=await serverFixture(t);let interaction;
 const result=await capturePage({url,select:true},{headless:true,report:()=>{},onPage:page=>{
  interaction=(async()=>{
   await drag(page,'#quote');
   await page.evaluate(()=>document.querySelector('#quote').remove());
   await button(page,'finish');
   assert.equal(await page.evaluate(()=>window.__webclipCapture.state.status),'selecting');
   assert.match(await page.evaluate(()=>document.querySelector('[data-webclip-ui]').shadowRoot.querySelector('#error').textContent),/变化/);
   await button(page,'clear');await drag(page,'#tiny');await button(page,'finish');
   await page.waitForFunction(()=>window.__webclipCapture.state.status==='preview',{polling:100});await button(page,'send');
  })();interaction.catch(()=>{void button(page,'cancel').catch(()=>{});});
 }});await interaction;assert.ok(result);t.after(()=>result.dispose());
 assert.equal(result.capture.mode,'regions');assert.equal(result.capture.regions.length,1);assert.deepEqual(result.capture.images,[]);assert.equal(result.files.length,2);
 assert.ok(result.capture.regions[0].text.includes('单行文本'));
});
