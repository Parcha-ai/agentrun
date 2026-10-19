// Draft 50, the blobs: a recording publishes only inert files. A blob's extension is on an allowlist (html and css only as the artifact's own files, svg never),
// every blob that is not media is scanned as text, and the scan knows the launch providers' key shapes and more of the machine's paths.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { credentialIn } from '../../packages/harness/src/scan.ts';
import { moveImages } from '../../packages/harness/src/record.ts';
import { gateProblems } from './gate.mjs';
import { validateRecording } from './validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = (t, prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const SCRIPT = '<html><body><script>alert(1)</script></body></html>';

/** The midstream-kill fixture with `blobs` (name -> bytes) added to blobs/ and `manifestOver` merged into its manifest. */
const recording = (t, blobs, manifestOver = {}) => {
  const dir = scratch(t, 'inert-test-');
  cpSync(join(here, 'fixtures', 'midstream-kill'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ...manifestOver }));
  for (const [name, bytes] of Object.entries(blobs)) writeFileSync(join(dir, 'blobs', name), bytes);
  return dir;
};
const named = (text, extension) => `${sha(text)}.${extension}`;
const problems = (dir) => validateRecording(dir).map((each) => `${each.where}: ${each.message}`);
/** The gate over a one-recording gallery built from `dir` (the index form). */
const gated = (t, dir) => {
  const dist = scratch(t, 'inert-gate-');
  cpSync(dir, join(dist, 'recordings', 'one'), { recursive: true });
  writeFileSync(join(dist, 'gallery.js'), "window.AGENTRUN_GALLERY_INDEX = 'recordings/index.json';\n");
  const held = Object.fromEntries(readdirSyncOf(join(dir, 'blobs')).map((name) => [name.split('.')[0], `blobs/${name}`]));
  writeFileSync(join(dist, 'recordings', 'index.json'), JSON.stringify([{ id: 'one', manifest: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')), blobs: held }]));
  return gateProblems(dist).map((each) => `${each.path}: ${each.message}`);
};
import { readdirSync as readdirSyncOf } from 'node:fs';

test('a blob that is html, svg, xml, js or of an unknown extension is refused by the validator and the gate, with its script in it', (t) => {
  for (const [extension, text] of [['html', SCRIPT], ['htm', SCRIPT], ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], ['xml', '<x/>'], ['xhtml', SCRIPT], ['js', 'alert(1)'], ['css', 'p{}'], ['bin', 'x']]) {
    const name = named(text, extension);
    const dir = recording(t, { [name]: text });
    assert.ok(problems(dir).some((each) => each.includes(name) && /may not have/.test(each)), `the validator refuses .${extension}: ${problems(dir).join(' | ')}`);
    assert.ok(gated(t, dir).some((each) => each.includes(name) && /may not have/.test(each)), `the gate refuses .${extension}`);
  }
});

test('the allowlisted blobs pass: png jpg jpeg webp gif webm mp4 pdf json jsonl txt md csv vtt', (t) => {
  const blobs = {};
  for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'webm', 'mp4', 'pdf', 'json', 'jsonl', 'txt', 'md', 'csv', 'vtt']) blobs[named(`one ${extension}`, extension)] = `one ${extension}`;
  const dir = recording(t, blobs);
  assert.deepEqual(problems(dir), []);
  assert.deepEqual(gated(t, dir), []);
});

test('html and css are allowed only as the artifact\'s own pages and stylesheets', (t) => {
  const page = '<!doctype html><html><head><title>A report</title><link rel="stylesheet" href="site.css"></head><body><p>hi</p></body></html>';
  const css = 'p { color: red }';
  const artifact = { title: 'A report', entry: 'index.html', files: { 'index.html': sha(page), 'site.css': sha(css) } };
  const dir = recording(t, { [named(page, 'html')]: page, [named(css, 'css')]: css }, { artifact });
  assert.deepEqual(problems(dir), []);
  assert.deepEqual(gated(t, dir), []);
  // The same blobs with no artifact naming them are refused.
  const loose = recording(t, { [named(page, 'html')]: page, [named(css, 'css')]: css });
  assert.equal(problems(loose).filter((each) => /may not have/.test(each)).length, 2);
  // An artifact file that is an svg is refused whatever its content.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const withSvg = recording(t, { [named(page, 'html')]: page, [named(svg, 'svg')]: svg }, { artifact: { title: 'A report', entry: 'index.html', files: { 'index.html': sha(page), 'logo.svg': sha(svg) } } });
  assert.ok(problems(withSvg).some((each) => /logo.svg has the extension .svg/.test(each)), problems(withSvg).join(' | '));
});

test('every blob that is not media is scanned as text: a key in a .vtt, .csv or .md, found by the validator and the gate, named or not by a line', (t) => {
  const key = `AIza${'Ab1_-'.repeat(7)}`;
  for (const extension of ['vtt', 'csv', 'md', 'txt']) {
    const text = `WEBVTT\n\nkey ${key}\n`;
    const dir = recording(t, { [named(text, extension)]: text });
    assert.ok(problems(dir).some((each) => /contains a google api key/.test(each)), `${extension}: ${problems(dir).join(' | ')}`);
    assert.ok(gated(t, dir).some((each) => /contains a google api key/.test(each)));
  }
});

test('the launch providers\' key shapes are found, and prose with their prefixes is not', () => {
  const hex = (n) => 'a1b2c3d4e5f60718'.repeat(Math.ceil(n / 16)).slice(0, n);
  const alnum = (n) => 'Zx9Qr7'.repeat(Math.ceil(n / 6)).slice(0, n);
  const found = {
    'google api key': `AIza${alnum(35)}`,
    'fal key': `0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0:${hex(32)}`,
    'elevenlabs key': `sk_${hex(48)}`,
    'xai key': `xai-${alnum(80)}`,
    'groq key': `gsk_${alnum(52)}`,
    'hugging face token': `hf_${alnum(37)}`,
    'slack token': `xox${'b'}-${'1234567890-'.repeat(2)}${alnum(24)}`,
    'stripe live key': `${'sk'}_live_${alnum(28)}`,
  };
  assert.equal(credentialIn('Authorization: Key ' + alnum(24)), 'fal key', 'the header form');
  for (const [name, text] of Object.entries(found)) assert.equal(credentialIn(`the value is ${text} here`), name, name);
  for (const prose of ['the xai-grok model', 'hf_hub is a library', 'sk_live is a prefix', 'gsk_ and AIza are prefixes', 'an Authorization: Key header', 'xoxo-hugs', 'a uuid 0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0 alone', 'sk_short']) assert.equal(credentialIn(prose), undefined, prose);
});

test('the machine-path scan takes /home/<user> with no slash, a Windows profile, /root/ and macOS temp, but not a URL path or a workflow path', () => {
  const dir = (...parts) => ['', ...parts].join('/');
  for (const text of [`at ${dir('home', 'someone')}`, `cwd=${dir('Users', 'someone')}`, `C:${'\\'}Users${'\\'}someone`, `${dir('root')}/.ssh/id`, dir('var', 'folders', 'zz', 'T')]) assert.equal(credentialIn(text), 'machine path', text);
  for (const text of ['https://example.org/home/page', 'see /root/steps/0 and /root/items', 'the /rooted idea', 'a home/other relative', `${dir('home', 'web_user')}`]) assert.equal(credentialIn(text), undefined, text);
});

test('the recorder records an svg tool output as text, never as .svg, and any other extension it is handed as txt', async (t) => {
  const kept = [];
  const { data } = moveImages({ content: [{ type: 'image', mimeType: 'image/svg+xml', data: Buffer.from('<svg><script>x</script></svg>').toString('base64') }] }, (bytes, extension) => { kept.push(extension); return sha(bytes); });
  assert.deepEqual(kept, ['txt']);
  const { openRecorder } = await import('../../packages/harness/src/record.ts');
  const dir = scratch(t, 'inert-rec-');
  const recorder = openRecorder({ dir });
  const hash = recorder.blob('<html><script>x</script></html>', 'html');
  assert.ok(readdirSyncOf(join(dir, 'blobs')).includes(`${hash}.txt`), 'markup is recorded as txt');
  assert.ok(!readdirSyncOf(join(dir, 'blobs')).some((name) => /\.(?:html|svg)$/.test(name)));
  void data;
});

test('live-follow scans every text blob a line names, whatever its extension', async (t) => {
  const { startedAt, followRecording } = await import('../../packages/harness/src/record.ts');
  const dir = scratch(t, 'inert-follow-');
  mkdirSync(join(dir, '.spool'), { recursive: true });
  mkdirSync(join(dir, 'blobs'));
  startedAt(dir);
  const text = `WEBVTT\n\nkey sk-${'b2'.repeat(20)}\n`;
  const hash = sha(text);
  writeFileSync(join(dir, 'blobs', `${hash}.vtt`), text);
  const follower = followRecording(dir, { holdMs: 0 });
  t.after(() => { try { follower.close(); } catch { /* the follow failed */ } });
  writeFileSync(join(dir, '.spool', 'live-1.jsonl'), `${JSON.stringify({ channel: 'live', source: 'workflow', kind: 'x', gen: 1, seq: 0, t: 1, blobs: [hash], data: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => follower.poll(), /a blob the run kept holds a provider secret/);
});
