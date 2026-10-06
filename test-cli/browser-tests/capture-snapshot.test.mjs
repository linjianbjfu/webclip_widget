import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchBrowser} from '../browser.mjs';
import {installSelectionUI} from '../selection-ui.mjs';

async function fixture(t) {
  const owned = await launchBrowser({headless:true});
  t.after(() => owned.close());
  const page = await owned.browser.newPage();
  await page.setContent('<!doctype html><html><head></head><body><main id="list"><article id="card"></article></main></body></html>');
  // DOM APIs allow the nested links that the HTML parser repairs on capture.
  await page.evaluate(() => {
    const card = document.querySelector('#card');
    const outer = document.createElement('a'); outer.href = '/news';
    outer.innerHTML = '<h2>新闻标题</h2><div class="author"></div>';
    const author = document.createElement('a'); author.href = '/author'; author.textContent = '作者';
    outer.querySelector('.author').append(author);
    const image = document.createElement('img'); image.setAttribute('src', '/cover.png');
    image.width = 80; image.height = 60; outer.append(image);
    card.append(outer);
    const following = document.createElement('a'); following.href = '/next'; following.textContent = '下一条';
    card.append(following);
  });
  await page.evaluate(installSelectionUI);
  return page;
}

test('parser repair preserves whole cards/lists and maps moved live XPath without touching the page', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    const api = window.__webclipCapture, card = document.querySelector('#card');
    const before = document.documentElement.outerHTML;
    const author=card.querySelector('a[href="/author"]');
    api.state.regions = [card, document.querySelector('#list'), author].map((el,i) => ({id:`r${i+1}`,el}));
    const snapshot = api.snapshot();
    const parsed = new DOMParser().parseFromString(snapshot.source,'text/html');
    const matches = snapshot.regions.map(r => {
      const nodes = parsed.evaluate(r.xpath,parsed,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
      const el = nodes.snapshotItem(0);
      return {count:nodes.snapshotLength,text:el.textContent,links:[...el.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')),images:[...el.querySelectorAll('img')].map(img=>img.getAttribute('src'))};
    });
    const moved = snapshot.regions[2];
    const liveMatch = document.evaluate(moved.sourceXPath,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
    return {snapshot,matches,unchanged:before===document.documentElement.outerHTML,liveMatches:liveMatch===author,repeat:JSON.stringify(snapshot)===JSON.stringify(api.snapshot())};
  });
  assert.ok(result.unchanged); assert.ok(result.repeat); assert.ok(result.liveMatches);
  assert.notEqual(result.snapshot.regions[2].sourceXPath,result.snapshot.regions[2].xpath);
  assert.equal(result.snapshot.regions[0].sourceXPath,undefined);
  assert.doesNotMatch(result.snapshot.source,/data-webclip-(region-map|ui)/);
  for (const match of result.matches.slice(0,2)) {
    assert.equal(match.count,1); assert.match(match.text,/新闻标题作者下一条/);
    assert.ok(match.links.includes('/news')); assert.ok(match.links.includes('/author'));
    assert.deepEqual(match.images,['/cover.png']);
  }
  assert.equal(result.matches[2].text,'作者');
});

test('split or lost regions are rejected with a region-specific parent-card hint', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {window.__webclipCapture.state.regions=[{id:'r4',el:document.querySelector('#card > a')}];});
  await assert.rejects(page.evaluate(() => window.__webclipCapture.snapshot()),/r4.*(拆分|内容).*父区块/);
  await page.evaluate(() => {
    const p = document.createElement('p'); p.textContent = '开头';
    const div = document.createElement('div'); div.textContent = '移到外部'; p.append(div); document.body.append(p);
    window.__webclipCapture.state.regions=[{id:'r5',el:p}];
  });
  await assert.rejects(page.evaluate(() => window.__webclipCapture.snapshot()),/r5.*内容.*父区块/);
  await page.evaluate(() => {
    const col=document.createElement('col'); document.body.append(col);
    window.__webclipCapture.state.regions=[{id:'r6',el:col}];
  });
  await assert.rejects(page.evaluate(() => window.__webclipCapture.snapshot()),/r6.*找不到.*父区块/);
});

test('SVG, duplicate ids and ids with both quotes resolve in both documents', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    const container=document.createElement('div');
    container.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><g><rect width="60" height="50"/></g></svg><p id="duplicate">one</p><p id="duplicate">two</p><p>quotes</p>';
    container.lastElementChild.id = `both'"quotes`;
    document.body.append(container);
    const elements=[container.querySelector('rect'),...container.querySelectorAll('p')];
    window.__webclipCapture.state.regions=elements.map((el,i)=>({id:`r${i+1}`,el}));
    const snapshot=window.__webclipCapture.snapshot(), parsed=new DOMParser().parseFromString(snapshot.source,'text/html');
    return snapshot.regions.map((region,i)=> {
      const match=parsed.evaluate(region.xpath,parsed,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
      const live=document.evaluate(region.sourceXPath??region.xpath,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
      return {count:match.snapshotLength,live:live===elements[i],text:match.snapshotItem(0).textContent};
    });
  });
  assert.deepEqual(result,[{count:1,live:true,text:''},{count:1,live:true,text:'one'},{count:1,live:true,text:'two'},{count:1,live:true,text:'quotes'}]);
});

test('temporary mapping does not overwrite a page-owned attribute', async t => {
  const page=await fixture(t);
  const result=await page.evaluate(()=>{
    const card=document.querySelector('#card');card.setAttribute('data-webclip-region-map','page-value');
    window.__webclipCapture.state.regions=[{id:'r1',el:card}];
    const snapshot=window.__webclipCapture.snapshot();
    return {source:snapshot.source,live:card.getAttribute('data-webclip-region-map'),temporary:document.querySelector('[data-webclip-region-map-x]')!==null};
  });
  assert.match(result.source,/data-webclip-region-map="page-value"/);
  assert.doesNotMatch(result.source,/data-webclip-region-map-x/);
  assert.equal(result.live,'page-value');assert.equal(result.temporary,false);
});
