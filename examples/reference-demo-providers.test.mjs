// Tool-made boxes on the demo's own providers (`DemoOptions.providers`): the harness taps them, so a recording holds every box a run's tools made, by label.
// The lines are RECORDING.md's (draft 39): `box.created` { box, provider, facts, role? }, `box.exec` { box } per command, `box.ended` { box }, all live lines with source `transport` and
// a `box-N` label, never a provider id; one host `box.receipt` per box with no rate (`usd_per_second`, `cost_usd`, `source` and `priced` null), so the run's cost reads unknown.
// The provider ids go only to a directory outside the recording (`--box-ids`, default `<run dir>/box-ids.internal`), one file per label (`box-N.json`), each claimed exclusively,
// so two processes of a run never take one label.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { costLabel, countersOf, counterFold } from '../apps/viewer/src/counters.ts';
import { parseLines, validate as viewerValidate } from '../apps/viewer/src/format.ts';
import { transportPanel } from '../apps/viewer/src/transport.ts';
import { FIXTURE, localBoxes, run } from './reference-demo-helpers.mjs';

const transport = (recording) => readEvents(recording).filter((line) => line.source === 'transport' && line.channel === 'live');
const receipts = (recording) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'box.receipt').map((line) => line.data);
/** Every file under a folder, as latin1 text. */
const everyFile = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'));
const NO_RATE = { usd_per_second: null, cost_usd: null, source: null, priced: null };
/** The boxes the providers' tool answered, from the run's kept answers. */
const answered = (dir) => readdirSync(join(dir, 'answers')).map((name) => JSON.parse(readFileSync(join(dir, 'answers', name), 'utf8')).value).find((value) => value && 'alpha' in value && 'beta' in value);
/** The labels a run's ids directory holds, each `box-N` with its entry. */
const readIds = (dir) => Object.fromEntries((existsSync(dir) ? readdirSync(dir) : []).filter((name) => /^box-\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5))).map((name) => [name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), 'utf8'))]));
/** Ends a box a run left, by the id the ids directory names, so a test leaves nothing running. */
async function endLeft(dir, ids, label) {
  const { id } = ids[label];
  const found = await localBoxes({ root: join(dir, 'beta') }).attach(id, BACKGROUND_CONTEXT);
  if (found.ok && found.value) await found.value.destroy(BACKGROUND_CONTEXT);
}

test('two boxes on two providers of the demo\'s own: box.created, a box.exec per command and box.ended for each, by the labels the tool answered, and a receipt with no rate for each', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.deepEqual(answered(result.dir), { alpha: 'box-1', beta: 'box-2' }, 'the tool\'s answer names each box by its label');
  const lines = transport(recording).map((line) => [line.kind, line.data]);
  // A local box's facts are this machine's (its CPU count), so the cpus are read from the line and checked to be a count.
  const created = lines.filter(([kind]) => kind === 'box.created').map(([, data]) => data);
  for (const data of created) assert.ok(Number.isInteger(data.facts.cpus) && data.facts.cpus > 0, `cpus is a count: ${JSON.stringify(data.facts)}`);
  assert.deepEqual(created, [
    { box: 'box-1', provider: 'alpha', facts: { isolation: 'none', cpus: created[0].facts.cpus, gpu: null }, role: 'worker' },
    { box: 'box-2', provider: 'beta', facts: { isolation: 'none', cpus: created[1].facts.cpus, gpu: null } },
  ]);
  assert.deepEqual(lines.filter(([kind]) => kind === 'box.exec').map(([, data]) => data), [{ box: 'box-1' }, { box: 'box-1' }, { box: 'box-2' }], 'one line per command, and never the command');
  assert.deepEqual(lines.filter(([kind]) => kind === 'box.ended').map(([, data]) => data.box), ['box-1', 'box-2']);
  const kept = receipts(recording);
  assert.deepEqual(kept.map((receipt) => [receipt.box, receipt.provider, receipt.kind]), [['box-1', 'alpha', 'none'], ['box-2', 'beta', 'none']]);
  for (const receipt of kept) {
    assert.deepEqual({ usd_per_second: receipt.usd_per_second, cost_usd: receipt.cost_usd, source: receipt.source, priced: receipt.priced }, NO_RATE, 'no rate: the four keys are there, and null');
    assert.ok(Date.parse(receipt.from) <= Date.parse(receipt.to) && receipt.seconds >= 0, 'an ended box has its end');
  }
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.equal(manifest.cost.usd, null, 'a box with no rate makes the run\'s cost unknown, never 0');
});

test('no provider id is in the recording: the ids are in the run directory\'s box-ids.internal/, outside the recording, one file per label', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1' });
  const file = join(result.dir, 'box-ids.internal');
  assert.ok(existsSync(file), 'the ids directory is in the run directory');
  assert.ok(relative(realpathSync(recording), realpathSync(file)).startsWith('..'), 'and outside the recording');
  const ids = readIds(file);
  assert.deepEqual([ids['box-1'].owner, ids['box-2'].owner], ['tools', 'tools']);
  assert.deepEqual(Object.keys(ids), ['box-1', 'box-2']);
  assert.deepEqual([ids['box-1'].provider, ids['box-2'].provider], ['alpha', 'beta']);
  const recorded = everyFile(recording).join('\n');
  for (const { id } of Object.values(ids)) {
    assert.ok(id.length > 4);
    assert.ok(!recorded.includes(id) && !recorded.includes(JSON.stringify(id).slice(1, -1)), `the id of a box is in no file of the recording: ${id}`);
  }
});

