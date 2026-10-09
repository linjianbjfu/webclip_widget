import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {encode} from 'fast-png';
import {launchBrowser} from '../../../test-cli/browser.mjs';
import {IMAGE_EXTRACTOR,IMAGE_ACCEPT} from '../design-system/images.ts';

test('image negotiation bypasses an opaque cached variant and preserves transparent response bytes',async t=>{
 const png=Buffer.from(encode({width:2,height:1,channels:4,data:new Uint8Array([0,0,0,0,0,0,0,255])}));
 let jpeg;const requests=[];
 const server=createServer((req,res)=>{
  if(req.url==='/')return res.writeHead(200,{'content-type':'text/html'}).end('<p>Images</p>');
  const negotiated=req.headers.accept===IMAGE_ACCEPT;
  requests.push({path:req.url,accept:req.headers.accept});
  // No Vary header models a CDN whose opaque cached response ignores Accept differences.
  res.writeHead(200,{'content-type':negotiated?'image/png':'image/jpeg','cache-control':'public,max-age=3600'}).end(negotiated?png:jpeg);
 });
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
 const page=await owned.browser.newPage();await page.goto(origin);
 jpeg=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=2;c.height=1;return c.toDataURL('image/jpeg').split(',')[1];}),'base64');
 const variants=[['current',IMAGE_EXTRACTOR],['old-cache',IMAGE_EXTRACTOR.replace("cache:'reload'","cache:'force-cache'")],['no-accept',IMAGE_EXTRACTOR.replace(`headers:{Accept:'${IMAGE_ACCEPT}'}`, 'headers:{}')]];
 for(const [id,helper] of variants){
  const url=origin+'/'+id;
  await page.evaluate(async url=>{await (await fetch(url,{credentials:'omit',cache:'force-cache'})).arrayBuffer();},url);
  const uri=await page.evaluate(`(async()=>{${helper};const img=new DOMParser().parseFromString('<img>','text/html').querySelector('img');img.src=${JSON.stringify(url)};return createImageExtractor()(img);})()`);
  if(id==='current'){
   assert.equal(uri,'data:image/png;base64,'+png.toString('base64'));
   const pixels=await page.evaluate(async uri=>{const i=new Image();i.src=uri;await i.decode();const c=document.createElement('canvas');c.width=2;c.height=1;const x=c.getContext('2d');x.drawImage(i,0,0);return [...x.getImageData(0,0,2,1).data];},uri);
   assert.deepEqual(pixels,[0,0,0,0,0,0,0,255]);
  }else assert.equal(uri,'data:image/jpeg;base64,'+jpeg.toString('base64'),id+' must reproduce opaque result');
 }
 assert.equal(requests.filter(r=>r.path==='/old-cache').length,1,'negative control must use the cached response');
 assert.deepEqual(requests.filter(r=>r.path==='/current').map(r=>r.accept),['*/*',IMAGE_ACCEPT]);
});
