import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRecording } from './validate.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from('not really a png');
const blob = sha(png);
const manifest = {
  format: 'agentrun.recording/1', title: 'A run', task: 'company-check',
  recorded: { started: '2026-10-14T08:00:00.000Z', ended: '2026-10-14T08:00:05.000Z' },
  code: { repo: 'agentrun', commit: 'abc1234', packages: { '@parcha/agentrun-dsl': '0.1.0' } },
  model: 'faux/faux-1', generations: 2, kills: 1, cost: { usd: 0, parts: { 'faux/faux-1': 0 } },
  source: { run: 'run-1', store_sha256: 'a'.repeat(64) }, result: { blob, title: 'The record' },
};
const durable = (commit, order, over = {}) => ({ channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: commit * 10 + order, commit, order, data: { generation: 1 }, ...over });
const live = (gen, seq, t, over = {}) => ({ channel: 'live', source: 'workflow', kind: 'node.start', gen, t, seq, path: 'n1', data: { type: 'node.start' }, ...over });
const events = [durable(1, 0), live(1, 0, 11), durable(1, 1, { t: 12 }), live(1, 1, 13, { blobs: [blob], source: 'browser', kind: 'EvidenceRecord' }), durable(2, 0, { gen: 2, t: 20 }), live(2, 0, 21, { gen: 2 })];

/** A recording in a directory of its own, built from `lines` and `manifestOver`, to hand-break. */
async function recording(t, { lines = events, manifestOver = {}, blobs = { [`${blob}.png`]: png } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'recording-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'blobs'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, ...manifestOver }));
  await writeFile(join(dir, 'events.jsonl'), lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + '\n');
  for (const [name, bytes] of Object.entries(blobs)) await writeFile(join(dir, 'blobs', name), bytes);
  return dir;
}
const first = dir => validateRecording(dir)[0];

test('a well-formed recording has no problem', async t => {
  assert.deepEqual(validateRecording(await recording(t)), []);
});

test('the manifest must carry every field of the format', async t => {
  assert.match(first(await recording(t, { manifestOver: { format: 'agentrun.recording/2' } })).message, /manifest\.format/);
  assert.match(first(await recording(t, { manifestOver: { generations: 0 } })).message, /generations/);
  assert.match(first(await recording(t, { manifestOver: { cost: { usd: 'free', parts: {} } } })).message, /cost/);
  assert.match(first(await recording(t, { manifestOver: { source: { run: 'r', store_sha256: 'xyz' } } })).message, /store_sha256/);
  assert.match(first(await recording(t, { manifestOver: { recorded: { started: '2026-10-14T08:00:05.000Z', ended: '2026-10-14T08:00:00.000Z' } } })).message, /before recorded\.started/);
  assert.match(first(await recording(t, { manifestOver: { generations: 1 } })).message, /generations is 1, but a line carries gen 2/);
});

test('a line must carry the fields of its channel', async t => {
  const broken = (over, remove) => events.map((line, index) => (index === 1 ? Object.fromEntries(Object.entries({ ...line, ...over }).filter(([key]) => !remove?.includes(key))) : line));
  const at = async (over, remove) => first(await recording(t, { lines: broken(over, remove) }));
  assert.deepEqual([(await at({ channel: 'both' })).line, (await at({}, ['seq'])).message], [2, 'a live line needs an integer seq']);
  assert.match((await at({ source: 'cloud' })).message, /source/);
  assert.match((await at({ gen: 0 })).message, /gen/);
  assert.match((await at({}, ['data'])).message, /data is missing/);
  assert.match((await at({ commit: 3 })).message, /live line has no commit/);
  assert.match((await at({ blobs: ['short'] })).message, /blobs/);
  const durableWithoutOrder = events.map((line, index) => (index === 0 ? { ...line, order: undefined } : line));
  assert.match(first(await recording(t, { lines: durableWithoutOrder })).message, /durable line needs an integer order/);
});

test('invariant 1: commit never decreases across durable lines', async t => {
  const lines = [durable(2, 0), durable(1, 1, { t: 21 })];
  const problem = first(await recording(t, { lines, manifestOver: { generations: 1 } }));
  assert.equal(problem.line, 2);
  assert.match(problem.message, /commit 1 is lower/);
});

test('invariant 2: (commit, order) strictly increases across durable lines', async t => {
  const lines = [durable(1, 0), durable(1, 0, { t: 11 })];
  const problem = first(await recording(t, { lines, manifestOver: { generations: 1 } }));
  assert.equal(problem.line, 2);
  assert.match(problem.message, /does not increase past/);
});

test('invariant 3: seq strictly increases within one generation across live lines', async t => {
  const lines = [live(1, 0, 1), live(1, 1, 2), live(1, 1, 3)];
  const problem = first(await recording(t, { lines, manifestOver: { generations: 1 } }));
  assert.equal(problem.line, 3);
  assert.match(problem.message, /seq 1 does not increase past 1 in generation 1/);
  assert.deepEqual(validateRecording(await recording(t, { lines: [live(1, 0, 1), live(2, 0, 2, { gen: 2 }), live(1, 1, 3)] })), []);
});

test('the file is in order of t', async t => {
  assert.match(first(await recording(t, { lines: [durable(1, 0, { t: 50 }), live(1, 0, 10)], manifestOver: { generations: 1 } })).message, /before the previous line/);
});

test('every blob a line or the manifest names is present and hashes to its name', async t => {
  assert.match(first(await recording(t, { blobs: {} })).message, /not in blobs/);
  assert.match(first(await recording(t, { blobs: { [`${blob}.png`]: Buffer.from('tampered') } })).message, /does not hash to its name/);
  const absent = events.map(line => (line.blobs ? { ...line, blobs: ['b'.repeat(64)] } : line));
  const problem = (await recording(t, { lines: absent })) && validateRecording(await recording(t, { lines: absent })).find(each => each.line === 4);
  assert.match(problem.message, /bbbb.* not in blobs/);
});

test('a line or the manifest that holds a credential-shaped value is refused', async t => {
  const secret = `sk-${'a1'.repeat(20)}`;
  const withSecret = events.map((line, index) => (index === 3 ? { ...line, data: { header: `Bearer ${'x'.repeat(30)}` } } : line));
  assert.deepEqual([first(await recording(t, { lines: withSecret })).line, first(await recording(t, { lines: withSecret })).message], [4, 'contains a bearer secret']);
  const inManifest = first(await recording(t, { manifestOver: { title: secret } }));
  assert.equal(inManifest.where, 'manifest.json');
  assert.match(inManifest.message, /provider secret/);
});

test('a line that is not JSON, an empty line and a missing file are named', async t => {
  assert.deepEqual([first(await recording(t, { lines: [JSON.stringify(events[0]), '{nope'] })).line, first(await recording(t, { lines: [JSON.stringify(events[0]), ''] })).message], [2, 'has an empty line']);
  const dir = await recording(t);
  await rm(join(dir, 'events.jsonl'));
  assert.equal(first(dir).message, 'is missing');
});

test('an image stays out of the line: a block holds its blob, never its data', async t => {
  const block = { type: 'image', mimeType: 'image/png', blob };
  const fine = events.map((line, index) => (index === 3 ? { ...line, data: { content: [block] } } : line));
  assert.deepEqual(validateRecording(await recording(t, { lines: fine })), []);
  const inline = events.map((line, index) => (index === 3 ? { ...line, data: { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] } } : line));
  assert.deepEqual([first(await recording(t, { lines: inline })).line, first(await recording(t, { lines: inline })).message.slice(0, 22)], [4, 'holds image data inlin']);
  const dataUrl = events.map((line, index) => (index === 3 ? { ...line, data: { src: 'data:image/png;base64,AAAA' } } : line));
  assert.match(first(await recording(t, { lines: dataUrl })).message, /image data inline/);
  const long = events.map((line, index) => (index === 3 ? { ...line, data: { frame: 'A'.repeat(5000) } } : line));
  assert.match(first(await recording(t, { lines: long })).message, /image data inline/);
  const unlisted = events.map((line, index) => (index === 3 ? { ...line, blobs: undefined, data: { content: [block] } } : line));
  assert.match(first(await recording(t, { lines: unlisted })).message, /does not list/);
});

