/** Opt-in real-model design checks. Keeps artifacts, screenshots and measured usage in downloads. */
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {Client} from './client.mjs';
import {saveArtifacts} from './artifacts.mjs';
import {launchBrowser} from './browser.mjs';
import {composeCaptureImage} from './capture-images.mjs';
import {spaceCases, verifySpaceList, assertNoListCoverage} from './design-space-cases.mjs';
import {imageCases, prepareDesignImages, verifyDesignImages} from './design-image-cases.mjs';
import {renderWidgetPreview} from '../backend/src/agent/preview-render.ts';
import {extractionExpression} from '../backend/src/agent/extraction.ts';
import {parseCapture} from '../backend/src/capture.ts';

const {WEBCLIP_URL:baseUrl,WEBCLIP_TOKEN:token}=process.env;
if(!baseUrl||!token)throw Error('WEBCLIP_URL and WEBCLIP_TOKEN must be set');
await mkdir('downloads',{recursive:true});
const root=await mkdtemp(resolve('downloads/design-check-'));
const client=new Client({baseUrl,token,userId:process.env.WEBCLIP_USER??basename(root)});
const longTitles = [
  '北岸步道修复工程开放首段并公布周末绕行路线',
  '市立图书馆延长夜间开放并新增预约自习座位',
  '社区公交调整早高峰班次方便居民换乘地铁',
  '城市博物馆推出传统木作展及公益讲解活动',
  '滨江公园启动本季候鸟观察与湿地保护计划',
  '旧街区公共照明更新项目完成首轮居民意见征集',
  '周末手作市集公布摊位名单及雨天替代场地',
  '社区卫生中心增设秋季流感疫苗预约服务时段',
];
const metricBody = (value='18', details=true) => `<h1>东区供水</h1><p>今日重点：<strong>未恢复供水</strong> <b id="value">${value}</b> 户</p><p>范围：仅东区；截至 09:30；不含计划停水</p>${details ? '<section><h2>运维明细</h2>'+['巡检 27 次','工单 83 条','值班 16 人','备件 205 件','满意度 98%','上月培训 12 场'].map(v=>`<p>${v}</p>`).join('')+'</section>' : ''}`;
const listBody = titles => '<h1>社区资讯</h1><p>按发布时间从新到旧</p><ol>'+titles.map((v,i)=>`<li><strong>${v}</strong><p>栏目：民生；发布时间 10:${String(59-i).padStart(2,'0')}；编辑：社区新闻组；阅读量 ${930-i*37}；附完整报道与采访背景。</p></li>`).join('')+'</ol>';
const textBody = (status='尚未开放', details=true) => `<h1>北岸步道公告</h1><p id="lead">最新状态：北岸步道${status}；仅南入口通行；截至 10 月 8 日；请勿进入施工区。</p>${details ? Array.from({length:7},(_,i)=>`<section><h2>背景资料 ${i+1}</h2><p>施工背景第${i+1}节：本项目开展沿岸设施维护、步道路面检查和绿化养护，施工团队将依次完成测量、备料和现场复核。历史记录仅供了解项目，不代表当前通行状态。</p></section>`).join('') : ''}`;
const emptyBody = '<h1>暂无数据</h1>';
const cases=[
  ...imageCases,
  ...spaceCases,
  {id:'small',size:'small',text:'用小号 widget 显示本月故障数。',body:'<h1>设备运行</h1><p>本月故障数 <b id="value">0</b></p><canvas></canvas>'},
  {id:'progress',size:'middle',text:'用中号 widget 展示我的步行记录。',body:'<h1>步行记录</h1><p>今日 <b id="value">7592</b> 步，目标 <b id="target">10000</b> 步</p><ol id="history">'+[3200,5100,4100,6000,5200,6900,7592].map((v,i)=>`<li data-day="${i+1}">${v}</li>`).join('')+'</ol>'},
  {id:'list',size:'large',text:'用大号 widget 显示全部六篇文章标题和栏目。',body:'<h1>今日阅读</h1><ul>'+['春日徒步路线','手冲咖啡入门','城市建筑漫步','一周书单','室内植物养护','周末展览推荐'].map((v,i)=>`<li><strong>${v}</strong><span>栏目 ${i+1}</span></li>`).join('')+'</ul>'},
  {id:'image',size:'middle',text:'用中号 widget 展示本周推荐商品和价格。',body:'<h1>本周推荐</h1><img id="product" alt="蓝色陶瓷马克杯" width="144" height="120"><p>蓝色陶瓷马克杯</p><p>价格 <b id="value">89</b> 元</p>',image:true,followup:'保持中号，换成深色风格，不使用图片。'},
  {id:'missing-history',size:'small',text:'用小号 widget 显示当前关注人数及历史趋势，没有的数据如实说明。',body:'<h1>关注人数</h1><b id="value">42</b>'},
  {id:'freeform',size:'middle',text:'用中号 widget 自由组合这两项信息，以接下来的会议为主，阅读进度为辅。',body:'<h1>今日安排</h1><p>下一场会议：设计评审，14:30</p><p>阅读进度：<b id="value">24</b> / 100 页</p>'},
  {id:'dense-metrics',size:'small',text:'用小号 widget 展示这里的供水情况。',body:metricBody(),
    variants:[{id:'changed',body:metricBody('7'),present:/\b7\s*户/,absent:/18/},{id:'zero',body:metricBody('0'),present:/\b0\s*户/},{id:'missing',body:metricBody('暂无'),present:/暂无|未知|缺|不可用|未提供|—|--/,absent:/\b0\s*户/},{id:'short',body:metricBody('3',false),present:/\b3\s*户/},{id:'empty',body:emptyBody,absent:/\b0\s*户/}]},
  {id:'long-list',size:'middle',text:'用中号 widget 展示社区资讯。',body:listBody(longTitles),
    variants:[{id:'changed',body:listBody(['今晨社区食堂开放早餐预约服务',...longTitles.slice(0,4)]),present:/社区食堂/},{id:'short',body:listBody(['明日书屋开放']),present:/明日书屋开放/,absent:/北岸步道/},{id:'empty',body:emptyBody,absent:/北岸步道/}]},
  {id:'paragraphs',size:'large',text:'用大号 widget 展示这份步道公告。',body:textBody(),
    variants:[{id:'changed',body:textBody('已部分开放'),present:/已部分开放/,absent:/尚未开放/},{id:'short',body:textBody('暂时关闭',false),present:/暂时关闭/},{id:'empty',body:emptyBody,absent:/尚未开放/}]},
  {id:'overfull',size:'small',text:'必须用小号 widget，完整展示全部八条新闻标题及每条的栏目、发布时间、编辑、阅读量和报道背景，不截断、不省略。',body:listBody(longTitles),conflict:true},
  {id:'canvas-only',text:'把实时销量做成可更新的小号 widget。',body:'<h1>实时销量</h1><canvas width="300" height="100"></canvas>',canvas:true},
];
const selected=process.env.DESIGN_CASES?.split(',');
const owned=await launchBrowser({headless:true});
const results=[], failures=[];
try {
  async function runCase(item){
    const folder=join(root,item.id);await mkdir(folder);
    const page=await owned.browser.newPage();
    await page.setViewport({width:440,height:520,deviceScaleFactor:1});
    await page.setContent(`<html><head><meta charset="utf-8"><style>body{font:18px sans-serif;margin:20px}main{padding:12px;width:380px}li{margin:8px 0}span{margin-left:12px;color:#666}</style></head><body><main>${item.body}</main></body></html>`);
    if(item.image)await page.evaluate(()=>{
      const c=document.createElement('canvas');c.width=144;c.height=120;const x=c.getContext('2d');
      x.fillStyle='#eaf2f4';x.fillRect(0,0,144,120);x.fillStyle='#73a8ba';x.beginPath();x.roundRect(34,28,62,66,8);x.fill();
      x.strokeStyle='#73a8ba';x.lineWidth=10;x.beginPath();x.arc(100,54,17,-Math.PI/2,Math.PI/2);x.stroke();
      document.querySelector('img').src=c.toDataURL('image/png');
    });
    if(item.canvas)await page.evaluate(()=>{const c=document.querySelector('canvas'),x=c.getContext('2d');x.font='32px sans-serif';x.fillText('128',20,60);});
    if(item.artwork)await prepareDesignImages(page,item);
    await page.evaluate(()=>Promise.all([...document.images].map(img=>img.decode())));
    const source=await page.content();await writeFile(join(folder,'source.html'),source);
    const rect=await page.evaluate(()=>{const r=document.querySelector('main').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    const tile=await page.screenshot({type:'png',clip:rect,captureBeyondViewport:true,encoding:'base64'});
    const documentSize=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));
    const image=await composeCaptureImage(page,[{id:'r1',data:tile}],'regions',documentSize);
    const imageFile=image.mimeType==='image/png'?'regions.png':'regions.jpg';
    await writeFile(join(folder,imageFile),Buffer.from(image.data,'base64'));
    const capture={version:1,mode:'regions',source:'source.html',viewport:{width:440,height:520},regions:[{id:'r1',xpath:'/html[1]/body[1]/main[1]',rect,text:await page.$eval('main',el=>el.innerText),imageId:'regions-image',imageRect:image.boxes[0]}],images:[{id:'regions-image',file:imageFile,role:'montage',width:image.width,height:image.height,mimeType:image.mimeType,bytes:image.bytes,originalWidth:image.originalWidth,originalHeight:image.originalHeight}]};
    parseCapture(capture);
    await page.close();
    const created=await client.createSession('Design check '+item.id);assert.equal(created.status,201);
    const sessionId=created.body.sessionId;
    try {
      for(const [turn,text] of [item.text,...(item.followup?[item.followup]:[])].entries()){
        const started=Date.now();console.log(`START ${item.id} turn ${turn+1}`);
        const result=await client.prompt({sessionId,text,...(turn===0?{files:[join(folder,'source.html'),join(folder,imageFile)],capture}:{}),onFrame:frame=>{if(frame.event==='tool_end')console.log(`  ${item.id}: ${frame.data.name} ${frame.data.isError?'error':'ok'}`);}});
        await writeFile(join(folder,`turn-${turn+1}.json`),JSON.stringify(result));
        assert.equal(result.status,200,JSON.stringify(result.body));
        const end=result.frames.find(frame=>frame.event==='turn_end'&&frame.data.turnId===result.turnId);
        assert.equal(end?.data.reason,'completed',JSON.stringify(result.frames.filter(frame=>frame.event==='error').map(frame=>frame.data)));
        const messages=result.frames.filter(frame=>frame.event==='entry'&&frame.data?.type==='message').map(frame=>frame.data.message);
        const tools=messages.filter(message=>message?.role==='toolResult');
        const usage=messages.filter(message=>message?.role==='assistant').reduce((sum,message)=>{for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'])sum[key]+=(message.usage?.[key]??0);return sum;},{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0});
        const measurement={case:item.id,turn:turn+1,ms:Date.now()-started,usage,designCalls:tools.filter(tool=>tool.toolName==='get_design_context').length,toolCalls:tools.length};
        const reply=messages.filter(message=>message?.role==='assistant').flatMap(message=>message.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
        await writeFile(join(folder,`reply-${turn+1}.txt`),reply);
        if(item.conflict){
          assert.equal(end.data.out?.length??0,0,'overfull explicit request must ask before delivering a reduced widget');
          assert.match(reply,/容不下|放不下|无法|不能|不足|冲突/,'missing size/content conflict');
          assert.match(reply,/大号|中号|增大|更大/,'missing larger-size option');
          assert.match(reply,/减少|精简|删减|省略|摘要/,'missing reduced-content option');
          results.push(measurement);continue;
        }
        if(item.canvas){assert.equal(end.data.out?.length??0,0,'canvas-only generation must not fake a widget');results.push(measurement);continue;}
        assert.ok(tools.some(tool=>tool.toolName==='get_design_context'&&!tool.isError),'design context was not loaded');
        const final=tools.filter(tool=>tool.toolName==='preview_widget').at(-1);
        assert.equal(final?.details?.valid,true,'final Browser Run preview did not pass');
        const outRoot=join(folder,`turn-${turn+1}`);await mkdir(outRoot);
        const out=await saveArtifacts({sessionId,out:end.data.out,root:outRoot});
        const [html,extra,meta]=await Promise.all(['widget.html','extra.js','meta.json'].map(name=>readFile(join(out,name),'utf8')));
        assert.equal(JSON.parse(meta).size,item.size);
        const rendered=await renderWidgetPreview(owned.browser,{html,extra,size:item.size,source});
        assert.deepEqual(rendered.errors,[]);
        await writeFile(join(out,'widget.png'),Buffer.from(rendered.screenshotBase64,'base64'));
        await writeFile(join(out,'data.json'),rendered.extractedData);
        await writeFile(join(out,'text.txt'),rendered.text);
        if(item.space)await verifySpaceList(owned.browser,{item,source,html,extra,out});
        if(item.artwork)await verifyDesignImages(owned.browser,{item,source,html,extra,rendered,out});
        if(item.id==='dense-metrics'){
          assert.match(rendered.text,/18/);assert.match(rendered.text,/未恢复/);assert.match(rendered.text,/户/);assert.match(rendered.text,/东区/);
          assert.match(rendered.text,/09:30/);assert.match(rendered.text,/不含计划停水/);
          assert.ok(!['27','83','16','205','98%','12'].every(value=>rendered.text.includes(value)),'secondary metrics were not omitted');
        }
        if(item.id==='long-list'){
          const shown=longTitles.filter(title=>rendered.text.includes(title));
          assert.ok(shown.length>0&&shown.length<longTitles.length,'list must show identifiable selected records');
          assertNoListCoverage(rendered.text,longTitles);
          assert.ok(rendered.text.includes(longTitles[0]),'selection must follow observed chronology');
        }
        if(item.id==='paragraphs'){
          assert.match(rendered.text,/尚未开放/);assert.match(rendered.text,/仅南入口/);assert.match(rendered.text,/10.*8/);
          assert.ok(!Array.from({length:7},(_,i)=>`施工背景第${i+1}节`).every(value=>rendered.text.includes(value)),'background paragraphs were not omitted');
        }
        for(const variant of item.variants??[]){
          const changed=source.replace(/<main>[\s\S]*?<\/main>/,`<main>${variant.body}</main>`);
          const rerender=await renderWidgetPreview(owned.browser,{html,extra,size:item.size,source:changed});
          await writeFile(join(out,`${variant.id}.png`),Buffer.from(rerender.screenshotBase64,'base64'));
          await writeFile(join(out,`${variant.id}.json`),JSON.stringify({source:changed,...rerender,screenshotBase64:undefined},null,2));
          assert.deepEqual(rerender.errors,[],`${item.id}/${variant.id}`);
          assert.notEqual(rerender.extractedData,rendered.extractedData,`${variant.id}: captured data was frozen`);
          if(item.id==='long-list')assertNoListCoverage(rerender.text,[...longTitles,'今晨社区食堂开放早餐预约服务','明日书屋开放']);
          if(variant.present)assert.match(rerender.text,variant.present);
          if(variant.absent)assert.doesNotMatch(rerender.text,variant.absent);
          if(variant.id==='empty')assert.match(rerender.text,/暂无|无数据|不可用|未找到|未提供|缺|—|--/,'empty source must remain honest');
        }
        if(item.image&&turn===0){
          const brokenSource=source.replace(/src="data:image[^"]*"/,'src="data:image/png;base64,AAAA"');
          const broken=await renderWidgetPreview(owned.browser,{html,extra,size:item.size,source:brokenSource});
          await writeFile(join(out,'broken-image.png'),Buffer.from(broken.screenshotBase64,'base64'));
          assert.deepEqual(broken.errors,[]);assert.match(broken.text,/89/);assert.match(broken.text,/马克杯/);
        }
        if(item.image&&turn===0)assert.match(rendered.extractedData,/data:image\/(png|jpeg|webp);base64,/,'model did not choose the suitable source image');
        if(item.image&&turn===1)assert.doesNotMatch(html,/<img\b/i,'explicit no-image preference ignored');
        if(item.id==='small')assert.match(rendered.text,/0/);
        if(item.id==='list')for(const title of ['春日徒步路线','手冲咖啡入门','城市建筑漫步','一周书单','室内植物养护','周末展览推荐'])assert.ok(rendered.text.includes(title),title);
        if(item.id==='progress'){
          const changed=source.replace('7592','1234');
          const rerender=await renderWidgetPreview(owned.browser,{html,extra,size:item.size,source:changed});
          assert.deepEqual(rerender.errors,[]);assert.notEqual(rerender.extractedData,rendered.extractedData);assert.notEqual(rerender.screenshotBase64,rendered.screenshotBase64);
          await writeFile(join(out,'changed.png'),Buffer.from(rerender.screenshotBase64,'base64'));
        }
        // Exercise the exact generated extractor in a live document, in addition to inert preview.
        const live=await owned.browser.newPage();await live.setContent(source);await live.evaluate(()=>Promise.all([...document.images].map(img=>img.decode())));
        await live.evaluate(extractionExpression(extra));await live.close();
        results.push({...measurement,out});console.log(`PASS ${item.id} turn ${turn+1}: ${out}`);
        await writeFile(join(root,'results.json'),JSON.stringify(results,null,2));
      }
    } catch(error) {
      failures.push(error);results.push({case:item.id,error:error.message});console.error(`FAIL ${item.id}: ${error.message}`);
    } finally {await client.deleteSession(sessionId);}
  }
  const queue=cases.filter(item=>!selected||selected.includes(item.id));
  const workers=await Promise.allSettled([0,1].map(async()=>{while(queue.length)await runCase(queue.shift());}));
  for(const worker of workers)if(worker.status==='rejected')failures.push(worker.reason);
  if(failures.length)throw new AggregateError(failures,`${failures.length} design case(s) failed`);
} finally {await owned.close();await writeFile(join(root,'results.json'),JSON.stringify(results,null,2));console.log(`Evidence: ${root}`);}
