import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureSource} from './capture-page.mjs';

test('capture source accepts one URL or HTML and rejects ambiguous/invalid arguments',()=>{
 assert.equal(captureSource({files:[]}),null);
 assert.match(captureSource({files:['page.html']}).url,/^file:/);
 assert.equal(captureSource({url:'https://example.com',files:['notes.txt'],select:true}).url,'https://example.com');
 for(const args of [{select:true},{url:'file:///secret'},{url:'not a URL'},{url:'https://example.com',files:['page.html']},{files:['one.html','two.html']}])assert.throws(()=>captureSource(args));
});