test('a durable line may have no gen; a live line must have one', async t => {
  const noGen = events.map((line, index) => (index === 0 ? Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'gen')) : line));
  assert.deepEqual(validateRecording(await recording(t, { lines: noGen })), []);
  const liveNoGen = events.map((line, index) => (index === 1 ? Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'gen')) : line));
  assert.match(first(await recording(t, { lines: liveNoGen })).message, /gen/);
});

test('a snapshot sits at the store\'s latest commit, never below an earlier line, and does not break the strict order', async t => {
  const snap = (commit, order, t, over = {}) => durable(commit, order, { snapshot: true, t, gen: 2, ...over });
  const fine = [durable(1, 0), durable(2, 0, { t: 12 }), snap(2, 0, 20), snap(2, 1, 21), durable(3, 0, { t: 30, gen: 2 })];
  assert.deepEqual(validateRecording(await recording(t, { lines: fine })), []);
  const below = [durable(1, 0), durable(3, 0, { t: 12 }), snap(2, 0, 20)];
  const problem = first(await recording(t, { lines: below }));
  assert.equal(problem.line, 3);
  assert.match(problem.message, /snapshot commit 2 is lower/);
  assert.match(first(await recording(t, { lines: [durable(1, 0, { snapshot: 'yes' })], manifestOver: { generations: 1 } })).message, /snapshot is not true/);
  assert.match(first(await recording(t, { lines: [live(1, 0, 1, { snapshot: true })], manifestOver: { generations: 1 } })).message, /no commit, order or snapshot/);
});
