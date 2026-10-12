/** Multi-record source icons exercise identity, capacity and per-record image updates. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {renderWidgetPreview} from '../backend/src/agent/preview-render.ts';
import {startPreviewServer} from './preview-server.mjs';
import {TOKENS} from '../backend/src/design-system/tokens.ts';
import {WIDGET_SIZES} from '../backend/src/widget-contract.ts';
import {assertNoListCoverage,measureList} from './design-space-cases.mjs';
const games=[['NHL','SJ','3','STL','2'],['NFL','TB','24','DAL','16'],['MLB','CLE','9','CWS','5'],['NHL','TOR','31','VGK','42'],['NCAAF','S FLA','24','UTSA','31'],['NBA','BOS','124','CLE','113'],['NBA','NO','118','MIA','128']];
const apps=['笔记','日历','阅读','音乐','相册','天气'];
const layoutGames=[...games.slice(0,3),['NHL','TOR','3','VGK','4'],games[4],['NBA','HOU',null,'DAL',null]];
const longApps=['云端协作笔记本','团队共享日程表','离线电子书阅读器','无损音乐播放器','家庭照片管理器','城市逐小时天气'];
export const iconCases=[
 {id:'layout-scores',size:'large',icons:true,nested:true,expectedIcons:12,labels:layoutGames.flatMap(g=>[g[1],g[3]]),text:'用大号 widget 展示全部六场比赛，保留双方队徽、队名、主比分、点球比分、联赛与状态。',
  body:'<h1>赛事速览</h1><ol>'+layoutGames.map(([league,a,x,b,y])=>`<li><p>${league} ${a==='TOR'?'完赛 · 点球':x===null?'8:00 PM GMT+8':'完赛'}</p>`+[[a,x],[b,y]].map(([name,score],i)=>`<div><img alt="${name}队徽" width="32" height="32"><strong>${name}</strong><b class="score">${score??'—'}${a==='TOR'?`<sup title="点球比分">${i+1}</sup>`:''}</b></div>`).join('')+'</li>').join('')+'</ol>'},
 {id:'icons-scores',size:'large',icons:true,emblems:true,expectedIcons:14,labels:games.flatMap(g=>[g[1],g[3]]),text:'用大号 widget 展示全部七场比分，保留每队队徽、球队简称、比分、联赛和完赛状态。',
  body:'<h1>赛事比分</h1><ol>'+games.map(([league,a,x,b,y])=>`<li><p>${league} 完赛</p><div><img alt="${a}队徽" width="32" height="32"><strong>${a}</strong><b>${x}</b></div><div><img alt="${b}队徽" width="32" height="32"><strong>${b}</strong><b>${y}</b></div></li>`).join('')+'</ol>',
  followups:['保持大号和全部七场比分、队徽，选一张合适的来源图片作局部淡背景，只放在所属比赛区域，文字保持清晰。','保持大号和全部七场比分，不使用图片或主题图标。']},
 {id:'icons-apps',longNames:true,size:'large',icons:true,expectedIcons:6,labels:apps,text:'用大号 widget 展示全部六个应用的图标、名称及其使用时长。',
  body:'<h1>应用使用</h1><ol>'+apps.map((name,i)=>`<li><img alt="${name}图标" width="32" height="32"><strong>${name}</strong><span>${60-i*7} 分钟</span></li>`).join('')+'</ol>'},
];
for(const [id,base,text] of [
 ['emphasis-scores','layout-scores','用大号 widget 展示全部六场比赛的双方队徽、名称、主比分、点球比分、联赛和状态。以图片为主，让队徽尽可能大且易辨认，名称作为辅助标签、弱化文字，关键比分保持清楚。'],
 ['emphasis-apps','icons-apps','用大号 widget 展示全部六个应用的图标、名称及使用时长。以图片为主，让图标尽可能大、便于识别，名称作为辅助标签、弱化文字，时长清楚。'],
])iconCases.push({...iconCases.find(item=>item.id===base),id,text,emphasis:true});
export async function prepareIcons(page,changed=false,emblems=false){
 // Background selection needs recognizable artwork; numbered capacity markers are unsuitable.
 await page.evaluate(({changed,emblems})=>{
  for(const [i,img] of [...document.images].entries()){
   const canvas=document.createElement('canvas');canvas.width=canvas.height=32;const c=canvas.getContext('2d');
   c.fillStyle=`hsl(${(i*47+(changed?170:0))%360} 55% 45%)`;c.beginPath();
   if(emblems){c.moveTo(2,2);c.lineTo(30,2);c.lineTo(28,19);c.quadraticCurveTo(25,27,16,30);c.quadraticCurveTo(7,27,4,19);c.closePath();}
   else c.arc(16,16,14,0,Math.PI*2);
   c.fill();c.fillStyle='#fff';
   if(emblems){
    c.beginPath();for(let n=0;n<10;n++){const a=n*Math.PI/5-Math.PI/2,r=n%2?4:10;c.lineTo(16+Math.cos(a)*r,15+Math.sin(a)*r);}c.closePath();c.fill();
   }else{c.font='bold 14px sans-serif';c.textAlign='center';c.fillText(String(i+1),16,21);}
   img.src=canvas.toDataURL();
  }
 },{changed,emblems});
}
const imageValues=value=>typeof value==='string'?(/^data:image\//.test(value)?[value]:[]):value&&typeof value==='object'?Object.values(value).flatMap(imageValues):[];
const scalars=value=>value&&typeof value==='object'?Object.values(value).flatMap(scalars):[String(value)];
export function assertSeparateScores(data,expectations=[['TOR','3','1'],['VGK','4','2']]){
 const records=[];
 function visit(value){if(value&&typeof value==='object'){records.push(value);Object.values(value).forEach(visit);}}
 visit(data);
 for(const [name,main,secondary] of expectations){
  const record=records.find(value=>Object.values(value).includes(name));
  assert.ok(record,'missing score record: '+name);
  const values=scalars(record);
  assert.ok(values.includes(main)&&values.includes(secondary)&&!values.includes(main+secondary),'primary and nested scores must remain separate: '+name);
 }
}
export async function inspectIconDisplay(browser,out,size,labels=[],viewport=WIDGET_SIZES[size]){
 const server=await startPreviewServer(out);let page;
 try{
  page=await browser.newPage();await page.setViewport({...viewport,deviceScaleFactor:1});await page.goto(server.url+'/widget.html');
  await page.evaluate(()=>Promise.all([window.widgetReady,document.fonts.ready]));
  await page.evaluate(()=>Promise.all([...document.images].map(img=>img.decode().catch(()=>{}))));
  const measured=await page.evaluate(measureList,labels);
  const display=await page.evaluate(()=>{
   const root=document.querySelector('#widget-root'),r=root.getBoundingClientRect();
   const visible=el=>{const b=el.getBoundingClientRect(),s=getComputedStyle(el);return b.width>0&&b.height>0&&b.left<r.right&&b.right>r.left&&b.top<r.bottom&&b.bottom>r.top&&s.display!=='none'&&s.visibility!=='hidden';};
   const icons=[...root.querySelectorAll('img')].filter(visible);
   const images=icons.map(el=>el.src);
   const artwork=icons.map(el=>{
    if(!el.naturalWidth||!el.naturalHeight)return {width:0,height:0};
    const c=document.createElement('canvas');c.width=el.naturalWidth;c.height=el.naturalHeight;
    const x=c.getContext('2d');x.drawImage(el,0,0);const pixels=x.getImageData(0,0,c.width,c.height).data;
    let left=c.width,right=-1,top=c.height,bottom=-1;
    for(let y=0;y<c.height;y++)for(let col=0;col<c.width;col++)if(pixels[(y*c.width+col)*4+3]>16){left=Math.min(left,col);right=Math.max(right,col);top=Math.min(top,y);bottom=Math.max(bottom,y);}
    const box=el.getBoundingClientRect(),scale=Math.min(box.width/c.width,box.height/c.height);
    return {width:Math.max(0,right-left+1)*scale,height:Math.max(0,bottom-top+1)*scale};
   });
   const pairs=icons.map(el=>{
    let context=el.parentElement;
    while(context&&context!==root&&!context.textContent.trim())context=context.parentElement;
    return {uri:el.src,label:context?.textContent.trim()||''};
   });
   const decoration=[root,...root.querySelectorAll('*')].some(el=>{
    if(!visible(el))return false;
    return [null,'::before','::after'].some(pseudo=>{
     const s=getComputedStyle(el,pseudo),quiet=Number(s.opacity)>0&&Number(s.opacity)<=.15;
     if(pseudo)return quiet&&s.content!=='none'&&s.content!=='normal'&&s.position==='absolute'&&parseFloat(s.width)>0&&parseFloat(s.height)>0&&s.backgroundImage!=='none';
     return quiet&&(s.position==='absolute'||el.matches('svg,img'))&&!el.textContent.trim();
    });
   });
   const backgrounds=icons.filter(el=>{
    if(!el.naturalWidth||!el.naturalHeight)return false;
    let opacity=1,positioned=false;
    for(let n=el;n&&root.contains(n);n=n.parentElement){
     const s=getComputedStyle(n);opacity*=Number(s.opacity);
     positioned ||= s.position==='absolute';
     if(Number(s.opacity)<1&&n.textContent.trim())return false;
    }
    return positioned&&opacity>0&&opacity<1;
   }).map(el=>el.src);
   const boxes=icons.filter(el=>{
    let opacity=1;for(let n=el;n&&root.contains(n);n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);
    return opacity>.15;
   }).map(el=>{const b=el.getBoundingClientRect();return {left:b.left,top:b.top,right:b.right,bottom:b.bottom};});
   return {images,pairs,decoration,backgrounds,artwork,boxes};
  });
  return {...display,records:measured.records};
 }finally{await page?.close();await server.close();}
}
export function assertIconDisplay(display,{expectedIcons,expected=[],pairs=[],noImage=false,background=false}){
 if(noImage){assert.equal(display.images.length,0,'explicit no-image preference ignored');assert.equal(display.decoration,false,'explicit no-theme preference ignored');return;}
 assert.ok(display.images.length>=expectedIcons,'not enough visible record icons');
 for(const uri of expected)assert.ok(display.images.includes(uri),'record icon not displayed');
 for(const pair of pairs)assert.ok(display.pairs?.some(actual=>actual.uri===pair.uri&&actual.label.includes(pair.label)),'icon paired with wrong record: '+pair.label);
 if(background){
  assert.ok(display.backgrounds?.length,'missing quiet source-image background');
  if(expected.length)assert.ok(display.backgrounds.every(uri=>expected.includes(uri)),'background is not a source image');
 }
}
export async function verifyIcons(browser,{item,source,html,extra,rendered,out,turn}){
 if(item.nested)assertSeparateScores(JSON.parse(rendered.extractedData));
 for(const label of item.labels)assert.ok(rendered.text.includes(label),'missing identity: '+label);
 assertNoListCoverage(rendered.text,item.labels);
 const display=await inspectIconDisplay(browser,out,item.size,item.labels);
 if(item.nested||item.longNames)assertReadableIdentities(display,item.labels,item.emphasis?TOKENS.sizes[item.size].caption:TOKENS.sizes[item.size].body);
 if(item.emphasis)assertImageEmphasis(display,item.expectedIcons);
 assertIconDisplay(display,{expectedIcons:item.expectedIcons,noImage:turn===2,background:turn===1});
 if(turn===2)return;
 const page=await browser.newPage();
 try{
  await page.setContent(source);const expected=await page.$$eval('img',imgs=>imgs.map(n=>n.src));
  const sourcePairs=()=>page.$$eval('img',imgs=>imgs.map(n=>({uri:n.src,label:n.parentElement.querySelector('strong').textContent})));
  assertIconDisplay(display,{expectedIcons:item.expectedIcons,expected,pairs:await sourcePairs(),background:turn===1});
  const values=imageValues(JSON.parse(rendered.extractedData));
  for(const uri of expected){assert.ok(values.includes(uri),'source icon not extracted');assert.ok(display.images.includes(uri),'record icon not displayed');assert.ok(!html.includes(uri),'image frozen in HTML');}
  for(const variant of ['updated','missing','broken',...(item.longNames?['long-names']:[]),...(item.nested?['nested-updated']:[])]){
   await page.setContent(source);
   if(variant==='updated'){
    await prepareIcons(page,true,item.emblems);
    await page.evaluate(()=>{const list=document.querySelector('ol');list.prepend(list.lastElementChild);document.querySelector('strong').textContent='NEW';});
   }else if(variant==='long-names')await page.$$eval('strong',(names,labels)=>names.forEach((n,i)=>n.textContent=labels[i]),longApps);
   else if(variant==='nested-updated')await page.$$eval('sup',nodes=>nodes.forEach((n,i)=>{n.textContent=String(i+2);n.parentElement.firstChild.textContent=String(i+5);}));
   else await page.$$eval('img',(imgs,variant)=>imgs.forEach(n=>variant==='missing'?n.removeAttribute('src'):n.src='data:image/png;base64,AAAA'),variant);
   const result=await renderWidgetPreview(browser,{html,extra,size:item.size,source:await page.content()});
   assert.deepEqual(result.errors,[],variant);
   await writeFile(join(out,variant+'.png'),Buffer.from(result.screenshotBase64,'base64'));
   await writeFile(join(out,variant+'.json'),result.extractedData);
   if((item.emphasis||turn===1)&&['missing','broken'].includes(variant)){
    const variantOut=join(out,variant);await mkdir(variantOut,{recursive:true});
    await writeFile(join(variantOut,'widget.html'),html);await writeFile(join(variantOut,'data.json'),result.extractedData);
    const failedDisplay=await inspectIconDisplay(browser,variantOut,item.size,item.labels);
    assertReadableIdentities(failedDisplay,item.labels,TOKENS.sizes[item.size].caption);
    if(turn===1)assert.deepEqual(failedDisplay.backgrounds,[],'failed background retained');
   }
   if(variant==='nested-updated')assertSeparateScores(JSON.parse(result.extractedData),[['TOR','5','2'],['VGK','6','3']]);
   if(variant==='long-names'){
    for(const label of longApps)assert.ok(result.text.includes(label),'long name lost: '+label);
    const variantOut=join(out,variant);await mkdir(variantOut,{recursive:true});
    await writeFile(join(variantOut,'widget.html'),html);await writeFile(join(variantOut,'data.json'),result.extractedData);
    const longDisplay=await inspectIconDisplay(browser,variantOut,item.size,longApps);
    assertReadableIdentities(longDisplay,longApps,item.emphasis?TOKENS.sizes[item.size].caption:TOKENS.sizes[item.size].body);
    if(item.emphasis)assertImageEmphasis(longDisplay,item.expectedIcons);
    assertIconDisplay(longDisplay,{expectedIcons:item.expectedIcons,pairs:await sourcePairs()});
   }
   if(variant==='updated'){
    assert.ok(result.text.includes('NEW'),'updated identity was frozen');
    const updated=imageValues(JSON.parse(result.extractedData));assert.ok(updated.length>=item.expectedIcons);
    assert.ok(updated.every(uri=>!expected.includes(uri)),'updated icons were frozen');
    const variantOut=join(out,variant);await mkdir(variantOut,{recursive:true});
    await writeFile(join(variantOut,'widget.html'),html);await writeFile(join(variantOut,'data.json'),result.extractedData);
    assertIconDisplay(await inspectIconDisplay(browser,variantOut,item.size),{expectedIcons:item.expectedIcons,pairs:await sourcePairs(),background:turn===1,expected:updated});
   }else if(variant!=='long-names')for(const label of item.labels)assert.ok(result.text.includes(label),'image failure lost text');
  }
 }finally{await page.close();}
}
export function assertReadableIdentities(display,labels,minFont=15){
 for(const label of labels){
  const record=display.records.find(record=>record.title===label);
  assert.ok(record,'missing visible identity: '+label);
  assert.ok(record.font>=minFont,'identity font shrank: '+label);
  assert.equal(record.clipped,false,'identity clipped: '+label);
 }
}

/** Known 32px source fixtures have visible artwork spanning 28px; tiny slots must fail. */
export function assertImageEmphasis(display,count){
 assert.ok(display.artwork.length>=count,'missing prominent imagery');
 for(const art of display.artwork)assert.ok(Math.min(art.width,art.height)>=26,'visible artwork is too small for image emphasis');
}
