/** Capture one live source DOM and its selected regions before creating a server turn. */
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { bounded, launchBrowser } from './browser.mjs';
import { installSelectionUI } from './selection-ui.mjs';
import { composeCaptureImage } from './capture-images.mjs';
import { serializeDomSnapshot } from '../backend/src/dom-snapshot.ts';
import { parseCapture, CAPTURE_LIMITS } from '../backend/src/capture.ts';

export function captureSource({ url, files = [], select = false }) {
  const html = files.filter(file => /\.html?$/i.test(file));
  if (html.length > 1 || url && html.length) throw new Error('Choose one HTML --file or --url, not both');
  if (url) {
    try { if (!['http:','https:'].includes(new URL(url).protocol)) throw Error(); }
    catch { throw new Error('--url requires an HTTP/HTTPS URL'); }
  }
  if (select && !url && !html.length) throw new Error('--select requires --url or one HTML --file');
  return url ? {url,html:undefined} : html.length ? {url:pathToFileURL(resolve(html[0])).href,html:html[0]} : null;
}

export function validateCaptureSizes(sizes) {
  if(sizes.some(size=>size>CAPTURE_LIMITS.sourceBytes)||sizes.reduce((sum,size)=>sum+size,0)>24*1024*1024)throw new Error('附件超过单文件 16 MiB 或合计 24 MiB，请缩小选区或减少附件');
}

async function captureOnce(page, compositor) {
  const snapshot = await page.evaluate(() => window.__webclipCapture.snapshot());
  const mode = snapshot.regions.length ? 'regions' : 'page';
  const size = snapshot.documentSize;
  if (mode === 'page' && (size.width * size.height > 80_000_000 || size.height > 100_000 || size.width > 20_000)) throw new Error('页面过大，无法完整截图，请框选区域');
  if (Buffer.byteLength(snapshot.source) > CAPTURE_LIMITS.sourceBytes) throw new Error('source.html 超过 16 MiB，请缩小选区');
  await page.evaluate(() => window.__webclipCapture.hide(true));
  const tiles = [];
  try {
    if (mode === 'page') {
      tiles.push({id:'page',data:await page.screenshot({type:'png',fullPage:true,encoding:'base64'})});
    } else {
      for (const region of snapshot.regions) if (!region.textOnly) {
        if(region.rect.width*region.rect.height>80_000_000)throw new Error('选区过大，请缩小区域');
        tiles.push({
        id:region.id, data:await page.screenshot({type:'png',clip:region.rect,captureBeyondViewport:true,encoding:'base64'}),
      });
      }
    }
    const after = await page.evaluate(() => window.__webclipCapture.snapshot());
    if (snapshot.source !== after.source || JSON.stringify(snapshot.dom) !== JSON.stringify(after.dom) || JSON.stringify(snapshot.regions) !== JSON.stringify(after.regions)) throw new Error('页面在捕获期间发生变化，请重新选择/捕获');
    const image = await composeCaptureImage(compositor, tiles, mode, size);
    const imageId = mode==='page'?'page-image':'regions-image';
    const filename = image ? (mode==='page'?'page':'regions')+(image.mimeType==='image/png'?'.png':'.jpg') : null;
    const regions = snapshot.regions.map(({id,xpath,sourceXPath,rect,text}) => {
      const index=tiles.findIndex(tile=>tile.id===id);
      return {id,xpath,...(sourceXPath?{sourceXPath}:{}),rect,text,...(index>=0?{imageId,imageRect:image.boxes[index]}:{})};
    });
    const domJson=await serializeDomSnapshot(snapshot.source,snapshot.dom);
    validateCaptureSizes([Buffer.byteLength(snapshot.source),Buffer.byteLength(domJson),image?.bytes??0]);
    return {snapshot,domJson,image,filename,capture:{version:2,dom:'source.dom.json',mode,source:'source.html',viewport:snapshot.viewport,regions,
      images:image?[{id:imageId,file:filename,width:image.width,height:image.height,originalWidth:image.originalWidth,originalHeight:image.originalHeight,mimeType:image.mimeType,bytes:image.bytes,role:mode==='page'?'full-page':'montage'}]:[]}};
  } finally { await page.evaluate(() => window.__webclipCapture?.hide(false)).catch(()=>{}); }
}

