import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser} from '../browser.mjs';
import {DOM_CODEC} from '../../backend/src/dom-snapshot.ts';
import {installSelectionUI} from '../selection-ui.mjs';

async function fixture(t){
  const owned=await launchBrowser({headless:true});t.after(()=>owned.close());
  const page=await owned.browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>section{display:block}</style><script type="application/json">{"outside":true}</script></head><body>
    <nav><a href="/home" data-key="nav">导航</a><template><i data-key="template">模板文字</i></template></nav>
    <main id="root"><div class="nav"><a href="/">导航文字</a></div><div class="ad">广告文字</div>
      <div class="news" id="news"><h2>新闻标题</h2><a href="/story">新闻内容</a><script type="application/json">{"inside":true}</script></div>
      <div id="between"><i>中间文字</i></div><section id="branch"><p>前方</p><article id="second"><b>第二个选区</b></article><footer id="branch-tail">后方</footer></section>
      <div id="tail"><div id="news">后方重复 id</div></div>
    </main><aside id="outer-tail">外层后方</aside></body></html>`);
  await page.evaluate(installSelectionUI);await page.evaluate(`${DOM_CODEC};window.restoreCapture=decodeDom;`);return page;
}

test('trailing branches disappear while preceding structure and absolute paths stay intact',async t=>{
  const page=await fixture(t);
  const result=await page.evaluate(()=>{
    const api=window.__webclipCapture, news=document.querySelector('.news'), before=document.documentElement.outerHTML;
    const expected=news.outerHTML;
    api.state.regions=[{id:'r1',el:news}];
    const snapshot=api.snapshot(), doc=window.restoreCapture(snapshot.dom), region=snapshot.regions[0];
    const match=doc.evaluate(region.xpath,doc,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
    return {region,unchanged:before===document.documentElement.outerHTML,subtree:match.outerHTML===expected,
      ids:[...doc.querySelectorAll('#news')].length,childTags:[...doc.querySelector('#root').children].map(n=>n.className),
      tail:!!doc.querySelector('#tail,#branch,#between,#outer-tail'),nav:doc.querySelector('nav a').outerHTML,
      template:doc.querySelector('template').innerHTML,style:doc.querySelector('style').textContent,
      script:doc.querySelector('head script').textContent,source:snapshot.source};
  });
  assert.equal(result.region.xpath,'/html[1]/body[1]/main[1]/div[3]');assert.equal(result.region.sourceXPath,undefined);
  assert.ok(result.unchanged);assert.ok(result.subtree);assert.equal(result.ids,1);assert.equal(result.tail,false);
  assert.deepEqual(result.childTags,['nav','ad','news']);assert.equal(result.nav,'<a href="/home" data-key="nav"></a>');
  assert.equal(result.template,'<i data-key="template"></i>');assert.equal(result.style,'');assert.equal(result.script,'');
  assert.doesNotMatch(result.source,/广告文字|导航文字|data-webclip-region-map/);
});

test('multiple and overlapping regions retain later branches and preserve every selected subtree',async t=>{
  const page=await fixture(t);
  const result=await page.evaluate(()=>{
    const selected=[document.querySelector('.news'),document.querySelector('#second'),document.querySelector('#second b')];
    window.__webclipCapture.state.regions=selected.map((el,i)=>({id:`r${i+1}`,el}));
    const snapshot=window.__webclipCapture.snapshot(),doc=window.restoreCapture(snapshot.dom);
    return {matches:snapshot.regions.map((r,i)=>{
      const captured=doc.evaluate(r.xpath,doc,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
      const live=document.evaluate(r.xpath,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
      return live===selected[i]&&captured.isEqualNode(selected[i]);
    }),between:doc.querySelector('#between').outerHTML,preceding:doc.querySelector('#branch p').outerHTML,
    secondCount:doc.querySelectorAll('#second').length,tail:!!doc.querySelector('#tail,#branch-tail,#outer-tail')};
  });
  assert.deepEqual(result.matches,[true,true,true]);assert.equal(result.secondCount,1);assert.equal(result.tail,false);
  assert.equal(result.between,'<div id="between"><i></i></div>');assert.equal(result.preceding,'<p></p>');
});

test('capture stability ignores discarded content but detects retained data, paths, attributes and positions',async t=>{
  const page=await fixture(t);
  const result=await page.evaluate(()=>{
    const api=window.__webclipCapture,news=document.querySelector('.news');
    api.state.regions=[{id:'r1',el:news}];
    const key=()=>{const s=api.snapshot();return JSON.stringify([s.source,s.regions]);};
    const base=key();
    document.querySelector('head script').textContent='{"changed":true}';
    document.querySelector('#tail').innerHTML='<div>完全不同的后方结构</div>';
    const ignored=key()===base;
    news.querySelector('h2').textContent='更新标题';const changedText=key()!==base;
    news.querySelector('h2').textContent='新闻标题';
    const nav=document.querySelector('nav a');nav.setAttribute('data-key','changed');const changedAttribute=key()!==base;nav.setAttribute('data-key','nav');
    const spacer=document.createElement('div');news.before(spacer);const changedPath=key()!==base;spacer.remove();
    news.style.transform='translateY(1px)';const changedPosition=key()!==base;news.removeAttribute('style');
    api.state.regions=[];const full=api.snapshot().source;
    return {ignored,changedText,changedAttribute,changedPath,changedPosition,full};
  });
  for(const key of ['ignored','changedText','changedAttribute','changedPath','changedPosition'])assert.equal(result[key],true,key);
  assert.match(result.full,/广告文字/);assert.match(result.full,/完全不同的后方结构/);assert.match(result.full,/changed/);
});

test('unsupported DOM nodes are rejected rather than silently removed',async t=>{
  const page=await fixture(t);
  await page.evaluate(()=>{
    document.querySelector('.news').append(document.createProcessingInstruction('test','payload'));
    window.__webclipCapture.state.regions=[{id:'r1',el:document.querySelector('.news')}];
  });
  await assert.rejects(page.evaluate(()=>window.__webclipCapture.snapshot()),/Unsupported DOM node type/);
});
