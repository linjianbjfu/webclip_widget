import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchBrowser} from '../browser.mjs';
import {inspectIconDisplay,assertIconDisplay,assertImageEmphasis} from '../design-icon-cases.mjs';
import {assertSeparatedIcons} from '../design-density-cases.mjs';
test('quiet backgrounds require source images and opaque text, not geometric decoration',async t=>{
 const root=await mkdtemp(join(tmpdir(),'webclip-icon-style-'));let owned;
 t.after(async()=>{await owned?.close();await rm(root,{recursive:true,force:true});});
 owned=await launchBrowser({headless:true});
 const page=await owned.browser.newPage();
 const uri=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=32;c.getContext('2d').fillRect(0,0,32,32);return c.toDataURL();});
 await page.close();
 const cases=[
  ['image','<img class="background" src="'+uri+'">','.background{opacity:.08}',true],
  ['container','<div class="background" style="opacity:.08"><img src="'+uri+'"></div>','',true],
  ['masked','<img class="background" src="'+uri+'">','.background{opacity:.16;mask-image:linear-gradient(to right,transparent,black)}',true],
  ['opaque','<img class="background" src="'+uri+'">','',false],
  ['faded-text','<img class="background" src="'+uri+'">','#widget-root{opacity:.08}',false],
  ['missing','','',false],
  ['broken','<img class="background" src="data:image/png;base64,AAAA">','.background{opacity:.08}',false],
  ['geometry','','#widget-root::before{content:"";position:absolute;width:80px;height:80px;border:2px solid orange;border-radius:50%;opacity:.08;background-image:linear-gradient(90deg,transparent 49%,orange 49%,orange 51%,transparent 51%),linear-gradient(transparent 49%,orange 49%,orange 51%,transparent 51%)}',false],
 ];
 for(const [name,content,style,valid] of cases){
  await writeFile(join(root,'widget.html'),`<style>body{margin:0}#widget-root{width:100vw;height:100vh;position:relative}.background{position:absolute;width:80px;height:80px}img{width:80px;height:80px}${style}</style><main id="widget-root">${content}<span>比分</span></main><script>window.widgetReady=Promise.resolve();</script>`);
  const display=await inspectIconDisplay(owned.browser,root,'large');
  if(valid)assertIconDisplay(display,{expectedIcons:0,expected:[uri],background:true});
  else assert.throws(()=>assertIconDisplay(display,{expectedIcons:0,background:true}),/source-image background/,name);
 }
});

test('image emphasis measures visible pixels rather than transparent outer margins',async t=>{
 const root=await mkdtemp(join(tmpdir(),'webclip-artwork-'));let owned;
 t.after(async()=>{await owned?.close();await rm(root,{recursive:true,force:true});});
 owned=await launchBrowser({headless:true});
 const page=await owned.browser.newPage();
 for(const inner of [28,12]){
  const uri=await page.evaluate(inner=>{const c=document.createElement('canvas');c.width=c.height=32;const x=c.getContext('2d');x.fillRect((32-inner)/2,(32-inner)/2,inner,inner);return c.toDataURL();},inner);
  await writeFile(join(root,'widget.html'),`<style>body{margin:0}#widget-root{width:100vw;height:100vh}img{width:32px;height:32px;object-fit:contain}</style><main id="widget-root"><img src="${uri}">应用</main><script>window.widgetReady=Promise.resolve()</script>`);
  const display=await inspectIconDisplay(owned.browser,root,'large');
  assert.deepEqual(display.artwork,[{width:inner,height:inner}]);
  if(inner===28)assertImageEmphasis(display,1);
  else assert.throws(()=>assertImageEmphasis(display,1),/too small/);
 }
});

test('foreground image geometry rejects overlapping and touching images in adjacent rows',async t=>{
 const root=await mkdtemp(join(tmpdir(),'webclip-icon-spacing-'));let owned;
 t.after(async()=>{await owned?.close();await rm(root,{recursive:true,force:true});});
 owned=await launchBrowser({headless:true});
 const page=await owned.browser.newPage();
 const uri=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=32;c.getContext('2d').fillRect(0,0,32,32);return c.toDataURL();});
 await page.close();
 for(const height of [30,32,40]){
  await writeFile(join(root,'widget.html'),`<style>body{margin:0}#widget-root{width:100vw;height:100vh}.team{display:flex;align-items:center;height:${height}px}img{width:32px;height:32px}</style><main id="widget-root">${['A','B'].map(name=>`<div class="team"><img src="${uri}">${name}</div>`).join('')}</main><script>window.widgetReady=Promise.resolve()</script>`);
  const display=await inspectIconDisplay(owned.browser,root,'large');
  assert.equal(display.boxes.length,2);
  if(height<=32)assert.throws(()=>assertSeparatedIcons(display.boxes),/icons overlap/);
  else assertSeparatedIcons(display.boxes);
 }
});
