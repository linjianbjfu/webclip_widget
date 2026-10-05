import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPreviewServer } from './preview-server.mjs';

function get(url, path, method = 'GET') {
  return new Promise((resolve,reject) => {
    const req = request(url, {path, method}, res => {
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
    });
    req.on('error',reject); req.end();
  });
}

test('loopback HTTP serves fresh files and rejects escaping paths and non-files', async t => {
  const root=await mkdtemp(join(tmpdir(),'webclip-server-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const out=join(root,'out'); await mkdir(out);
  await writeFile(join(out,'widget.html'),'<p>widget</p>');
  await writeFile(join(out,'data.json'),'{"value":0}');
  await writeFile(join(root,'outside.txt'),'private');
  await mkdir(join(out,'folder'));
  const server=await startPreviewServer(out);
  t.after(()=>server.close());
  assert.match(server.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await get(server.url,'/')).body,'<p>widget</p>');
  const data=await get(server.url,'/data.json');
  assert.equal(data.status,200); assert.equal(data.headers['cache-control'],'no-store');
  assert.match(data.headers['content-type'],/^application\/json/);
  await writeFile(join(out,'data.json'),'{"value":7}');
  assert.equal((await get(server.url,'/data.json')).body,'{"value":7}');
  assert.equal((await get(server.url,'/data.json','HEAD')).body,'');
  for (const path of ['/../outside.txt','/%2e%2e/outside.txt','/%2e%2e%2foutside.txt','/..%5coutside.txt','/%00']) {
    assert.equal((await get(server.url,path)).status,403,path);
  }
  assert.equal((await get(server.url,'/%zz')).status,400);
  assert.equal((await get(server.url,'/folder')).status,404);
  assert.equal((await get(server.url,'/absent')).status,404);
  assert.equal((await get(server.url,'/data.json','POST')).status,405);
  // Directory junctions do not require Windows file-symlink privileges.
  await symlink(root,join(out,'escape'),process.platform==='win32'?'junction':'dir');
  assert.equal((await get(server.url,'/escape/outside.txt')).status,403);
  const another=await startPreviewServer(out);
  t.after(()=>another.close());
  assert.notEqual(another.url,server.url);
  await server.close();
  await assert.rejects(get(server.url,'/'));
});
