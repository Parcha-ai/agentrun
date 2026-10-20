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
  assert.deepEqual(lines.filter(([kind]) => kind === 'box.created'), [
    ['box.created', { box: 'box-1', provider: 'alpha', facts: { isolation: 'none', cpus: null, gpu: null }, role: 'worker' }],
    ['box.created', { box: 'box-2', provider: 'beta', facts: { isolation: 'none', cpus: null, gpu: null } }],
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
