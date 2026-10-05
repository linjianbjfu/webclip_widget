/** Loopback static server rooted at an existing widget directory. */
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.gif': 'image/gif', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
function inside(root, path) {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(suffix);
}

export async function startPreviewServer(directory) {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error(`Not a widget directory: ${directory}`);
  const pending = new Set();
  const serve = async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent((req.url ?? '').split('?')[0]); }
    catch { res.writeHead(400).end(); return; }
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) {
      res.writeHead(403).end(); return;
    }
    const candidate = resolve(root, pathname === '/' ? 'widget.html' : pathname.slice(1));
    if (!inside(root, candidate)) { res.writeHead(403).end(); return; }
    try {
      const target = await realpath(candidate);
      if (!inside(root, target)) { res.writeHead(403).end(); return; }
      if (!(await stat(target)).isFile()) { res.writeHead(404).end(); return; }
      const bytes = await readFile(target);
      res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream', 'content-length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500).end();
    }
  };
  const server = createServer((req, res) => {
    const task = serve(req, res).catch(() => res.destroy());
    pending.add(task);
    void task.finally(() => pending.delete(task));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closing;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => closing ??= (async () => {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
      await Promise.allSettled([...pending]);
    })(),
  };
}
