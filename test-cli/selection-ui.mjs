import { DOM_CODEC } from '../backend/src/dom-snapshot.ts';

/** Runs in the source page; tool nodes are removable without editing selected elements. */
function selectionUI({encodeDom, decodeDom}) {
  if (window.__webclipCapture) return;
  const host = document.createElement('div'); host.dataset.webclipUi = 'true';
  document.documentElement.append(host);
  const root = host.attachShadow({mode:'open'});
  root.innerHTML = `<style>
    :host{all:initial}*{box-sizing:border-box;font-family:system-ui,sans-serif}
    #panel{position:fixed;right:16px;bottom:16px;width:340px;max-height:70vh;overflow:auto;background:#fff;color:#17202a;padding:16px;border:1px solid #abb4c0;border-radius:12px;box-shadow:0 4px 24px #0004;z-index:2147483647;font-size:13px}
    button{border:1px solid #b5bdc8;border-radius:6px;padding:7px;margin:3px;background:#f5f7fa;color:#17202a;cursor:pointer}button.primary{background:#185abc;color:white;border-color:#185abc}h3{margin:0 0 8px}p{margin:6px 0;line-height:1.4}
    .row{border-top:1px solid #ddd;padding:7px 0}.box{position:fixed;border:2px solid #185abc;background:#185abc16;pointer-events:none;z-index:2147483646}.tag{background:#185abc;color:white;padding:2px 5px;font-size:12px}
    #preview{max-width:100%;max-height:36vh;object-fit:contain}#error{color:#a11;white-space:pre-wrap}
  </style><div id="boxes"></div><div id="panel"><h3>选择 widget 内容</h3><p>拖框后吸附完整区块；可滚动并多选，最多 8 个。小型纯文本只发送文本。</p><button id="mode">切换到浏览</button><button id="clear">清空</button><div id="list"></div><p id="error"></p><div id="previewArea" hidden><img id="preview"><p>检查区域编号和文字是否清晰。</p><button id="back">重新选择</button><button id="send" class="primary">确认发送</button></div><button id="finish" class="primary">整页截图并继续</button><button id="cancel">取消</button></div>`;
  const state = { regions: [], mode: true, status:'selecting', next:1, hide: false };
  const api = window.__webclipCapture = {
    state, host,
    showPreview(url) { root.querySelector('#preview').src = url || ''; root.querySelector('#preview').hidden = !url; root.querySelector('#previewArea').hidden=false; root.querySelector('#finish').hidden=true; root.querySelector('#list').inert=true;root.querySelector('#clear').disabled=true;root.querySelector('#mode').disabled=true;state.status='preview'; },
    error(message) { root.querySelector('#error').textContent=message; state.status='selecting'; },
    hide(hidden) { host.style.display=hidden?'none':''; },
  };
  const supported = el => el && el !== host && !host.contains(el) && el.getRootNode() === document && !el.shadowRoot && !['IFRAME','FRAME','HTML','HEAD','BODY','SCRIPT','STYLE'].includes(el.tagName);
  const textOnly = el => {
    const r=el.getBoundingClientRect(), style=getComputedStyle(el), text=el.innerText?.trim()??'';
    return text.length>0&&text.length<=200&&r.height<=Math.max(40,parseFloat(style.lineHeight)*1.5||40)&&!el.querySelector('img,svg,canvas,video,iframe')&&style.backgroundImage==='none'&&[...el.querySelectorAll('*')].every(n=>!n.shadowRoot&&getComputedStyle(n).backgroundImage==='none');
  };
  function draw() {
    const list=root.querySelector('#list'), boxes=root.querySelector('#boxes'); list.replaceChildren(); boxes.replaceChildren();
    for (const item of state.regions) {
      const row=document.createElement('div'); row.className='row';
      const valid=item.el.isConnected&&supported(item.el), title=document.createElement('div');
      title.textContent=`${item.id} · ${valid?(textOnly(item.el)?'仅文本':'含截图'):'已失效，请删除'} · ${(item.el.innerText||item.el.tagName).trim().slice(0,65)}`;
      row.append(title);
      for(const [label,action] of [['父区块',()=>{if(supported(item.el.parentElement)&&!state.regions.some(r=>r!==item&&r.el===item.el.parentElement))item.el=item.el.parentElement;}],['子区块',()=>{const child=[...item.el.children].find(supported);if(child&&!state.regions.some(r=>r!==item&&r.el===child))item.el=child;}],['删除',()=>{state.regions=state.regions.filter(r=>r!==item);} ]]) {
        const button=document.createElement('button');button.textContent=label;button.onclick=()=>{action();draw();};row.append(button);
      }
      list.append(row);
      if(valid) {const r=item.el.getBoundingClientRect(),box=document.createElement('div');box.className='box';Object.assign(box.style,{left:`${r.x}px`,top:`${r.y}px`,width:`${r.width}px`,height:`${r.height}px`});const tag=document.createElement('span');tag.className='tag';tag.textContent=item.id;box.append(tag);boxes.append(box);}
    }
    root.querySelector('#finish').textContent=state.regions.length?`预览 ${state.regions.length} 个选区`:'整页截图并继续';
  }
  root.querySelector('#mode').onclick=()=>{state.mode=!state.mode;root.querySelector('#mode').textContent=state.mode?'切换到浏览':'切换到框选';};
  root.querySelector('#clear').onclick=()=>{state.regions=[];draw();};
  root.querySelector('#cancel').onclick=()=>{state.status='cancelled';};
  root.querySelector('#finish').onclick=()=>{
    if(state.regions.some(r=>!r.el.isConnected||!supported(r.el))) {api.error('选区已变化，请重新选择。');return;}
    state.status='capture';
  };
  root.querySelector('#send').onclick=()=>{state.status='send';};
  root.querySelector('#back').onclick=()=>{state.status='selecting';root.querySelector('#previewArea').hidden=true;root.querySelector('#finish').hidden=false;root.querySelector('#list').inert=false;root.querySelector('#clear').disabled=false;root.querySelector('#mode').disabled=false;draw();};
  let start, drag;
  document.addEventListener('pointerdown',event=>{
    if(!state.mode||state.status!=='selecting'||event.button!==0||event.composedPath().includes(host))return;
    event.preventDefault();event.stopImmediatePropagation();start={x:event.clientX,y:event.clientY};
    drag=document.createElement('div');drag.className='box';root.querySelector('#boxes').append(drag);
  },true);
  document.addEventListener('pointermove',event=>{
    if(!start)return;event.preventDefault();Object.assign(drag.style,{left:`${Math.min(start.x,event.clientX)}px`,top:`${Math.min(start.y,event.clientY)}px`,width:`${Math.abs(start.x-event.clientX)}px`,height:`${Math.abs(start.y-event.clientY)}px`});
  },true);
  document.addEventListener('pointerup',event=>{
    if(!start)return;event.preventDefault();event.stopImmediatePropagation();
    const a=start;start=null;drag.remove();
    const rect={left:Math.min(a.x,event.clientX),top:Math.min(a.y,event.clientY),right:Math.max(a.x,event.clientX),bottom:Math.max(a.y,event.clientY)};
    const hits=[];
    for(let y=0;y<3;y++)for(let x=0;x<3;x++){
      const el=document.elementFromPoint(rect.left+(rect.right-rect.left)*(x+.5)/3,rect.top+(rect.bottom-rect.top)*(y+.5)/3);
      if(el&&el!==host&&!host.contains(el))hits.push(el);
    }
    let candidate=hits[0];
    while(candidate&&hits.some(el=>!candidate.contains(el)))candidate=candidate.parentElement;
    if(!supported(candidate)){api.error('请选择主页面的普通 DOM 区块；iframe、Shadow DOM 内部和整页根节点暂不支持。');draw();return;}
    if(state.regions.some(r=>r.el===candidate)){api.error('该区块已选择。');draw();return;}
    if(state.regions.length>=8){api.error('最多选择 8 个区域。');draw();return;}
    root.querySelector('#error').textContent='';state.regions.push({id:`r${state.next++}`,el:candidate});draw();
  },true);
  document.addEventListener('click',event=>{if(state.mode&&!event.composedPath().includes(host)){event.preventDefault();event.stopImmediatePropagation();}},true);
  addEventListener('blur',()=>{start=null;drag?.remove();});
  addEventListener('scroll',draw,{passive:true});addEventListener('resize',draw);draw();
  api.snapshot = () => {
    const literal = value => !value.includes("'") ? `'${value}'` : !value.includes('"') ? `"${value}"` : `concat(${value.split("'").map(part=>`'${part}'`).join(`,"'",`)})`;
    const xpath = el => {
      const parts=[];
      for(let node=el;node;node=node.parentElement){
        let index=1;
        for(let sib=node.previousElementSibling;sib;sib=sib.previousElementSibling)if(sib.localName===node.localName&&sib.namespaceURI===node.namespaceURI)index++;
        const name=node.namespaceURI==='http://www.w3.org/1999/xhtml' ? node.localName : `*[local-name()=${literal(node.localName)} and namespace-uri()=${literal(node.namespaceURI??'')}]`;
        parts.unshift(`${name}[${index}]`);
      }
      return '/'+parts.join('/');
    };
    const clone=document.documentElement.cloneNode(true);
    const selected=state.regions.map(item=>{
      if(!item.el.isConnected||!supported(item.el))throw Error(`${item.id}：选区已失效，请重新选择`);
      const path=xpath(item.el), fail=message=>{throw Error(`${item.id} (${path})：${message}`);};
      // Child indices map to the untouched clone, before UI removal.
      const indices=[];
      for(let node=item.el;node!==document.documentElement;node=node.parentNode)indices.unshift([...node.parentNode.childNodes].indexOf(node));
      let target=clone;
      for(const index of indices)target=target.childNodes[index];
      return {item,path,fail,target};
    });
    clone.querySelectorAll('[data-webclip-ui]').forEach(n=>n.remove());
    const mapped=selected;
    if(mapped.length){
      const roots=new Set(mapped.map(region=>region.target)), branches=new Set();
      for(const root of roots)for(let node=root;node;node=node.parentElement)branches.add(node);
      const clearText = root => {
        const pending=[root];
        while(pending.length){
          const node=pending.pop();
          for(const child of [...node.childNodes]){
            if(child.nodeType===Node.TEXT_NODE||child.nodeType===Node.COMMENT_NODE)child.remove();
            else pending.push(child);
          }
          if(node.localName==='template'&&node.content)pending.push(node.content);
        }
      };
      const prune = node => {
        if(roots.has(node))return;
        const children=[...node.childNodes];
        const last=children.findLastIndex(child=>branches.has(child));
        for(const [index,child] of children.entries()){
          if(index>last||child.nodeType!==Node.ELEMENT_NODE)child.remove();
          else if(branches.has(child))prune(child);
          else clearText(child);
        }
      };
      // Keeping every preceding element preserves forward XPath indices at each level.
      prune(clone);
    }
    const source='<!doctype html>\n'+clone.outerHTML;
    const dom=encodeDom(clone), restored=decodeDom(dom);
    if(!clone.isEqualNode(restored.documentElement))throw Error('捕获无法精确保留 DOM 结构');
    const regions=mapped.map(({item,path,target,fail})=>{
      const match=restored.evaluate(path,restored,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
      if(match.snapshotLength!==1 || !target.isEqualNode(match.snapshotItem(0)) ||
          JSON.stringify(encodeDom(item.el))!==JSON.stringify(encodeDom(target)))fail('捕获改变了选区结构，请重新选择');
      const r=item.el.getBoundingClientRect();
      if(r.width<=0||r.height<=0)fail('选区不可见，请重新选择');
      return {id:item.id,xpath:path,rect:{x:Math.max(0,r.x+scrollX),y:Math.max(0,r.y+scrollY),width:r.width,height:r.height},text:(item.el.innerText||'').trim().slice(0,4000),textOnly:textOnly(item.el),fingerprint:item.el.outerHTML};
    });
    return {source,dom,regions,pageUrl:location.href,baseUrl:document.baseURI,viewport:{width:innerWidth,height:innerHeight},documentSize:{width:Math.max(document.documentElement.scrollWidth,innerWidth),height:Math.max(document.documentElement.scrollHeight,innerHeight)}};
  };
}

// Inject the shared codec into the self-contained browser function.
export const installSelectionUI = new Function(`${DOM_CODEC}\nreturn (${selectionUI.toString()})({encodeDom, decodeDom});`);
