// The reference entry as a demo's platform (item A of the entry brief): the spec's kills list through the supervisor (a named crossing, a storm, a box kind),
// --input, --max-usd, the browser choice, and the box the job's tools run in. The demo here is the reference job itself, started through demo-fixture.ts.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { chooseBrowser, demo, killsOf, maxUsdOf, parseInput, plansOf } from './reference/index.ts';

const FIXTURE = new URL('./reference/demo-fixture.ts', import.meta.url).href;

async function run(t, spec, argv, env = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-demo-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', ...spec }));
  const before = { ...process.env };
  Object.assign(process.env, { DEMO_SPEC: file, ...env });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
  // The supervisor is this process; it starts the fixture as each child.
  const { demo: fixtureDemo } = await import('./reference/demo.ts');
  const { fakes: scripted, job } = await import('./reference/job.ts');
  const judgeCost = Number(env.DEMO_JUDGE_COST ?? 0);
  const fakes = judgeCost ? { ...scripted, judge: async (request) => ({ ...(await scripted.judge(request)), cost_usd: judgeCost }) } : scripted;
  const recording = join(tmp, 'recording');
  const result = await fixtureDemo({ self: FIXTURE, spec: JSON.parse(readFileSync(file, 'utf8')), job, fakes, argv: ['--record', recording, ...argv] });
  return { result, recording, tmp };
}

test('the spec\'s kills are a list: a named crossing and a storm, in order, each ending one process, and the run finishes with nothing paid twice', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { kills: [{ point: 'judge.asked verdict', why: 'the judge is the call a kill would cost most' }, { storm: { kills: 2, gapMs: 0 } }] }, ['--kill', '--json']);
  assert.deepEqual(result.processes.map((process) => process.signal), ['SIGKILL', 'SIGKILL', 'SIGKILL', null]);
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(result.kills.map((kill) => [kill.gen, kill.kind]), [[1, 'process'], [2, 'process'], [3, 'process']]);
  assert.equal(result.kills[0].point, 'judge.asked verdict', 'the first kill landed on the crossing it named');
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  const killLines = lines.filter((line) => line.source === 'host' && line.kind === 'kill');
  assert.equal(killLines.length, 3);
  assert.deepEqual(killLines.map((line) => line.data.kind), ['process', 'process', 'process']);
  assert.equal(killLines[0].data.crossing.point, 'judge.asked verdict');
  const counted = fold(lines);
  assert.deepEqual([counted.processes, counted.kills, counted.unknown], [4, 3, 0]);
  assert.equal(JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')).kills, 3);
});

test('a kill of kind box is written as a box kill, and the process\'s box is taken away with it', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { boxes: { kind: 'local' }, kills: [{ point: 'judge.asked verdict', why: 'the machine goes with the process', kind: 'box' }] }, ['--kill', '--json']);
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.deepEqual(result.kills.map((kill) => kill.kind), ['box']);
  const kill = readEvents(recording).find((line) => line.source === 'host' && line.kind === 'kill');
  assert.equal(kill.data.kind, 'box');
  assert.deepEqual(validateRecording(recording), []);
});

test('--input replaces the job\'s input, from inline JSON or a file, and the default stays when it is absent', { timeout: 300_000 }, async (t) => {
  const inline = await run(t, {}, ['--json', '--input', '{"company":"Beta Ltd"}']);
  assert.equal(inline.result.record.company, 'Beta Ltd');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-input-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, 'in.json'), '{"company":"Gamma Ltd"}');
  const file = await run(t, {}, ['--json', '--input', join(tmp, 'in.json')]);
  assert.equal(file.result.record.company, 'Gamma Ltd');
  const plain = await run(t, {}, ['--json']);
  assert.equal(plain.result.record.company, 'Acme Ltd');
  assert.throws(() => parseInput('[1]', () => ''), /JSON object/);
  assert.throws(() => parseInput('/no/such/file', () => { throw new Error('ENOENT'); }), /ENOENT/);
  assert.throws(() => parseInput('{ nope', () => ''), /--input is a path/);
});

test('--max-usd: the default is twice expectedCost, and a run past the cap is stopped and says so', { timeout: 300_000 }, async (t) => {
  assert.equal(maxUsdOf(undefined, { name: 'x', expectedCost: 0.25 }), 0.5);
  assert.equal(maxUsdOf(undefined, { name: 'x' }), null);
  assert.equal(maxUsdOf('1.5', { name: 'x', expectedCost: 9 }), 1.5);
  assert.throws(() => maxUsdOf('-1', { name: 'x' }), /number of dollars/);
  assert.throws(() => maxUsdOf('lots', { name: 'x' }), /number of dollars/);
  // The reference job's judge costs nothing; a demo whose judge costs 0.30 is over a 0.10 cap at the end of its run.
  const { result, recording } = await run(t, { expectedCost: 0.05 }, ['--json'], { DEMO_JUDGE_COST: '0.3' });
  assert.equal(result.maxUsd, 0.1);
  assert.equal(result.usd, 0.3);
  assert.equal(result.overBudget, true);
  assert.deepEqual(validateRecording(recording), []);
  const within = await run(t, { expectedCost: 1 }, ['--json'], { DEMO_JUDGE_COST: '0.3' });
  assert.equal(within.result.overBudget, false);
});

test('the browser: Browserbase when its key is set, else a local Chrome only when asked for and only live; fakes use the fake', () => {
  assert.equal(chooseBrowser({ live: false, env: {}, localChrome: false }), 'fake');
  assert.equal(chooseBrowser({ live: true, env: { BROWSERBASE_API_KEY: 'x' }, localChrome: false }), 'browserbase');
  assert.equal(chooseBrowser({ live: true, env: { BB_API_KEY: 'x', CHROME_PATH: '/c' }, localChrome: true }), 'browserbase', 'Browserbase wins when its key is set');
  assert.equal(chooseBrowser({ live: true, env: { CHROME_PATH: '/c' }, localChrome: true }), 'chrome');
  assert.throws(() => chooseBrowser({ live: true, env: {}, localChrome: true }), /CHROME_PATH/);
  assert.throws(() => chooseBrowser({ live: true, env: { CHROME_PATH: '/c' }, localChrome: false }), /shows your address/, 'a local Chrome on real pages is never chosen for you');
});

test('the kills a spec asks for are checked: the template\'s single kill is a list of one, a storm of N is N plans, and a bad entry is refused', () => {
  assert.deepEqual(killsOf({ name: 'x', kill: { point: 'a', why: 'b' } }), [{ point: 'a', why: 'b' }]);
  assert.deepEqual(plansOf(killsOf({ name: 'x', kills: [{ point: 'a', why: 'b', kind: 'box' }, { storm: { kills: 2, gapMs: 5 } }] })).map((plan) => [plan.kind, 'storm' in plan ? plan.gapMs : plan.point]), [['box', 'a'], ['process', 5], ['process', 5]]);
  assert.throws(() => killsOf({ name: 'x', kills: [{ point: '', why: 'b' }] }), /names a point/);
  assert.throws(() => killsOf({ name: 'x', kills: [{ storm: { kills: 0, gapMs: 1 } }] }), /positive integer/);
  assert.throws(() => killsOf({ name: 'x', kills: [{ point: 'a', why: 'b', kind: 'machine' }] }), /"process" or "box"/);
});

test('--live is refused by a demo that supplies no live parts', { timeout: 60_000 }, async (t) => {
  await assert.rejects(() => run(t, {}, ['--live']), /supplies no live parts|needs a browser/);
});
