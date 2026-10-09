import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser} from '../browser.mjs';
import {spaceTitles,measureList,assertListCapacity,assertNoListCoverage} from '../design-space-cases.mjs';

test('capacity checks reject truncation, unreadable titles and unsolicited coverage notices',async t=>{
 const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
 const page=await owned.browser.newPage();await page.setViewport({width:344,height:360,deviceScaleFactor:1});
 async function render({count=10,font=15,clip=false,notice=''}={}){
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}#widget-root{width:344px;height:360px;padding:20px}h1{font:20px/26px sans-serif;margin:0 0 12px}.note{font:12px/16px sans-serif;}ol{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}li{font:${font}px/21px sans-serif;${clip?'height:10px;overflow:hidden':''}}</style><main id="widget-root"><h1>市场热点</h1><p class="note">${notice}</p><ol>${spaceTitles.slice(0,count).map(title=>`<li>${title}</li>`).join('')}</ol></main>`);
  return page.evaluate(measureList,spaceTitles);
 }
 assertListCapacity(await render(),{titles:spaceTitles,min:10,fill:true});
 const nine=await render({count:9});assert.throws(()=>assertListCapacity(nine,{titles:spaceTitles,min:10}),/expected 10/);
 assert.throws(()=>assertListCapacity({records:[],text:'',bottom:340},{titles:spaceTitles,min:7}));
 for(const options of [{count:5},{font:12},{clip:true}]){
  const measured=await render(options);assert.throws(()=>assertListCapacity(measured,{titles:spaceTitles,min:7,fill:true}));
 }
 const five=await render({count:5});assert.throws(()=>assertListCapacity(five,{titles:spaceTitles,min:5,fill:true}),/unused bottom/);
 assertListCapacity(five,{titles:spaceTitles,min:5,max:5});
 for(const notice of ['精选前 9 条 · 共 10 条','9/10','9／10','全部 10 条热点','Showing 9 of 10','剩余 1 条','热点精选']){
  const measured=await render({count:5,notice});
  assert.throws(()=>assertListCapacity(measured,{titles:spaceTitles,min:5,max:5}),/coverage notice/);
 }
 assertNoListCoverage('1 商品价格 89 元，销量 200 件\n2 进度 9/10\n3 今日精选商品 共10项',['商品价格 89 元，销量 200 件','进度 9/10','今日精选商品 共10项']);
});