test('--box-ids names the ids directory: a path outside the recording is used, and one inside it is refused', { timeout: 300_000 }, async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const outside = join(own, 'ids');
  const { result } = await run(t, {}, ['--json', '--box-ids', outside], { DEMO_PROVIDERS: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(Object.keys(readIds(outside)), ['box-1', 'box-2']);
  assert.ok(!existsSync(join(result.dir, 'box-ids.internal')), 'the default directory is not written as well');
  // The last --record wins: this run records into a directory the test knows, and is asked to put the ids inside it.
  const recording = join(own, 'recording');
  await assert.rejects(run(t, {}, ['--json', '--record', recording, '--box-ids', join(recording, 'ids.json')], { DEMO_PROVIDERS: '1' }), /--box-ids .*inside the recording/);
});

test('a box still open when the run ends gets its receipt then, with no end and no seconds', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: 'leave' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  const ids = readIds(join(result.dir, 'box-ids.internal'));
  t.after(() => endLeft(result.dir, ids, 'box-2'));
  assert.deepEqual(transport(recording).filter((line) => line.kind === 'box.ended').map((line) => line.data.box), ['box-1'], 'only the alpha box ended');
  const open = receipts(recording).find((receipt) => receipt.box === 'box-2');
  assert.deepEqual({ to: open.to, seconds: open.seconds, ...Object.fromEntries(Object.keys(NO_RATE).map((key) => [key, open[key]])) }, { to: null, seconds: null, ...NO_RATE });
});

test('the recording validates, the viewer\'s transport panel lists both boxes by label, and its cost reads unknown, with no dollar sign', { timeout: 300_000 }, async (t) => {
  const { recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1' });
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  let state = transportPanel.init();
  for (const line of lines) if (transportPanel.accepts(line)) state = transportPanel.reduce(state, line);
  assert.deepEqual(state.boxes.map((box) => [box.box, box.provider]), [['box-1', 'alpha'], ['box-2', 'beta']]);
  let counters = counterFold.init();
  for (const line of lines) if (counterFold.accepts(line)) counters = counterFold.reduce(counters, line);
  const strip = countersOf(counters, true);
  const label = costLabel(strip.cost, strip.costLowerBound, 'scripted', strip.costParts);
  assert.equal(label, 'unknown');
  assert.ok(!label.includes('$'));
});

test('a supervised run\'s tool-box receipts are the supervisor\'s (RECORDING.md 3.1): the viewer\'s own format check gives no note, and each label\'s receipt is written once, its process in data.gen, with no event-level gen', { timeout: 300_000 }, async (t) => {
  const { recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1' });
  const lines = parseLines(readFileSync(join(recording, 'events.jsonl'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  const blobs = new Set((existsSync(join(recording, 'blobs')) ? readdirSync(join(recording, 'blobs')) : []).map((name) => name.split('.')[0]));
  assert.deepEqual(viewerValidate(manifest, lines, blobs), []);
  const kept = lines.filter((line) => line.source === 'host' && line.kind === 'box.receipt');
  assert.deepEqual(kept.map((line) => line.data.box), ['box-1', 'box-2'], 'each label\'s receipt once');
  for (const line of kept) {
    assert.equal(line.gen, undefined, `${line.data.box}'s receipt has no event-level gen`);
    assert.ok(Number.isInteger(line.data.gen) && line.data.gen >= 1, `${line.data.box}'s receipt names its process in data.gen`);
  }
});

test('an ids directory a later run uses again (the same --box-ids) holds the earlier run\'s boxes: their receipts are never written again, only the new run\'s own', { timeout: 300_000 }, async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-again-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const shared = join(own, 'ids');
  const first = await run(t, {}, ['--json', '--box-ids', shared], { DEMO_PROVIDERS: '1' });
  assert.deepEqual(receipts(first.recording).map((receipt) => receipt.box), ['box-1', 'box-2']);
  const second = await run(t, {}, ['--json', '--box-ids', shared], { DEMO_PROVIDERS: '1' });
  assert.deepEqual(receipts(second.recording).map((receipt) => receipt.box), ['box-3', 'box-4'], 'the second run\'s own boxes only');
});

test('a box ids directory the supervisor cannot read at its final pass fails the run by name: the receipts it still owes are never dropped without a note', { timeout: 300_000 }, async (t) => {
  const { mkdirSync, watch, writeFileSync } = await import('node:fs');
  const own = await mkdtemp(join(tmpdir(), 'box-ids-damaged-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const shared = join(own, 'ids');
  mkdirSync(shared);
  // Once the run's last box has ended (its file says so), a damaged file lands beside it: after every write the run's
  // process makes, before the supervisor's last read.
  let damaged = false;
  const watcher = watch(shared, (_event, name) => {
    if (damaged || name !== 'box-2.json') return;
    try { if (JSON.parse(readFileSync(join(shared, name), 'utf8')).receipt !== 'ended') return; } catch { return; }
    damaged = true;
    writeFileSync(join(shared, 'box-9.json'), '{ not a ledger entry');
  });
  t.after(() => watcher.close());
  await assert.rejects(run(t, {}, ['--json', '--box-ids', shared], { DEMO_PROVIDERS: '1' }), /box ids file .*box-9\.json cannot be read/);
  assert.ok(damaged, 'the damage landed while the run went on');
});

test('a run whose place makes boxes and whose tools make boxes too is refused: one labeller, never two box-1s', async (t) => {
  await assert.rejects(run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: '1' }), /place.*tool-made boxes|tool-made boxes.*place/);
});

test('the demo.json boxes (local here) are named by label too: box.created, box.exec and box.ended carry box-N, never the provider id', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { boxes: { kind: 'local' } }, ['--json'], { DEMO_BOX_TOOL: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  const lines = transport(recording);
  assert.deepEqual(lines.filter((line) => line.kind === 'box.created').map((line) => line.data.box), ['box-1']);
  assert.ok(lines.filter((line) => line.kind === 'box.exec').every((line) => line.data.box === 'box-1') && lines.some((line) => line.kind === 'box.exec'));
  assert.ok(!readFileSync(join(recording, 'events.jsonl'), 'utf8').includes('local-'), 'no local box id in a line');
});

test('providerExtensions get the tapped providers, never the raw ones: an agent\'s own tool (not a call node) makes a box on one, and it is recorded by label with a receipt', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: 'ext' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const lines = transport(recording).map((line) => [line.kind, line.data.box, line.data.role ?? null]);
  assert.deepEqual(lines, [['box.created', 'box-1', 'ext'], ['box.exec', 'box-1', null], ['box.ended', 'box-1', null]], 'the extension tool\'s box is on the recording: the provider it was handed is the tapped one');
  const [receipt] = receipts(recording);
  assert.deepEqual([receipt.box, receipt.provider, receipt.cost_usd, receipt.usd_per_second], ['box-1', 'alpha', null, null]);
  assert.ok(!readFileSync(join(recording, 'events.jsonl'), 'utf8').includes('local-'), 'no provider id in a line');
});

test('providerExtensions without providers is refused: the hook would have nothing to hand its tools', async (t) => {
  await assert.rejects(run(t, {}, ['--json'], { DEMO_EXT_ALONE: '1' }), /providerExtensions.*providers/);
});

test('the default ids file is never in the recording: a run whose directory is inside the recording is refused before it starts, as --box-ids inside it is', async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-default-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const recording = join(own, 'recording');
  // No --box-ids: the default, box-ids.internal/ in the run's directory, would be inside the recording.
  await assert.rejects(run(t, {}, ['--json', '--record', recording, '--dir', join(recording, 'run')], { DEMO_PROVIDERS: '1' }), /box-ids\.internal.* inside the recording/);
  await assert.rejects(run(t, {}, ['--json', '--record', join(own, 'same'), '--dir', join(own, 'same')], { DEMO_PROVIDERS: '1' }), /box-ids\.internal.* inside the recording/);
});

test('a box still open when the result hook throws gets its receipt all the same, with no end and no seconds', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: 'leave', DEMO_RESULT_THROWS: '1' });
  assert.notEqual(result.processes.at(-1).outcome.status, 'complete', 'the result hook failed the process');
  const ids = readIds(join(result.dir, 'box-ids.internal'));
  t.after(() => endLeft(result.dir, ids, 'box-2'));
  const kept = receipts(recording);
  assert.deepEqual(kept.map((receipt) => [receipt.box, receipt.to === null, receipt.seconds === null]), [['box-1', false, false], ['box-2', true, true]]);
});

