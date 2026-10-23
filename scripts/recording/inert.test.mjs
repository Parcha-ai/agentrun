// Draft 50, the blobs: a recording publishes only inert files. A blob's extension is on an allowlist (html, htm and css only as the artifact's own files, svg never),
// every blob that is not media is scanned as text, and the scan knows the launch providers' key shapes and more of the machine's paths.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BLOB_EXTENSIONS, PAGE_EXTENSIONS, SHEET_EXTENSIONS, credentialIn } from '../../packages/harness/src/scan.ts';
import { SHOWN_AS_DATA } from '../../apps/viewer/src/blobs.ts';
import { moveImages } from '../../packages/harness/src/record.ts';
import { readdirSync as readdirSyncOf } from 'node:fs';
import { build } from '../../apps/viewer/build.mjs';
import { gateProblems } from './gate.mjs';
import { blobNameProblem, validateRecording } from './validate.mjs';

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
/** The gate over a one-recording gallery from `dir`, published as the Pages job builds it (`build.mjs --files`). */
const gated = (t, dir) => {
  const recordings = scratch(t, 'inert-recordings-');
  cpSync(dir, join(recordings, 'one'), { recursive: true });
  const dist = join(scratch(t, 'inert-gate-'), 'dist');
  build(dist, recordings, { files: true });
  return gateProblems(dist).map((each) => `${each.path}: ${each.message}`);
};

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

