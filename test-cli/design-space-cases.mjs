/** Content-capacity regressions based on the captured Xueqiu headlines. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startPreviewServer} from './preview-server.mjs';
import {renderWidgetPreview} from '../backend/src/agent/preview-render.ts';

export const spaceTitles=[
 'OpenAI营收预期差200亿，AI板块巨震','煤化工景气回暖，广汇能源业绩大增',
 '银行股逆势走强，工行中行同创新高','玻璃基板概念走弱，沃格光电大跌',
 '港股大模型双雄走弱，MINIMAX-W大跌','CPO概念大跌，长光华芯触及跌停',
 '农业板块活跃，金健米业逼近涨停','深物业A涨停，房地产板块拉升',
 '固态电池板块走强，传艺科技拉升','PCB概念活跃，世名科技涨停',
];
const body=titles=>'<h1>市场热点</h1><table>'+titles.map((title,i)=>`<tr><td>${i+1}</td><td><a href="https://example.test/topic/${i+1}">${title}</a></td></tr>`).join('')+'</table>';
export const spaceCases=[
 {id:'space-list',size:'large',text:'用大号 widget 展示这些市场热点。',body:body(spaceTitles),space:true},
 {id:'space-limited',size:'large',text:'用大号 widget 只展示排名前五条市场热点，不要增加其他条目。',body:body(spaceTitles),space:true,explicitCount:5},
];

/** Runs inside the rendered page; match complete source titles independently of model-selected markup. */
export function measureList(titles){
 const root=document.querySelector('#widget-root'),bounds=root.getBoundingClientRect(),style=getComputedStyle(root);
 const records=titles.map(title=>{
  const el=[...root.querySelectorAll('*')].find(el=>el.textContent.trim()===title && ![...el.children].some(child=>child.textContent.trim()===title));
  if(!el)return null;
  const css=getComputedStyle(el),range=document.createRange();range.selectNodeContents(el);
  const rect=range.getBoundingClientRect();
  if(!rect.width||!rect.height||css.visibility==='hidden'||css.display==='none')return null;
  let clipped=rect.top<bounds.top-.5||rect.bottom>bounds.bottom+.5||rect.left<bounds.left-.5||rect.right>bounds.right+.5;
  for(let node=el;node&&node!==root;node=node.parentElement){
   const parent=getComputedStyle(node),box=node.getBoundingClientRect();
   if(/hidden|clip|scroll|auto/.test(parent.overflowY)&&rect.bottom>box.bottom+.5)clipped=true;
   if(/hidden|clip|scroll|auto/.test(parent.overflowX)&&(rect.left<box.left-.5||rect.right>box.right+.5))clipped=true;
  }
  return {title,top:rect.top,bottom:rect.bottom,font:parseFloat(css.fontSize),lineHeight:parseFloat(css.lineHeight)||parseFloat(css.fontSize)*1.2,clipped};
 }).filter(Boolean);
 return {records,text:root.innerText,bottom:bounds.bottom-parseFloat(style.paddingBottom)};
}

/** Known list fixtures have no coverage facts; remove their source text before checking generated labels. */
export function assertNoListCoverage(text,sourceTexts=[]){
 for(const source of [...sourceTexts].sort((a,b)=>b.length-a.length))text=text.replaceAll(source,'');
 assert.doesNotMatch(text,/精选|节选|选摘|选取|仅显示|仅展示|(?:展示|显示|前|全部|共|剩余|还有|更多)\s*[一二三四五六七八九十百\d]+\s*(?:条|项|篇)|\d+\s*[／/]\s*\d+|\b(?:showing|selected|remaining|all\s+\d+|\d+\s+of\s+\d+)\b/i,'unsolicited list coverage notice');
}

export function assertListCapacity(measured,{titles,min=1,max=titles.length,fill=false}){
 const {records}=measured;
 assert.ok(records.length>=min&&records.length<=max,`expected ${min}–${max} complete titles, got ${records.length}`);
 assert.deepEqual(records.map(row=>row.title),titles.slice(0,records.length),'selection must retain the source prefix');
 for(const row of records){assert.ok(row.font>=15,`body font shrank: ${row.font}`);assert.equal(row.clipped,false,`title clipped: ${row.title}`);}
 if(fill&&records.length<titles.length){
  const last=records.at(-1),steps=records.slice(1).map((row,i)=>row.top-records[i].top).filter(step=>step>0);
  const nextRow=Math.min(...steps,last.lineHeight+12);
  assert.ok(measured.bottom-last.bottom<nextRow+2,`unused bottom ${measured.bottom-last.bottom}px can fit another row (${nextRow}px)`);
 }
 assertNoListCoverage(measured.text,titles);
}

export async function verifySpaceList(browser,{item,source,html,extra,out}){
 const longer=spaceTitles.map(title=>title+'，相关企业发布最新经营公告与后续市场动态');
 const variants=item.explicitCount?[{id:'base',titles:spaceTitles,min:5,max:5}]:[
  {id:'base',titles:spaceTitles,min:10,fill:true},
  {id:'longer',titles:longer,min:1},
  {id:'short',titles:spaceTitles.slice(0,2),min:2,max:2},
  {id:'empty',titles:[],min:0,max:0},
 ];
 const results=[];
 for(const variant of variants){
  const changed=source.replace(/<main>[\s\S]*?<\/main>/,`<main>${body(variant.titles)}</main>`);
  const rendered=await renderWidgetPreview(browser,{source:changed,html,extra,size:'large'});
  const folder=join(out,variant.id);await mkdir(folder,{recursive:true});
  await writeFile(join(folder,'widget.html'),html);await writeFile(join(folder,'data.json'),rendered.extractedData??'null');
  await writeFile(join(folder,'widget.png'),Buffer.from(rendered.screenshotBase64,'base64'));
  assert.deepEqual(rendered.errors,[],variant.id);
  const server=await startPreviewServer(folder);let page;
  try{
   page=await browser.newPage();await page.setViewport({width:344,height:360,deviceScaleFactor:1});
   await page.goto(server.url+'/widget.html');await page.evaluate(()=>Promise.all([window.widgetReady,document.fonts.ready]));
   const measured=await page.evaluate(measureList,variant.titles);
   await writeFile(join(folder,'measurement.json'),JSON.stringify(measured,null,2));
   assertListCapacity(measured,variant);
   if(variant.id==='empty')assert.match(measured.text,/暂无|无数据|不可用|未找到|未提供|缺|—|--/);
   if(variant.id==='short'||variant.id==='empty')for(const title of spaceTitles.slice(variant.titles.length))assert.ok(!measured.text.includes(title),'stale record after source replacement');
   if(variant.id==='base'&&!item.explicitCount)for(const title of spaceTitles)assert.ok(rendered.extractedData.includes(title),'extractor discarded a relevant candidate');
   results.push({variant:variant.id,count:measured.records.length});
  }finally{await page?.close();await server.close();}
 }
 if(!item.explicitCount)assert.ok(results[1].count<results[0].count,'long titles must reduce the displayed count');
 await writeFile(join(out,'capacity.json'),JSON.stringify(results,null,2));
}
