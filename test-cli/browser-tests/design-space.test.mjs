import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser} from '../browser.mjs';
import {spaceTitles,measureList,assertListCapacity} from '../design-space-cases.mjs';

test('capacity checks reject premature truncation, shrunken text and clipped titles',async t=>{
 const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
 const page=await owned.browser.newPage();await page.setViewport({width:344,height:360,deviceScaleFactor:1});
 async function render({count=8,font=15,clip=false}={}){
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}#widget-root{width:344px;height:360px;padding:20px}h1{font:20px/26px sans-serif;margin:0 0 12px}.note{font:12px/16px sans-serif;margin:0 0 12px}ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:12px}li{font:${font}px/21px sans-serif;${clip?'height:10px;overflow:hidden':''}}</style><main id="widget-root"><h1>市场热点</h1><p class="note">前 ${count} 条 · 共 10 条</p><ol>${spaceTitles.slice(0,count).map(title=>`<li>${title}</li>`).join('')}</ol></main>`);
  return page.evaluate(measureList,spaceTitles);
 }
 assertListCapacity(await render(),{titles:spaceTitles,min:7,fill:true});
 assert.throws(()=>assertListCapacity({records:[],text:'',bottom:340},{titles:spaceTitles,min:7}));
 for(const options of [{count:5},{font:12},{clip:true}]){
  const measured=await render(options);assert.throws(()=>assertListCapacity(measured,{titles:spaceTitles,min:7,fill:true}));
 }
 const five=await render({count:5});assert.throws(()=>assertListCapacity(five,{titles:spaceTitles,min:5,fill:true}),/unused bottom/);
 assertListCapacity(five,{titles:spaceTitles,min:5,max:5});
 const eight=await render();assert.throws(()=>assertListCapacity({...eight,text:'前 5 条 · 共 10 条'},{titles:spaceTitles,min:7,fill:true}),/shown count/);
});
