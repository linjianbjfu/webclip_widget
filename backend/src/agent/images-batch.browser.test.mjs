import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encode} from 'fast-png';
import {launchBrowser} from '../../../test-cli/browser.mjs';
import {IMAGE_EXTRACTOR,IMAGE_LIMITS} from '../design-system/images.ts';

const png=Buffer.from(encode({width:1,height:1,data:new Uint8Array([50,120,190,0]),channels:4}));
const uri='data:image/png;base64,'+png.toString('base64');
async function fixture(t){
 const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
 const page=await owned.browser.newPage();await page.setContent('<p>Images</p>');
 await page.evaluate(new Function(`${IMAGE_EXTRACTOR};window.extract=createImageExtractor();window.img=url=>{const n=new DOMParser().parseFromString('<img>','text/html').querySelector('img');n.src=url;return n;};`));
 return page;
}
test('batch retains fourteen transparent icons and charges repeated output URIs',async t=>{
 const page=await fixture(t);
 const result=await page.evaluate(async({uri,count})=>{
  const values=await window.extract.all(Array.from({length:count+1},()=>window.img(uri)));
  const image=new Image();image.src=values[0];await image.decode();
  const c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').drawImage(image,0,0);
  return {values,alpha:c.getContext('2d').getImageData(0,0,1,1).data[3]};
 },{uri,count:IMAGE_LIMITS.count});
 assert.deepEqual(result.values,[...Array(IMAGE_LIMITS.count).fill(uri),null]);assert.equal(result.alpha,0);
});
test('batch limits concurrent reads, commits bytes in source order and deduplicates URLs',async t=>{
 const page=await fixture(t);
 const medium=Buffer.concat([png,Buffer.alloc(95_000)]).toString('base64');
 await page.evaluate(({medium})=>{
  window.pending=new Map();window.started=[];window.active=0;window.maxActive=0;
  window.fetch=(url)=>new Promise(resolve=>{
   window.started.push(url);window.active++;window.maxActive=Math.max(window.maxActive,window.active);
   window.pending.set(url,()=>{window.active--;resolve(new Response(Uint8Array.from(atob(medium),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}}));});
  });
  window.batch=window.extract.all([0,1,2,3,3].map(i=>window.img('https://fixture.invalid/'+i)));
 },{medium});
 await page.waitForFunction(()=>window.started.length===3);
 await page.evaluate(()=>{window.pending.get('https://fixture.invalid/2')();window.pending.get('https://fixture.invalid/1')();});
 await page.waitForFunction(()=>window.started.length===4);
 await page.evaluate(()=>{window.pending.get('https://fixture.invalid/3')();window.pending.get('https://fixture.invalid/0')();});
 const result=await page.evaluate(async()=>({values:(await window.batch).map(Boolean),maxActive:window.maxActive,started:window.started}));
 assert.equal(result.maxActive,3);assert.equal(result.started.length,4);
 assert.deepEqual(result.values,[true,true,false,false,false]);
});
test('batch deadline cancels active reads and leaves queued candidates and text available',async t=>{
 const page=await fixture(t);
 const result=await page.evaluate(async()=>{
  let active=0,aborted=0;const starts=[],start=performance.now();
  window.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{
   active++;starts.push(performance.now()-start);
   signal.addEventListener('abort',()=>{active--;aborted++;reject(new DOMException('Stopped','AbortError'));},{once:true});
  });
  const images=await window.extract.all(Array.from({length:24},(_,i)=>window.img('https://fixture.invalid/'+i)));
  return {images,active,aborted,starts,elapsed:performance.now()-start,text:document.querySelector('p').textContent};
 });
 assert.deepEqual(result.images,Array(24).fill(null));assert.equal(result.active,0);assert.equal(result.aborted,result.starts.length);
 assert.ok(result.starts.length<24);assert.ok(result.starts.every(ms=>ms<IMAGE_LIMITS.batchTimeoutMs));
 assert.ok(result.elapsed<15_000,'image work exceeded the extraction deadline');assert.equal(result.text,'Images');
});
test('decoding timeout discards late image results and closes their bitmap',async t=>{
 const page=await fixture(t);
 const large=Buffer.concat([png,Buffer.alloc(140_000)]).toString('base64');
 await page.evaluate(large=>{
  window.fetch=async()=>new Response(Uint8Array.from(atob(large),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}});
  window.bitmapClosed=false;window.createImageBitmap=()=>new Promise(resolve=>{window.finishDecode=()=>resolve({width:1,height:1,close(){window.bitmapClosed=true;}});});
  window.batch=window.extract.all([window.img('https://fixture.invalid/large')]);
 },large);
 await page.waitForFunction(()=>typeof window.finishDecode==='function');
 assert.deepEqual(await page.evaluate(()=>window.batch),[null]);
 await page.evaluate(()=>window.finishDecode());await page.waitForFunction(()=>window.bitmapClosed);
 assert.deepEqual(await page.evaluate(()=>window.batch),[null]);
});
