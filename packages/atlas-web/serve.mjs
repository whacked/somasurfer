/**
 * Serves dist/ for local inspection. Not part of the product: the product is a
 * static directory, and this is the smallest thing that proves it.
 *
 *   node serve.mjs [--port 8080] [--dir dist]
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const ROOT = join(HERE, arg('dir', 'dist'));
const PORT = Number(arg('port', '8080'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '': 'text/plain; charset=utf-8',
};

if (!existsSync(ROOT)) {
  console.error(`${ROOT} does not exist. Run \`node build.mjs\` first.`);
  process.exit(1);
}

createServer((req, res) => {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // normalize + the prefix test keeps `..` from escaping dist/.
  const resolved = normalize(join(ROOT, requested === '/' ? 'index.html' : requested));
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const path = existsSync(resolved) && statSync(resolved).isDirectory() ? join(resolved, 'index.html') : resolved;
  if (!existsSync(path)) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    // No caching, so a rebuild is visible on reload.
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}/`));
