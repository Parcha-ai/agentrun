// Static server for dist/ with the cross-origin isolation headers the show page uses (COOP/COEP/CORP), so the page is
// checked under the same constraints it is embedded under. `node scripts/serve.mjs [port]`
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json' };

/**
 * opts.modelDisk: a directory laid out like the run's disk (scripts/make-model-disk.mjs), served at /modeldisk/<path> while server.modelReady is true
 * (the manifest "appears" when a check sets it), with server.corruptChunk = n flipping a byte of that chunk; POST /api/judge answers through
 * server.judge(prompt, answer) (default show) and records each call in server.judgeCalls.
 */
export function serve(port = 0, opts = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (opts.modelDisk && url.pathname.startsWith('/modeldisk/')) {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      const rel = normalize(decodeURIComponent(url.pathname.slice('/modeldisk/'.length))).replace(/^(\.\.[/\\])+/, '');
      const f = join(opts.modelDisk, rel);
      if (!server.modelReady || !rel.startsWith('home/model/') || !existsSync(f)) { res.statusCode = 404; return res.end(); }
      const body = Buffer.from(await readFile(f));
      if (server.corruptChunk !== undefined && rel === `home/model/chunk-${String(server.corruptChunk).padStart(4, '0')}.bin`) body[10] ^= 1;
      return res.end(body);
    }
    if (req.method === 'POST' && url.pathname === '/api/judge') {
      let raw = '';
      for await (const c of req) raw += c;
      const { prompt, answer } = JSON.parse(raw);
      server.judgeCalls.push({ prompt, answer });
      const r = await server.judge(prompt, answer);
      res.statusCode = r.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(r.body ?? { verdict: 'show', dark: false, quote: '', ms: 1, model: 'check' }));
    }
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    // /__harness.html is the embedding test page (scripts/), not part of the shipped dist
    const file = path === '/__harness.html' ? join(root, '..', 'scripts', 'embed-harness.html') : join(root, path.endsWith('/') ? path + 'index.html' : path);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      const body = await readFile(file);
      res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  server.modelReady = false;
  server.judgeCalls = [];
  server.judge = async () => ({});
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await serve(Number(process.argv[2] ?? 8795));
  console.log(`http://127.0.0.1:${s.address().port}/`);
}
