import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {launchBrowser} from '../../../test-cli/browser.mjs';
import {IMAGE_EXTRACTOR, IMAGE_LIMITS} from '../design-system/images.ts';
import {extractionExpression} from './extraction.ts';
import {renderWidgetPreview} from './preview-render.ts';
import {IMAGE_READINESS} from './image-readiness.ts';

test('selected img conversion handles live origins, anti-hotlinking, inert captures and budgets',async t=>{
  const requests=[];
  const server=createServer((req,res)=>{
    requests.push({path:req.url,referer:req.headers.referer});
    if(req.url==='/')return res.writeHead(200,{'content-type':'text/html'}).end('<p id="value">42</p><canvas id="unsupported"></canvas>');
    if(req.url==='/protected'&&!req.headers.referer?.startsWith(origin))return res.writeHead(403).end();
    res.writeHead(200,{'content-type':'image/svg+xml',...(req.url==='/cors'?{'access-control-allow-origin':'*'}:{})}).end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="orange"/></svg>');
  });
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  // A second hostname is a distinct origin on the same owned listener.
  const cross=`http://localhost:${server.address().port}`;
  const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
  const page=await owned.browser.newPage();await page.goto(origin);
  await page.evaluate(async({origin,cross})=>{
    for(const [id,url,cors] of [['selected',origin+'/protected',false],['cors',cross+'/cors',true],['tainted',cross+'/plain',false]]){
      const img=new Image();img.id=id;if(cors)img.crossOrigin='anonymous';img.src=url;document.body.append(img);await img.decode();
    }
  },{origin,cross});
  const extra=`(() => { ${IMAGE_EXTRACTOR} const extract=createImageExtractor();return {value:Number(document.querySelector('#value').textContent),image:extract(document.querySelector('#selected')),cors:extract(document.querySelector('#cors')),tainted:extract(document.querySelector('#tainted')),canvas:extract(document.querySelector('canvas'))}; })()`;
  const data=JSON.parse(await page.evaluate(extractionExpression(extra)));
  assert.equal(data.value,42);assert.match(data.image,/^data:image\/png;base64,/);assert.match(data.cors,/^data:image\/png;base64,/);
  assert.equal(data.tainted,null);assert.equal(data.canvas,null);
  assert.equal((await fetch(origin+'/protected')).status,403);
  const before=requests.filter(request=>request.path==='/protected').length;
  const display=await owned.browser.newPage();await display.setContent('<img id="photo">');
  const size=await display.evaluate(async image=>{const img=document.querySelector('img');img.src=image;await img.decode();return [img.naturalWidth,img.naturalHeight];},data.image);
  assert.deepEqual(size,[512,256]);assert.equal(requests.filter(request=>request.path==='/protected').length,before);
  const source=await page.content();
  const inert=JSON.parse(await page.evaluate(extractionExpression(extra,source)));
  assert.equal(inert.image,null);assert.equal(inert.value,42);
  const checks=await page.evaluate(`(() => { ${IMAGE_EXTRACTOR}
    const uri=${JSON.stringify(data.image)};
    const img=new Image();img.src=uri;
    const extract=createImageExtractor();const count=Array.from({length:4},()=>extract(img));
    const large=new Image();large.src='data:image/png;base64,'+btoa(atob(uri.split(',')[1])+'x'.repeat(140000));
    const perImage=createImageExtractor()(large);
    const medium=new Image();medium.src='data:image/png;base64,'+btoa(atob(uri.split(',')[1])+'x'.repeat(95000));
    const limited=createImageExtractor();const total=Array.from({length:3},()=>limited(medium));
    const malformed=new Image();malformed.src='data:image/png;base64,bm90LXBuZw==';
    const missing=new Image();
    return {count:count.map(Boolean),perImage,total:total.map(Boolean),malformed:createImageExtractor()(malformed),missing:createImageExtractor()(missing)};
  })()`);
  assert.deepEqual(checks,{count:[true,true,true,false],perImage:null,total:[true,true,false],malformed:null,missing:null});
  assert.equal(IMAGE_LIMITS.longestSide,512);
});

function html(hideBroken){
  return `<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%}#widget-root{width:100%;height:100%;padding:12px}img{width:64px;height:64px}</style><main id="widget-root"></main><script>
  window.renderWidget=d=>{const root=document.querySelector('#widget-root');root.replaceChildren();const p=document.createElement('p');p.textContent=d.title;root.append(p);if(d.image){const img=document.createElement('img');${hideBroken?'img.onerror=()=>img.remove();':''}img.src=d.image;root.append(img);}};
  window.widgetReady=fetch('./data.json').then(r=>r.json()).then(renderWidget);window.widgetReady.catch(()=>{});
  </script>`;
}

test('image readiness accepts removed optional images and rejects visible decode failures',async t=>{
  const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
  const files={size:'small',source:'<p>content</p>',extra:'(() => ({title:"Title",image:"data:image/png;base64,bm90LXBuZw=="}))()'};
  const good=await renderWidgetPreview(owned.browser,{...files,html:html(true)});
  assert.deepEqual(good.errors,[]);
  const bad=await renderWidgetPreview(owned.browser,{...files,html:html(false)});
  assert.ok(bad.errors.some(error=>error.includes('image failed to decode')));
  const page=await owned.browser.newPage();await page.setContent(html(true));
  await page.evaluate(`window.renderWidget({title:'First',image:'data:image/png;base64,bm90LXBuZw=='})`);
  await page.evaluate(IMAGE_READINESS);
  await page.evaluate(`window.renderWidget({title:'Next',image:null})`);
  assert.equal(await page.evaluate(()=>document.querySelectorAll('img').length),0);
  assert.equal(await page.evaluate(()=>document.querySelector('#widget-root').textContent),'Next');
});
