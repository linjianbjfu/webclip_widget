import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser} from '../browser.mjs';
import {installSelectionUI} from '../selection-ui.mjs';
import {structureKinds,buildStructure} from '../dom-structure-fixtures.mjs';
import {DOM_CODEC,serializeDomSnapshot} from '../../backend/src/dom-snapshot.ts';
import {extractionExpression} from '../../backend/src/agent/extraction.ts';
import {renderWidgetPreview} from '../../backend/src/agent/preview-render.ts';

test('capture preserves runtime trees, namespaces, templates and extraction without parser repair',async t=>{
 const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
 const page=await owned.browser.newPage();
 for(const kind of structureKinds){
  await page.setContent('<main id="region" style="width:400px;min-height:100px"></main>');
  await page.evaluate(buildStructure,kind);
  await page.evaluate(()=>{
   const root=document.querySelector('#region'),template=document.createElement('template');
   template.innerHTML='<b title="&quot;&amp;">中文 &amp; 😀</b><!-- template -->';root.append(template,document.createComment('中文 <>&'));
   const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
   svg.setAttributeNS('http://www.w3.org/1999/xlink','xlink:href','#shape');root.append(svg);
  });
  await page.evaluate(installSelectionUI);
  await page.evaluate(new Function(`${DOM_CODEC}; window.restoreCapture=decodeDom;`));
  const snapshot=await page.evaluate(()=>{
   const root=document.querySelector('#region');window.__webclipCapture.state.regions=[{id:'r1',el:root}];
   const snapshot=window.__webclipCapture.snapshot(),doc=window.restoreCapture(snapshot.dom);
   if(!root.isEqualNode(doc.querySelector('#region')))throw Error('Region changed');
   if(doc.defaultView!==null)throw Error('Reconstruction is not inert');
   const xpath=snapshot.regions[0].xpath;
   if(doc.evaluate(xpath,doc,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue!==doc.querySelector('#region'))throw Error('XPath changed');
   return snapshot;
  });
  const script=`(() => ({html:document.querySelector('#region').outerHTML,rows:document.querySelectorAll('table > tr').length,nested:document.querySelectorAll('a a').length,template:document.querySelector('template').content.textContent}))()`;
  assert.equal(await page.evaluate(extractionExpression(script)),await page.evaluate(extractionExpression(script,snapshot.source,snapshot.dom)),kind);
  assert.equal(snapshot.regions[0].sourceXPath,undefined);
 }
});

test('v2 preview keeps direct rows and nested cards inert and rejects a mismatched pair',async t=>{
 const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
 const page=await owned.browser.newPage();await page.setContent('<main id="region" style="min-height:100px"></main>');
 await page.evaluate(buildStructure,'table-tr');await page.evaluate(buildStructure,'nested-a');
 await page.evaluate(installSelectionUI);
 const snapshot=await page.evaluate(()=>{window.__webclipCapture.state.regions=[{id:'r1',el:document.querySelector('main')}];return window.__webclipCapture.snapshot();});
 // Add resources only to the inert tree, so any request/execution is attributable to reconstruction.
 const body=snapshot.dom[4].find(node=>node[2]==='body');
 body[4].push([1,0,'script',[],[[3,'globalThis.sourceExecuted=true']]], [1,0,'img',[[null,'src','https://source.invalid/image']],[]]);
 const dom=await serializeDomSnapshot(snapshot.source,snapshot.dom);
 const requests=[];await page.setRequestInterception(true);page.on('request',request=>{requests.push(request.url());void request.abort();});
 const extra=`(() => ({rows:document.querySelectorAll('table > tr').length,author:document.querySelector('a a').textContent}))()`;
 const expected=await page.evaluate(extractionExpression(extra));
 assert.equal(await page.evaluate(extractionExpression(extra,snapshot.source,snapshot.dom)),expected);
 assert.equal(await page.evaluate(()=>globalThis.sourceExecuted),undefined);
 assert.deepEqual(requests,[]);
 const html=`<style>*{box-sizing:border-box}html,body,#widget-root{margin:0;width:100%;height:100%}</style><main id="widget-root"></main><script>window.renderWidget=d=>document.querySelector('main').textContent=d.rows+' '+d.author;window.widgetReady=fetch('./data.json').then(r=>r.json()).then(renderWidget);</script>`;
 const result=await renderWidgetPreview(owned.browser,{html,extra,source:snapshot.source,dom,size:'small'});
 assert.deepEqual(result.errors,[]);assert.equal(result.extractedData,expected);
 await assert.rejects(renderWidgetPreview(owned.browser,{html,extra,source:'changed',dom,size:'small'}),/does not match/);
});
