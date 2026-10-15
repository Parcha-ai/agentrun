// sources.json: checked files fetched into work/ as <id><extension> and verified by size and hash; kept when already there; refused when they are not the checked bytes. And the entry fetches them on
// --fetch-sources (a demo's run), reading sources.json beside the demo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchSources, fileOf, readSources, withSources } from './reference/sources.ts';

const sha = (text) => createHash('sha256').update(text).digest('hex');

async function serve(t, files) {
  const served = [];
  const server = createServer((request, response) => {
    served.push(request.url);
    const body = files[request.url];
    response.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/octet-stream' });
    response.end(body ?? 'no');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, served };
}

test('an item is fetched into work/ as its id plus the URL\'s extension, verified by size and hash, and kept when it is already there', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { base, served } = await serve(t, { '/p/page-one.png': 'PNG bytes one', '/q/film.mp4': 'MP4 bytes' });
  const item = (id, path, text) => ({ id, url: `${base}${path}`, bytes: text.length, sha256: sha(text), license: 'public domain' });
  const sources = { items: [item('page-1', '/p/page-one.png', 'PNG bytes one'), item('film', '/q/film.mp4', 'MP4 bytes')] };
  assert.deepEqual(sources.items.map(fileOf), ['page-1.png', 'film.mp4']);
  const work = join(tmp, 'work');
  const first = await fetchSources(sources, work);
  assert.deepEqual([first.fetched, first.kept], [['page-1.png', 'film.mp4'], []]);
  assert.equal(readFileSync(join(work, 'page-1.png'), 'utf8'), 'PNG bytes one');
  const second = await fetchSources(sources, work);
  assert.deepEqual([second.fetched, second.kept], [[], ['page-1.png', 'film.mp4']]);
  assert.equal(served.length, 2, 'a kept file is not fetched again');
});

test('a fetch that is not the checked file is refused, naming the file, what was checked and what came, and nothing is written', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { base } = await serve(t, { '/a.txt': 'changed bytes' });
  const checked = 'original bytes';
  const sources = { items: [{ id: 'a', url: `${base}/a.txt`, bytes: checked.length, sha256: sha(checked) }] };
  await assert.rejects(() => fetchSources(sources, join(tmp, 'work')), (error) => /a\.txt: not the checked file/.test(error.message) && error.message.includes(sha(checked)) && error.message.includes(sha('changed bytes')));
  assert.equal(existsSync(join(tmp, 'work', 'a.txt')), false);
  await assert.rejects(() => fetchSources({ items: [{ id: 'gone', url: `${base}/missing.txt`, bytes: 1, sha256: sha('x') }] }, join(tmp, 'work')), /answered 404/);
  // A file already there with the wrong hash is replaced by the checked one.
  mkdirSync(join(tmp, 'work'), { recursive: true });
  writeFileSync(join(tmp, 'work', 'a.txt'), 'stale');
  const good = { items: [{ id: 'a', url: `${base}/a.txt`, bytes: 'changed bytes'.length, sha256: sha('changed bytes') }] };
  assert.deepEqual((await fetchSources(good, join(tmp, 'work'))).fetched, ['a.txt']);
  assert.equal(readFileSync(join(tmp, 'work', 'a.txt'), 'utf8'), 'changed bytes');
});