// ---- H1: one labeller for a place's host boxes and the tools' boxes ---------------------------------------------------------------------------------
// A place that hands its run's process the host box it started (HOST_BOX) and lets the supervisor read the run's files (readRunFile and listRunFiles, disk's K8 shape) shares
// one numbering with the tools' boxes: the process claims the host box's label first, and the supervisor reads it back itself. Without those reads, providers beside the place
// are refused; with them (H8) the refusal lifts.

const { boxLedger: hostLedger, parseHostBox } = await import('../packages/harness/dist/boxes.js');

test('a place that reports host boxes with no run-file reads, in a run with no providers, is the run\'s only labeller: its home box is box-1, with its receipt', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_WITH_PLACE: 'reporting' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(receipts(recording).map((line) => [line.box, line.provider, line.kind, line.to]), [['box-1', 'home', 'host', null]]);
});

test('(3) a place with no run-file reads numbers its own boxes, so no HOST_BOX is ever claimed under it: one it hands over anyway refuses the process (two labellers), and no place label is written', { timeout: 300_000 }, async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-handing-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const dir = join(own, 'run');
  const outcome = await run(t, {}, ['--json', '--dir', dir], { DEMO_WITH_PLACE: 'handing' }).then((done) => JSON.stringify(done.result.processes.at(-1)), (error) => String(error.message));
  assert.match(outcome, /HOST_BOX was handed over, but this run's supervisor cannot read the run's labels/);
  assert.deepEqual(Object.values(readIds(join(dir, 'box-ids.internal'))).filter((entry) => entry.owner === 'place'), [], 'no host box label was claimed');
});

test('FAIL CLOSED, no members: the same place beside providers is refused before the run: the lifted refusal needs the run-file reads', async (t) => {
  await assert.rejects(run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'reporting' }), /readRunFile/);
});

