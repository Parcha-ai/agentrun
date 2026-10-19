// the demo CLI: the kills list, --input, --max-usd, the browser choice, the boxes capability and the spec.
// One of the files the reference entry's demo tests are split into (each under about two minutes serial on CI); the shared helpers are in reference-demo-helpers.mjs.
// The reference entry as a demo's platform (item A of the entry brief): the spec's kills list through the supervisor (a named crossing, a storm, a box kind),
// --input, --max-usd, the browser choice, and the box the job's tools run in. The demo here is the reference job itself, started through demo-fixture.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { effectiveBoxes } from '../packages/harness/dist/demo-spec.js';
import { BOX_CROSSINGS, localPlace, capJudge, chooseBrowser, crossings, demo, tapBox, JEV_CAPS, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from '@parcha/agentrun-harness';
import { ORIGINAL, FIXTURE, BASELINE, run, composeHost, destroyBoxes, meterKnown, RUN_LABEL, localBoxes, ctx, finish, lines, planFor, recordingPlace, specWith, SITES, signInHome, filesIn, killSpec, boxed } from './reference-demo-helpers.mjs';

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
  // A run still going when it passes the cap is stopped: the judge's 0.30 is on the recording, the next step lingers 20 s, and the supervisor ends the process
  // long before, writes the kill (label max-usd) and does not resume it.
  const started = Date.now();
  const stopped = await run(t, { expectedCost: 0.05 }, ['--json'], { DEMO_JUDGE_COST: '0.3', DEMO_LINGER_MS: '20000' });
  assert.ok(Date.now() - started < 15_000, 'the run was stopped, not waited out');
  assert.equal(stopped.result.overBudget, true);
  assert.deepEqual(stopped.result.processes.map((process) => process.signal), ['SIGKILL']);
  assert.deepEqual(stopped.result.kills.map((kill) => kill.why), ['past --max-usd 0.1']);
  assert.equal(readEvents(stopped.recording).find((line) => line.source === 'host' && line.kind === 'kill').data.label, 'max-usd');
  assert.deepEqual(validateRecording(stopped.recording), []);
});
test('the browser: Browserbase only when its key pair is set, else a local Chrome only when asked for and only live; a half pair is named, never used; fakes use the fake', () => {
  const pair = { BROWSERBASE_API_KEY: 'x', BROWSERBASE_PROJECT_ID: 'p' };
  assert.equal(chooseBrowser({ live: false, env: {}, localChrome: false }), 'fake');
  assert.equal(chooseBrowser({ live: true, env: pair, localChrome: false }), 'browserbase');
  assert.equal(chooseBrowser({ live: true, env: { BB_API_KEY: 'x', BROWSERBASE_PROJECT_ID: 'p' }, localChrome: false }), 'browserbase', 'the alias of the key counts');
  assert.equal(chooseBrowser({ live: true, env: { ...pair, CHROME_PATH: '/c' }, localChrome: true }), 'browserbase', 'the pair wins over a local Chrome');
  assert.equal(chooseBrowser({ live: true, env: { CHROME_PATH: '/c' }, localChrome: true }), 'chrome');
  assert.throws(() => chooseBrowser({ live: true, env: {}, localChrome: true }), /CHROME_PATH/);
  assert.throws(() => chooseBrowser({ live: true, env: { CHROME_PATH: '/c' }, localChrome: false }), /shows your address/, 'a local Chrome on real pages is never chosen for you');
  // A half pair is not a provider that fails later: it is not chosen, and it is named.
  assert.throws(() => chooseBrowser({ live: true, env: { BROWSERBASE_API_KEY: 'x' }, localChrome: false }), /Only BROWSERBASE_API_KEY is set: Browserbase needs BROWSERBASE_PROJECT_ID too/);
  assert.throws(() => chooseBrowser({ live: true, env: { BROWSERBASE_PROJECT_ID: 'p' }, localChrome: false }), /Only BROWSERBASE_PROJECT_ID is set: Browserbase needs BROWSERBASE_API_KEY too/);
  assert.equal(chooseBrowser({ live: true, env: { BROWSERBASE_API_KEY: 'x', CHROME_PATH: '/c' }, localChrome: true }), 'chrome', 'a half pair with a local Chrome asked for is the local Chrome');
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
test('a kill\'s n picks the nth time the crossing is taken: the third node start lands later in the process than the second', { timeout: 300_000 }, async (t) => {
  const at = async (n) => {
    const { result, recording } = await run(t, { kills: [{ point: 'event workflow.node.start', why: `node start ${n}`, n }] }, ['--kill', '--json']);
    assert.equal(result.processes.at(-1).outcome.status, 'complete');
    return readEvents(recording).find((line) => line.source === 'host' && line.kind === 'kill').data.crossing;
  };
  const [second, third] = [await at(2), await at(3)];
  assert.equal(second.point, 'event workflow.node.start');
  assert.ok(third.n > second.n, `the third (crossing ${third.n}) is after the second (${second.n})`);
});
test('a storm takes no crossing before the process has begun its first node, and a named point is taken as named', (t) => {
  const kills = [];
  const real = process.kill;
  process.kill = (pid, signal) => { kills.push(signal); return true; };
  t.after(() => { process.kill = real; });
  const storm = { run: { storm: true, gapMs: 0, kind: 'process', target: 'run', why: 'storm 1 of 1' }, tools: [] };
  const cross = crossings(storm, undefined);
  cross('event browser.reconciled'); cross('model.request turn 0');
  assert.deepEqual(kills, [], 'nothing before the first node starts');
  cross('event workflow.node.start');
  assert.deepEqual(kills, [], 'the start of the first node is not itself a storm kill point');
  cross('model.request turn 0');
  assert.deepEqual(kills, ['SIGKILL'], 'the first crossing after it is');
  // A named point earlier than any node start is still taken as named.
  kills.length = 0;
  const named = crossings({ run: { point: 'event browser.reconciled', kind: 'process', target: 'run', why: 'named', n: 1 }, tools: [] }, undefined);
  named('event browser.reconciled');
  assert.deepEqual(kills, ['SIGKILL']);
});
test('a kill that never lands is reported, not hidden: the process finished without taking the crossing', { timeout: 300_000 }, async (t) => {
  const { result } = await run(t, { kills: [{ point: 'no.such.point', why: 'a point this demo never takes' }] }, ['--kill', '--json']);
  assert.deepEqual(result.unlanded, ['no.such.point']);
  assert.deepEqual(result.kills, []);
});
test('a tool kill that never fires is reported though its attempt ended in a process kill: it is not carried off with the attempt', { timeout: 300_000 }, async (t) => {
  const { result } = await run(t, { kills: [{ point: 'judge.asked verdict', why: 'the run kill that does land' }, { point: 'no.such.point', why: 'a tool kill at a point never taken', target: 'tool' }] }, ['--kill', '--json']);
  assert.equal(result.kills.length, 1, 'the run kill landed');
  assert.deepEqual(result.unlanded, ['no.such.point'], 'and the tool kill that did not is reported');
});
test('--max-usd compares what is known: an unknown price elsewhere does not switch the cap off', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-meter-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  mkdirSync(join(tmp, '.spool'), { recursive: true });
  const durable = (data) => JSON.stringify({ channel: 'durable', source: 'pi', kind: 'x', gen: 1, t: 1, commit: 1, order: 0, data });
  writeFileSync(join(tmp, '.spool', 'durable-1.jsonl'), [
    durable({ doc: 'agentrun.decisions', value: { receipts: [{ decision_id: 'd1', run_key: 'r', cost_usd: 0.5 }] } }),
    durable({ model: [{ role: 'assistant', usage: { cost: {} } }] }),
  ].join('\n') + '\n');
  assert.equal(meterKnown(tmp), 0.5, 'the priced decision counts, though the model\'s cost is unknown');
});
test('hold: the nth filing and those after it are parked until `hold` are parked or waitMs has passed, then the kill; without a hold the kill is at the crossing', (t) => {
  const kills = [];
  const make = (plan) => crossings({ run: plan, tools: [] }, undefined, Date.now(), (crossing) => kills.push(crossing.point));
  const plan = (extra) => ({ point: 'vision.filing', kind: 'process', target: 'run', why: 'x', n: 1, ...extra });
  // hold 3: three filings are parked, and the kill comes with the third.
  const held = make(plan({ hold: 3, waitMs: 60_000 }));
  for (let index = 0; index < 3; index += 1) { held('vision.filing'); assert.ok(held.park('vision.filing') instanceof Promise, `filing ${index + 1} is parked`); }
  assert.deepEqual(kills, ['vision.filing'], 'one kill, once the third is parked');
  // The point alone does not kill a plan that holds: the kill is the park\'s.
  kills.length = 0;
  const alone = make(plan({ hold: 2, waitMs: 60_000 }));
  alone('vision.filing');
  assert.deepEqual(kills, []);
  assert.equal(alone.park('vision.other'), undefined, 'another point is never parked');
  // n: the filings before the nth go through.
  const later = make(plan({ hold: 1, n: 2, waitMs: 60_000 }));
  later('vision.filing'); assert.equal(later.park('vision.filing'), undefined, 'the first filing is not parked');
  later('vision.filing'); assert.ok(later.park('vision.filing') instanceof Promise, 'the second is');
  assert.deepEqual(kills, ['vision.filing']);
  // waitMs: fewer than hold are parked, and the kill comes when the wait is over.
  kills.length = 0;
  const waiting = make(plan({ hold: 5, waitMs: 30 }));
  waiting('vision.filing'); waiting.park('vision.filing');
  assert.deepEqual(kills, []);
  return new Promise((resolve) => setTimeout(() => { assert.deepEqual(kills, ['vision.filing']); resolve(); }, 120));
});
test('a kill spec checks hold and waitMs, and the plan carries them (waitMs defaults to 3000)', () => {
  assert.deepEqual(plansOf(killsOf({ name: 'x', kills: [{ point: 'vision.filing', why: 'y', hold: 6 }] })).map((plan) => [plan.hold, plan.waitMs]), [[6, 3000]]);
  assert.throws(() => killsOf({ name: 'x', kills: [{ point: 'a', why: 'b', hold: 0 }] }), /hold is a positive integer/);
  assert.throws(() => killsOf({ name: 'x', kills: [{ point: 'a', why: 'b', hold: 2, waitMs: -1 }] }), /waitMs is 0 or more/);
  assert.throws(() => killsOf({ name: 'x', kills: [{ point: 'a', why: 'b', hold: 2, target: 'tool' }] }), /does not go with target "tool"/);
});
test('ToolContext.live: false on a no-key run, true when the host is live, so one set of tools reads live or replays a capture', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-live-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('@parcha/agentrun-harness');
  const seen = [];
  for (const live of [false, true]) {
    const place = await placeAt(join(tmp, String(live)));
    const local = localHost(place, { model: () => { throw new Error('unused'); }, tools: { look: (_args, context) => { seen.push(context.live); return {}; } }, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' }, { live });
    await local.host.tools.runEffect({ node: { tool: 'look' }, input: {}, effect: { id: `e${live}`, argsHash: 'h' } });
  }
  assert.deepEqual(seen, [false, true]);
});
test('boxes on fakes are local, and Docker is used only with --live: a no-key run starts no container', async (t) => {
  assert.deepEqual(effectiveBoxes({ name: 'x', boxes: { kind: 'docker', image: 'i', runIn: true } }, false), { kind: 'local', image: 'i', runIn: true });
  assert.deepEqual(effectiveBoxes({ name: 'x', boxes: { kind: 'docker' } }, true), { kind: 'docker' });
  assert.equal(effectiveBoxes({ name: 'x' }, false), undefined);
  const { result, recording } = await run(t, { boxes: { kind: 'docker', runIn: true } }, ['--json']);
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const created = readEvents(recording).filter((line) => line.source === 'transport' && line.kind === 'box.created').map((line) => line.data.provider);
  assert.deepEqual(created, ['local'], 'the box was a local one');
});
test('fakes.extensions are for a no-key run: a live host does not install them', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-live-ext-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('@parcha/agentrun-harness');
  const scripted = { name: 'scripted', tools: [] };
  const fakes = { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank', extensions: [scripted] };
  assert.deepEqual(localHost(await placeAt(join(tmp, 'a')), fakes, { live: false }).host.tools.extensions, [scripted]);
  assert.deepEqual(localHost(await placeAt(join(tmp, 'b')), fakes, { live: true }).host.tools.extensions, []);
});
test('the model flags reach the demo\'s live part, and are refused without --live or a model with a provider', { timeout: 300_000 }, async (t) => {
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }];
  const keys = [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }]];
  const browser = Object.fromEntries(['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  const { result } = await run(t, { keys, programs }, ['--json', '--live', '--provider', 'openai', '--model', 'gpt-6', '--eyes-model', 'gemini-4'], { DEMO_LIVE_PROBE: '1', ...browser });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(JSON.parse(readFileSync(join(result.dir, 'models-seen.json'), 'utf8')), { provider: 'openai', model: 'gpt-6', eyesModel: 'gemini-4' });
  await assert.rejects(() => run(t, {}, ['--json', '--model', 'gpt-6']), /need --live/);
  await assert.rejects(() => run(t, { keys, programs }, ['--json', '--live', '--provider', 'openai'], { DEMO_LIVE_PROBE: '1', ...browser }), /--provider needs --model/);
});
test('a kill\'s where: only a crossing whose info has those values counts, and n is the nth matching one', async (t) => {
  const kills = [];
  const real = process.kill;
  process.kill = (pid, signal) => { kills.push(signal); return true; };
  t.after(() => { process.kill = real; });
  const tmp = await mkdtemp(join(tmpdir(), 'reference-where-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const log = join(tmp, 'cross.jsonl');
  const [plan] = plansOf(killsOf({ name: 'x', kills: [{ point: 'transport.tool.started', where: { tool: 'install' }, why: 'the install step' }] }));
  assert.deepEqual(plan.where, { tool: 'install' });
  const cross = crossings({ run: plan, tools: [] }, log);
  cross('transport.tool.started', { info: { tool: 'fetch' } });
  cross('transport.tool.started');
  assert.deepEqual(kills, [], 'other tools and a crossing without info are not it');
  cross('transport.tool.started', { info: { tool: 'install' } });
  assert.deepEqual(kills, ['SIGKILL'], 'the install step is');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line).info), [{ tool: 'fetch' }, undefined, { tool: 'install' }], 'the crossing log records the info');
  // With n: the second install, not the second crossing.
  kills.length = 0;
  const second = crossings({ run: { ...plan, n: 2 }, tools: [] }, undefined);
  for (const tool of ['install', 'fetch', 'fetch']) second('transport.tool.started', { info: { tool } });
  assert.deepEqual(kills, []);
  second('transport.tool.started', { info: { tool: 'install' } });
  assert.deepEqual(kills, ['SIGKILL']);
  // A matching crossing inside an open tool call is not a time at all, as for any run kill.
  kills.length = 0;
  const window = { open: 1 };
  const guarded = crossings({ run: plan, tools: [] }, undefined, Date.now(), undefined, window);
  guarded('transport.tool.started', { info: { tool: 'install' } });
  assert.deepEqual(kills, []);
  window.open = 0;
  guarded('transport.tool.started', { info: { tool: 'install' } });
  assert.deepEqual(kills, ['SIGKILL']);
  // A tool box takes where too.
  const box = crossings({ run: undefined, tools: [{ point: 'transport.box.exec', kind: 'box', why: 'x', target: 'tool', n: 1, where: { tool: 'install' } }] }, undefined);
  assert.equal(box('transport.box.exec', { info: { tool: 'fetch' } }), false);
  assert.equal(box('transport.box.exec', { info: { tool: 'install' } }), true);
  for (const where of [{}, [], 'install', { tool: {} }, { tool: null }]) assert.throws(() => killsOf({ name: 'x', kills: [{ point: 'p', why: 'w', where }] }), /where is an object/);
  assert.throws(() => killsOf({ name: 'x', kills: [{ storm: { kills: 1, gapMs: 0 }, where: { tool: 'x' } }] }), /storm has no where/);

});
test('a run is keyed by a fresh id that starts with its demo\'s name (the place\'s paths.id), so two demos never share a run', { timeout: 300_000 }, async (t) => {
  const { readJournal } = await import('@parcha/agentrun-pi/durable');
  const { RUN_KEY } = await import('@parcha/agentrun-harness');
  const parent = await mkdtemp(join(tmpdir(), 'reference-keyed-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const name of ['alpha-demo', 'beta-demo']) {
    const dir = join(parent, name);
    const { result } = await run(t, { name }, ['--json', '--dir', dir]);
    assert.equal(result.processes.at(-1).outcome.status, 'complete');
    const file = join(dir, 'store', 'run.sqlite');
    assert.match(result.runId, new RegExp(`^${name}-[0-9a-f]{8}$`));
    assert.ok(readJournal(file, result.runId)?.binding, `${name}'s journal is under its own run id`);
    assert.equal(readJournal(file, name), undefined, 'and not under the bare name');
    assert.equal(readJournal(file, RUN_KEY), undefined, `nothing is kept under the fixed key ${RUN_KEY}`);
  }
});
test('every order a place is handed carries the demo\'s entry module and name in its env (start and recover alike), so a demo\'s run.ts needs no wrapper', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-order-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'order-demo', kills: [{ point: 'judge.asked verdict', why: 'to make a recover' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const orders = [];
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, start: (order) => { orders.push(['start', order.env]); return inner.start(order); }, recover: (last, kind, order) => { orders.push(['recover', order.env]); return inner.recover(last, kind, order); } };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(orders.map(([how]) => how), ['start', 'recover']);
  for (const [how, env] of orders) {
    assert.equal(env.DEMO_ENTRY, options.self, `${how}: the demo's entry module`);
    assert.equal(env.DEMO_NAME, 'order-demo', `${how}: the demo's name`);
  }
});
test('one fresh run id per invocation, shared by its processes: a second run of one demo on a shared disk finds none of the first\'s signals, and the manifest is written before the place is released', { timeout: 300_000 }, async (t) => {
  const shared = await mkdtemp(join(tmpdir(), 'reference-shared-disk-'));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const { options } = await killSpec(t);
  const { localPlace } = await import('@parcha/agentrun-harness');
  const seen = [];
  const released = [];
  const invoke = async (name) => {
    const recording = join(shared, `recording-${name}`);
    const ids = new Set();
    const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording, '--dir', join(shared, `run-${name}`)], place: ({ paths, self, destroyBoxes }) => {
      // A shared disk: every run\'s signals are under one directory, by run id (paths.id), and a release deletes the run\'s tree.
      const requestFile = (attempt) => join(shared, 'signals', paths.id, `kill-${attempt}.json`);
      mkdirSync(join(shared, 'signals', paths.id), { recursive: true });
      const inner = localPlace({ self, paths, destroyBoxes, requestFile });
      return {
        ...inner,
        start: (order) => { ids.add(order.env.RUN_ID); return inner.start(order); },
        recover: (last, kind, order) => { ids.add(order.env.RUN_ID); return inner.recover(last, kind, order); },
        release: async () => { released.push({ name, manifestFirst: existsSync(join(recording, 'manifest.json')) }); rmSync(join(shared, 'signals', paths.id), { recursive: true, force: true }); },
      };
    } });
    assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
    assert.equal(ids.size, 1, 'the same run id across the invocation\'s processes (a kill and its resume)');
    assert.deepEqual([...ids], [result.runId]);
    assert.match(result.runId, /^reference-[0-9a-f]{8}$/);
    seen.push(result.runId);
    return recording;
  };
  const first = await invoke('first');
  const second = await invoke('second');
  assert.notEqual(seen[0], seen[1], 'a second run of one demo has its own run id');
  assert.deepEqual(released.map((entry) => entry.manifestFirst), [true, true], 'the manifest is written before the place releases (a release may delete the run tree)');
  const kills = (recording) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'kill').length;
  assert.deepEqual([kills(first), kills(second)], [1, 1], 'each run made its own kill');
  assert.equal(readEvents(second).filter((line) => line.kind === 'kill.request.ignored').length, 0, 'the second run saw none of the first\'s signals');
});
// ---- browser: false ----------------------------------------------------------------------------------------------------------------------------

