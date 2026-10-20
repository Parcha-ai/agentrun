// The gallery's recordings from a release asset (gallery.mjs): the lock is read strictly, a tar the pack writes unpacks
// to the same bytes, and every way a tar could put an unchecked byte into the gallery is refused with nothing written.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GALLERY_LIMIT, RECORDING_LIMIT, exampleFolders, galleryOf, packGallery, readLock, readTar, unpackGallery, writeTar } from './gallery.mjs';

const script = fileURLToPath(new URL('./gallery.mjs', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JSON_BLOB = Buffer.from('{"answer":"a page"}\n');

/** A directory with two recording-shaped folders, `a` (a picture and a JSON blob, its manifest naming its example) and
 *  `b` (no blobs, its task naming it), or the same under `ids`. */
const recordings = (t, [a, b] = ['a', 'b']) => {
  const dir = mkdtempSync(join(tmpdir(), 'gallery-src-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [id, manifest] of [[a, { title: a, task: 'vision-agent', example: a }], [b, { title: b, task: b }]]) {
    mkdirSync(join(dir, id));
    writeFileSync(join(dir, id, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
    writeFileSync(join(dir, id, 'events.jsonl'), `{"t":1,"id":"${id}"}\n`);
  }
  mkdirSync(join(dir, a, 'blobs'));
  writeFileSync(join(dir, a, 'blobs', `${sha256(PNG)}.png`), PNG);
  writeFileSync(join(dir, a, 'blobs', `${sha256(JSON_BLOB)}.json`), JSON_BLOB);
  return dir;
};
const lockOf = (ids, bytes = Buffer.alloc(0)) => ({ asset: 'recordings.tar', sha256: sha256(bytes), ids: ids.map((each) => (typeof each === 'string' ? { id: each } : each)) });
/** `files` as a tar and the lock that pins it. */
const pinned = (files, ids) => { const tar = writeTar(files); return { tar, lock: lockOf(ids, tar) }; };
const files = (dir, ids = ['a', 'b']) => { const tar = packGallery(dir, lockOf(ids)); return readTar(tar).filter((entry) => entry.type === '0').map(({ path, data }) => ({ path, data })); };
/** A tar header for `path`, typed `type`, holding `data`: for the entries writeTar never writes. */
const header = (path, type, data = Buffer.alloc(0)) => {
  const block = Buffer.alloc(512);
  block.write(path, 0);
  block.write('0000644\0', 100);
  block.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  block.write('        ', 148);
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  block.write(`${block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([block, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
};
/** A tar of `parts` (headers and their data, as `header` makes them) then the end blocks. */
const raw = (...parts) => Buffer.concat([...parts, Buffer.alloc(1024)]);
const empty = (t) => { const dir = mkdtempSync(join(tmpdir(), 'gallery-out-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'recordings'); };

test('the limits are 80 MB a recording and 300 MB the gallery, raw', () => {
  assert.equal(RECORDING_LIMIT, 80_000_000);
  assert.equal(GALLERY_LIMIT, 300_000_000);
});

test('the lock reads plain ids and { id, poster?, looks? }, and refuses every other shape', () => {
  const poster = sha256(PNG);
  assert.deepEqual(readLock(JSON.stringify({ asset: 'recordings.tar', sha256: poster, ids: ['a', { id: 'b', poster }] })),
    { lock: { asset: 'recordings.tar', sha256: poster, ids: [{ id: 'a' }, { id: 'b', poster }] } });
  const problems = (lock) => readLock(JSON.stringify(lock)).problems ?? [];
  const good = { asset: 'recordings.tar', sha256: poster, ids: ['a'] };
  assert.match(readLock('{').problems[0], /^the lock is not JSON/);
  assert.match(problems({ ...good, asset: '../recordings.tar' })[0], /is not a \.tar file name/);
  assert.match(problems({ ...good, asset: 'recordings*.tar' })[0], /is not a \.tar file name/, 'no glob reaches the download');
  assert.match(problems({ ...good, sha256: 'abc' })[0], /is not a SHA-256/);
  assert.match(problems({ ...good, ids: [] })[0], /ids is not a non-empty list/);
  assert.match(problems({ ...good, ids: ['a', 'a'] })[0], /a is listed twice/);
  assert.match(problems({ ...good, ids: ['../a'] })[0], /is not \{ id, poster\?, looks\? \} with a plain id/);
  assert.match(problems({ ...good, ids: [{ id: 'a', rank: 1 }] })[0], /holds \["id","rank"\], not id, poster and looks/);
  assert.deepEqual(readLock(JSON.stringify({ ...good, ids: [{ id: 'a', poster, looks: ['k1', 'k2'] }] })).lock?.ids, [{ id: 'a', poster, looks: ['k1', 'k2'] }], 'looks beside a poster');
  for (const looks of [[], 'k1', [''], [7], ['k1', 'k1']]) assert.match(problems({ ...good, ids: [{ id: 'a', looks }] })[0], /looks .* is not a list of distinct look keys/, JSON.stringify(looks));
  assert.match(problems({ ...good, ids: [{ id: 'a', poster: 'cover.png' }] })[0], /poster "cover\.png" is not a SHA-256/);
});

test('a pack unpacks to the same bytes, and the same recordings pack to the same tar', (t) => {
  const dir = recordings(t);
  const lock = lockOf(['a', 'b']);
  const tar = packGallery(dir, lock);
  assert.ok(tar.equals(packGallery(dir, lock)), 'sorted, owner and time zeroed');
  const out = empty(t);
  assert.deepEqual(unpackGallery(tar, { ...lock, sha256: sha256(tar) }, out), []);
  const held = (root) => readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort();
  assert.deepEqual(held(out), held(dir));
  for (const at of held(dir)) assert.ok(readFileSync(join(out, at)).equals(readFileSync(join(dir, at))), at);
});

test('a tar that does not hash to the lock is refused before it is read', (t) => {
  const dir = recordings(t);
  const tar = packGallery(dir, lockOf(['a', 'b']));
  const { problems } = galleryOf(tar, lockOf(['a', 'b'], Buffer.from('another tar')));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^the asset hashes to [0-9a-f]{64}, not the lock's [0-9a-f]{64}$/);
});

test('only a listed recording\'s manifest, lines and blobs, as plain files, once each, are unpacked; anything else refuses the whole tar', (t) => {
  const dir = recordings(t);
  const good = files(dir);
  const refused = (tar, lock, expected) => {
    const out = empty(t);
    const problems = unpackGallery(tar, lock, out);
    assert.ok(problems.some((problem) => expected.test(problem)), `${expected}\n${problems.join('\n')}`);
    assert.ok(!existsSync(out), 'nothing is written');
  };
  const with_ = (...extra) => pinned([...good, ...extra], ['a', 'b']);
  let tar;
  ({ tar } = with_({ path: 'c/manifest.json', data: Buffer.from('{}') }));
  refused(tar, { ...lockOf(['a', 'b'], tar) }, /^c\/manifest\.json: is not a manifest, lines or blob of a recording the lock lists$/);
  ({ tar } = with_({ path: 'a/notes.txt', data: Buffer.from('a note') }));
  refused(tar, lockOf(['a', 'b'], tar), /^a\/notes\.txt: is not a manifest, lines or blob/);
  ({ tar } = with_({ path: 'a/blobs/cover.png', data: PNG }));
  refused(tar, lockOf(['a', 'b'], tar), /^a\/blobs\/cover\.png: is not a manifest, lines or blob/);
  // A path that climbs out, or starts at the root, never matches a member's shape.
  tar = raw(...good.map(({ path, data }) => header(path, '0', data)), header('a/../../etc/cron.d', '0', Buffer.from('x')));
  refused(tar, lockOf(['a', 'b'], tar), /^a\/\.\.\/\.\.\/etc\/cron\.d: is not a manifest, lines or blob/);
  tar = raw(...good.map(({ path, data }) => header(path, '0', data)), header('/a/events.jsonl', '0', Buffer.from('x')));
  refused(tar, lockOf(['a', 'b'], tar), /^\/a\/events\.jsonl: is not a manifest, lines or blob/);
  // A link, of either kind, a device or a FIFO: never a plain file.
  for (const type of ['1', '2', '3', '4', '6']) {
    tar = raw(...good.map(({ path, data }) => header(path, '0', data)), header(`a/blobs/${sha256(PNG)}.webp`, type));
    refused(tar, lockOf(['a', 'b'], tar), new RegExp(`is not a regular file \\(type "${type}"\\)`));
  }
  // The same member twice: the second would overwrite what was checked.
  tar = raw(...good.map(({ path, data }) => header(path, '0', data)), header('a/events.jsonl', '0', Buffer.from('{"other":1}\n')));
  refused(tar, lockOf(['a', 'b'], tar), /^a\/events\.jsonl: is in the asset twice$/);
  // A directory outside a listed recording.
  tar = raw(...good.map(({ path, data }) => header(path, '0', data)), header('c/', '5'));
  refused(tar, lockOf(['a', 'b'], tar), /^c\/: is a directory outside a listed recording$/);
  // A listed recording the tar does not hold whole.
  ({ tar } = pinned(good.filter(({ path }) => path !== 'b/events.jsonl'), ['a', 'b']));
  refused(tar, lockOf(['a', 'b'], tar), /^b: the asset holds no events\.jsonl for it$/);
  ({ tar } = pinned(good, ['a', 'b']));
  refused(tar, lockOf(['a', 'b', 'c'], tar), /^c: the asset holds no manifest\.json for it$/);
});

test('long paths read as GNU tar and pax write them', () => {
  const long = `${'r'.repeat(40)}/blobs/${sha256(PNG)}.png`;
  assert.ok(long.length > 100);
  const gnu = readTar(raw(header('././@LongLink', 'L', Buffer.from(`${long}\0`)), header(long.slice(0, 100), '0', PNG)));
  assert.deepEqual(gnu.map(({ path, type }) => [path, type]), [[long, '0']]);
  const record = `path=${long}\n`;
  const sized = `${record.length + String(record.length).length + 1} ${record}`;
  const pax = readTar(raw(header('PaxHeader', 'x', Buffer.from(sized)), header('short', '0', PNG)));
  assert.deepEqual(pax.map(({ path }) => path), [long]);
  // writeTar splits a long path into ustar's prefix and name, which any tar reads.
  const ustar = readTar(writeTar([{ path: long, data: PNG }]));
  assert.deepEqual(ustar.filter(({ type }) => type === '0').map(({ path }) => path), [long]);
});

test('a header whose checksum fails, or a tar cut short, is refused', () => {
  const tar = writeTar([{ path: 'a/manifest.json', data: Buffer.from('{}') }]);
  const bent = Buffer.from(tar);
  bent[512 * 1 + 0] ^= 1;
  assert.throws(() => readTar(bent), /fails its checksum/);
  assert.throws(() => readTar(tar.subarray(0, 512 * 2)), /ends without its end-of-archive blocks|runs past the end/);
  const lock = lockOf(['a'], bent);
  assert.match(galleryOf(bent, lock).problems[0], /^the asset is not a tar: /);
});

test('an id is the name of its example folder, as the run\'s own manifest says: one recording per example', (t) => {
  const dir = recordings(t);
  const tar = packGallery(dir, lockOf(['a', 'b']));
  const lock = lockOf(['a', 'b'], tar);
  assert.equal(galleryOf(tar, lock, { examples: new Set(['a', 'b', 'c']) }).problems, undefined, 'a by its example, b by its task');
  assert.deepEqual(galleryOf(tar, lock, { examples: new Set(['a']) }).problems, ['b: names no example folder (examples/b)']);
  // A run filed under another example's id: its manifest says whose it is.
  const swapped = pinned(files(dir).map(({ path, data }) => ({ path, data: path === 'b/manifest.json' ? Buffer.from('{"task":"vision-agent","example":"a"}') : data })), ['a', 'b']);
  assert.deepEqual(galleryOf(swapped.tar, lockOf(['a', 'b'], swapped.tar)).problems, ['b: its manifest names the example "a", not b']);
  const unread = pinned(files(dir).map(({ path, data }) => ({ path, data: path === 'b/manifest.json' ? Buffer.from('{') : data })), ['a', 'b']);
  assert.deepEqual(galleryOf(unread.tar, lockOf(['a', 'b'], unread.tar)).problems, ['b: its manifest names the example null, not b']);
  // A second take of one example cannot be listed: the lock refuses an id twice.
  assert.match(readLock(JSON.stringify({ ...lock, ids: ['a', 'b', 'a'] })).problems[0], /^a is listed twice$/);
});

test('a recording over its limit, or a gallery over its own, is refused', (t) => {
  const dir = recordings(t);
  const tar = packGallery(dir, lockOf(['a', 'b']));
  const lock = lockOf(['a', 'b'], tar);
  const sizeOf = (id) => readTar(tar).filter(({ path, type }) => type === '0' && path.startsWith(`${id}/`)).reduce((sum, { data }) => sum + data.length, 0);
  const [a, b] = [sizeOf('a'), sizeOf('b')];
  assert.equal(galleryOf(tar, lock, { recording: a, gallery: a + b }).files?.length, 6, 'at the limits exactly: it passes');
  assert.deepEqual(galleryOf(tar, lock, { recording: a - 1 }).problems, [`a: is ${a} bytes, over the ${a - 1} a recording may be`]);
  assert.deepEqual(galleryOf(tar, lock, { gallery: a + b - 1 }).problems, [`the gallery is ${a + b} bytes, over the ${a + b - 1} it may be`]);
});

test('a poster is an image, by its bytes, that its own recording holds', (t) => {
  const dir = recordings(t);
  const tar = packGallery(dir, lockOf(['a', 'b']));
  const pin = (ids) => lockOf(ids, tar);
  assert.equal(galleryOf(tar, pin([{ id: 'a', poster: sha256(PNG) }, 'b'])).problems, undefined, 'a PNG it holds');
  const refused = (ids, expected) => assert.deepEqual(galleryOf(tar, pin(ids)).problems, [expected]);
  refused([{ id: 'a', poster: sha256(JSON_BLOB) }, 'b'], `a: its poster ${sha256(JSON_BLOB)} is not an image blob it holds`);
  refused(['a', { id: 'b', poster: sha256(PNG) }], `b: its poster ${sha256(PNG)} is not an image blob it holds`);
  // Named as a picture, not one by its bytes.
  const fake = Buffer.from('not a picture at all');
  const faked = pinned([...files(dir), { path: `b/blobs/${sha256(fake)}.png`, data: fake }], ['a', 'b']);
  assert.deepEqual(galleryOf(faked.tar, lockOf(['a', { id: 'b', poster: sha256(fake) }], faked.tar)).problems, [`b: its poster ${sha256(fake)} is not an image blob it holds`]);
});

test('the gallery unpacks only into a directory with no recording in it', (t) => {
  const dir = recordings(t);
  const tar = packGallery(dir, lockOf(['a', 'b']));
  const out = empty(t);
  mkdirSync(join(out, 'reference-job'), { recursive: true });
  writeFileSync(join(out, 'README.md'), 'the recordings come from the lock\n');
  assert.deepEqual(unpackGallery(tar, lockOf(['a', 'b'], tar), out), [`${out} already holds ["reference-job"]: the gallery unpacks into a directory with no recording`]);
  assert.deepEqual(readdirSync(out).sort(), ['README.md', 'reference-job'], 'nothing written');
  rmSync(join(out, 'reference-job'), { recursive: true });
  assert.deepEqual(unpackGallery(tar, lockOf(['a', 'b'], tar), out), [], 'a README beside it is fine');
});

/** The command as the Pages step runs it, on a tar already here; its exit code and output. */
const run = (args) => new Promise((resolve) => execFile(process.execPath, [script, ...args], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })));

test('the command: fetch --from unpacks a pinned tar and says so; a problem is printed and exits 1 with nothing written; pack writes the tar and the lock', async (t) => {
  const [a, b] = ['document-check', 'hear-and-find'];
  assert.ok(exampleFolders().has(a) && exampleFolders().has(b), 'both are example folders');
  const dir = recordings(t, [a, b]);
  const work = mkdtempSync(join(tmpdir(), 'gallery-cli-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const lockPath = join(work, 'recordings.lock.json');
  writeFileSync(lockPath, JSON.stringify({ asset: 'recordings.tar', sha256: '0'.repeat(64), ids: [a, { id: b }] }));
  const packed = await run(['pack', dir, lockPath, join(work, 'recordings.tar')]);
  assert.equal(packed.code, 0, packed.stderr);
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.sha256, sha256(readFileSync(join(work, 'recordings.tar'))));
  assert.deepEqual(lock.ids, [{ id: a }, { id: b }]);
  const fetched = await run(['fetch', lockPath, join(work, 'out'), '--from', join(work, 'recordings.tar')]);
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.match(fetched.stdout, /: 2 recording\(s\) from recordings\.tar \([0-9a-f]{12}\)\n$/);
  writeFileSync(lockPath, JSON.stringify({ ...lock, ids: [{ id: a, poster: sha256(JSON_BLOB) }, b] }));
  const refused = await run(['fetch', lockPath, join(work, 'refused'), '--from', join(work, 'recordings.tar')]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /^document-check: its poster [0-9a-f]{64} is not an image blob it holds\n$/);
  // An id that is no example folder is refused by the command too.
  const other = recordings(t, ['a', b]);
  writeFileSync(lockPath, JSON.stringify({ asset: 'recordings.tar', sha256: '0'.repeat(64), ids: ['a', b] }));
  const unnamed = await run(['pack', other, lockPath, join(work, 'other.tar')]);
  assert.equal(unnamed.code, 1);
  assert.match(unnamed.stderr, /^a: names no example folder \(examples\/a\)\n$/);
  assert.ok(!existsSync(join(work, 'other.tar')), 'nothing written');
  assert.ok(!existsSync(join(work, 'refused')));
  const usage = await run(['fetch']);
  assert.equal(usage.code, 2);
});