test('H8: one run, two labellers lifted into one: the place\'s home box and the tools\' two boxes are box-1, box-2 and box-3 run-wide, each with one receipt, and the viewer\'s format check gives no note', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'labelled' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const ids = readIds(join(result.dir, 'box-ids.internal'));
  assert.deepEqual(Object.entries(ids).map(([label, entry]) => [label, entry.owner, entry.provider]), [['box-1', 'place', 'home'], ['box-2', 'tools', 'alpha'], ['box-3', 'tools', 'beta']]);
  assert.deepEqual(answered(result.dir), { alpha: 'box-2', beta: 'box-3' });
  assert.deepEqual(receipts(recording).map((receipt) => [receipt.box, receipt.provider]).sort(), [['box-1', 'home'], ['box-2', 'alpha'], ['box-3', 'beta']], 'one receipt each, by the one numbering');
  const lines = parseLines(readFileSync(join(recording, 'events.jsonl'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  const blobs = new Set((existsSync(join(recording, 'blobs')) ? readdirSync(join(recording, 'blobs')) : []).map((name) => name.split('.')[0]));
  assert.deepEqual(viewerValidate(manifest, lines, blobs), []);
});

test('H8 on the disk package\'s localPlace: demo() takes tool boxes beside a disk place of its own (each process pi-durable-disk run --app on the run\'s directory, the place\'s own run-file reads, no live disk): the tools\' two boxes are box-1 and box-2, one receipt each, and the viewer\'s format check gives no note', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'disk-local' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const ids = readIds(join(result.dir, 'box-ids.internal'));
  assert.deepEqual(Object.entries(ids).map(([label, entry]) => [label, entry.owner, entry.provider]), [['box-1', 'tools', 'alpha'], ['box-2', 'tools', 'beta']]);
  assert.deepEqual(answered(result.dir), { alpha: 'box-1', beta: 'box-2' });
  assert.deepEqual(receipts(recording).map((receipt) => [receipt.box, receipt.provider]).sort(), [['box-1', 'alpha'], ['box-2', 'beta']], 'one receipt each');
  const lines = parseLines(readFileSync(join(recording, 'events.jsonl'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  const blobs = new Set((existsSync(join(recording, 'blobs')) ? readdirSync(join(recording, 'blobs')) : []).map((name) => name.split('.')[0]));
  assert.deepEqual(viewerValidate(manifest, lines, blobs), []);
});

test('a host box\'s label is claimed by the run\'s process: the same again in the same supervisor life, refused in another or on another provider, and a malformed identity is refused', async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-host-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const dir = join(own, 'ids');
  const from = new Date().toISOString();
  assert.equal(hostLedger({ dir }).claimHost({ provider: 'home', key: '0', run: 'life-a' }, from), 'box-1');
  assert.equal(hostLedger({ dir }).claimHost({ provider: 'home', key: '0', run: 'life-a' }, from), 'box-1', 'a process restarted in the same supervisor life gets the same label');
  assert.throws(() => hostLedger({ dir }).claimHost({ provider: 'home', key: '0', run: 'life-b' }, from), /restarted/, 'another supervisor life would renumber: refused');
  assert.throws(() => hostLedger({ dir }).claimHost({ provider: 'away', key: '0', run: 'life-a' }, from), /box-1 on home, not on away/, 'one key on another provider is not the same box: refused');
  assert.equal(hostLedger({ dir }).claimHost({ provider: 'home', key: '1', run: 'life-a' }, from), 'box-2');
  for (const bad of ['not json', '{}', '{"provider":"home","key":"x","run":"a"}', '{"provider":"","key":"0","run":"a"}', '{"provider":"home","key":"0"}']) assert.throws(() => parseHostBox(bad), /HOST_BOX/, bad);
});

test('(A) a host box key is claimed exclusively, before its label: a key another supervisor life claimed first refuses this one even before that life\'s label has landed, so two lives starting together never both label one box', async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-key-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const dir = join(own, 'ids');
  const from = new Date().toISOString();
  // Life b won key 0 a moment ago: its key file is there, its box-N label not yet (the window two lives starting together race in).
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'host-0.json'), JSON.stringify({ provider: 'home', key: '0', run: 'life-b' }));
  assert.throws(() => hostLedger({ dir }).claimHost({ provider: 'home', key: '0', run: 'life-a' }, from), /restarted|another supervisor life/);
  assert.deepEqual(Object.keys(readIds(dir)), [], 'life a claimed no label for that box');
  // Life b's own process (restarted) gets its key and a label.
  assert.equal(hostLedger({ dir }).claimHost({ provider: 'home', key: '0', run: 'life-b' }, from), 'box-1');
});

test('(A) a FORCED race: two processes of two supervisor lives claim host key 0 at one instant, 20 rounds: each round keeps exactly one claim, refuses the other, and leaves one key file and one place label', { timeout: 120_000 }, async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-race-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const { spawn } = await import('node:child_process');
  const { readdirSync: list, writeFileSync } = await import('node:fs');
  const boxes = new URL('../packages/harness/dist/boxes.js', import.meta.url).href;
  // Each process spins at a barrier (a file that does not exist yet), then claims at once.
  const worker = "const { boxLedger } = await import(process.argv[1]); const [dir, go, run] = process.argv.slice(2); const { existsSync } = await import('node:fs'); while (!existsSync(go)) {} try { console.log(JSON.stringify({ label: boxLedger({ dir }).claimHost({ provider: 'home', key: '0', run }, new Date().toISOString()) })); } catch (error) { console.log(JSON.stringify({ refused: String(error.message) })); }";
  for (let round = 0; round < 20; round += 1) {
    const dir = join(own, `ids-${round}`);
    const go = join(own, `go-${round}`);
    const claim = (life) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, boxes, dir, go, life], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(JSON.parse(out)));
    });
    const both = [claim('life-a'), claim('life-b')];
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    writeFileSync(go, '');
    const results = await Promise.all(both);
    assert.equal(results.filter((result) => result.label).length, 1, `round ${round}: one claim kept (${JSON.stringify(results)})`);
    assert.match(results.find((result) => result.refused)?.refused ?? '', /another supervisor life/, `round ${round}: the other refused`);
    assert.deepEqual(list(dir).filter((name) => name.startsWith('host-')), ['host-0.json']);
    assert.equal(Object.values(readIds(dir)).filter((entry) => entry.owner === 'place').length, 1, `round ${round}: one place label`);
  }
});

test('(B) the supervisor reads only ITS life\'s label for a host box: a previous life\'s entry in a reused ids directory is no label, so a box this life never claimed is still refused at the final read', async () => {
  const { hostLabelIn } = await import('../packages/harness/dist/boxes.js');
  const entry = (run) => new TextEncoder().encode(JSON.stringify({ provider: 'home', owner: 'place', key: '0', run, kind: 'host' }));
  const files = { listRunFiles: async () => ['box-1.json'], readRunFile: async () => entry('life-old') };
  assert.equal(await hostLabelIn(files, 'box-ids.internal', { provider: 'home', key: '0', run: 'life-new' }), undefined, 'another life\'s label is not this box\'s');
  assert.equal(await hostLabelIn(files, 'box-ids.internal', { provider: 'home', key: '0', run: 'life-old' }), 'box-1');
});

