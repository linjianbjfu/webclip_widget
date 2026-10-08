/** Source illustrations make image selection reproducible without third-party image availability. */
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {renderWidgetPreview} from '../backend/src/agent/preview-render.ts';

export const imageCases = [
  {id:'image-plant',size:'middle',text:'用中号 widget 展示这株植物的观察记录。',artwork:'plant',
    body:'<h1>植物观察</h1><article><img alt="琴叶榕叶形观察图" width="144" height="160"><h2>琴叶榕</h2><p>状态：新叶展开</p><p>观察日期：10 月 8 日</p><p>记录员：小林；位置：东窗；花盆编号：A17；记录归档于本月植物观察手册。</p></article>',
    identity:'琴叶榕',nextIdentity:'龟背竹'},
  {id:'image-movies',size:'large',text:'用大号 widget 展示这里正在热映的电影。',artwork:'poster',
    body:'<h1>正在热映</h1><p>按页面推荐顺序</p><ol>'+[['海边来信','8.1'],['星际归途','7.6']].map(([title,rating])=>`<li><img alt="${title}海报" width="108" height="144"><h2>${title}</h2><p>评分：${rating}</p><p>类型：剧情；片长：120 分钟；语言：中文；上映时间：10 月 1 日；影院信息及制作名单详见影片页面。</p></li>`).join('')+'</ol>',
    identity:'海边来信',nextIdentity:'雨中漫步'},
  {id:'image-decoration',size:'small',text:'用小号 widget 展示本月故障数。',artwork:'decoration',
    body:'<h1>设备运行</h1><p>本月故障数 <b id="value">0</b></p><aside aria-label="广告"><img alt="花店促销广告，与设备无关" width="144" height="100"><p>花店开业促销</p></aside>'},
];

export async function prepareDesignImages(page, item, changed = false) {
  await page.evaluate(({kind,changed})=>{
    for(const [index,img] of [...document.images].entries()){
      const c=document.createElement('canvas');c.width=180;c.height=240;const x=c.getContext('2d');
      x.fillStyle=changed?'#efe4cf':index?'#182e51':'#e6efe6';x.fillRect(0,0,180,240);
      if(kind==='poster'){
        x.fillStyle=changed?'#be624e':index?'#efcf72':'#619fa9';
        x.beginPath();x.arc(105,72,35,0,Math.PI*2);x.fill();
        x.fillStyle=index?'#496287':'#347985';x.fillRect(0,140,180,100);
        x.fillStyle='#f8f4e9';x.beginPath();x.moveTo(38,157);x.lineTo(80,110);x.lineTo(105,157);x.closePath();x.fill();
        x.font='bold 16px sans-serif';x.fillText(changed&&index===0?'雨中漫步':index?'星际归途':'海边来信',18,211);
      }else{
        x.strokeStyle='#376349';x.lineWidth=5;x.beginPath();x.moveTo(90,185);x.lineTo(90,40);x.stroke();
        x.fillStyle=changed?'#39645c':'#629d4e';
        for(const [left,top,angle] of [[67,65,-.5],[115,100,.5],[60,137,-.5]]){
          x.beginPath();x.ellipse(left,top,32,20,angle,0,Math.PI*2);x.fill();
        }
        x.fillStyle=changed?'#648aa1':'#b78565';x.beginPath();x.moveTo(58,177);x.lineTo(122,177);x.lineTo(114,218);x.lineTo(66,218);x.closePath();x.fill();
      }
      img.src=c.toDataURL('image/png');
    }
  },{kind:item.artwork,changed});
}

function imageValues(value) {
  if(typeof value==='string')return /^data:image\/(png|jpeg|webp);base64,/.test(value)?[value]:[];
  if(value&&typeof value==='object')return Object.values(value).flatMap(imageValues);
  return [];
}

/** Re-extract from changed sources; the generated bundle remains untouched. */
export async function verifyDesignImages(browser, {item,source,html,extra,rendered,out}) {
  const initial=imageValues(JSON.parse(rendered.extractedData));
  if(item.artwork==='decoration'){
    assert.equal(initial.length,0,'unrelated advertising image was selected');
    assert.match(rendered.text,/0/);
    return;
  }
  assert.ok(initial.length>0,'helpful source images were not extracted');
  assert.ok(rendered.text.includes(item.identity),'primary record identity is missing');
  for(const uri of initial)assert.ok(!html.includes(uri),'captured source image was embedded in widget.html');
  const page=await browser.newPage();
  try {
    const changedSources=[];
    await page.setContent(source.replaceAll(item.identity,item.nextIdentity));
    await prepareDesignImages(page,item,true);
    changedSources.push(['changed-image',await page.content()]);
    for(const [name,src] of [['missing-image',null],['broken-image','data:image/png;base64,AAAA'],['restricted-image','https://images.invalid/blocked.png']]){
      const changedSource=await page.evaluate(({source,src})=>{
        const doc=new DOMParser().parseFromString(source,'text/html');
        for(const img of doc.images){if(src===null)img.removeAttribute('src');else img.setAttribute('src',src);}
        return '<!doctype html>'+doc.documentElement.outerHTML;
      },{source,src});
      changedSources.push([name,changedSource]);
    }
    for(const [name,changedSource] of changedSources){
      const result=await renderWidgetPreview(browser,{html,extra,size:item.size,source:changedSource});
      await writeFile(join(out,`${name}.png`),Buffer.from(result.screenshotBase64,'base64'));
      await writeFile(join(out,`${name}.json`),JSON.stringify({...result,screenshotBase64:undefined,source:changedSource},null,2));
      assert.deepEqual(result.errors,[],name);
      const updated=imageValues(JSON.parse(result.extractedData));
      if(name==='changed-image'){
        assert.ok(result.text.includes(item.nextIdentity),'record name did not refresh');
        assert.ok(!result.text.includes(item.identity),'stale record name');
        assert.ok(updated.length>0,'updated images were lost');
        assert.ok(updated.every(uri=>!initial.includes(uri)),'stale record image');
      }else{
        assert.ok(result.text.includes(item.identity),'image failure removed the record text');
        if(name!=='broken-image')assert.equal(updated.length,0,'unavailable image must not use a captured fallback');
        assert.ok(!result.extractedData.includes('https://images.invalid'),'remote display URL fallback');
      }
      assert.notEqual(result.screenshotBase64,rendered.screenshotBase64,`${name}: image change was not visible`);
    }
  }finally{await page.close();}
}
