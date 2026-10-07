import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {InMemoryFs} from 'just-bash/browser';
import {createModelRuntime} from './model.ts';
import {openSession} from './session-factory.ts';
import {createDesignContextTool} from './design-context.ts';

test('real SDK calls the design tool and restores its result into the next turn', async t => {
  const requests=[];
  const server=createServer(async(req,res)=>{
    const parts=[];for await(const part of req)parts.push(part);
    requests.push(JSON.parse(Buffer.concat(parts).toString()));
    res.writeHead(200,{'content-type':'text/event-stream'});
    const first=requests.length===1;
    const delta=first ? {role:'assistant',tool_calls:[{index:0,id:'design-1',type:'function',function:{name:'get_design_context',arguments:JSON.stringify({pattern:'image-text',size:'middle'})}}]} : {role:'assistant',content:'Design loaded'};
    for(const chunk of [{choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}}])res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const runtime=await createModelRuntime({id:'design-fixture',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fixture',defaultModel:'gpt-6.1-sol'});
  const input={modelRuntime:runtime,providerId:'design-fixture',modelId:'gpt-6.1-sol',fs:new InMemoryFs(),sessionId:'design',history:[]};
  const first=await openSession(input);t.after(()=>first.session.dispose());
  await first.session.prompt('Create a widget for this content.');
  const tool=requests[0].tools.find(item=>item.function?.name==='get_design_context');
  assert.ok(tool);assert.match(JSON.stringify(tool),/image-text/);
  const result=requests[1].messages.find(item=>item.role==='tool'&&item.tool_call_id==='design-1');
  assert.ok(result);assert.match(JSON.stringify(result),/createImageExtractor/);
  const restored=await openSession({...input,history:first.manager.getEntries()});t.after(()=>restored.session.dispose());
  await restored.session.prompt('Keep the design, shorten the title.');
  assert.deepEqual(requests[2].messages.find(item=>item.role==='tool'&&item.tool_call_id==='design-1'),result);
  const design=createDesignContextTool();
  await assert.rejects(design.execute('bad',{pattern:'../../secret',size:'small'}),/Invalid design/);
});