test('a won label is durable before it is used: after the winning link(2), in claimKey() and in claim(), the ids directory is fsynced, so a crash that keeps a synced line naming box-N never loses box-N.json (a fix: the next claim would take box-N again)', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const tmp = await mkdtemp(join(tmpdir(), 'box-ids-durable-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'box-ids.internal');
  // The ledger's own calls, in order: each link(2) into the directory, and each fsync of the directory itself (a file's fsync is not one).
  const events = [];
  const opened = new Map();
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync };
  fs.openSync = (path, ...rest) => { const fd = real.openSync(path, ...rest); opened.set(fd, String(path)); return fd; };
  fs.fsyncSync = (fd) => { if (opened.get(fd) === dir) events.push('fsync the directory'); return real.fsyncSync(fd); };
  fs.linkSync = (from, to) => { real.linkSync(from, to); if (!String(to).includes('.probe-')) events.push(`link ${String(to).slice(dir.length + 1)}`); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, real); syncBuiltinESMExports(); });
  const ledger = hostLedger({ dir });
  events.push(`use ${ledger.claimHost({ provider: 'home', key: '0', run: 'life-1' }, new Date().toISOString())}`);
  events.push(`use ${ledger.label('alpha', 'alpha-1')}`);
  assert.deepEqual(events, [
    'link host-0.json', 'fsync the directory',
    'link box-1.json', 'fsync the directory', 'use box-1',
    'link box-2.json', 'fsync the directory', 'use box-2',
  ]);
});

test('a label whose directory entry cannot be made durable is never used: a failed fsync of the ids directory refuses the claim, by name, in claim() and in claimKey()', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const tmp = await mkdtemp(join(tmpdir(), 'box-ids-durable-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'box-ids.internal');
  const opened = new Map();
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync };
  fs.openSync = (path, ...rest) => { const fd = real.openSync(path, ...rest); opened.set(fd, String(path)); return fd; };
  fs.fsyncSync = (fd) => { if (/ids\.internal$/.test(opened.get(fd) ?? '')) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); return real.fsyncSync(fd); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, real); syncBuiltinESMExports(); });
  assert.throws(() => hostLedger({ dir }).label('alpha', 'alpha-1'), /cannot be made durable \(EIO/);
  // A host box's key that cannot be made durable refuses before its label is even linked.
  const hostDir = join(tmp, 'host-ids.internal');
  assert.throws(() => hostLedger({ dir: hostDir }).claimHost({ provider: 'home', key: '0', run: 'life-1' }, new Date().toISOString()), /cannot be made durable \(EIO/);
  assert.deepEqual(readdirSync(hostDir).filter((name) => /^box-\d+\.json$/.test(name)), [], 'no label linked after a key that cannot be made durable');
});

test('a label\'s new receipt state is durable before it is relied on: after the rename(2) of box-N.json, in the ledger\'s open and the supervisor\'s mark, the ids directory is fsynced, so a crash never brings back a state that says a written receipt is unwritten (a fix: it would be written twice)', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { markReceiptWritten } = await import('../packages/harness/dist/boxes.js');
  const tmp = await mkdtemp(join(tmpdir(), 'box-ids-durable-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'box-ids.internal');
  const ledger = hostLedger({ dir });
  const label = ledger.label('alpha', 'alpha-1');
  const events = [];
  const opened = new Map();
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
  fs.openSync = (path, ...rest) => { const fd = real.openSync(path, ...rest); opened.set(fd, String(path)); return fd; };
  fs.fsyncSync = (fd) => { if (opened.get(fd) === dir) events.push('fsync the directory'); return real.fsyncSync(fd); };
  fs.renameSync = (from, to) => { real.renameSync(from, to); events.push(`rename to ${String(to).slice(dir.length + 1)}`); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, real); syncBuiltinESMExports(); });
  ledger.open(label, { provider: 'alpha', kind: 'container', from: new Date().toISOString() });
  events.push('rely on open');
  const entry = JSON.parse(readFileSync(join(dir, `${label}.json`), 'utf8'));
  markReceiptWritten(dir, label, entry);
  events.push('rely on written');
  assert.deepEqual(events, ['rename to box-1.json', 'fsync the directory', 'rely on open', 'rename to box-1.json', 'fsync the directory', 'rely on written']);
  // A directory that cannot be fsynced refuses the new state by name.
  fs.fsyncSync = (fd) => { if (opened.get(fd) === dir) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); return real.fsyncSync(fd); };
  syncBuiltinESMExports();
  assert.throws(() => markReceiptWritten(dir, label, entry), /cannot be made durable \(EIO/);
});

test('a NEW ids directory is durable in its parent before the first label: when the ledger makes box-ids.internal/ (and any missing ancestor), each level it made is fsynced in its parent before the first claim\'s link', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const tmp = await mkdtemp(join(tmpdir(), 'box-ids-durable-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'run', 'box-ids.internal');
  const events = [];
  const opened = new Map();
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync, mkdirSync: fs.mkdirSync };
  const named = (path) => (path === tmp ? 'the run\'s parent' : path === join(tmp, 'run') ? 'run' : path === dir ? 'box-ids.internal' : undefined);
  fs.openSync = (path, ...rest) => { const fd = real.openSync(path, ...rest); opened.set(fd, String(path)); return fd; };
  fs.fsyncSync = (fd) => { const name = named(opened.get(fd)); if (name) events.push(`fsync ${name}`); return real.fsyncSync(fd); };
  fs.mkdirSync = (path, options) => { const made = real.mkdirSync(path, options); if (named(String(path))) events.push(`mkdir ${named(String(path))}`); return made; };
  fs.linkSync = (from, to) => { real.linkSync(from, to); if (!String(to).includes('.probe-')) events.push(`link ${String(to).slice(dir.length + 1)}`); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, real); syncBuiltinESMExports(); });
  events.push(`use ${hostLedger({ dir }).label('alpha', 'alpha-1')}`);
  // run/ and box-ids.internal/ were both made: each is durable in its parent (the run's parent, then run/) before the link.
  assert.deepEqual(events, ['mkdir box-ids.internal', 'fsync the run\'s parent', 'fsync run', 'link box-1.json', 'fsync box-ids.internal', 'use box-1']);
});

