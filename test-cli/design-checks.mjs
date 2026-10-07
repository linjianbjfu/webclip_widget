/** Opt-in real-model design checks. Keeps artifacts, screenshots and measured usage in downloads. */
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Client} from './client.mjs';
import {saveArtifacts} from './artifacts.mjs';
import {launchBrowser} from './browser.mjs';
import {renderWidgetPreview} from '../backend/src/agent/preview-render.ts';
import {extractionExpression} from '../backend/src/agent/extraction.ts';
import {parseCapture} from '../backend/src/capture.ts';

const {WEBCLIP_URL:baseUrl,WEBCLIP_TOKEN:token}=process.env;
if(!baseUrl||!token)throw Error('WEBCLIP_URL and WEBCLIP_TOKEN must be set');
await mkdir('downloads',{recursive:true});
const root=await mkdtemp(resolve('downloads/design-check-'));
const client=new Client({baseUrl,token,userId:process.env.WEBCLIP_USER??'design-checks'});
const cases=[
  {id:'small',size:'small',text:'用小号 widget 显示本月故障数。',body:'<h1>设备运行</h1><p>本月故障数 <b id="value">0</b></p><canvas></canvas>'},
  {id:'progress',size:'middle',text:'用中号 widget 显示今日步数、目标和本周步数变化。',body:'<h1>步行记录</h1><p>今日 <b id="value">7592</b> 步，目标 <b id="target">10000</b> 步</p><ol id="history">'+[3200,5100,4100,6000,5200,6900,7592].map((v,i)=>`<li data-day="${i+1}">${v}</li>`).join('')+'</ol>'},
  {id:'list',size:'large',text:'用大号 widget 显示全部六篇文章标题和栏目。',body:'<h1>今日阅读</h1><ul>'+['春日徒步路线','手冲咖啡入门','城市建筑漫步','一周书单','室内植物养护','周末展览推荐'].map((v,i)=>`<li><strong>${v}</strong><span>栏目 ${i+1}</span></li>`).join('')+'</ul>'},
  {id:'image',size:'middle',text:'用中号 widget 展示本周推荐商品和价格。',body:'<h1>本周推荐</h1><img id="product" alt="蓝色陶瓷马克杯" width="144" height="120"><p>蓝色陶瓷马克杯</p><p>价格 <b id="value">89</b> 元</p>',image:true,followup:'保持中号，换成深色风格，不使用图片。'},
  {id:'missing-history',size:'small',text:'用小号 widget 显示当前关注人数及历史趋势，没有的数据如实说明。',body:'<h1>关注人数</h1><b id="value">42</b>'},
  {id:'freeform',size:'middle',text:'用中号 widget 自由组合这两项信息，以接下来的会议为主，阅读进度为辅。',body:'<h1>今日安排</h1><p>下一场会议：设计评审，14:30</p><p>阅读进度：<b id="value">24</b> / 100 页</p>'},
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
    await page.evaluate(()=>Promise.all([...document.images].map(img=>img.decode())));
    const source=await page.content();await writeFile(join(folder,'source.html'),source);
    const rect=await page.evaluate(()=>{const r=document.querySelector('main').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
    const png=await page.screenshot({type:'png',clip:rect});await writeFile(join(folder,'regions.png'),png);
    const capture={version:1,mode:'regions',source:'source.html',viewport:{width:440,height:520},regions:[{id:'r1',xpath:'/html[1]/body[1]/main[1]',rect,text:await page.$eval('main',el=>el.innerText),imageId:'regions-image',imageRect:{x:0,y:0,width:png.readUInt32BE(16),height:png.readUInt32BE(20)}}],images:[{id:'regions-image',file:'regions.png',role:'montage',width:png.readUInt32BE(16),height:png.readUInt32BE(20),mimeType:'image/png',bytes:png.length,originalWidth:440,originalHeight:520}]};
    parseCapture(capture);
    await page.close();
    const created=await client.createSession('Design check '+item.id);assert.equal(created.status,201);
    const sessionId=created.body.sessionId;
    try {
      for(const [turn,text] of [item.text,...(item.followup?[item.followup]:[])].entries()){
        const started=Date.now();console.log(`START ${item.id} turn ${turn+1}`);
        const result=await client.prompt({sessionId,text,...(turn===0?{files:[join(folder,'source.html'),join(folder,'regions.png')],capture}:{}),onFrame:frame=>{if(frame.event==='tool_end')console.log(`  ${item.id}: ${frame.data.name} ${frame.data.isError?'error':'ok'}`);}});
        await writeFile(join(folder,`turn-${turn+1}.json`),JSON.stringify(result));
        assert.equal(result.status,200,JSON.stringify(result.body));
        const end=result.frames.find(frame=>frame.event==='turn_end'&&frame.data.turnId===result.turnId);
        assert.equal(end?.data.reason,'completed',JSON.stringify(result.frames.filter(frame=>frame.event==='error').map(frame=>frame.data)));
        const messages=result.frames.filter(frame=>frame.event==='entry'&&frame.data?.type==='message').map(frame=>frame.data.message);
        const tools=messages.filter(message=>message?.role==='toolResult');
        const usage=messages.filter(message=>message?.role==='assistant').reduce((sum,message)=>{for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'])sum[key]+=(message.usage?.[key]??0);return sum;},{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0});
        const measurement={case:item.id,turn:turn+1,ms:Date.now()-started,usage,designCalls:tools.filter(tool=>tool.toolName==='get_design_context').length,toolCalls:tools.length};
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
