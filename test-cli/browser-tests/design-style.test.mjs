import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser} from '../browser.mjs';
import {measureStyle,assertStyle} from '../design-style-cases.mjs';

test('style checks reject missing grouping, faded text and invalid background images',async t=>{
 const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
 const page=await owned.browser.newPage();await page.setViewport({width:344,height:160,deviceScaleFactor:1});
 await page.setContent('<style>body{margin:0;background:#fff}#widget-root{height:160px;position:relative}.group{background:#f5f5f5}img{position:absolute;right:0;opacity:.15;width:60px;height:60px}</style><main id="widget-root"><h1>植物记录</h1><section class="group">东窗</section><img></main>');
 await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=c.height=20;c.getContext('2d').fillRect(0,0,20,20);const img=document.querySelector('img');img.src=c.toDataURL();await img.decode();});
 const valid=await page.evaluate(measureStyle);assertStyle(valid,{group:true,background:true});
 await page.$eval('img',el=>el.style.position='static');
 const inline=await page.evaluate(measureStyle);assert.throws(()=>assertStyle(inline,{background:true}),/background img/);
 await page.$eval('img',el=>{const layer=document.createElement('div');layer.style.cssText='position:absolute;right:0;top:0';el.replaceWith(layer);layer.append(el);});
 assertStyle(await page.evaluate(measureStyle),{group:true,background:true});
 await page.$eval('.group',el=>el.style.background='transparent');
 const noGroup=await page.evaluate(measureStyle);assert.throws(()=>assertStyle(noGroup,{group:true}),/muted group/);
 await page.$eval('#widget-root',el=>el.style.opacity='.2');
 const faded=await page.evaluate(measureStyle);assert.throws(()=>assertStyle(faded),/dim text/);
 await page.$eval('#widget-root',el=>el.style.opacity='1');
 await page.$eval('img',el=>el.remove());
 const missing=await page.evaluate(measureStyle);assert.throws(()=>assertStyle(missing,{background:true}),/background img/);
 assertStyle(missing,{noImage:true});assert.throws(()=>assertStyle(valid,{noImage:true}),/no-image/);
 assert.throws(()=>assertStyle({...valid,images:[{...valid.images[0],decoded:false}]},{background:true}),/background img/);
 assert.throws(()=>assertStyle({...valid,surface:'rgb(0, 0, 0)'}),/theme surface/);
});