test('a NEW ids directory whose parent could not be fsynced stays pending: the first claim is refused by name, and the retry (its mkdir finds the levels made) fsyncs each made level\'s parent BEFORE its first link', async (t) => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const tmp = await mkdtemp(join(tmpdir(), 'box-ids-durable-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'run', 'box-ids.internal');
  const events = [];
  const opened = new Map();
  let failParentOnce = true;
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync };
  const named = (path) => (path === tmp ? 'the run\'s parent' : path === join(tmp, 'run') ? 'run' : path === dir ? 'box-ids.internal' : undefined);
  fs.openSync = (path, ...rest) => { const fd = real.openSync(path, ...rest); opened.set(fd, String(path)); return fd; };
  fs.fsyncSync = (fd) => {
    const name = named(opened.get(fd));
    if (name === 'the run\'s parent' && failParentOnce) { failParentOnce = false; throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); }
    if (name) events.push(`fsync ${name}`);
    return real.fsyncSync(fd);
  };
  fs.linkSync = (from, to) => { real.linkSync(from, to); if (!String(to).includes('.probe-')) events.push(`link ${String(to).slice(dir.length + 1)}`); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, real); syncBuiltinESMExports(); });
  const ledger = hostLedger({ dir });
  assert.throws(() => ledger.label('alpha', 'alpha-1'), /cannot be made durable \(EIO/, 'the first claim is refused: run/ is not yet durable in its parent');
  assert.equal(existsSync(join(dir, 'box-1.json')), false, 'nothing was linked');
  events.length = 0;
  events.push(`use ${ledger.label('alpha', 'alpha-1')}`);
  // The retry's mkdir found both levels made; both are still pending, so both parents are fsynced before the link.
  assert.deepEqual(events, ['fsync the run\'s parent', 'fsync run', 'link box-1.json', 'fsync box-ids.internal', 'use box-1']);
});

/** The ids directory's fsyncs, spied on: `fail(n)` says whether the nth fsync OF THE DIRECTORY (from 1, counted since the last `reset`) fails. */
async function spyDirectoryFsync(t, dir) {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const spy = { events: [], seen: 0, fail: () => false, reset(fail) { this.seen = 0; this.fail = fail; } };
  const opened = new Map();
  const real = { openSync: fs.openSync, fsyncSync: fs.fsyncSync };
  fs.openSync = (path, ...rest) => { const fd = real.openSync(path, ...rest); opened.set(fd, String(path)); return fd; };
  fs.fsyncSync = (fd) => {
    if (opened.get(fd) !== dir) return real.fsyncSync(fd);
    spy.seen += 1;
    if (spy.fail(spy.seen)) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    spy.events.push('fsync the directory');
    return real.fsyncSync(fd);
  };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs, real); syncBuiltinESMExports(); });
  return spy;
}

const labelFiles = (dir) => readdirSync(dir).filter((name) => /^box-\d+\.json$/.test(name)).sort();

test('REUSE (the tools\' label): a label refused because its directory could not be made durable is refused again on the retry that finds it, and once the fsync works the retry is made durable before its use', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'box-ids-durable-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'box-ids.internal');
  const spy = await spyDirectoryFsync(t, dir);
  const ledger = hostLedger({ dir });
  spy.reset(() => true);
  assert.throws(() => ledger.label('alpha', 'alpha-1'), /cannot be made durable/);
  assert.deepEqual(labelFiles(dir), ['box-1.json'], 'the won file stays linked');
  assert.throws(() => ledger.label('alpha', 'alpha-1'), /cannot be made durable/, 'the retry finds box-1 for alpha-1 and is refused too');
  spy.reset(() => false);
  spy.events.push(`use ${ledger.label('alpha', 'alpha-1')}`);
  assert.deepEqual(spy.events, ['fsync the directory', 'use box-1']);
});

test('REUSE (the host key read back): a host key refused because its directory could not be made durable is refused again on the retry that reads it back, BEFORE any label is linked, and once the fsync works the retry is made durable before its use', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'box-ids-durable-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'box-ids.internal');
  const spy = await spyDirectoryFsync(t, dir);
  const ledger = hostLedger({ dir });
  const host = { provider: 'home', key: '0', run: 'life-1' };
  spy.reset(() => true);
  assert.throws(() => ledger.claimHost(host, new Date().toISOString()), /cannot be made durable/);
  assert.throws(() => ledger.claimHost(host, new Date().toISOString()), /cannot be made durable/, 'the retry reads host-0.json back and is refused');
  assert.deepEqual(labelFiles(dir), [], 'refused at the key read back: no label was linked');
  spy.reset(() => false);
  spy.events.push(`use ${ledger.claimHost(host, new Date().toISOString())}`);
  // The key read back is made durable, then the label is claimed and made durable, then used.
  assert.deepEqual(spy.events, ['fsync the directory', 'fsync the directory', 'use box-1']);
});

test('REUSE (the host label): a restarted process of the same life that finds its host label is refused while the directory cannot be made durable, and once the fsync works it is made durable before its use', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'box-ids-durable-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'box-ids.internal');
  const spy = await spyDirectoryFsync(t, dir);
  const host = { provider: 'home', key: '0', run: 'life-1' };
  assert.equal(hostLedger({ dir }).claimHost(host, new Date().toISOString()), 'box-1');
  // The restart: its key read back is made durable (1st fsync); only the label reuse (2nd) fails.
  spy.reset((n) => n === 2);
  assert.throws(() => hostLedger({ dir }).claimHost(host, new Date().toISOString()), /cannot be made durable/, 'the host label reuse is made durable first');
  spy.reset(() => false);
  spy.events.length = 0;
  spy.events.push(`use ${hostLedger({ dir }).claimHost(host, new Date().toISOString())}`);
  assert.deepEqual(spy.events, ['fsync the directory', 'fsync the directory', 'use box-1']);
});