test('sources.json is checked when it is read', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const write = (value) => { const file = join(tmp, 's.json'); writeFileSync(file, JSON.stringify(value)); return file; };
  assert.throws(() => readSources(write({})), /lists neither files .* nor pages/);
  // Pages (visited live by the agent) are passed through untouched: never fetched, never refused, whatever they hold.
  assert.deepEqual(readSources(write({ pages: [{ id: 'caiso', dashboardUrl: 'https://e.x/dash', checked: { date: '2026-10-14' } }] })).items, []);
  assert.equal(readSources(write({ files: [{ id: 'a', url: 'https://e.x/a.png', bytes: 1, sha256: sha('x') }], pages: [{ id: 'p' }] })).items.length, 1, 'files and pages in one file');
  assert.throws(() => readSources(write({ items: [{ id: '../x', url: 'https://e.x/a.png', bytes: 1, sha256: sha('x') }] })), /id is a file name/);
  assert.throws(() => readSources(write({ items: [{ id: 'a', url: 'ftp://e.x/a.png', bytes: 1, sha256: sha('x') }] })), /no http or https url/);
  assert.throws(() => readSources(write({ items: [{ id: 'a', url: 'https://e.x/a.png', bytes: 1, sha256: 'abc' }] })), /size in bytes and its SHA-256/);
  assert.equal(readSources(write({ items: [{ id: 'a', url: 'https://e.x/a.png', bytes: 1, sha256: sha('x') }] })).items.length, 1);
});

test('two items that would be the same file are refused before anything is fetched', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 's.json');
  writeFileSync(file, JSON.stringify({ items: [
    { id: 'page', url: 'https://e.x/one/scan.png', bytes: 1, sha256: sha('a') },
    { id: 'page', url: 'https://e.x/two/other.png', bytes: 1, sha256: sha('b') },
  ] }));
  assert.throws(() => readSources(file), /page and page are both page\.png/);
});

test('a download has a deadline that covers its body: a server that never finishes its response is cut off, naming the file', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const sockets = new Set();
  const server = createServer((request, response) => { response.writeHead(200, { 'content-length': '1000' }); response.write('x'); /* the rest never comes */ });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const sources = { items: [{ id: 'slow', url: `http://127.0.0.1:${server.address().port}/slow.bin`, bytes: 1000, sha256: sha('x') }] };
  const started = Date.now();
  await assert.rejects(() => fetchSources(sources, join(tmp, 'work'), fetch, 300), /slow\.bin: .* did not finish within 300 ms/);
  assert.ok(Date.now() - started < 5000);
});

test('the files a box is given hold the job\'s own and each fetched source (a Docker box shares nothing with work/)', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, 'work'), { recursive: true });
  writeFileSync(join(tmp, 'work', 'scan-1.png'), 'verified bytes');
  const files = withSources({ 'committed.txt': new TextEncoder().encode('committed') }, join(tmp, 'work'), ['scan-1.png']);
  assert.deepEqual(Object.keys(files).sort(), ['committed.txt', 'scan-1.png']);
  assert.equal(new TextDecoder().decode(files['scan-1.png']), 'verified bytes');
  assert.deepEqual(Object.keys(withSources(undefined, join(tmp, 'work'), [])), []);
});

test('the download cache: a fetched file is kept by its hash, a re-run is served from it, and a damaged copy is fetched again', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { base, served } = await serve(t, { '/big.bin': 'the big file' });
  const sources = { items: [{ id: 'big', url: `${base}/big.bin`, bytes: 'the big file'.length, sha256: sha('the big file') }] };
  const cache = join(tmp, 'cache');
  const first = await fetchSources(sources, join(tmp, 'run-1'), fetch, 60_000, cache);
  assert.deepEqual([first.fetched, first.cached], [['big.bin'], []]);
  assert.equal(readFileSync(join(cache, sha('the big file')), 'utf8'), 'the big file');
  const second = await fetchSources(sources, join(tmp, 'run-2'), fetch, 60_000, cache);
  assert.deepEqual([second.fetched, second.cached], [[], ['big.bin']]);
  assert.equal(readFileSync(join(tmp, 'run-2', 'big.bin'), 'utf8'), 'the big file');
  assert.equal(served.length, 1, 'the second run did not fetch it');
  writeFileSync(join(cache, sha('the big file')), 'damaged');
  const third = await fetchSources(sources, join(tmp, 'run-3'), fetch, 60_000, cache);
  assert.deepEqual([third.fetched, third.cached], [['big.bin'], []], 'a copy that no longer has the checked bytes is fetched again');
  assert.equal(served.length, 2);
});