test('a refused extension is told the allowlist the validator checks: every blob extension, then every page and sheet extension as the artifact\'s own', () => {
  const said = blobNameProblem(`${'a'.repeat(64)}.svg`, new Set()) ?? '';
  const [blobs, artifactOnly] = /\(([^;]*); (.*) only as the artifact's own files\)$/.exec(said)?.slice(1).map((list) => list.split(' ')) ?? [];
  assert.deepEqual(blobs, [...BLOB_EXTENSIONS], said);
  assert.deepEqual(artifactOnly, [...PAGE_EXTENSIONS, ...SHEET_EXTENSIONS], said);
});

test('the viewer publishes as data exactly the recording\'s blob allowlist and the style sheets, never a page (apps/viewer/src/blobs.ts cannot import scan.ts, so this pins the two)', () => {
  assert.deepEqual([...SHOWN_AS_DATA].sort(), [...BLOB_EXTENSIONS, ...SHEET_EXTENSIONS].sort());
  for (const page of PAGE_EXTENSIONS) assert.equal(SHOWN_AS_DATA.has(page), false, `.${page} is published as .txt`);
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
  // A child workflow at the root and a loop at the root: the pointers a run records, as text and inside a JSON line.
  for (const text of ['/root/workflow/root/steps/0', '/root/iterations/3/body', '/root/iterations/0', JSON.stringify({ executionPath: '/root/iterations/0/body/workflow/root', path: '/root/body' })]) assert.equal(credentialIn(text), undefined, text);
  // A workflow name is taken whole, a child as workflow/root and a loop's pass as iterations/<n>: any other folder in root's home is root's home.
  for (const text of [dir('root', 'myproject', 'x'), dir('root', '.ssh', 'id_rsa'), dir('root', 'workflow-notes'), dir('root', 'steps.bak'), dir('root', 'iterations_old', 'x'), dir('root', 'workflow', 'notes.txt'), dir('root', 'workflow', 'rootkit'), dir('root', 'iterations', 'x'), dir('root', 'iterations', '3x')]) assert.equal(credentialIn(text), 'machine path', text);
  // A root child workflow's own fields, as the DSL's validation names them (one schema id is one segment, ~0 and ~1 escaped).
  for (const path of ['/root/workflow', '/root/workflow/name', '/root/workflow/schemas', '/root/workflow/schemas/Answer', '/root/workflow/schemas/a~1b~0c', '/root/workflow/input', '/root/workflow/input/schemaId', '/root/workflow/output', '/root/workflow/output/schemaId', '/root/workflow/output/path']) {
    for (const text of [path, `at ${path}: must be an object`, JSON.stringify({ path })]) assert.equal(credentialIn(text), undefined, text);
  }
  for (const text of [dir('root', 'workflowx'), dir('root', 'workflow', 'schemasx'), dir('root', 'workflow', 'schemas', 'ab', 'secret'), dir('root', 'workflow', 'schemas', 'x', 'y'), `${dir('root', 'workflow', 'schemas')}/`, dir('root', 'workflow', 'input', 'x'), dir('root', 'workflow', 'outputs'), dir('root', 'workflow', 'name.txt')]) assert.equal(credentialIn(text), 'machine path', text);
});

test('every pointer the DSL\'s validation names in a root child workflow passes the machine-path scan, as text and in a JSON line', async () => {
  const { validateWorkflow } = await import('@parcha/agentrun-dsl');
  const child = { v: 2, name: 'child', schemas: { In: { type: 'object' }, Out: { type: 'object' } }, input: { schemaId: 'In' }, output: { schemaId: 'Out' }, root: { node: 'agent', label: 'work', prompt: 'p', out: 'Out', as: 'r' } };
  const broken = [{}, { schemas: 5 }, { schemas: { ...child.schemas, 'a/b~c': 7 } }, { schemas: { ...child.schemas, Bad: { $ref: '#/definitions/Nope' } } }, { input: { schemaId: 'Missing' } }, { input: 3 }, { input: { schemaId: 5 } },
    { output: 'x' }, { output: { schemaId: 4 } }, { output: { schemaId: 'Out', path: 9 } }, { name: 1 }, { v: 3 }, { root: undefined }];
  const paths = new Set();
  for (const change of broken) {
    const result = validateWorkflow({ v: 2, name: 'p', schemas: { In: { type: 'object' }, Out: { type: 'object' } }, input: { schemaId: 'In' }, output: { schemaId: 'Out' }, root: { node: 'workflow', label: 'kid', workflow: { ...child, ...change }, input: {}, out: 'Out', as: 'k' } });
    if (!result.ok) for (const issue of result.issues) paths.add(issue.path);
  }
  for (const path of ['/root/workflow', '/root/workflow/schemas', '/root/workflow/schemas/a~1b~0c', '/root/workflow/schemas/Bad', '/root/workflow/input/schemaId', '/root/workflow/output', '/root/workflow/name']) assert.ok(paths.has(path), `the DSL names ${path}`);
  for (const path of paths) for (const text of [path, JSON.stringify({ issues: [{ path }] })]) assert.equal(credentialIn(text), undefined, text);
});

test('a read the DSL refuses inside a route branch, past a route or past a parallel of a root child workflow names a pointer the scan passes', async () => {
  const { validateWorkflow } = await import('@parcha/agentrun-dsl');
  const fetch = (label) => ({ node: 'call', label, via: 'tool', tool: 'fetch', args: { url: '{url}' }, out: 'Any', as: label, deadline_s: 5 });
  const agent = (label) => ({ node: 'agent', label, instructions: 'Do it.', out: 'Any', as: label });
  const route = (a, b) => ({ node: 'route', label: 'r', valuePath: 'topic', otherwise: 'a', branches: { a: { body: a }, b: { body: b } } });
  const chain = (...steps) => ({ node: 'chain', steps });
  const schemas = { Any: { type: 'object' }, In: { type: 'object', properties: { topic: { type: 'string' } } } };
  const cases = {
    // Each case's root, and the pointer of the read the DSL refuses (STATE_PATH_UNPRODUCED at that node).
    'inside a route branch': [chain(route(fetch('read'), agent('other'))), '/root/workflow/root/steps/0/branches/a/body'],
    'past a route': [chain(route(agent('one'), agent('two')), fetch('read')), '/root/workflow/root/steps/1'],
    'past a parallel': [chain({ node: 'parallel', label: 'p', branches: [agent('one'), agent('two')] }, fetch('read')), '/root/workflow/root/steps/1'],
  };
  for (const [where, [root, read]] of Object.entries(cases)) {
    const child = { v: 2, name: 'child', schemas, input: { schemaId: 'In' }, output: { schemaId: 'Any' }, root };
    const result = validateWorkflow({ v: 2, name: 'p', schemas, input: { schemaId: 'In' }, output: { schemaId: 'Any' }, root: { node: 'workflow', label: 'kid', workflow: child, input: { topic: 'a' }, out: 'Any', as: 'k' } });
    const unread = result.ok ? [] : result.issues.filter((issue) => issue.code === 'STATE_PATH_UNPRODUCED' && issue.path === read);
    assert.ok(unread.length > 0, `${where}: the DSL refuses the read`);
    for (const { path } of result.issues) for (const text of [path, JSON.stringify({ issues: [{ path }] })]) assert.equal(credentialIn(text), undefined, `${where}: ${text}`);
  }
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

test('an image block of a type the recording cannot hold (avif, bmp) is recorded as text, so the recording still publishes', (t) => {
  for (const mimeType of ['image/avif', 'image/bmp', 'image/tiff']) {
    const kept = [];
    moveImages({ content: [{ type: 'image', mimeType, data: Buffer.from('picture bytes').toString('base64') }] }, (bytes, extension) => { kept.push(extension); return sha(bytes); });
    assert.deepEqual(kept, ['txt'], mimeType);
  }
  const png = [];
  moveImages({ content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('p').toString('base64') }] }, (bytes, extension) => { png.push(extension); return sha(bytes); });
  assert.deepEqual(png, ['png']);
  void t;
});

test('a directory in blobs/ is a problem, not a crash, in the validator and the gate', (t) => {
  const dir = recording(t, {});
  mkdirSync(join(dir, 'blobs', `${'a'.repeat(64)}.txt`));
  assert.ok(problems(dir).some((each) => /is not a file/.test(each)), problems(dir).join(' | '));
  assert.ok(gated(t, dir).some((each) => /is not a file|is not a blob/.test(each)));
});

test('a native video block (mp4, webm) is kept with its own extension, and a text file that shares its hash with a media file is still scanned', (t) => {
  const kept = [];
  for (const mimeType of ['video/mp4', 'video/webm']) moveImages({ content: [{ type: 'image', mimeType, data: Buffer.from('frames').toString('base64') }] }, (bytes, extension) => { kept.push(extension); return sha(bytes); });
  assert.deepEqual(kept, ['mp4', 'webm']);
  // One content, a .png and a .json, the hash named by a line: the key in the .json is found, not hidden by the .png.
  const text = `{"key":"AIza${'Ab1_-'.repeat(7)}"}`;
  const hash = sha(text);
  const dir = recording(t, { [`${hash}.png`]: text, [`${hash}.json`]: text });
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.blobs = [hash];
  writeFileSync(join(dir, 'events.jsonl'), [JSON.stringify(first), ...lines.slice(1)].join('\n') + '\n');
  assert.ok(problems(dir).some((each) => /contains a google api key/.test(each)), problems(dir).join(' | '));
});

test('a live host line with an event-level gen is refused: the supervisor\'s lines have none and name their process in data.gen (RECORDING.md 3.1)', (t) => {
  const dir = recording(t, {});
  assert.deepEqual(problems(dir), [], 'the fixture is valid');
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const last = Math.max(...lines.filter((line) => line.channel === 'live' && line.source === 'host').map((line) => line.seq));
  const end = Math.max(...lines.map((line) => line.t));
  writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl'), 'utf8') + JSON.stringify({ channel: 'live', source: 'host', kind: 'box.receipt', gen: 1, t: end + 1, seq: last + 1, data: { gen: 1, box: 'box-1' } }) + '\n');
  assert.ok(problems(dir).some((each) => /a supervisor line \(box\.receipt\) has no event-level gen/.test(each)), problems(dir).join(' | '));
});
