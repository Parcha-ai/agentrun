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
  code: { repo: 'agentrun', commit: 'abc1234', packages: { '@parcha/agentrun-dsl': '0.1.0', '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } },
  model: 'faux/faux-1', generations: 2, kills: 1, cost: { usd: 0, parts: { 'faux/faux-1': 0 } },
  source: { run: 'run-1', store_sha256: 'a'.repeat(64) }, result: { blob, title: 'The record' },
};
const durable = (commit, order, over = {}) => ({ channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen: 1, t: commit * 10 + order, commit, order, data: { generation: 1 }, ...over });
const live = (gen, seq, t, over = {}) => ({ channel: 'live', source: 'workflow', kind: 'node.start', gen, t, seq, path: 'n1', data: { type: 'node.start' }, ...over });
const events = [durable(1, 0), live(1, 0, 11), durable(1, 1, { t: 12 }), live(1, 1, 13, { blobs: [blob], source: 'browser', kind: 'EvidenceRecord' }), durable(2, 0, { gen: 2, t: 20 }), live(2, 0, 21, { gen: 2 })];

/** A recording in a directory of its own, built from `lines` and `manifestOver`, to hand-break. */
async function recording(t, { lines = events, manifestOver = {}, blobs = { [`${blob}.png`]: png }, started = 0 } = {}) {
  // `started` supervisor lines process.started { gen }: no event-level gen, a seq space of their own, and each placed just before the first
  // line of the generation it opens (a process's lines follow its start).
  if (started) {
    const out = [...lines];
    let previous = 0;
    for (let index = 0; index < started; index += 1) {
      const times = lines.filter(line => typeof line === 'object' && line.gen === index + 1).map(line => line.t);
      const at = Math.max(previous, times.length ? Math.min(...times) - 0.25 : 0);
      previous = at;
      const place = out.findIndex(line => typeof line === 'object' && line.t > at);
      out.splice(place < 0 ? out.length : place, 0, { channel: 'live', source: 'host', kind: 'process.started', t: at, seq: index, data: { gen: index + 1, pid: index + 1 } });
    }
    lines = out;
  }
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
  assert.deepEqual(validateRecording(await recording(t, { started: 2 })), []);
});

test('the manifest must list the pi packages beside ours', async t => {
  assert.match(first(await recording(t, { manifestOver: { code: { repo: 'r', commit: 'c', packages: { '@parcha/agentrun-dsl': '0.1.0' } } } })).message, /code\.packages must list @earendil-works\/pi-durable and @earendil-works\/pi-ai/);
});

test('the manifest must carry every field of the format', async t => {
  assert.match(first(await recording(t, { manifestOver: { format: 'agentrun.recording/2' } })).message, /manifest\.format/);
  assert.match(first(await recording(t, { manifestOver: { generations: 0 } })).message, /generations/);
  assert.match(first(await recording(t, { manifestOver: { cost: { usd: 'free', parts: {} } } })).message, /cost/);
  assert.match(first(await recording(t, { manifestOver: { source: { run: 'r', store_sha256: 'xyz' } } })).message, /store_sha256/);
  assert.match(first(await recording(t, { manifestOver: { recorded: { started: '2026-10-14T08:00:05.000Z', ended: '2026-10-14T08:00:00.000Z' } } })).message, /before recorded\.started/);
  assert.match(first(await recording(t, { manifestOver: { generations: 1 }, started: 2 })).message, /generations is 1, but the recording has 2 host process.started lines/);
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
  assert.deepEqual(validateRecording(await recording(t, { lines: [live(1, 0, 1), live(2, 0, 2, { gen: 2 }), live(1, 1, 3)], started: 2 })), []);
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
  assert.deepEqual(validateRecording(await recording(t, { lines: fine, started: 2 })), []);
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
  assert.deepEqual(validateRecording(await recording(t, { lines: noGen, started: 2 })), []);
  const liveNoGen = events.map((line, index) => (index === 1 ? Object.fromEntries(Object.entries(line).filter(([key]) => key !== 'gen')) : line));
  assert.match(first(await recording(t, { lines: liveNoGen })).message, /gen/);
});

