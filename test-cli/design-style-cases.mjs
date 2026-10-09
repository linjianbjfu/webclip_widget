/** Real-model style cases with known semantic groups and controlled source imagery. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {startPreviewServer} from './preview-server.mjs';
import {TOKENS} from '../backend/src/design-system/tokens.ts';
import {WIDGET_SIZES} from '../backend/src/widget-contract.ts';

export const styleCases=[
 {id:'style-meeting',size:'large',style:'group',text:'用大号 widget 展示这个会议，保留时间、议题、分类和参与者。',
  body:'<h1>设计讨论</h1><p>10 月 12 日 09:00–12:30</p><p>议题：讨论用户调研与产品路线图</p><section><h2>会议详情</h2><p>分类：团队协作</p><p>参与者：小林、小周、小陈</p></section>'},
 {id:'style-agenda',size:'middle',style:'group',text:'用中号 widget 展示当前和下一项日程，保留名称、时间和分类。',
  body:'<h1>今日日程</h1><article><h2>编程学习</h2><p>09:00–12:30</p><p>分类：个人</p><p>状态：当前</p></article><article><h2>文案设计</h2><p>13:00–15:00</p><p>分类：工作</p><p>状态：下一项</p></article>'},
 {id:'style-background',size:'middle',style:'image',artwork:'plant',identity:'琴叶榕',nextIdentity:'龟背竹',
  text:'用中号 widget 展示这株植物的观察记录，保留名称、状态和位置。',
  body:'<h1>植物观察</h1><article><img alt="琴叶榕观察插图" width="180" height="240"><h2>琴叶榕</h2><p>状态：新叶展开</p><p>位置：东窗</p></article>',
  followups:['保持中号，将植物图片作为右侧的淡背景，向白色正文区域渐隐，保留名称、状态和位置。','保持中号，改为深色风格，不使用图片，保留名称、状态和位置。']},
];

/** Measure rendered layers without depending on generated class names. */
export function measureStyle(){
 const root=document.querySelector('#widget-root'),bounds=root.getBoundingClientRect();
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&r.right>bounds.left&&r.left<bounds.right&&r.bottom>bounds.top&&r.top<bounds.bottom&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)>0;};
 const color=el=>getComputedStyle(el).backgroundColor;
 let surface=color(root);for(let el=root.parentElement;el&&surface==='rgba(0, 0, 0, 0)';el=el.parentElement)surface=color(el);
 const groups=[...root.querySelectorAll('*')].filter(el=>visible(el)&&el.textContent.trim()).map(el=>({color:color(el),text:el.textContent.trim()}));
 const fadedText=[...root.querySelectorAll('*')].filter(el=>visible(el)&&[...el.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&n.textContent.trim())).filter(el=>{
  let opacity=1;for(let n=el;n;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);return opacity<.99;
 }).map(el=>el.textContent.trim());
 const images=[...root.querySelectorAll('img')].filter(visible).map(el=>{
  let positionedLayer=false;for(let n=el;n&&n!==root;n=n.parentElement)if(getComputedStyle(n).position==='absolute')positionedLayer=true;
  return {positionedLayer,decoded:el.complete&&el.naturalWidth>0,embedded:/^data:image\/(png|jpeg|webp);base64,/.test(el.currentSrc||el.src)};
 });
 return {surface,groups,fadedText,images,text:root.innerText};
}
const rgb=hex=>'rgb('+hex.slice(1).match(/../g).map(v=>parseInt(v,16)).join(', ')+')';

export function assertStyle(measured,{group=false,background=false,dark=false,noImage=false}={}){
 const theme=TOKENS.themes[dark?'dark':'light'];
 assert.equal(measured.surface,rgb(theme.surface),'canvas must use the requested theme surface');
 if(group)assert.ok(measured.groups.some(g=>g.color===rgb(theme.surfaceMuted)),'missing meaningful muted group');
 assert.deepEqual(measured.fadedText,[],'background fading must not dim text');
 if(noImage)assert.equal(measured.images.length,0,'explicit no-image preference ignored');
 if(background)assert.ok(measured.images.some(i=>i.positionedLayer&&i.decoded),'missing decoded background img layer');
 assert.ok(measured.images.every(i=>i.decoded&&i.embedded),'visible image must use decoded embedded bytes');
}

export async function verifyStyle(browser,{item,out,turn}){
 const server=await startPreviewServer(out);let page;
 try{
  page=await browser.newPage();await page.setViewport({...WIDGET_SIZES[item.size],deviceScaleFactor:1});
  await page.goto(server.url+'/widget.html');await page.evaluate(()=>Promise.all([window.widgetReady,document.fonts.ready]));
  const measured=await page.evaluate(measureStyle);
  await writeFile(join(out,'style.json'),JSON.stringify(measured,null,2));
  assertStyle(measured,{group:item.style==='group',background:item.style==='image'&&turn===1,dark:turn===2,noImage:turn===2});
  const required=item.id==='style-meeting'?['设计讨论','09:00','12:30','用户调研','产品路线图','团队协作','小林','小周','小陈']:
   item.id==='style-agenda'?['编程学习','文案设计','09:00','12:30','13:00','15:00','个人','工作','当前','下一']:['琴叶榕','新叶展开','东窗'];
  for(const text of required)assert.ok(measured.text.includes(text),'missing requested fact: '+text);
 }finally{await page?.close();await server.close();}
}