test('(C) HOST_BOX holds provider, key and run and nothing else: any other key (a box id, a credential) is refused by name, never carried silently, and no value is echoed', () => {
  const secret = `sk-${'s'.repeat(12)}`;
  assert.throws(() => parseHostBox(JSON.stringify({ provider: 'home', key: '0', run: 'a', id: 'sb-provider-box-id', token: secret })), (error) => {
    assert.match(error.message, /HOST_BOX/);
    assert.match(error.message, /\bid\b.*\btoken\b|\btoken\b.*\bid\b/);
    assert.equal(error.message.includes(secret) || error.message.includes('sb-provider-box-id'), false, 'no value in the refusal');
    return true;
  });
  assert.deepEqual(parseHostBox(JSON.stringify({ provider: 'home', key: '0', run: 'a' })), { provider: 'home', key: '0', run: 'a' });
});

test('FAIL CLOSED, a null: a host box the place started but no process claimed (every read answers null) refuses the recording at the final read: it is never finished without that box', { timeout: 300_000 }, async (t) => {
  await assert.rejects(run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'unclaimed' }), /host box 0 on home has no label: its child never claimed it/);
});

test('FAIL CLOSED, a throw: a host box whose label the run-file reads cannot read refuses the recording at the final read too: a failed read is no label, never a recording without that box', { timeout: 300_000 }, async (t) => {
  await assert.rejects(run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'unreadable' }), /host box 0 on home has no label: its label cannot be read \(the run files cannot be read here\)/);
});

test('a host box whose label read outlasts the supervisor\'s bound on the final read refuses the recording: a cut-off read is no label, never a recording without that box', { timeout: 300_000 }, async (t) => {
  await assert.rejects(run(t, {}, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'slow' }), /host box 0 on home has no label: the final read did not finish reading it inside its bound/);
});

/** A run of the fixture with `env`, recorded (`--record`, as `run` does) or not: its result or its error. */
async function plantedRun(t, env, record, argv) {
  if (record) return run(t, {}, argv, env).then((done) => ({ result: done.result }), (error) => ({ error }));
  const tmp = await mkdtemp(join(tmpdir(), 'reference-demo-plain-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { writeFileSync } = await import('node:fs');
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  const before = { ...process.env };
  Object.assign(process.env, { DEMO_SPEC: file, ...env });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
  const { demo: fixtureDemo } = await import('@parcha/agentrun-harness');
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  return fixtureDemo({ ...options, argv: [...argv, '--dir', join(tmp, 'run')] }).then((result) => ({ result }), (error) => ({ error }));
}

const PLANTED_KEY = `sk-${'q'.repeat(8)}${'7'.repeat(26)}`;
for (const record of [true, false]) {
  test(`the final-read refusal names a failed process's own text with every credential-shaped line withheld, ${record ? 'with --record' : 'with no recording'}: a key the process printed to its stderr never reaches it, the rest of its text does`, { timeout: 300_000 }, async (t) => {
    const refused = await plantedRun(t, { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'labelled', DEMO_STDERR_SECRET: PLANTED_KEY }, record, ['--json']);
    assert.ok(refused.error, 'the run is refused');
    assert.match(refused.error.message, /host box 0 on home has no label: its child never claimed it \(the run's last process did not complete/);
    assert.equal(refused.error.message.includes(PLANTED_KEY), false, 'the key is not in the refusal');
    assert.match(refused.error.message, /and a plain line after it/, 'the rest of the process\'s text is kept');
  });
}

test('the final-read refusal redacts a value the run TRACKS (a declared key\'s value), with --record, though it has no credential shape: the recording\'s redaction applies there, not only the credential pass', { timeout: 300_000 }, async (t) => {
  const tracked = `plainword${'x'.repeat(14)}`;
  const spec = { keys: [{ env: 'DEMO_TRACKED_TOKEN', why: 'a value the run tracks', where: 'the test', required: false, for: 'live' }] };
  const refused = await run(t, spec, ['--json'], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'labelled', DEMO_TRACKED_TOKEN: tracked, DEMO_STDERR_SECRET: tracked }).then(() => undefined, (error) => error);
  assert.ok(refused, 'the run is refused');
  assert.match(refused.message, /never claimed it \(the run's last process did not complete/);
  assert.equal(refused.message.includes(tracked), false, 'the tracked value is not in the refusal');
  assert.match(refused.message, /and a plain line after it/);
});

test('two supervisors on one run directory are two lives: the second, resuming the run, is refused at its host box\'s claim, never given the first one\'s label', { timeout: 300_000 }, async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-lives-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const dir = join(own, 'run');
  const first = await run(t, {}, ['--json', '--dir', dir], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'labelled' });
  assert.equal(first.result.processes.at(-1).outcome.status, 'complete');
  const life = readIds(join(dir, 'box-ids.internal'))['box-1'].run;
  assert.match(life, /^[0-9a-f-]{36}$/, 'the first life\'s RUN_LABEL');
  const second = await run(t, {}, ['--json', '--dir', dir], { DEMO_PROVIDERS: '1', DEMO_WITH_PLACE: 'labelled' }).catch((error) => ({ error }));
  const said = second.error ? String(second.error.message) : JSON.stringify(second.result.processes.at(-1));
  assert.match(said, /restarted/, 'the second life is refused at its host box');
  assert.equal(readIds(join(dir, 'box-ids.internal'))['box-1'].run, life, 'and box-1 is still the first life\'s');
});

// ---- the review of #833 ------------------------------------------------------------------------------------------------------------------------

const { boxLedger, tapBox: tap } = await import('../packages/harness/dist/boxes.js');
const quiet = { cross: () => false, window: { open: 0 } };
/** The local boxes under a root that are still there (a box's directory, its own state file kept beside it). */
const boxesUnder = (root) => (existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('local-')) : []);

test('a box whose label cannot be saved is destroyed and its create fails: no box is left running with no label and no receipt', async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-unwritable-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(own, 'a-file'), 'not a directory');
  const root = join(own, 'boxes');
  const provider = tap(localBoxes({ root }), { ...quiet, ledger: boxLedger({ dir: join(own, 'a-file', 'ids') }), receipts: true });
  const made = await provider.create({ maxLifetimeMs: 60_000 }, BACKGROUND_CONTEXT);
  assert.equal(made.ok, false, 'the create fails');
  assert.match(made.error.message, /box ids/);
  assert.deepEqual(boxesUnder(root), [], 'and the box it made is destroyed');
});

