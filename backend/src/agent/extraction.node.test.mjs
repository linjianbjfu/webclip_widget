import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {extractionExpression} from './extraction.ts';

test('extraction awaits object results and rejects unresolved or non-JSON async data',async()=>{
  const evaluate=script=>runInNewContext(extractionExpression(script),{document:{},setTimeout,clearTimeout});
  assert.equal(await evaluate('(() => ({value:0}))()'),'{"value":0}');
  assert.equal(await evaluate('(async () => ({value:await Promise.resolve(42)}))()'),'{"value":42}');
  for(const script of ['Promise.resolve([])','Promise.resolve("data")','Promise.resolve({image:Promise.resolve(null)})','Promise.reject(new Error("failed"))']){
    await assert.rejects(evaluate(script));
  }
  let cleared=false;
  // Drive the extraction deadline without depending on elapsed CI time.
  const pending=runInNewContext(extractionExpression('new Promise(()=>{})'),{
    document:{},setTimeout(callback,ms){assert.equal(ms,15000);queueMicrotask(callback);return 1;},
    clearTimeout(id){assert.equal(id,1);cleared=true;},
  });
  await assert.rejects(pending,/extra.js timed out/);assert.equal(cleared,true);
});
