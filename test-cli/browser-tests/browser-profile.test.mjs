import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBrowser } from '../browser.mjs';

test('persistent profile retains site state across restart and rejects overlapping Chrome', async t => {
  const root = await mkdtemp(join(tmpdir(), 'webclip-profile-test-'));
  const browsers = [];
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Profile fixture</p>'));
  t.after(async () => {
    for (const owned of browsers) await owned.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/`;
  const userDataDir = join(root, 'profile');
  const first = await launchBrowser({ headless: true, userDataDir });
  browsers.push(first);
  const page = await first.browser.newPage();
  await page.goto(url);
  await page.evaluate(() => {
    document.cookie = 'login=fixture; Max-Age=3600; SameSite=Lax; Path=/';
    localStorage.setItem('account', 'fixture');
  });
  assert.equal(await page.evaluate(() => document.cookie), 'login=fixture');

  // The first Chrome holds its native profile lock throughout the competing process startup.
  const competing = launchBrowser({ headless: true, userDataDir }).then(owned => { browsers.push(owned); return owned; });
  await assert.rejects(competing, error => {
    assert.match(error.message, /Chrome exited before startup/);
    assert.ok(error.message.includes(userDataDir));
    return true;
  });
  assert.equal(await page.evaluate(() => localStorage.getItem('account')), 'fixture');
  await first.close();
  assert.ok((await stat(userDataDir)).isDirectory());

  const second = await launchBrowser({ headless: true, userDataDir });
  browsers.push(second);
  const reopened = await second.browser.newPage();
  await reopened.goto(url);
  assert.deepEqual(await reopened.evaluate(() => ({ cookie: document.cookie, account: localStorage.getItem('account') })), {
    cookie: 'login=fixture', account: 'fixture',
  });
  await second.close();
  assert.ok((await stat(userDataDir)).isDirectory());
});
