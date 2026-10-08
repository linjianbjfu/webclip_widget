import {env,runInDurableObject} from 'cloudflare:test';
import {it,expect} from 'vitest';
import type {UserAgentDO} from '../do/user-agent-do.ts';
import {WorkspaceFs} from '../fs/workspace-fs.ts';
import {applyCaptureInput,readCaptureSource} from './capture-source.ts';
import {parseMultipartPrompt} from '../do/upload.ts';
import {serializeDomSnapshot,type DomNode} from '../dom-snapshot.ts';
import {parseCapture} from '../capture.ts';
import {Store} from '../do/store.ts';

it('accepted input owns its DOM pair across storage, follow-ups and source replacement',async()=>{
 const stub=env.AGENT.get(env.AGENT.idFromName('capture-source-pair'));
 await runInDurableObject(stub,async(instance:UserAgentDO,state)=>{
  const fs=new WorkspaceFs(instance.sqlForTest,'pair');
  const source='<!doctype html><html><head></head><body><p>42</p></body></html>';
  const root:DomNode=[1,0,'html',[],[[1,0,'head',[],[]],[1,0,'body',[],[[1,0,'p',[],[[3,'42']]]]]]];
  const dom=await serializeDomSnapshot(source,root);
  const capture={version:2,dom:'source.dom.json',mode:'regions',source:'source.html',viewport:{width:1280,height:900},regions:[{id:'r1',xpath:'/html[1]/body[1]/p[1]',rect:{x:0,y:0,width:20,height:20},text:'42'}],images:[]};
  const form=()=>{const f=new FormData();f.set('capture',JSON.stringify(capture));f.append('file',new File([source],'source.html'));f.append('file',new File([dom],'source.dom.json'));return f;};
  const parsed=await parseMultipartPrompt(form());
  const store=new Store(instance.sqlForTest,fn=>state.storage.transactionSync(fn));store.createSession('pair');
  store.acceptTurn('pair','one','capture',parsed.files,parsed.capture);
  const input=new Store(instance.sqlForTest,fn=>state.storage.transactionSync(fn)).turnInput('pair','one');
  await applyCaptureInput(fs,input.files,input.capture);
  expect(await readCaptureSource(fs)).toEqual({source,dom});
  await applyCaptureInput(fs,[],null);expect(await readCaptureSource(fs)).toEqual({source,dom});
  await fs.rm('/source.dom.json');await expect(readCaptureSource(fs)).rejects.toThrow();
  await fs.writeFile('/source.dom.json',dom);await fs.writeFile('/source.html','different');await expect(readCaptureSource(fs)).rejects.toThrow('does not match');
  await applyCaptureInput(fs,[{name:'source.html',data:new TextEncoder().encode('legacy')}],null);
  expect(await readCaptureSource(fs)).toEqual({source:'legacy'});expect(await fs.exists('/source.dom.json')).toBe(false);
  await fs.writeFile('/source.dom.json','stale');expect(await readCaptureSource(fs)).toEqual({source:'legacy'});
  await applyCaptureInput(fs,input.files,input.capture);
  const {dom: _dom, ...legacyCapture}=capture;
  await applyCaptureInput(fs,[{name:'source.html',data:new TextEncoder().encode(source)}],parseCapture({...legacyCapture,version:1}));
  expect(await readCaptureSource(fs)).toEqual({source});expect(await fs.exists('/source.dom.json')).toBe(false);
  const bomSource='\uFEFF'+source,bomDom=await serializeDomSnapshot(bomSource,root),bom=form();
  bom.delete('file');bom.append('file',new File([bomSource],'source.html'));bom.append('file',new File([bomDom],'source.dom.json'));
  const bomInput=await parseMultipartPrompt(bom);await applyCaptureInput(fs,bomInput.files,bomInput.capture);expect(await readCaptureSource(fs)).toEqual({source:bomSource,dom:bomDom});
  const missing=form();missing.delete('file');missing.append('file',new File([source],'source.html'));await expect(parseMultipartPrompt(missing)).rejects.toThrow('source.dom.json is missing');
  for(const body of ['{}','{bad',dom.replace(/"sourceSha256":"[a-f0-9]+"/,'"sourceSha256":"'+'0'.repeat(64)+'"'),JSON.stringify({...JSON.parse(dom),root:[7,'script']})]){
   const bad=form();bad.delete('file');bad.append('file',new File([source],'source.html'));bad.append('file',new File([body],'source.dom.json'));await expect(parseMultipartPrompt(bad)).rejects.toThrow('Invalid capture DOM');
  }
  const unclaimed=form();unclaimed.delete('capture');await expect(parseMultipartPrompt(unclaimed)).rejects.toThrow('requires capture v2');
  const reserved=new FormData();reserved.append('file',new File(['{}'],'capture-source.json'));await expect(parseMultipartPrompt(reserved)).rejects.toThrow('Reserved');
 });
});
