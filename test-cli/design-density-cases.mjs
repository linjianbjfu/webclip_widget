/** Image-rich peers must adapt as complete groups, without a fixed visual quota. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {renderWidgetPreview} from '../backend/src/agent/preview-render.ts';
import {prepareIcons,inspectIconDisplay,assertReadableIdentities,assertImageEmphasis} from './design-icon-cases.mjs';
import {WIDGET_SIZES} from '../backend/src/widget-contract.ts';
import {TOKENS} from '../backend/src/design-system/tokens.ts';
import {assertNoListCoverage} from './design-space-cases.mjs';

const names=['北岸','南港','西山','东城','青原','白石','红枫','蓝湾','星河','晨光','松林','竹溪','云岭','海角','金桥','银湖','长风','远帆','新洲','古城'];
export const densityCases=[{id:'density-scores',size:'large',icons:true,density:true,
 text:'帮我做个大尺寸 widget，展示赛事概况。按来源顺序选取适合布局的完整比赛，保留所选比赛双方完整名称、比分和状态。',
 body:'<h1>赛事概况</h1><p>按比赛时间排序，各场同等重要</p><ol>'+Array.from({length:names.length/2},(_,i)=>
  '<li><p class="status">完赛</p>'+[0,1].map(j=>`<div><img width="32" height="32"><strong>${names[i*2+j]}</strong><b>${80+i*2+j}</b></div>`).join('')+'</li>').join('')+'</ol>'}];

densityCases.push({...densityCases[0],id:'density-default',defaultImagePriority:true,text:'帮我做个 widget，大尺寸。'});

densityCases.push({...densityCases[0],id:'density-emphasis',emphasis:true,text:densityCases[0].text+'以图片为主，图片尽可能大而清晰，文字作为辅助标签。'});

/** Geometry catches invasion, not aesthetic density; scoped to foreground images in these fixtures. */
export function assertSeparatedIcons(boxes){
 for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
  const a=boxes[i],b=boxes[j];
  const width=Math.min(a.right,b.right)-Math.max(a.left,b.left);
  const height=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
  assert.ok(width<-.5||height<-.5,'foreground icons overlap or touch');
 }
}

export async function verifyIconDensity(browser,{item,source,html,extra,out}){
 const page=await browser.newPage(),results=[];
 try{
  for(const variant of ['base','longer','short','updated','missing','broken']){
   await page.setContent(source);
   if(variant==='longer')await page.evaluate(()=>{
    document.querySelectorAll('strong').forEach(n=>n.textContent+='城市青年篮球俱乐部');
    document.querySelectorAll('.status').forEach(n=>n.textContent='完赛 · 加时赛结束');
   });
   if(variant==='short')await page.$$eval('li',nodes=>nodes.slice(2).forEach(n=>n.remove()));
   if(variant==='updated'){
    await prepareIcons(page,true);
    await page.evaluate(()=>{const list=document.querySelector('ol');list.prepend(list.lastElementChild);document.querySelector('strong').textContent='新队';document.querySelector('b').textContent='137';});
   }
   if(variant==='missing'||variant==='broken')await page.$$eval('img',(imgs,variant)=>imgs.forEach(n=>variant==='missing'?n.removeAttribute('src'):n.src='data:image/png;base64,AAAA'),variant);
   const records=await page.$$eval('li',nodes=>nodes.map(li=>({status:li.querySelector('.status').textContent,teams:[...li.querySelectorAll('strong')].map(n=>({name:n.textContent,score:n.parentElement.querySelector('b').textContent,uri:n.parentElement.querySelector('img').getAttribute('src')}))})));
   const labels=records.flatMap(r=>r.teams.map(t=>t.name));
   const rendered=await renderWidgetPreview(browser,{html,extra,source:await page.content(),size:item.size});
   const folder=join(out,variant);await mkdir(folder,{recursive:true});
   await writeFile(join(folder,'widget.html'),html);await writeFile(join(folder,'data.json'),rendered.extractedData??'null');
   await writeFile(join(folder,'widget.png'),Buffer.from(rendered.screenshotBase64,'base64'));
   assert.deepEqual(rendered.errors,[],variant);
   const display=await inspectIconDisplay(browser,folder,item.size,labels);
   const shown=records.filter(r=>r.teams.some(t=>display.records.some(n=>n.title===t.name)));
   assert.ok(shown.length>0,'no complete matches displayed');
   assert.deepEqual(shown,records.slice(0,shown.length),'selection must preserve source order');
   assertReadableIdentities(display,shown.flatMap(r=>r.teams.map(t=>t.name)),item.emphasis?TOKENS.sizes[item.size].caption:TOKENS.sizes[item.size].body);
   assertNoListCoverage(rendered.text,labels);
   for(const record of shown){
    assert.ok(rendered.text.includes(record.status),'missing match status');
    for(const team of record.teams){
     assert.ok(new RegExp('\\b'+team.score+'\\b').test(rendered.text),'missing score: '+team.name);
     if(variant!=='missing'&&variant!=='broken')assert.ok(display.pairs.some(pair=>pair.uri===team.uri&&pair.label.includes(team.name)),'missing or mispaired image: '+team.name);
    }
   }
   if((item.emphasis||item.defaultImagePriority)&&variant!=='missing'&&variant!=='broken')assertImageEmphasis(display,shown.length*2);
   assertSeparatedIcons(display.boxes);
   if(variant==='base'){
    for(const label of labels)assert.ok(rendered.extractedData.includes(label),'extractor discarded layout candidates');
    // Fixed width preserves artwork needs; extra height exposes a hidden constant display cap.
    const viewport={...WIDGET_SIZES[item.size],height:WIDGET_SIZES[item.size].height*2};
    const expanded=await inspectIconDisplay(browser,folder,item.size,labels,viewport);
    if(shown.length<records.length)assert.ok(expanded.records.length>display.records.length,'extra height did not expand capacity: possible fixed display cap');
    assertReadableIdentities(expanded,expanded.records.map(r=>r.title),item.emphasis?TOKENS.sizes[item.size].caption:TOKENS.sizes[item.size].body);
    assertSeparatedIcons(expanded.boxes);
    await writeFile(join(folder,'expanded-measurement.json'),JSON.stringify(expanded,null,2));
   }
   if(variant==='short')assert.equal(shown.length,records.length,'sparse data lost a complete match');
   if(variant==='updated')assert.ok(rendered.text.includes('新队')&&rendered.text.includes('137'),'updated record frozen');
   results.push({variant,matches:shown.length,icons:display.images.length,boxes:display.boxes});
   await writeFile(join(folder,'measurement.json'),JSON.stringify(display,null,2));
  }
  assert.ok(results[1].matches<results[0].matches,'long names and status must reduce capacity in this fixture');
  await writeFile(join(out,'density.json'),JSON.stringify(results,null,2));
 }finally{await page.close();}
}