test('browser:false creates no browser, live or on fakes: --live needs no Browserbase key and no Chrome, and the agent is offered no browser tool, so a page call is answered as one that is not available; the default is unchanged', { timeout: 300_000 }, async (t) => {
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }];
  const none = { BROWSERBASE_API_KEY: '', BB_API_KEY: '', BROWSERBASE_PROJECT_ID: '', CHROME_PATH: '' };
  // Live, with no browser key and no Chrome anywhere: the default asks for one.
  await assert.rejects(() => run(t, { programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', ...none }), /A live run needs a browser/);
  const live = await run(t, { programs, browser: false }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', ...none });
  assert.equal(live.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(live.result.processes.at(-1)));
  // The page call the reference lead makes reached no browser: none is installed, so pi answers that the tool is not available.
  const said = (recording) => readFileSync(join(recording, 'events.jsonl'), 'utf8').includes('Tool run is not available');
  assert.ok(said(live.recording), 'the page call is answered as a tool the run does not offer, not a missing key');
  // On fakes: no browser either.
  const fakes = await run(t, { browser: false }, ['--json'], { DEMO_LIVE_PROBE: '' });
  assert.ok(said(fakes.recording));
  assert.ok(!said((await run(t, {}, ['--json'], { DEMO_LIVE_PROBE: '' })).recording), 'the default still has its fake browser');
});
