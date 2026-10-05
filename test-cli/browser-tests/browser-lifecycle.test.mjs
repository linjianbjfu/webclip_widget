import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bounded, launchBrowser } from '../browser.mjs';

test('browser exit releases stderr even when a descendant still holds the pipe', {
  skip: process.platform === 'win32' ? 'The executable fixture uses a POSIX shebang' : false,
}, async t => {
  const root=await mkdtemp(join(tmpdir(),'webclip-inherited-stderr-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  let connection;
  const control=createServer(socket=>{connection=socket;});
  control.listen(0,'127.0.0.1');
  await once(control,'listening');
  t.after(async()=>{
    if(connection&&!connection.destroyed) {
      const closed=once(connection,'close');
      connection.write('stop');
      await closed;
    }
    await new Promise(resolve=>control.close(resolve));
  });
  const marker=join(root,'profile');
  const descendant=`const net=require('node:net'); const socket=net.connect(${control.address().port},'127.0.0.1',()=>console.log('ready')); socket.on('data',()=>process.exit(0));`;
  const executable=join(root,'fake-chrome');
  await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process');
fs.writeFileSync(${JSON.stringify(marker)},process.argv.find(arg=>arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length));
const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']});
child.stdout.once('data',()=>process.exit(1));\n`,{mode:0o755});
  const launching=launchBrowser({executable,headless:true});
  t.after(()=>launching.then(owned=>owned.close(),()=>{}));
  await assert.rejects(bounded(launching,{timeout:10_000,label:'Inherited stderr cleanup'}),/Chrome exited before startup/);
  assert.ok(connection&&!connection.destroyed,'the descendant retains stderr until the test releases it');
  await assert.rejects(stat(await readFile(marker,'utf8')),{code:'ENOENT'});
});
