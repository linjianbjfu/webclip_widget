import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {InMemoryFs} from 'just-bash/browser';
import {createModelRuntime} from './model.ts';
import {openSession} from './session-factory.ts';
import {capturePrompt,ensureCaptureBudget} from './capture-prompt.ts';

test('real SDK sends capture image blocks and XPath context to the gateway, including restored history',async t=>{
 const requests=[];
 const server=createServer(async(req,res)=>{
  const parts=[];for await(const part of req)parts.push(part);requests.push(JSON.parse(Buffer.concat(parts).toString()));
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const chunk of [{choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:1,total_tokens:101}}])res.write('data: '+JSON.stringify(chunk)+'\n\n');
  res.end('data: [DONE]\n\n');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const runtime=await createModelRuntime({id:'fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture-key',defaultModel:'gpt-6.1-sol'});
 const fs=new InMemoryFs();
 const first=await openSession({modelRuntime:runtime,providerId:'fixture',modelId:'gpt-6.1-sol',fs,sessionId:'test',history:[]});
 const capture={version:1,mode:'regions',source:'source.html',viewport:{width:1280,height:900},regions:[{id:'r1',xpath:"//*[@id='quote']",rect:{x:0,y:0,width:40,height:40},text:'quote',imageId:'image',imageRect:{x:0,y:0,width:40,height:40}}],images:[{id:'image',file:'regions.png',role:'montage',width:40,height:40,mimeType:'image/png'}]};
 const text=capturePrompt('Read selected price',capture);
 await ensureCaptureBudget(first.session,text,1);
 await first.session.prompt(text,{images:[{type:'image',mimeType:'image/png',data:'AQID'}]});
 const user=requests[0].messages.findLast(m=>m.role==='user');assert.ok(user.content.some(block=>block.type==='image_url'&&block.image_url.url==='data:image/png;base64,AQID'));
 assert.ok(user.content.some(block=>block.type==='text'&&block.text.includes("//*[@id='quote']")));
 const restored=await openSession({modelRuntime:runtime,providerId:'fixture',modelId:'gpt-6.1-sol',fs,sessionId:'test',history:first.manager.getEntries()});
 await restored.session.prompt('Continue without new image');
 const users=requests[1].messages.filter(m=>m.role==='user');
 assert.equal(users.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='image_url').length,1);
 assert.equal(typeof users.at(-1).content==='string'?users.at(-1).content:users.at(-1).content[0].text,'Continue without new image');
 await first.session.dispose();await restored.session.dispose();
});
