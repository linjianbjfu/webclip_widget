import {test} from 'node:test';
import assert from 'node:assert/strict';
import {captureSource,validateCaptureSizes} from './capture-page.mjs';

test('capture source accepts one URL or HTML and rejects ambiguous/invalid arguments',()=>{
 assert.equal(captureSource({files:[]}),null);
 assert.match(captureSource({files:['page.html']}).url,/^file:/);
 assert.equal(captureSource({url:'https://example.com',files:['notes.txt'],select:true}).url,'https://example.com');
 for(const args of [{select:true},{url:'file:///secret'},{url:'not a URL'},{url:'https://example.com',files:['page.html']},{files:['one.html','two.html']}])assert.throws(()=>captureSource(args));
});


test('capture upload budget includes both source files and remaining attachments',()=>{
 const mib=1024*1024;
 validateCaptureSizes([12*mib,10*mib,2*mib]);
 assert.throws(()=>validateCaptureSizes([16*mib+1]),/16 MiB/);
 assert.throws(()=>validateCaptureSizes([12*mib,12*mib,1]),/24 MiB/);
});
