import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {encode} from 'fast-png';
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
  const extra=`(async () => { ${IMAGE_EXTRACTOR} const extract=createImageExtractor();return {value:Number(document.querySelector('#value').textContent),image:await extract(document.querySelector('#selected')),cors:await extract(document.querySelector('#cors')),tainted:await extract(document.querySelector('#tainted')),canvas:await extract(document.querySelector('canvas'))}; })()`;
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
  const checks=await page.evaluate(`(async () => { ${IMAGE_EXTRACTOR}
    const uri=${JSON.stringify(data.image)};
    const img=new Image();img.src=uri;
    const extract=createImageExtractor();const count=await Promise.all(Array.from({length:4},()=>extract(img)));
    const large=new Image();large.src='data:image/png;base64,'+btoa(atob(uri.split(',')[1])+'x'.repeat(140000));
    const perImage=await createImageExtractor()(large);
    const medium=new Image();medium.src='data:image/png;base64,'+btoa(atob(uri.split(',')[1])+'x'.repeat(95000));
    const limited=createImageExtractor();const total=await Promise.all(Array.from({length:3},()=>limited(medium)));
    const malformed=new Image();malformed.src='data:image/png;base64,bm90LXBuZw==';
    const missing=new Image();
    return {count:count.map(Boolean),perImage,total:total.map(Boolean),malformed:await createImageExtractor()(malformed),missing:await createImageExtractor()(missing)};
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

test('URL images use original CORS bytes without credentials and bound failed requests',async t=>{
  const png=Buffer.from(encode({width:1,height:1,data:new Uint8Array([255,120,0,255]),channels:4}));
  const pixels=new Uint8Array(256*256*4);let seed=7;
  for(let i=0;i<pixels.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels[i]=i%4===3?255:seed>>>24;}
  const photo=Buffer.from(encode({width:256,height:256,data:pixels,channels:4}));
  assert.ok(photo.length*4/3>IMAGE_LIMITS.perImageChars);
  const requests=[];
  const server=createServer((req,res)=>{
    requests.push({path:req.url,cookie:req.headers.cookie,mode:req.headers['sec-fetch-mode']});
    if(req.url==='/')return res.writeHead(200,{'content-type':'text/html'}).end('<p>42</p>');
    if(req.url==='/cookie')return res.writeHead(200,{'set-cookie':'secret=present; Path=/'}).end('ok');
    const headers={'content-type':'image/png',...(req.url==='/plain'?{}:{'access-control-allow-origin':'*'})};
    if(req.url==='/hang'){res.writeHead(200,headers);res.flushHeaders();return;}
    if(req.url==='/denied')return res.writeHead(403,headers).end();
    if(req.url==='/photo')return res.writeHead(200,headers).end(photo);
    if(req.url==='/resize')return res.writeHead(200,headers).end(Buffer.concat([png,Buffer.alloc(140000)]));
    if(req.url==='/wrong')return res.writeHead(200,headers).end('not png');
    if(req.url==='/mime')return res.writeHead(200,{...headers,'content-type':'text/html'}).end(png);
    if(req.url==='/oversize')return res.writeHead(200,{...headers,'content-length':IMAGE_LIMITS.fetchBytes+1}).end();
    if(req.url==='/stream-limit')return res.writeHead(200,headers).end(Buffer.alloc(IMAGE_LIMITS.fetchBytes+1));
    return res.writeHead(200,headers).end(png);
  });
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  const cross=`http://localhost:${server.address().port}`;
  const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
  const page=await owned.browser.newPage();
  await page.goto(origin+'/cookie');await page.goto(origin);
  await page.evaluate(async url=>{const img=new Image();img.id='cover';img.src=url;document.body.append(img);await img.decode();},cross+'/cors');
  assert.equal(await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.getContext('2d').drawImage(document.querySelector('img'),0,0);
    try{canvas.toDataURL();return 'readable';}catch(e){return e.name;}
  }),'SecurityError');
  const extra=`(async () => { ${IMAGE_EXTRACTOR} return {value:42,image:await createImageExtractor()(document.querySelector('img'))}; })()`;
  const data=JSON.parse(await page.evaluate(extractionExpression(extra)));
  assert.equal(data.image,'data:image/png;base64,'+png.toString('base64'));
  // force-cache can reuse the img response; use a fresh URL to observe request credentials.
  await page.evaluate(`(async () => { ${IMAGE_EXTRACTOR}
    const img=new DOMParser().parseFromString('<img src="${origin}/fresh">','text/html').querySelector('img');
    return createImageExtractor()(img);
  })()`);
  assert.ok(requests.some(r=>r.path==='/'&&r.cookie==='secret=present'));
  assert.ok(requests.some(r=>r.path==='/fresh'&&r.mode==='cors'&&!r.cookie));
  const before=requests.length;
  const inert=JSON.parse(await page.evaluate(extractionExpression(extra,await page.content())));
  assert.deepEqual(inert,{value:42,image:null});assert.equal(requests.length,before);
  const failures=await page.evaluate(`(async () => { ${IMAGE_EXTRACTOR}
    const paths=['/plain','/denied','/wrong','/mime','/oversize','/stream-limit','/hang'];
    return Promise.all(paths.map(async path=>{
      // A live document owner permits fetch, without loading the img itself.
      const img=new DOMParser().parseFromString('<img>','text/html').querySelector('img');
      img.setAttribute('src',${JSON.stringify(cross)}+path);
      return {path,image:await createImageExtractor()(img)};
    }));
  })()`);
  assert.ok(failures.every(result=>result.image===null),JSON.stringify(failures));
  const resized=await page.evaluate(`(async () => { ${IMAGE_EXTRACTOR}
    const img=new DOMParser().parseFromString('<img src="${cross}/resize">','text/html').querySelector('img');
    return createImageExtractor()(img);
  })()`);
  assert.match(resized,/^data:image\/png;base64,/);assert.ok(resized.length<IMAGE_LIMITS.perImageChars);
  const compressed=await page.evaluate(`(async () => { ${IMAGE_EXTRACTOR}
    const img=new DOMParser().parseFromString('<img src="${cross}/photo">','text/html').querySelector('img');
    return createImageExtractor()(img);
  })()`);
  assert.match(compressed,/^data:image\/webp;base64,/);assert.ok(compressed.length<IMAGE_LIMITS.perImageChars);
  const limited=await page.evaluate(`(async () => { ${IMAGE_EXTRACTOR}
    const extract=createImageExtractor();
    return Promise.all(Array.from({length:5},(_,i)=>{
      const img=new DOMParser().parseFromString('<img>','text/html').querySelector('img');
      img.src=${JSON.stringify(cross)}+'/limit?'+i;return extract(img);
    }));
  })()`);
  assert.deepEqual(limited.map(Boolean),[true,true,true,false,false]);
  assert.equal(requests.filter(r=>r.path.startsWith('/limit?')).length,3);
});