test('a snapshot sits at the store\'s latest commit, never below an earlier line, and does not break the strict order', async t => {
  const snap = (commit, order, t, over = {}) => durable(commit, order, { snapshot: true, t, gen: 2, ...over });
  const fine = [durable(1, 0), durable(2, 0, { t: 12 }), snap(2, 0, 20), snap(2, 1, 21), durable(3, 0, { t: 30, gen: 2 })];
  assert.deepEqual(validateRecording(await recording(t, { lines: fine, started: 2 })), []);
  const below = [durable(1, 0), durable(3, 0, { t: 12 }), snap(2, 0, 20)];
  const problem = first(await recording(t, { lines: below }));
  assert.equal(problem.line, 3);
  assert.match(problem.message, /first snapshot is at commit 2, below the 3 already seen/);
  assert.match(first(await recording(t, { lines: [durable(1, 0, { snapshot: 'yes' })], manifestOver: { generations: 1 } })).message, /snapshot is not true/);
  assert.match(first(await recording(t, { lines: [live(1, 0, 1, { snapshot: true })], manifestOver: { generations: 1 } })).message, /no commit, order or snapshot/);
});

test('generations counts the supervisor\'s processes, not a durable line\'s gen, which counts journal opens', async t => {
  // Two processes opened the journal four times between them: durable gens run to 4, live gens stay within 2.
  const opens = [durable(1, 0, { gen: 1, t: 1 }), durable(2, 0, { gen: 2, t: 2 }), durable(3, 0, { gen: 3, t: 3 }), durable(4, 0, { gen: 4, t: 4 })];
  const lines = [...opens, live(1, 0, 5), live(2, 0, 6, { gen: 2 })];
  assert.deepEqual(validateRecording(await recording(t, { lines, started: 2 })), []);
  const beyond = [...opens, live(1, 0, 5), live(3, 0, 6, { gen: 3 })];
  assert.match(first(await recording(t, { lines: beyond, started: 2 })).message, /live line carries gen 3, beyond the 2 processes/);
  assert.match(first(await recording(t, { lines: opens, manifestOver: { generations: 4 }, started: 2 })).message, /generations is 4, but the recording has 2 host process.started/);
});

