import { env, runInDurableObject } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import type { UserAgentDO } from './user-agent-do.ts';
import { Store } from './store.ts';
import { initializeSchema } from '../fs/schema.ts';

it('image references round-trip beyond a SQLite row, survive Store reconstruction and remain isolated',async()=>{
 const stub=env.AGENT.get(env.AGENT.idFromName('capture-storage'));
 await runInDurableObject(stub,async(instance:UserAgentDO,state)=>{
  const store=new Store(instance.sqlForTest,fn=>state.storage.transactionSync(fn));store.createSession('s');
  const bytes=Buffer.alloc(2*1024*1024,123),image={type:'image',mimeType:'image/png',data:bytes.toString('base64')};
  const entry={type:'message',message:{role:'user',content:[{type:'text',text:'selected r1'},image]}};
  store.acceptTurn('s','t1','prompt',[{name:'source.html',data:Buffer.from('old')},{name:'regions.png',data:bytes}],null);
  store.append('s',[{turnId:'t1',kind:'pi_entry',payload:entry}]);
  const persisted=store.eventsSince('s',0)[0]!.payload;expect(persisted.length).toBeLessThan(1000);expect(persisted).toContain('image_ref');expect(persisted).not.toContain(image.data.slice(0,80));
  initializeSchema(instance.sqlForTest);
  const reconstructed=new Store(instance.sqlForTest,fn=>state.storage.transactionSync(fn));
  expect(reconstructed.piEntries('s')[0]!.entry).toEqual(entry);
  store.acceptTurn('s','t2','next',[{name:'source.html',data:Buffer.from('new')}],null);
  expect(Buffer.from(reconstructed.turnInput('s','t1').files[0]!.data).toString()).toBe('old');
  expect(reconstructed.turnInput('s','t2').files).toHaveLength(1);
  expect(reconstructed.piEntries('s','t1')).toEqual([]);
  expect(reconstructed.turnInput('s','legacy')).toEqual({capture:null,files:[]});
  instance.sqlForTest.exec('INSERT INTO events (session_id,seq,turn_id,kind,payload) VALUES (?,?,?,?,?)','s',2,'legacy','pi_entry',JSON.stringify({type:'message',message:{content:[{type:'image',mimeType:'image/png',data:'AQID'}]}}));
  expect(JSON.stringify(reconstructed.piEntries('s')[1]!.entry)).toContain('AQID');
  const circular:Record<string,unknown>={image};circular.self=circular;
  expect(()=>store.append('s',[{turnId:'t3',kind:'pi_entry',payload:circular}])).toThrow();expect(store.lastSeq('s')).toBe(2);
  store.createSession('other');expect(store.turnInput('other','t1').files).toEqual([]);
  store.deleteSession('s');expect(instance.sqlForTest.exec('SELECT * FROM input_chunks WHERE session_id=?','s').toArray()).toEqual([]);
 });
});

it('rejected or duplicate prompt attachments never replace accepted input/workspace',async()=>{
 const stub=env.AGENT.get(env.AGENT.idFromName('capture-http'));
 const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',next='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 await runInDurableObject(stub,async(instance:UserAgentDO)=>{instance.storeForTest.createSession('s');instance.turnRunner=async()=>{};await instance.workspace('s').writeFile('/source.html','existing');});
 const send=async(turnId:string,text:string,content:string)=>{
  const form=new FormData();form.set('turnId',turnId);form.set('text',text);form.append('file',new File([content],'source.html'));
  return stub.fetch('https://x/v1/sessions/s/prompt',{method:'POST',body:form});
 };
 const accepted=await send(id,'build','accepted');expect(accepted.status).toBe(200);await accepted.body?.cancel();
 const busy=await send(next,'build','overwrite');expect(busy.status).toBe(409);
 const repeat=await send(id,'changed','replacement');expect(repeat.status).toBe(200);await repeat.body?.cancel();
 await runInDurableObject(stub,async(instance:UserAgentDO)=>{
  expect(await instance.workspace('s').readFile('/source.html')).toBe('existing');
  expect(Buffer.from(instance.storeForTest.turnInput('s',id).files[0]!.data).toString()).toBe('accepted');
  expect(instance.storeForTest.turnInput('s',next).files).toEqual([]);
  instance.storeForTest.endTurn('s',id,'completed');
 });
 const empty=await send(next,'','bad');expect(empty.status).toBe(400);
});