/** Short browser reads keep user interaction independent of CDP's per-call timeout. */
async function waitCaptureState(page, states, signal) {
  for (;;) {
    signal.throwIfAborted();
    try {
      const status = await bounded(page.evaluate(() => window.__webclipCapture?.state.status), {signal,label:'Selection state'});
      if (states.includes(status)) return status;
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context/.test(String(error))) throw error;
    }
    await delay(100, undefined, {signal});
  }
}

/** Returns temporary upload paths with dispose(), or null when the user cancels. */
export async function capturePage(options, { headless = false, signal, onPage, report = console.log } = {}) {
  const source = captureSource(options);
  if (!source) return null;
  const stop=new AbortController(), cancel=()=>stop.abort();
  signal?.addEventListener('abort',cancel,{once:true}); if(signal?.aborted)cancel();
  let owned, directory;
  try {
    owned=await launchBrowser({headless,signal:stop.signal});
    owned.browser.on('disconnected',cancel);
    const page=await owned.browser.newPage(); page.on('close',cancel);
    if(headless)await page.setViewport({width:1280,height:900,deviceScaleFactor:1});
    await bounded(page.goto(source.url,{waitUntil:'load',timeout:30_000}),{signal:stop.signal,label:'Source loading'});
    await delay(3000,undefined,{signal:stop.signal});
    await page.evaluate(installSelectionUI);
    if(!options.select)await page.evaluate(()=>window.__webclipCapture.hide(true));
    const onLoad=()=>{void page.evaluate(installSelectionUI).catch(()=>{});};
    if(options.select)page.on('load',onLoad);
    const compositor=await owned.browser.newPage();
    await page.bringToFront();
    await onPage?.(page);
    let result;
    for (;;) {
      if(options.select) {
        report('在浏览器中框选区域，完成后预览并确认发送；不选区域则发送整页。');
        await waitCaptureState(page, ['capture','cancelled'], stop.signal);
        if(await page.evaluate(()=>window.__webclipCapture.state.status)==='cancelled')return null;
      }
      try {
        try { result=await captureOnce(page,compositor); }
        catch(error) { if(!String(error).includes('捕获期间'))throw error; result=await captureOnce(page,compositor); }
      } catch(error) {
        if(!options.select)throw error;
        const message=(error instanceof Error?error.message:String(error)).split('\n')[0];
        report(message);await page.evaluate(message=>window.__webclipCapture.error(message),message);continue;
      }
      if(!options.select)break;
      await page.evaluate(url=>window.__webclipCapture.showPreview(url),result.image?.url??'');
      await waitCaptureState(page, ['send','selecting','capture','cancelled'], stop.signal);
      const status=await page.evaluate(()=>window.__webclipCapture.state.status);
      if(status==='cancelled')return null;
      if(status==='send')break;
    }
    for(const name of ['pageUrl','baseUrl'])if(/^https?:/.test(result.snapshot[name]))result.capture[name]=result.snapshot[name];
    if(options.url)result.capture.requestUrl=source.url;
    const capture=parseCapture(result.capture);
    directory=await mkdtemp(join(tmpdir(),'webclip-capture-'));
    await writeFile(join(directory,'source.html'),result.snapshot.source);
    await writeFile(join(directory,'source.dom.json'),result.domJson);
    if(result.image)await writeFile(join(directory,result.filename),Buffer.from(result.image.data,'base64'));
    const attachments=(options.files??[]).filter(file=>file!==source.html);
    const reserved=new Set(['source.html','source.dom.json',result.filename].filter(Boolean));
    if(attachments.some(file=>reserved.has(basename(file))))throw new Error('Attachment filename conflicts with captured files');
    const paths=[join(directory,'source.html'),...(result.filename?[join(directory,result.filename)]:[]),join(directory,'source.dom.json'),...attachments];
    const sizes=await Promise.all(paths.map(path=>stat(path)));
    validateCaptureSizes(sizes.map(file=>file.size));
    const saved=directory;directory=undefined;
    return {capture,files:paths,dispose:()=>rm(saved,{recursive:true,force:true})};
  } catch(error) {
    if(stop.signal.aborted)return null;
    throw error;
  } finally {
    signal?.removeEventListener('abort',cancel);
    owned?.browser.off('disconnected',cancel);
    await owned?.close();
    if(directory)await rm(directory,{recursive:true,force:true});
  }
}
