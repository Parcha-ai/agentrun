// Tool-made boxes on the demo's own providers (`DemoOptions.providers`): the harness taps them, so a recording holds every box a run's tools made, by label.
// The lines are RECORDING.md's (draft 39): `box.created` { box, provider, facts, role? }, `box.exec` { box } per command, `box.ended` { box }, all live lines with source `transport` and
// a `box-N` label, never a provider id; one host `box.receipt` per box with no rate (`usd_per_second`, `cost_usd`, `source` and `priced` null), so the run's cost reads unknown.
// The provider ids go only to a file outside the recording (`--box-ids`, default `<run dir>/box-ids.internal.json`).
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
import { transportPanel } from '../apps/viewer/src/transport.ts';
import { localBoxes, run } from './reference-demo-helpers.mjs';

const transport = (recording) => readEvents(recording).filter((line) => line.source === 'transport' && line.channel === 'live');
const receipts = (recording) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'box.receipt').map((line) => line.data);
/** Every file under a folder, as latin1 text. */
const everyFile = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(join(entry.parentPath, entry.name), 'latin1'));
const NO_RATE = { usd_per_second: null, cost_usd: null, source: null, priced: null };
/** The boxes the providers' tool answered, from the run's kept answers. */
const answered = (dir) => readdirSync(join(dir, 'answers')).map((name) => JSON.parse(readFileSync(join(dir, 'answers', name), 'utf8')).value).find((value) => value && 'alpha' in value && 'beta' in value);
/** Ends a box a run left, by the id the ids file names, so a test leaves nothing running. */
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

test('no provider id is in the recording: the ids are in the run directory\'s box-ids.internal.json, outside the recording, by label', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: '1' });
  const file = join(result.dir, 'box-ids.internal.json');
  assert.ok(existsSync(file), 'the ids file is in the run directory');
  assert.ok(relative(realpathSync(recording), realpathSync(file)).startsWith('..'), 'and outside the recording');
  const ids = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(ids), ['box-1', 'box-2']);
  assert.deepEqual([ids['box-1'].provider, ids['box-2'].provider], ['alpha', 'beta']);
  const recorded = everyFile(recording).join('\n');
  for (const { id } of Object.values(ids)) {
    assert.ok(id.length > 4);
    assert.ok(!recorded.includes(id) && !recorded.includes(JSON.stringify(id).slice(1, -1)), `the id of a box is in no file of the recording: ${id}`);
  }
});

test('--box-ids names the ids file: a path outside the recording is used, and one inside it is refused', { timeout: 300_000 }, async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const outside = join(own, 'ids.json');
  const { result } = await run(t, {}, ['--json', '--box-ids', outside], { DEMO_PROVIDERS: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(outside, 'utf8'))), ['box-1', 'box-2']);
  assert.ok(!existsSync(join(result.dir, 'box-ids.internal.json')), 'the default file is not written as well');
  // The last --record wins: this run records into a directory the test knows, and is asked to put the ids inside it.
  const recording = join(own, 'recording');
  await assert.rejects(run(t, {}, ['--json', '--record', recording, '--box-ids', join(recording, 'ids.json')], { DEMO_PROVIDERS: '1' }), /--box-ids .*inside the recording/);
});

test('a box still open when the run ends gets its receipt then, with no end and no seconds', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: 'leave' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  const ids = JSON.parse(readFileSync(join(result.dir, 'box-ids.internal.json'), 'utf8'));
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
  // No --box-ids: the default, box-ids.internal.json in the run's directory, would be inside the recording.
  await assert.rejects(run(t, {}, ['--json', '--record', recording, '--dir', join(recording, 'run')], { DEMO_PROVIDERS: '1' }), /box-ids\.internal\.json.* inside the recording/);
  await assert.rejects(run(t, {}, ['--json', '--record', join(own, 'same'), '--dir', join(own, 'same')], { DEMO_PROVIDERS: '1' }), /box-ids\.internal\.json.* inside the recording/);
});

test('a box still open when the result hook throws gets its receipt all the same, with no end and no seconds', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_PROVIDERS: 'leave', DEMO_RESULT_THROWS: '1' });
  assert.notEqual(result.processes.at(-1).outcome.status, 'complete', 'the result hook failed the process');
  const ids = JSON.parse(readFileSync(join(result.dir, 'box-ids.internal.json'), 'utf8'));
  t.after(() => endLeft(result.dir, ids, 'box-2'));
  const kept = receipts(recording);
  assert.deepEqual(kept.map((receipt) => [receipt.box, receipt.to === null, receipt.seconds === null]), [['box-1', false, false], ['box-2', true, true]]);
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
  const provider = tap(localBoxes({ root }), { ...quiet, ledger: boxLedger({ file: join(own, 'a-file', 'ids.json') }), receipts: true });
  const made = await provider.create({ maxLifetimeMs: 60_000 }, BACKGROUND_CONTEXT);
  assert.equal(made.ok, false, 'the create fails');
  assert.match(made.error.message, /box ids/);
  assert.deepEqual(boxesUnder(root), [], 'and the box it made is destroyed');
});

test('a damaged ids file is refused, never read as empty: no label is reused and the box made is destroyed', async (t) => {
  const own = await mkdtemp(join(tmpdir(), 'box-ids-damaged-'));
  t.after(() => rm(own, { recursive: true, force: true }));
  const { writeFileSync } = await import('node:fs');
  const file = join(own, 'ids.json');
  writeFileSync(file, '{"box-1": {"provider": "alpha", "id": "x"');
  const root = join(own, 'boxes');
  const made = await tap(localBoxes({ root }), { ...quiet, ledger: boxLedger({ file }) }).create({ maxLifetimeMs: 60_000 }, BACKGROUND_CONTEXT);
  assert.equal(made.ok, false);
  assert.match(made.error.message, /box ids file .* cannot be read/);
  assert.equal(readFileSync(file, 'utf8'), '{"box-1": {"provider": "alpha", "id": "x"', 'the file is left as it was');
  assert.deepEqual(boxesUnder(root), []);
});

test('a box still open when its process is killed (SIGKILL, no finally) gets its receipt from the next process, once', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { kills: [{ point: 'effect.kept boxes2', why: 'the process dies with the beta box open' }] }, ['--kill', '--json'], { DEMO_PROVIDERS: 'leave' });
  assert.deepEqual(result.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']]);
  const ids = JSON.parse(readFileSync(join(result.dir, 'box-ids.internal.json'), 'utf8'));
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