test('a damaged label file is refused, never read as empty: no label is reused and the box made is destroyed', async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-damaged-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = join(own, 'ids');
  mkdirSync(dir);
  const file = join(dir, 'box-1.json');
  writeFileSync(file, '{"provider": "alpha", "id": "x"');
  const root = join(own, 'boxes');
  const made = await tap(localBoxes({ root }), { ...quiet, ledger: boxLedger({ dir }) }).create({ maxLifetimeMs: 60_000 }, BACKGROUND_CONTEXT);
  assert.equal(made.ok, false);
  assert.match(made.error.message, /box ids .* cannot be read/);
  assert.equal(readFileSync(file, 'utf8'), '{"provider": "alpha", "id": "x"', 'the file is left as it was');
  assert.deepEqual(boxesUnder(root), []);
});

test('a box still open when its process is killed (SIGKILL, no finally) gets its receipt from the next process, once', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { kills: [{ point: 'effect.kept boxes2', why: 'the process dies with the beta box open' }] }, ['--kill', '--json'], { DEMO_PROVIDERS: 'leave' });
  assert.deepEqual(result.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']]);
  const ids = readIds(join(result.dir, 'box-ids.internal'));
  t.after(() => endLeft(result.dir, ids, 'box-2'));
  const kept = receipts(recording);
  assert.deepEqual(kept.map((receipt) => [receipt.box, receipt.to === null, receipt.seconds === null]), [['box-1', false, false], ['box-2', true, true]], 'one receipt each: the ended box\'s from its process, the open one\'s from the next');
});

test('a path whose name starts with two dots is not outside the recording: --box-ids <recording>/..ids.json is refused', async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-dots-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const recording = join(own, 'recording');
  await assert.rejects(run(t, {}, ['--json', '--record', recording, '--box-ids', join(recording, '..ids.json')], { DEMO_PROVIDERS: '1' }), /--box-ids .*inside the recording/);
});

test('the app\'s boxes are closed when its run fails before the result: the receipts of open boxes and the detach run once, and the failure stands', async () => {
  const { closeOnFailure } = await import('../packages/harness/dist/child-app.js');
  let closed = 0;
  const close = async () => { closed += 1; };
  const failing = closeOnFailure(async () => { throw new Error('the drive failed'); }, close);
  await assert.rejects(failing({}), /the drive failed/);
  assert.equal(closed, 1);
  const fine = closeOnFailure(async () => 'done', close);
  assert.equal(await fine({}), 'done');
  assert.equal(closed, 1, 'a run that succeeds is closed by its result, not here');
});

// ---- one labeller run-wide: the place's boxes and the tools' boxes ----------------------------------------------------------------------------


test('two processes claiming labels in one directory at once get distinct labels, none lost: box-1..box-100', { timeout: 120_000 }, async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-race-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const dir = join(own, 'ids');
  const { fork } = await import('node:child_process');
  const claimer = join(own, 'claim.mjs');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(claimer, `const { boxLedger } = await import(${JSON.stringify(new URL('../packages/harness/dist/boxes.js', import.meta.url).href)});
const ledger = boxLedger({ dir: process.argv[2] });
for (let i = 0; i < 50; i += 1) ledger.label(process.argv[3], process.argv[3] + '-' + i);
`);
  await Promise.all(['alpha', 'beta'].map((name) => new Promise((resolve, reject) => fork(claimer, [dir, name]).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`)))))));
  const ids = readIds(dir);
  assert.deepEqual(Object.keys(ids), Array.from({ length: 100 }, (_, i) => `box-${i + 1}`), 'labels 1 to 100, none twice, none skipped');
  assert.equal(new Set(Object.values(ids).map((entry) => `${entry.provider}:${entry.id}`)).size, 100, 'every claimed box once');
});

test('an ids directory a place made beforehand is used as it is, and one that takes no files (ENOENT, though it exists: an Archil directory made by path) is refused by name', async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-premade-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const made = join(own, 'made');
  fs.mkdirSync(made, { mode: 0o755 });
  assert.equal(boxLedger({ dir: made }).label('alpha', 'one'), 'box-1', 'a directory already there takes claims');
  fs.writeFileSync(join(own, 'ids.json'), '{}');
  assert.throws(() => boxLedger({ dir: join(own, 'ids.json') }).label('alpha', 'one'), /ids\.json is a file: --box-ids names a directory/, 'a path that is a file is refused by name');
  const bare = join(own, 'bare');
  fs.mkdirSync(bare);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (path, ...rest) => {
    if (String(path).startsWith(`${bare}/`)) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' });
    return open(path, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => boxLedger({ dir: bare }).label('alpha', 'one'), /bare\/ cannot take files: on a disk place it must be made by the place, not by path/);
});