test('the supervisor\'s lines have no gen and number a seq space of their own', async t => {
  const kill = (seq, t) => ({ channel: 'live', source: 'host', kind: 'kill', t, seq, data: { gen: 1, label: 'search-landed', crossing: 3 } });
  // gen 1's lines run seq 0 and 1 while the supervisor's run 0, 1, 2: the same numbers in different spaces.
  const lines = [live(1, 0, 1), live(1, 1, 2), kill(2, 3)];
  assert.deepEqual(validateRecording(await recording(t, { lines, started: 2 })), []);
  const again = first(await recording(t, { lines: [kill(2, 3), kill(2, 4)], started: 2 }));
  assert.equal(again.line, 4);
  assert.match(again.message, /seq 2 does not increase past 2 in the supervisor's lines/);
  const noGenLive = Object.fromEntries(Object.entries(live(1, 0, 1)).filter(([key]) => key !== 'gen'));
  assert.match(first(await recording(t, { lines: [noGenLive], started: 2 })).message, /gen/);
});

test('a restore (3.2): a drop in commit at a generation\'s first snapshot is accepted only with that generation\'s restore record at head S + 1', async t => {
  const snap = (commit, order, t, gen) => durable(commit, order, { snapshot: true, t, gen });
  const moves = (head, t, gen = 2, kind = 'restore') => durable(0, 0, { source: 'transport', kind: 'transport.moves', t, gen, commit: 7, order: 0, data: { doc: 'transport.moves', value: { moves: [kind === 'move' ? { kind, head, seal: { head, sha256: 'a'.repeat(64), bytes: 1 } } : { kind, head, checkpoint: { head, sha256: 'a'.repeat(64), bytes: 1, at: 'x' } }] } } });
  // Generation 1 committed up to 7; the box died after checkpoint 4; generation 2 reopens it at S = 4, numbering from 5 again.
  const lost = [durable(5, 0, { t: 5 }), durable(6, 0, { t: 6 }), durable(7, 0, { t: 7 })];
  const restored = [...lost, snap(4, 0, 20, 2), snap(4, 1, 21, 2), durable(5, 0, { t: 22, gen: 2 }), durable(6, 0, { t: 23, gen: 2 })];
  const withRecord = [...restored, moves(5, 24)];
  assert.deepEqual(validateRecording(await recording(t, { lines: withRecord, started: 2 })), []);
  // the hand-broken copies: the drop with no restore record, with a record at the wrong head, with a record of another kind, and with the record in another generation
  const refused = async lines => first(await recording(t, { lines, started: 2 }));
  const none = await refused(restored);
  assert.equal(none.line, lost.length + 1 + 2);
  assert.match(none.message, /first snapshot is at commit 4, below the 7 already seen.*no transport\.moves restore record( after it)? with checkpoint head 5/);
  assert.match((await refused([...restored, moves(4, 24)])).message, /checkpoint head 5/);
  assert.ok(validateRecording(await recording(t, { lines: [...restored, moves(5, 24, 2, 'move')], started: 2 })).some(problem => /no transport\.moves restore record( after it)? with checkpoint head 5/.test(problem.message)), 'a move is not a restore');
  // matched by process, not by generation value: the snapshot's gen is an earlier process's, and the record's is whatever the driver says
  assert.deepEqual(validateRecording(await recording(t, { lines: [...restored, moves(5, 24, 3)], started: 2 })), []);
  // a record the previous process wrote, before this process's snapshot, does not excuse the drop
  const before = durable(7, 1, { source: 'transport', kind: 'transport.moves', t: 15, gen: 1, data: { doc: 'transport.moves', value: { moves: [{ kind: 'restore', head: 5, checkpoint: { head: 5, sha256: 'a'.repeat(64), bytes: 1, at: 'x' } }] } } });
  assert.match((await refused([...lost, before, snap(4, 0, 20, 2), snap(4, 1, 21, 2), durable(5, 0, { t: 22, gen: 2 }), durable(6, 0, { t: 23, gen: 2 })])).message, /no transport\.moves restore record( after it)? with checkpoint head 5/);
  // a later snapshot in the same generation may not drop again, and the lines after the restore still obey the strict order
  const again = await refused([...withRecord, snap(3, 0, 30, 2)]);
  assert.match(again.message, /snapshot commit 3 is lower/);
  const reuse = await refused([...lost, snap(4, 0, 20, 2), durable(4, 0, { t: 21, gen: 2 }), moves(5, 24)]);
  assert.match(reuse.message, /does not increase past/);
});

test('a move: the target\'s record anchors on its snapshot at open (3.2)', async t => {
  const snap = (commit, order, t, gen) => durable(commit, order, { snapshot: true, t, gen });
  const moveAt = (head, commit, order, t, gen = 2, sealHead) => durable(commit, order, { source: 'transport', kind: 'transport.moves', t, gen, data: { doc: 'transport.moves', value: { moves: [{ kind: 'move', head, seal: { head: sealHead ?? head, sha256: 'a'.repeat(64), bytes: 1 } }] } } });
  const run = async lines => validateRecording(await recording(t, { lines, started: 2 }));
  const sealed = [durable(1, 0), durable(2, 0, { t: 12 }), snap(2, 0, 20, 2)];
  // The record in the target's first commit, and in a later one (the journal open may commit first): both pass.
  assert.deepEqual(await run([...sealed, durable(3, 0, { t: 21, gen: 2 }), moveAt(3, 3, 1, 22)]), []);
  assert.deepEqual(await run([...sealed, durable(3, 0, { t: 21, gen: 2 }), moveAt(3, 4, 0, 22)]), []);
  // A generation with no snapshot (a bare export) skips the continuity check.
  assert.deepEqual(await run([durable(1, 0), durable(2, 0, { t: 12 }), moveAt(9, 9, 0, 22)]), []);
  // The hand-broken copies.
  const gap = (await run([...sealed, durable(3, 0, { t: 21, gen: 2 }), moveAt(5, 5, 0, 22)]))[0];
  assert.equal(gap.line, 7);
  assert.match(gap.message, /a move's head is 5, but the process's snapshot is at commit 2, so the target's first commit would be 3/);
  assert.match((await run([...sealed, moveAt(2, 3, 0, 22)]))[0].message, /a move's head is 2, but the process's snapshot is at commit 2/);
  assert.match((await run([...sealed, durable(4, 0, { t: 21, gen: 2 }), moveAt(3, 5, 0, 22)]))[0].message, /a move's head is 3, but the process's first commit is 4/);
  assert.match((await run([...sealed, durable(3, 0, { t: 21, gen: 2 }), moveAt(4, 3, 1, 22)]))[0].message, /record at commit 3 names head 4, which is a later commit/);
  // A move keeps one store: a snapshot below a commit already seen is a restore's drop, not a move.
  const dropped = await run([durable(1, 0), durable(3, 0, { t: 12 }), snap(2, 0, 20, 2), moveAt(3, 3, 0, 22)]);
  assert.ok(dropped.some(problem => /first snapshot is at commit 2, below the 3 already seen/.test(problem.message)));
  assert.ok(dropped.some(problem => /highest commit seen before it is 3; a move keeps one store/.test(problem.message)) || dropped.some(problem => /restore record/.test(problem.message)));
});

test('head is top-level: a move\'s head equals its seal.head, and a replayed restore has no drop', async t => {
  const snap = (commit, order, t, gen) => durable(commit, order, { snapshot: true, t, gen });
  const record = (value, commit, order, t, gen = 2) => durable(commit, order, { source: 'transport', kind: 'transport.moves', t, gen, data: { doc: 'transport.moves', value: { moves: [value] } } });
  const run = async lines => validateRecording(await recording(t, { lines, started: 2 }));
  const sealed = [durable(1, 0), durable(2, 0, { t: 12 })];
  // a move whose head differs from its seal.head
  const apart = await run([...sealed, snap(2, 0, 20, 2), durable(3, 0, { t: 21, gen: 2 }), record({ kind: 'move', head: 3, seal: { head: 4, sha256: 'a'.repeat(64), bytes: 1 } }, 3, 1, 22)]);
  assert.match(apart[0].message, /a move's head is 3, but its seal\.head is 4/);
  // a restore that replayed the host's log to commit 2: no drop, head = to + 1, S = the highest commit seen
  const replayed = { kind: 'restore', head: 3, checkpoint: { head: 2, sha256: 'a'.repeat(64), bytes: 1, at: 'x' }, replayed: { from: 2, to: 2 } };
  const lines = [...sealed, snap(2, 0, 20, 2), durable(3, 0, { t: 21, gen: 2 }), record(replayed, 3, 1, 22)];
  assert.deepEqual(await run(lines), []);
  // the same restore with a head that is not to + 1, and one that does not match the snapshot
  assert.match((await run([...sealed, snap(2, 0, 20, 2), durable(3, 0, { t: 21, gen: 2 }), record({ ...replayed, head: 4 }, 4, 1, 22)]))[0].message, /replayed to 2 has head 4, which should be replayed\.to \+ 1/);
  assert.match((await run([...sealed, snap(2, 0, 20, 2), durable(4, 0, { t: 21, gen: 2 }), record({ ...replayed, replayed: { from: 2, to: 3 }, head: 4 }, 4, 1, 22)]))[0].message, /head is 4, but the process's snapshot is at commit 2/);
  // a restore from the checkpoint alone: its head is the checkpoint's
  assert.match((await run([...sealed, snap(2, 0, 20, 2), durable(3, 0, { t: 21, gen: 2 }), record({ kind: 'restore', head: 3, checkpoint: { head: 5, sha256: 'a'.repeat(64), bytes: 1, at: 'x' } }, 3, 1, 22)]))[0].message, /no replay has head 3, but its checkpoint\.head is 5/);
});

test('a durable line\'s gen is the driver\'s and never decreases, outside a restore', async t => {
  const snap = (commit, order, t, gen) => durable(commit, order, { snapshot: true, t, gen });
  // a process whose snapshot carries its lease generation (3) while the commits before it carry the driver's (4)
  const lease = [durable(1, 0, { gen: 2 }), durable(2, 0, { gen: 4, t: 12 }), snap(2, 0, 20, 3), durable(3, 0, { gen: 6, t: 21 })];
  const problem = (await (async () => validateRecording(await recording(t, { lines: lease, started: 2 })))())[0];
  assert.equal(problem.line, 5);
  assert.match(problem.message, /durable gen 3 is lower than the previous durable line's 4/);
  // the driver's generation on the snapshot passes
  assert.deepEqual(validateRecording(await recording(t, { lines: [durable(1, 0, { gen: 2 }), durable(2, 0, { gen: 4, t: 12 }), snap(2, 0, 20, 4), durable(3, 0, { gen: 6, t: 21 })], started: 2 })), []);
});

test('providers, when given, is real or scripted', async t => {
  for (const providers of ['real', 'scripted']) assert.deepEqual(validateRecording(await recording(t, { manifestOver: { providers }, started: 2 })), []);
  assert.match(first(await recording(t, { manifestOver: { providers: 'live' } })).message, /providers is "live", expected real or scripted/);
  assert.match(first(await recording(t, { manifestOver: { providers: true } })).message, /providers/);
  // the field is optional: a manifest without it is valid
  assert.deepEqual(validateRecording(await recording(t, { started: 2 })), []);
});
