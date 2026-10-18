// The reference entry as a demo's platform (item A of the entry brief): the spec's kills list through the supervisor (a named crossing, a storm, a box kind),
// --input, --max-usd, the browser choice, and the box the job's tools run in. The demo here is the reference job itself, started through demo-fixture.ts.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { effectiveBoxes } from './reference/demo-spec.ts';
import { BOX_CROSSINGS, localPlace, capJudge, chooseBrowser, crossings, demo, tapBox, JEV_CAPS, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from './reference/index.ts';

const ORIGINAL = { ...process.env };
const FIXTURE = new URL('./reference/demo-fixture.ts', import.meta.url).href;

const BASELINE = new WeakMap();
async function run(t, spec, argv, env = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-demo-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', ...spec }));
  // The environment as the test found it: the first call in a test records it, so a later call's restore cannot put back what an earlier call set.
  if (!BASELINE.has(t)) BASELINE.set(t, { ...process.env });
  const before = BASELINE.get(t);
  Object.assign(process.env, { DEMO_SPEC: file, ...env });
  // Back to the environment the test file started with, whatever order the hooks of several runs in one test come in.
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  // The supervisor is this process; it starts the fixture as each child.
  const { demo: fixtureDemo } = await import('./reference/demo.ts');
  // The supervisor needs the same fakes and job the fixture runs (it serves the fake browser's pages): the fixture's own module, imported.
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const recording = join(tmp, 'recording');
  const result = await fixtureDemo({ ...options, argv: ['--record', recording, ...argv] });
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
  const { result, recording } = await run(t, { boxes: { kind: 'local', runIn: true }, kills: [{ point: 'judge.asked verdict', why: 'the machine goes with the process', kind: 'box' }] }, ['--kill', '--json']);
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

test('the boxes capability: a tool\'s box is destroyed once at "a box command in flight", the run\'s process lives, no kill line is written, and the transport box lines record the loss', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { boxes: { kind: 'local' }, kills: [{ point: 'transport.box.exec', why: 'the install box is lost with its command running', target: 'tool' }] }, ['--kill', '--json'], { DEMO_BOX_TOOL: '1' });
  assert.deepEqual(result.processes.map((process) => [process.signal, process.outcome?.status]), [[null, 'complete']], 'one process: the run itself was not killed');
  assert.deepEqual(result.kills, []);
  assert.deepEqual(result.unlanded, [], 'the tool kill landed: a run that finished is not told its kill never did');
  assert.equal(result.record.company, 'Acme Ltd');
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  assert.equal(lines.filter((line) => line.source === 'host' && line.kind === 'kill').length, 0, 'no kill line: the run\'s process lived');
  const box = lines.filter((line) => line.source === 'transport').map((line) => [line.kind, line.data.killed ?? line.data.crossing ?? null]);
  assert.deepEqual(box, [['box.created', null], ['box.killed', 'transport.box.exec'], ['box.ended', true], ['box.created', null], ['box.ended', false]], 'the first install box was lost and the second ran to its end');
  assert.equal(fold(lines).kills, 0);
});

test('a run kill at "a box command in flight" is not a kill point inside a tool call (it would leave the call unknown): the crossing is logged and never cut', { timeout: 300_000 }, async (t) => {
  const { result } = await run(t, { boxes: { kind: 'local' }, kills: [{ point: 'transport.box.exec', why: 'a kill here is the operator\'s, not the demo\'s' }] }, ['--kill', '--json'], { DEMO_BOX_TOOL: '1' });
  assert.deepEqual(result.processes.map((process) => process.signal), [null], 'the run was not killed');
  assert.equal(result.processes[0].outcome.status, 'complete');
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

test('the judge seam: 50 requests and 40,000 tokens, the next refused with JEV_CAP_REACHED; a failed request counts and a refused one does not; the count survives a restart', async (t) => {
  assert.deepEqual(JEV_CAPS, { requests: 50, tokens: 40_000 });
  const tmp = await mkdtemp(join(tmpdir(), 'reference-judge-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  let sent = 0;
  const ok = async () => { sent += 1; return { answers: {}, usage: { input_tokens: 10, output_tokens: 0 } }; };
  const file = join(tmp, 'judge.jsonl');
  const judge = capJudge(ok, file);
  for (let index = 0; index < 50; index += 1) await judge({ label: 'q' });
  assert.equal(sent, 50);
  await assert.rejects(() => judge({ label: 'q' }), (error) => error.code === 'JEV_CAP_REACHED' && /not sent/.test(error.message));
  assert.equal(sent, 50, 'the 51st was refused and never sent');
  await assert.rejects(() => capJudge(ok, file)({ label: 'q' }), (error) => error.code === 'JEV_CAP_REACHED', 'a restarted process continues the count');
  // A failed request counts: three failures leave 47 requests.
  const file2 = join(tmp, 'judge2.jsonl');
  const failing = capJudge(async () => { throw new Error('the judge is down'); }, file2);
  for (let index = 0; index < 3; index += 1) await assert.rejects(() => failing({ label: 'q' }), /the judge is down/);
  const some = capJudge(ok, file2);
  for (let index = 0; index < 47; index += 1) await some({ label: 'q' });
  await assert.rejects(() => some({ label: 'q' }), (error) => error.code === 'JEV_CAP_REACHED', '3 failed + 47 answered = 50: the next is refused');
  // The token cap: usage in and out, summed across requests.
  const file3 = join(tmp, 'judge3.jsonl');
  const big = capJudge(async () => ({ answers: {}, usage: { input_tokens: 15_000, output_tokens: 5_000 } }), file3);
  await big({ label: 'q' }); await big({ label: 'q' });
  await assert.rejects(() => big({ label: 'q' }), (error) => error.code === 'JEV_CAP_REACHED', '40,000 tokens spent');
});

test('the judge seam prices at Jev\'s public list price when the answer reports usage and no price of its own, and keeps a price it reports', async (t) => {
  assert.deepEqual([JEV_LIST_PRICE.inputUsdPerMillionTokens, JEV_LIST_PRICE.outputUsdPerMillionTokens], [0.042, 0]);
  assert.match(JEV_LIST_PRICE.source, /TypeSafe cookbook, 2026-07, jev-1.12/);
  assert.equal(jevCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0.042, 'output is free at list price');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-judge-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const priced = await capJudge(async () => ({ answers: {}, usage: { input_tokens: 500_000, output_tokens: 3 } }), join(tmp, 'a.jsonl'))({ label: 'q' });
  assert.equal(priced.cost_usd, 0.021);
  const own = await capJudge(async () => ({ answers: {}, usage: { input_tokens: 500_000, output_tokens: 3 }, cost_usd: 0.5 }), join(tmp, 'b.jsonl'))({ label: 'q' });
  assert.equal(own.cost_usd, 0.5);
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

test('the vision option: each look is filed, whole, in a vision.looks document with the image the eyes saw as a blob, and the counters read the look and its cost', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_EYES: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  const filed = lines.filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks);
  assert.equal(filed.length, 1, 'one look, filed once');
  assert.equal(filed[0].record.status, 'ok');
  assert.equal(filed[0].images.length, 1);
  assert.equal(filed[0].images[0].type, 'image');
  const bytes = readFileSync(join(recording, 'blobs', `${filed[0].images[0].blob}.png`));
  assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], 'the scan the eyes saw is in blobs/ as a PNG');
  const counted = fold(lines);
  assert.equal(counted.paid.vision, 1);
  assert.ok(counted.cost > 0, 'the eyes\' price is in the cost');
  assert.equal(JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')).cost.parts.look, counted.cost);
});

test('a kill at vision.filing (the eyes answered, the look not yet filed): the next process files the kept answer and the eyes are asked once in all', { timeout: 300_000 }, async (t) => {
  const { result, recording, tmp } = await run(t, { kills: [{ point: 'vision.filing', why: 'the answer is paid and kept, the look is not filed', hold: 1 }] }, ['--kill', '--json'], { DEMO_EYES: '1' });
  assert.deepEqual(result.processes.map((process) => process.signal), ['SIGKILL', null]);
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(result.unlanded, []);
  assert.equal(result.kills[0].point, 'vision.filing');
  const asked = readFileSync(join(result.dir, 'eyes.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  assert.equal(asked, 1, 'the eyes were asked once, across both processes');
  assert.deepEqual(validateRecording(recording), []);
  const counted = fold(readEvents(recording));
  assert.deepEqual([counted.processes, counted.kills, counted.paid.vision, counted.repeated, counted.unknown], [2, 1, 1, 0, 0]);
  assert.ok(tmp);
});

test('a kill that never lands is reported, not hidden: the process finished without taking the crossing', { timeout: 300_000 }, async (t) => {
  const { result } = await run(t, { kills: [{ point: 'no.such.point', why: 'a point this demo never takes' }] }, ['--kill', '--json']);
  assert.deepEqual(result.unlanded, ['no.such.point']);
  assert.deepEqual(result.kills, []);
});

test('a scripted tool is handed the run\'s place, so it can read the run\'s evidence files and the job\'s files', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('./reference/index.ts');
  const place = await placeAt(join(tmp, 'run'));
  let seen;
  const local = localHost(place, { model: () => { throw new Error('unused'); }, tools: { look: (_args, context) => { seen = context; return {}; } }, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' });
  await local.host.tools.runEffect({ node: { tool: 'look' }, input: {}, effect: { id: 'e', argsHash: 'h' } });
  assert.deepEqual(seen.place, { root: place.root, work: place.work });
});

// ---- the review of #518: one test for each thread ---------------------------------------------------------------------------------------------

const { composeHost, destroyBoxes, meterKnown } = await import('./reference/demo.ts');
const { RUN_LABEL } = await import('./reference/boxes.ts');
const { localBoxes } = await import('@parcha/pi-transport/box/local');
const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');
const { finish } = await import('@parcha/pi-transport');

test('judge cap: a request is counted before it is sent, so concurrent questions cannot pass the check together, and the count is on disk before the answer', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-judge-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'judge.jsonl');
  writeFileSync(file, `${JSON.stringify({ requests: 49, tokens: 10 })}\n`);
  let sent = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const judge = capJudge(async () => { sent += 1; await held; return { answers: {}, usage: { input_tokens: 5, output_tokens: 0 } }; }, file);
  const five = [0, 1, 2, 3, 4].map(() => judge({ label: 'q' }).then(() => 'answered', (error) => error.code));
  // The first request is in flight and already counted: the file says 50 before any answer.
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).requests).reduce((a, b) => a + b, 0), 50);
  release();
  assert.deepEqual((await Promise.all(five)).sort(), ['JEV_CAP_REACHED', 'JEV_CAP_REACHED', 'JEV_CAP_REACHED', 'JEV_CAP_REACHED', 'answered']);
  assert.equal(sent, 1, 'only one of five concurrent questions was sent');
});

test('live parts: merged member by member FIRST, then the crossings and the judge caps wrap the final host: a live judge is capped, a live status keeps its crossings, tools and decisions keep what the host had', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-compose-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('./reference/index.ts');
  const place = await placeAt(join(tmp, 'run'));
  const host = localHost(place, { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' }).host;
  const probe = { name: 'probe', tools: [] };
  host.tools = { ...host.tools, extensions: [probe], answered: async () => undefined };
  const crossed = [];
  const statuses = [];
  const liveJudge = async () => ({ answers: {}, usage: { input_tokens: 1, output_tokens: 0 } });
  composeHost(host, { tools: { runEffect: async () => 'live' }, decisions: { runJudge: liveJudge }, status: (event) => { statuses.push(event); } }, (point) => { crossed.push(point); return false; }, { open: 0 }, join(tmp, 'spent.jsonl'));
  assert.deepEqual(host.tools.extensions, [probe], 'the host\'s extensions stay');
  assert.equal(typeof host.tools.answered, 'function', 'and its answered');
  await host.status({ source: 'workflow', event: { type: 'node.start' } });
  assert.deepEqual(statuses.length, 1, 'the live status still ran');
  assert.ok(crossed.includes('event workflow.node.start'), 'and it has its crossing');
  for (let index = 0; index < 50; index += 1) await host.decisions.runJudge({ label: 'q' });
  await assert.rejects(() => host.decisions.runJudge({ label: 'q' }), (error) => error.code === 'JEV_CAP_REACHED', 'the live judge is held to the cap');
});

test('box cleanup: a run\'s boxes carry its label, tool-made ones too, and cleanup destroys those and no other run\'s, through the provider, so a detached command stops', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-boxes-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const spec = { name: 'x', boxes: { kind: 'local' } };
  const raw = localBoxes({ root: join(tmp, 'boxes') });
  const mine = tapBox(raw, { cross: () => false, window: { open: 0 }, runLabel: 'run-A' });
  const theirs = tapBox(raw, { cross: () => false, window: { open: 0 }, runLabel: 'run-B' });
  const pidFile = join(tmp, 'pid');
  const [a1, a2, b1] = await Promise.all([mine.create({ maxLifetimeMs: 60_000, labels: {} }, ctx), mine.create({ maxLifetimeMs: 60_000, labels: { 'a-tool': 'made it' } }, ctx), theirs.create({ maxLifetimeMs: 60_000, labels: {} }, ctx)]);
  for (const made of [a1, a2, b1]) assert.ok(made.ok);
  // A detached command in a box of this run: removing the directory would not stop it; destroying the box does.
  const started = await a1.value.exec([process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000)`], undefined, ctx);
  assert.ok(started.ok);
  for (let waited = 0; !existsSync(pidFile) && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.doesNotThrow(() => process.kill(pid, 0));
  await destroyBoxes(spec, 'run-A', tmp);
  for (let waited = 0; waited < 5000; waited += 50) { try { process.kill(pid, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.throws(() => process.kill(pid, 0), 'the command in the run\'s box was stopped with it');
  const survivors = (await raw.list({}, ctx)).value.map((ref) => ref.id);
  assert.deepEqual(survivors, [b1.value.id], 'the other run\'s box is alive');
  assert.equal(RUN_LABEL, 'agentrun-run');
  await b1.value.destroy(ctx);
});

test('a crossing taken while any tool call is between its dispatch and its kept answer is never a run kill point, at any seam', (t) => {
  const kills = [];
  const real = process.kill;
  process.kill = (pid, signal) => { kills.push(signal); return true; };
  t.after(() => { process.kill = real; });
  const window = { open: 1 };
  const cross = crossings({ run: { point: 'judge.asked verdict', kind: 'process', target: 'run', why: 'named', n: 1 }, tools: [] }, undefined, Date.now(), undefined, window);
  cross('judge.asked verdict');
  assert.deepEqual(kills, [], 'a parallel branch\'s tool is open: no kill');
  window.open = 0;
  cross('judge.asked verdict');
  assert.deepEqual(kills, ['SIGKILL'], 'closed: the next crossing of the point kills');
});

const lines = () => { const kept = []; return { kept, recorder: { live: (source, kind, data) => kept.push([source, kind, data.crossing ?? data.killed ?? null]) } }; };
const planFor = (point) => crossings({ run: undefined, tools: [{ point, kind: 'box', why: 'x', target: 'tool', n: 1 }] }, undefined, Date.now(), undefined, { open: 0 });

test('a tool-box kill is honored at each advertised crossing, and recorded as a loss at each', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-crossing-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  assert.deepEqual([...BOX_CROSSINGS], ['transport.box.create', 'transport.box.created', 'transport.box.exec', 'transport.box.destroy']);
  for (const point of ['transport.box.create', 'transport.box.created', 'transport.box.exec', 'transport.box.destroy']) {
    const { kept, recorder } = lines();
    const provider = tapBox(localBoxes({ root: join(tmp, point) }), { cross: planFor(point), window: { open: 0 }, recorder });
    const made = await provider.create({ maxLifetimeMs: 60_000, labels: {} }, ctx);
    assert.ok(made.ok, point);
    if (point === 'transport.box.exec') await made.value.exec([process.execPath, '-e', '0'], undefined, ctx);
    if (point === 'transport.box.destroy') await made.value.destroy(ctx);
    assert.deepEqual(kept.filter(([, kind]) => kind === 'box.killed').map(([, , at]) => at), [point], `${point}: one loss, recorded with its crossing`);
    assert.ok(kept.some(([, kind]) => kind === 'box.ended'), `${point}: and the box ended`);
    assert.equal((await made.value.status(ctx)).value.state === 'running', false, `${point}: the box is gone`);
  }
});

test('attach: a box a tool reconnects to has its crossings and its transport lines too', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-attach-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const crossed = [];
  const { kept, recorder } = lines();
  const provider = tapBox(localBoxes({ root: join(tmp, 'boxes') }), { cross: (point) => { crossed.push(point); return false; }, window: { open: 0 }, recorder });
  const made = await provider.create({ maxLifetimeMs: 60_000, labels: {} }, ctx);
  const found = await provider.attach(made.value.id, ctx);
  await found.value.exec([process.execPath, '-e', '0'], undefined, ctx);
  await found.value.destroy(ctx);
  assert.ok(crossed.includes('transport.box.exec') && crossed.includes('transport.box.destroy'));
  assert.ok(kept.some(([, kind]) => kind === 'box.ended'));
});

test('a box that will not be destroyed is not recorded as ended, and the failure comes back to the caller', async () => {
  const kept = [];
  const stuck = { id: 'b1', facts: () => ({}), exec: async () => ({ ok: true, value: {} }), upload: async () => ({ ok: true }), download: async () => ({ ok: true }), status: async () => ({ ok: true, value: { state: 'running' } }), destroy: async () => ({ ok: false, error: { code: 'unavailable' } }) };
  const provider = tapBox({ name: 'stuck', create: async () => ({ ok: true, value: stuck }), attach: async () => ({ ok: true, value: stuck }), list: async () => ({ ok: true, value: [] }) }, { cross: () => false, window: { open: 0 }, recorder: { live: (source, kind) => kept.push(kind) } });
  const made = await provider.create({ maxLifetimeMs: 1, labels: {} }, ctx);
  const result = await made.value.destroy(ctx);
  assert.equal(result.ok, false, 'the failure is returned');
  assert.ok(!kept.includes('box.ended'), 'and the box is not recorded as gone');
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

// A place that wraps the local one and records what the supervisor does through it, with the recording's kill lines it could see at each call.
function recordingPlace(calls, recordDir, options = {}) {
  return ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    const killLinesNow = () => {
      try {
        return readdirSync(join(recordDir, '.spool')).filter((name) => name.startsWith('supervisor-')).flatMap((name) => readFileSync(join(recordDir, '.spool', name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))).filter((line) => line.kind === 'kill').length;
      } catch { return 0; }
    };
    return {
      ...inner, name: 'fake', kills: options.kills ?? ['process', 'box'], ...(options.token ? { token: (attempt) => `mount-token-${attempt}` } : {}),
      start: async (order) => { calls.push({ call: 'start', gen: order.gen, stdin: order.stdin, secretInEnv: Object.values(order.env).includes(order.stdin) }); return inner.start(order); },
      kill: async (runner, kind) => {
        calls.push({ call: 'kill', kind, killLines: killLinesNow() });
        await inner.kill(runner, kind);
        if (options.killThrows) throw Object.assign(new Error('the provider would not confirm'), { code: 'KILL_FAILED' });
      },
      recover: async (last, kind, order) => { calls.push({ call: 'recover', kind, gen: order.gen, stdin: order.stdin }); return inner.recover(last, kind, order); },
      release: async () => { calls.push({ call: 'release' }); },
    };
  };
}

test('the place seam: the supervisor starts, kills and recovers through the place, writes the kill line BEFORE the place kills, and passes the token the place mints for each attempt on stdin', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'process' }, { point: 'judge.asked verdict', why: 'box', kind: 'box' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const calls = [];
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: recordingPlace(calls, recording, { token: true }) });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(calls.map((call) => [call.call, call.kind ?? call.gen]), [['start', 1], ['kill', 'process'], ['recover', 'process'], ['kill', 'box'], ['recover', 'box'], ['release', undefined]].map(([call, x]) => (call === 'start' ? [call, 1] : call === 'recover' ? [call, x === 'process' ? 'process' : 'box'] : [call, x])).map((row) => row), 'start, then kill and recover for each kill, then release');
  const kills = calls.filter((call) => call.call === 'kill');
  assert.ok(kills.every((call) => call.killLines >= 1), 'the kill line was on the recording when the place was asked to kill');
  assert.deepEqual(kills.map((call) => call.killLines), [1, 2], 'one more kill line before each kill');
  const starts = calls.filter((call) => call.call === 'start' || call.call === 'recover');
  assert.deepEqual(starts.map((call) => call.stdin), ['mount-token-1', 'mount-token-2', 'mount-token-3'], 'the place mints each attempt\'s token and the supervisor passes it on stdin as it is');
  assert.ok(!calls.some((call) => call.secretInEnv), 'the token is never in the environment');
  assert.deepEqual(validateRecording(recording), []);
  assert.deepEqual(readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'kill').map((line) => line.data.kind), ['process', 'box']);
  // The supervisor read nothing under the run's directory: the result blob is the record the last runner reported, and the store's hash came from its report too.
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.equal(JSON.parse(readFileSync(join(recording, 'blobs', `${manifest.result.blob}.json`), 'utf8')).record.company, 'Acme Ltd');
  assert.match(manifest.source.store_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(manifest.source.store_sha256, '0'.repeat(64));
  const localOnly = localPlace({ self: FIXTURE, paths: { id: 'r', root: '/x', work: '/x/work', store: '/x/store' } });
  assert.equal(localOnly.token, undefined, 'the local place mints no token');
});

test('a place that cannot lose its machine refuses a box kill, and says which place', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'box', kind: 'box' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const calls = [];
  await assert.rejects(() => demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'recording')], place: recordingPlace(calls, join(tmp, 'recording'), { kills: ['process'] }) }), /the fake place cannot lose its box/);
  assert.deepEqual(calls.map((call) => call.call), ['release'], 'refused before anything started or was killed: the run was not stopped first, and no box loss was recorded');
});

test('a kill the place cannot make is recorded as a host line with its code and ends the attempt cleanly: no unhandled rejection, no further attempt', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'the place will fail to kill' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const calls = [];
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: recordingPlace(calls, recording, { killThrows: true }) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(unhandled, [], 'nothing was left unhandled');
  assert.deepEqual(result.failedKills, [{ gen: 1, code: 'KILL_FAILED' }]);
  assert.equal(result.processes.length, 1, 'the run did not go on after a kill the place could not make');
  assert.equal(calls.filter((call) => call.call === 'recover').length, 0);
  const lines = readEvents(recording).filter((line) => line.source === 'host');
  const failed = lines.find((line) => line.kind === 'kill.failed');
  assert.deepEqual([failed.data.gen, failed.data.code], [1, 'KILL_FAILED']);
  assert.ok(lines.findIndex((line) => line.kind === 'kill') < lines.findIndex((line) => line.kind === 'kill.failed'), 'the kill line first, then the failure');
});

const specWith = async (t, spec) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify(spec));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  return { tmp, options };
};

test('a place that rejects a kill without stopping the process does not hang the supervisor: it records the failure and ends, whether the kill was planned or the budget\'s', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', expectedCost: 0.05, kills: [{ point: 'judge.asked verdict', why: 'the place will fail to kill' }] });
  const pids = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  // The kill rejects and the process is left running: its exit never comes (the child parks for a minute at the crossing).
  const place = ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, start: async (order) => { const runner = await inner.start(order); pids.push(runner.pid); return { ...runner, exited: new Promise(() => {}) }; }, kill: async () => { throw Object.assign(new Error('the provider refused'), { code: 'KILL_REFUSED' }); } };
  };
  const started = Date.now();
  const planned = await demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'planned')], place });
  assert.ok(Date.now() - started < 30_000, 'it did not wait for the exit of a process that was never stopped');
  assert.deepEqual(planned.failedKills, [{ gen: 1, code: 'KILL_REFUSED' }]);
  assert.equal(planned.processes.length, 1);
  // The budget's stop fails the same way.
  process.env.DEMO_JUDGE_COST = '0.3'; process.env.DEMO_LINGER_MS = '20000';
  const budget = await demo({ ...options, argv: ['--json', '--record', join(tmp, 'budget')], place });
  assert.deepEqual(budget.failedKills, [{ gen: 1, code: 'KILL_REFUSED' }]);
});

test('the budget\'s stop is awaited: the place has finished killing (its provider cleanup too) before the supervisor finishes the attempt and releases the place', { timeout: 120_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', expectedCost: 0.05 });
  process.env.DEMO_JUDGE_COST = '0.3'; process.env.DEMO_LINGER_MS = '20000';
  const order = [];
  const place = ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, kill: async (runner, kind) => { await inner.kill(runner, kind); await new Promise((resolve) => setTimeout(resolve, 500)); order.push('kill done'); }, release: async () => { order.push('release'); } };
  };
  const result = await demo({ ...options, argv: ['--json', '--record', join(tmp, 'recording')], place });
  assert.equal(result.overBudget, true);
  assert.deepEqual(order, ['kill done', 'release'], 'the kill, with its slow cleanup, ended before the place was released');
});

test('a place that cannot be made, or released, leaves nothing open: the scratch is removed and the error is the one the place raised', { timeout: 120_000 }, async (t) => {
  const { options } = await specWith(t, { name: 'reference' });
  let scratch;
  await assert.rejects(() => demo({ ...options, argv: ['--json'], place: async ({ paths }) => { scratch = paths.root; throw new Error('the provider is down'); } }), /the provider is down/);
  assert.equal(existsSync(scratch), false, 'a place that failed to be made left no scratch behind');
  let root;
  await assert.rejects(() => demo({ ...options, argv: ['--json'], place: ({ paths, self, destroyBoxes, requestFile }) => { root = paths.root; return { ...localPlace({ self, paths, destroyBoxes, requestFile }), release: async () => { throw new Error('release failed'); } }; } }), /release failed/);
  assert.equal(existsSync(root), false, 'a place that failed to release still had its scratch removed');
});

test('a box kill is carried out once: the recovery that follows does not stop the old runner (nor ask the providers to destroy its boxes) again', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await specWith(t, { name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'the machine is lost', kind: 'box' }] });
  let destroyed = 0;
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'recording')], place: ({ paths, self, requestFile }) => localPlace({ self, paths, requestFile, destroyBoxes: () => { destroyed += 1; } }) });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.equal(destroyed, 1, 'the boxes were destroyed once for one box kill');
});

test('the place\'s signals carry the kill request: a place with its own signals() is the one the supervisor reads, not the files', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const asked = [];
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', join(tmp, 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, signals: (attempt) => ({ [Symbol.asyncIterator]() { const it = inner.signals(attempt)[Symbol.asyncIterator](); return { async next() { const next = await it.next(); if (!next.done) asked.push([attempt, next.value.kind, next.value.crossing.point]); return next; }, return: () => it.return() }; } }) };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(asked, [[1, 'kill-request', 'judge.asked verdict']]);
});

const SITES = { registry: { title: 'The company registry', description: 'Company records: number, incorporation date, status.', startUrl: 'http://registry.example/companies/01234567' } };

test('sites: use_website hands the registry check to a child agent in a browser of its own, its report comes back, and the parent cites its receipt', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { sites: SITES }, ['--json'], { DEMO_SITES: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.equal(result.record.answer, 'Acme Ltd was incorporated on 2019-03-04.');
  assert.match(result.record.citations[0], /^evidence\/.+browser_read-\w+\.json$/, 'the parent cites the receipt the child filed');
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  const sessions = new Set(lines.filter((line) => line.source === 'browser' && line.kind === 'launched').map((line) => line.data.tag ?? line.data.sessionId ?? JSON.stringify(line.data)));
  assert.equal(sessions.size, 1, 'the parent opened no browser: the one session is the child\'s own');
});

test('a kill while the child works: the resumed run finds the site task by its request id and does not start a second child', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, { sites: SITES, kills: [{ point: 'model.request turn 1', why: 'the child is asked for its report', n: 1 }] }, ['--kill', '--json'], { DEMO_SITES: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.deepEqual(result.unlanded ?? [], []);
  assert.equal(result.record.answer, 'Acme Ltd was incorporated on 2019-03-04.');
  assert.deepEqual(validateRecording(recording), []);
  const children = new Map();
  for (const line of readEvents(recording).filter((line) => line.channel === 'durable' && line.data?.doc?.endsWith('.children'))) for (const [key, value] of Object.entries(line.data.value.byRequest ?? {})) children.set(key, [...(children.get(key) ?? []), JSON.stringify(value)]);
  assert.deepEqual([...children.keys()], ['registry:3f2b8a1c-7d4e-4b9a-8c1d-5e6f7a8b9c0d'], 'one child, kept under its site and request id');
  assert.equal(new Set(children.get('registry:3f2b8a1c-7d4e-4b9a-8c1d-5e6f7a8b9c0d')).size, 1, 'under that key, every revision names the same child conversation: a resume that started another would replace the id under one key');
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

test('looks carry their data set item, and every read leaves one live vision/shown line; a look that failed is kept with its miss', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_EYES: '1', DEMO_ITEM: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  const lines = readEvents(recording);
  const filed = lines.filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks);
  assert.deepEqual(filed.map((entry) => [entry.item, entry.miss]), [['scan filing.png', null]]);
  const shown = lines.filter((line) => line.source === 'vision' && line.kind === 'shown');
  assert.equal(shown.length, 1, 'one live line for the one read');
  assert.equal(shown[0].data.args.path, 'filing.png');
  assert.ok(shown[0].data.content.some((block) => block.type === 'image'));
  // Eyes that fail: the miss is kept with the look it belongs to.
  const failing = await run(t, {}, ['--json'], { DEMO_EYES: '1', DEMO_EYES_FAIL: '1' });
  const misses = readEvents(failing.recording).filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks).filter((entry) => entry.miss !== null);
  assert.ok(misses.length >= 1, 'a miss was kept');
  assert.ok(misses.every((entry) => entry.miss.code && entry.miss.reason && entry.record.facts.key));
});

test('the entry keeps every look and miss itself and calls a demo\'s own onLook and onMiss: it never replaces them', { timeout: 300_000 }, async (t) => {
  const { read } = { read: (dir) => { try { return readFileSync(join(dir, 'own-hooks.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } } };
  const filedOf = (recording) => readEvents(recording).filter((line) => line.channel === 'durable' && line.data?.doc === 'vision.looks').flatMap((line) => line.data.value.looks);
  const ok = await run(t, {}, ['--json'], { DEMO_EYES: '1', DEMO_OWN_HOOKS: '1' });
  assert.equal(ok.result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(read(ok.result.dir), ['look'], 'the demo\'s own onLook ran once for the one look');
  assert.equal(filedOf(ok.recording).length, 1, 'and the entry still kept the look');
  const failing = await run(t, {}, ['--json'], { DEMO_EYES: '1', DEMO_EYES_FAIL: '1', DEMO_OWN_HOOKS: '1' });
  assert.ok(read(failing.result.dir).includes('miss'), 'the demo\'s own onMiss ran');
  assert.ok(filedOf(failing.recording).some((entry) => entry.miss?.code), 'and the entry still kept the miss with its look');
});

test('--fetch-sources: the entry fetches the demo\'s sources.json into the run\'s work/ before the job runs, and a no-key run without the flag does not', { timeout: 300_000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const body = 'a checked scan';
  const asked = [];
  // Only the file's own path counts: on a shared machine a stray probe of this port is not the entry's request.
  const server = createServer((request, response) => { if (request.url === '/files/scan.png') asked.push(request.url); response.end(body); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sources-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'sources.json');
  writeFileSync(file, JSON.stringify({ items: [{ id: 'scan-1', url: `http://127.0.0.1:${server.address().port}/files/scan.png`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }] }));
  const plain = await run(t, { sources: file }, ['--json']);
  assert.equal(plain.result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(asked, [], 'a no-key run uses the files the demo commits: nothing fetched');
  const fetched = await run(t, { sources: file }, ['--json', '--fetch-sources', '--cache', join(tmpdir(), `reference-cache-${process.pid}-${Date.now()}`)]);
  assert.equal(fetched.result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(asked, ['/files/scan.png']);
  assert.equal(readFileSync(join(fetched.result.dir, 'work', 'scan-1.png'), 'utf8'), body);
});

test('sourcesFor: only the items the input needs are fetched (--fetch-sources); without the flag a run that lacks their files is refused in one line, and names the fix', { timeout: 300_000 }, async (t) => {
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const bodies = { '/a-1.png': 'default company page', '/o-1.png': 'other company page' };
  const asked = [];
  const server = createServer((request, response) => { if (request.url in bodies) asked.push(request.url); response.end(bodies[request.url] ?? 'x'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const tmp = await mkdtemp(join(tmpdir(), 'reference-sourcesfor-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const items = Object.entries(bodies).map(([path, body]) => ({ id: path.slice(1, 4), url: `http://127.0.0.1:${server.address().port}${path}`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }));
  writeFileSync(join(tmp, 'items.json'), JSON.stringify(items));
  const cache = join(tmp, 'cache');
  const fetched = await run(t, {}, ['--json', '--fetch-sources', '--cache', cache], { DEMO_SOURCES_ITEMS: join(tmp, 'items.json') });
  assert.equal(fetched.result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(asked, ['/a-1.png'], 'the default company\'s item only');
  assert.equal(readFileSync(join(fetched.result.dir, 'work', 'a-1.png'), 'utf8'), 'default company page');
  // Again with the cache: nothing asked.
  asked.length = 0;
  await run(t, {}, ['--json', '--fetch-sources', '--cache', cache], { DEMO_SOURCES_ITEMS: join(tmp, 'items.json') });
  assert.deepEqual(asked, [], 'served from the cache');
  // Without the flag, no-key: the files must be committed; the refusal is one line naming the fix.
  const refused = await run(t, {}, ['--json'], { DEMO_SOURCES_ITEMS: join(tmp, 'items.json') });
  const outcome = refused.result.processes.at(-1).outcome;
  assert.equal(outcome.status, 'error');
  assert.match(outcome.message, /^this input needs 1 source file\(s\) a no-key run does not have \(a-1\.png\): run with --fetch-sources, or --live$/);
});

// ---- the audit's five gaps (A2) -------------------------------------------------------------------------------------------------------------

test('Fakes.extensions are installed on a no-key run, and Fakes.vision is called with the host and the running run (its harness undefined until the run is open)', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-a2-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('./reference/index.ts');
  const place = await placeAt(join(tmp, 'run'));
  const probeExtension = { name: 'probe', tools: [] };
  const local = localHost(place, { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank', extensions: [probeExtension] });
  assert.deepEqual(local.host.tools.extensions, [probeExtension]);
  const { result } = await run(t, {}, ['--json'], { DEMO_VISION_PROBE: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(JSON.parse(readFileSync(join(result.dir, 'vision-called.json'), 'utf8')), { hasHost: true, harnessUndefinedAtBuild: true, input: { company: 'Acme Ltd' }, place: { root: result.dir, work: join(result.dir, 'work') } }, 'the third argument is the run\'s input (the job\'s own by default) and its place, as a tool sees it');
  // And the one the run was given: --input, on fakes and live alike (one seam).
  const given = await run(t, {}, ['--json', '--input', '{"company":"Gamma Ltd"}'], { DEMO_VISION_PROBE: '1' });
  assert.deepEqual(JSON.parse(readFileSync(join(given.result.dir, 'vision-called.json'), 'utf8')).input, { company: 'Gamma Ltd' });
});

test('the result hook: the entry writes the result line and its blob from what the demo makes (agentrun.cited/1), not from the raw record', { timeout: 300_000 }, async (t) => {
  const { result, recording } = await run(t, {}, ['--json'], { DEMO_RESULT: '1' });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(validateRecording(recording), []);
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.equal(manifest.result.title, 'A cited result');
  const cited = JSON.parse(readFileSync(join(recording, 'blobs', `${manifest.result.blob}.json`), 'utf8'));
  assert.equal(cited.format, 'agentrun.cited/1');
  assert.equal(cited.rows[0].value, 'Acme Ltd');
  assert.ok(readFileSync(join(recording, 'blobs', `${cited.rows[0].cites[0].blob}.txt`), 'utf8') === 'a cited file', 'keep() stored the file in the recording\'s blobs');
  const line = readEvents(recording).find((entry) => entry.source === 'host' && entry.kind === 'result');
  assert.equal(line.data.title, 'A cited result');
});

test('ToolContext.live: false on a no-key run, true when the host is live, so one set of tools reads live or replays a capture', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-live-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('./reference/index.ts');
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

test('--input <name> runs a capture from input.fixtures: a name not in the map is refused with the known captures, and a path outside fixtures/ is refused', async (t) => {
  const { mkdirSync, writeFileSync: write, rmSync } = await import('node:fs');
  const fixtures = new URL('./reference/fixtures/', import.meta.url);
  const capture = new URL('./other-ltd.json', fixtures);
  const spec = { input: { fixtures: { 'other-ltd': 'examples/reference/fixtures/other-ltd.json', 'acme-ltd': 'examples/reference/fixtures/acme-ltd.json' } } };
  // A name that is not a capture, on fakes: refused, and the refusal lists the captures there are.
  await assert.rejects(() => run(t, spec, ['--json', '--input', 'nobody']), (error) => /--input nobody is not a capture of reference/.test(error.message) && /The captures are: other-ltd, acme-ltd\./.test(error.message) && /--live/.test(error.message));
  await assert.rejects(() => run(t, {}, ['--json', '--input', 'nobody']), /It has none/);
  // A capture in the map whose file is not there says where to put it.
  await assert.rejects(() => run(t, spec, ['--json', '--input', 'other-ltd']), /examples\/reference\/fixtures\/other-ltd\.json, which does not exist/);
  // A path outside this demo's fixtures/ is refused, whatever it names.
  for (const path of ['examples/reference/job.ts', 'examples/other/fixtures/x.json', 'examples/reference/fixtures/../job.ts', '/etc/passwd']) await assert.rejects(() => run(t, { input: { fixtures: { escape: path } } }, ['--json', '--input', 'escape']), /not a path under examples\/reference\/fixtures\//, path);
  // The job's own input and an inline object need no capture.
  const own = await run(t, spec, ['--json', '--input', '{"company":"Acme Ltd"}']);
  assert.equal(own.result.processes.at(-1).outcome.status, 'complete');
  // With its fixture in place, the name runs the job on it.
  mkdirSync(fixtures, { recursive: true });
  write(capture, '{"company":"Other Ltd"}');
  t.after(() => { rmSync(capture, { force: true }); try { rmSync(fixtures); } catch { /* not empty or gone */ } });
  const other = await run(t, spec, ['--json', '--input', 'other-ltd']);
  assert.equal(other.result.record.company, 'Other Ltd');
});

test('a live child gets exactly the environment names demo.json declares (keys, oneOf members, programs) and nothing undeclared; its live vision is built from the host and the running run like the fakes\'', { timeout: 300_000 }, async (t) => {
  const { declaredEnv } = await import('./reference/demo-spec.ts');
  const keys = [
    { oneOf: [{ env: 'OPENAI_API_KEY', required: true }, { env: 'GEMINI_API_KEY' }] },
    { env: 'TYPESAFE_API_KEY', required: true },
    { oneOf: [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }], { env: 'CHROME_PATH' }] },
  ];
  assert.deepEqual([...declaredEnv({ name: 'x', keys, programs: [{ name: 'chrome', env: 'CHROME_BIN' }] })].sort(), ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'CHROME_BIN', 'CHROME_PATH', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'TYPESAFE_API_KEY']);
  // Values are made up from the names, so no literal that looks like a credential is in the source.
  const secrets = Object.fromEntries(['OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'GITHUB_TOKEN', 'UNDECLARED_SECRET', 'ANTHROPIC_API_KEY'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  // The test fixture's own settings are declared like any other name the child may see (`programs`), so the rule is exact.
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }];
  const { result } = await run(t, { keys, programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_SPEC_NOTE: 'also not declared', ...secrets });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  const seen = JSON.parse(readFileSync(join(result.dir, 'env-seen.json'), 'utf8'));
  for (const name of ['OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'PATH']) assert.ok(seen.includes(name), `${name} reaches the child`);
  for (const name of ['GITHUB_TOKEN', 'UNDECLARED_SECRET', 'ANTHROPIC_API_KEY', 'DEMO_SPEC_NOTE']) assert.ok(!seen.includes(name), `${name} was not declared and does not reach a live child`);
  assert.deepEqual(JSON.parse(readFileSync(join(result.dir, 'live-vision.json'), 'utf8')), { hasHost: true, harnessUndefinedAtBuild: true, input: { company: 'Acme Ltd' }, place: { root: result.dir, work: join(result.dir, 'work') } }, 'live vision gets (host, running, { input, place }) like fakes.vision');
  const givenLive = await run(t, { keys, programs }, ['--json', '--live', '--input', '{"company":"Gamma Ltd"}'], { DEMO_LIVE_PROBE: '1', ...secrets });
  assert.deepEqual(JSON.parse(readFileSync(join(givenLive.result.dir, 'live-vision.json'), 'utf8')).input, { company: 'Gamma Ltd' }, 'live sees --input too');
});

test('fakes.extensions are for a no-key run: a live host does not install them', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-live-ext-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('./reference/index.ts');
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

test('the manifest hook adds fields, the run is named by the input file, and --see-also links finished recordings by name', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-manifest-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const earlier = join(tmp, 'weak-eyes-pass');
  mkdirSync(earlier);
  writeFileSync(join(earlier, 'manifest.json'), JSON.stringify({ title: 'A weak-eyes pass', format: 'agentrun.recording/1', recorded: { started: '2026-10-16T00:00:00.000Z', ended: '2026-10-16T00:01:00.000Z' } }));
  writeFileSync(join(earlier, 'events.jsonl'), '');
  writeFileSync(join(tmp, 'apollo-11.json'), '{"company":"Acme Ltd"}');
  const first = await run(t, {}, ['--json', '--input', join(tmp, 'apollo-11.json'), '--see-also', earlier], { DEMO_MANIFEST: '1' });
  const manifest = JSON.parse(readFileSync(join(first.recording, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.sources, [{ file: 'a.pdf', sha256: 'ab' }]);
  assert.deepEqual(manifest.models, { lead: 'x' });
  assert.equal(manifest.source.run, 'reference-apollo-11');
  assert.deepEqual(manifest.see_also, [{ recording: 'weak-eyes-pass', label: 'A weak-eyes pass' }], 'linked by name, not by the path on this machine');
  assert.equal(manifest.format, 'agentrun.recording/1');
  const plain = await run(t, {}, ['--json']);
  const bare = JSON.parse(readFileSync(join(plain.recording, 'manifest.json'), 'utf8'));
  assert.equal(bare.source.run, 'reference');
  assert.ok(!('see_also' in bare));
  await assert.rejects(() => run(t, {}, ['--json'], { DEMO_MANIFEST: 'reserved' }), /"source" is written by the entry/);
  await assert.rejects(() => run(t, {}, ['--json', '--see-also', join(tmp, 'nope')]), /not a finished recording/);
  // A manifest with only a title is no recording: it has no format, no end and no lines.
  const titled = join(tmp, 'titled');
  mkdirSync(titled);
  writeFileSync(join(titled, 'manifest.json'), JSON.stringify({ title: 'Earlier pass' }));
  await assert.rejects(() => run(t, {}, ['--json', '--see-also', titled]), /not a finished recording/);
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
  const { RUN_KEY } = await import('./reference/index.ts');
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

test('fakes.input is the no-key default (--input still wins), the models the live parts chose reach manifest(), and a refused child\'s reason is in the summary', { timeout: 300_000 }, async (t) => {
  const smaller = await run(t, {}, ['--json'], { DEMO_FAKES_INPUT: '1' });
  assert.equal(smaller.result.record.company, 'Beta Ltd', 'no --input: the fakes\' input');
  const named = await run(t, {}, ['--json', '--input', '{"company":"Gamma Ltd"}'], { DEMO_FAKES_INPUT: '1' });
  assert.equal(named.result.record.company, 'Gamma Ltd', '--input wins');
  // Live: the job's own input is the default, and manifest() is told what the live parts chose.
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }];
  const keys = [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }]];
  const browser = Object.fromEntries(['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  const live = await run(t, { keys, programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_FAKES_INPUT: '1', DEMO_MANIFEST: 'models', ...browser });
  assert.equal(live.result.processes.at(-1).outcome.status, 'complete');
  assert.equal(live.result.record.company, 'Acme Ltd', 'live: the job\'s own input, not the fakes\'');
  assert.deepEqual(JSON.parse(readFileSync(join(live.recording, 'manifest.json'), 'utf8')).chosen, { lead: 'chosen-lead', eyes: 'chosen-eyes' });
  // The summary says why a child stopped.
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const tmp = await mkdtemp(join(tmpdir(), 'reference-stopped-'));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    writeFileSync(join(tmp, 'items.json'), JSON.stringify([{ id: 'a-1', url: 'http://127.0.0.1:1/a-1.png', bytes: 1, sha256: 'a'.repeat(64) }]));
    await run(t, {}, [], { DEMO_SOURCES_ITEMS: join(tmp, 'items.json'), DEMO_FAKES_INPUT: '', DEMO_LIVE_PROBE: '', DEMO_MANIFEST: '' });
  } finally { console.log = log; }
  assert.ok(lines.some((line) => /^  stopped: this input needs 1 source file\(s\)/.test(line)), lines.join('\n'));
});

// ---- secrets in a recording ------------------------------------------------------------------------------------------------------------------

/** A sign-in home with made-up tokens (derived from their names, so no literal in this file looks like a credential). */
const signInHome = async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reference-signin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const tokens = Object.fromEntries(['access', 'refresh', 'idToken'].map((field) => [field, `made-up-${field}-token-${'x'.repeat(24)}`]));
  const key = `made-up-provider-key-${'z'.repeat(24)}`;
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ version: 1, hostId: 'host-for-the-test', credentials: { openai: { type: 'oauth', ...tokens, expires: 1_900_000_000_000, clientId: 'client-for-the-test', scopes: ['scope-for-the-test'] }, other: { type: 'api_key', key } } }));
  return { home, tokens: { ...tokens, key } };
};
const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)]));

test('the sign-in\'s secret strings are read from auth.json by key (access, refresh, id token and an API key), a missing file is fine, and an unreadable or non-JSON one fails without a value in the message', async (t) => {
  const { signInSecrets, signInFile } = await import('./reference/secrets.ts');
  const { home, tokens } = await signInHome(t);
  const found = signInSecrets(join(home, 'auth.json'));
  assert.deepEqual(found.map((secret) => secret.key.replace(`${home}/auth.json `, '')), ['credentials.openai.access', 'credentials.openai.refresh', 'credentials.openai.idToken', 'credentials.other.key']);
  assert.deepEqual(found.map((secret) => secret.value), [tokens.access, tokens.refresh, tokens.idToken, tokens.key], 'every secret string a credential holds, and no expiry, client id, host id or scope');
  writeFileSync(join(home, 'short.json'), JSON.stringify({ credentials: { openai: { type: 'oauth', access: 'short', refresh: 'tiny' } } }));
  assert.deepEqual(signInSecrets(join(home, 'short.json')), [], 'a short string is a word, not a secret');
  assert.deepEqual(signInSecrets(join(home, 'absent.json')), [], 'no sign-in is fine');
  mkdirSync(join(home, 'dir.json'));
  assert.throws(() => signInSecrets(join(home, 'dir.json')), /cannot be read/);
  writeFileSync(join(home, 'bad.json'), `{ not json ${tokens.access}`);
  assert.throws(() => signInSecrets(join(home, 'bad.json')), (error) => /is not JSON/.test(error.message) && !error.message.includes(tokens.access));
  assert.equal(signInFile({ AGENTRUN_HOME: '/elsewhere' }), '/elsewhere/auth.json');
  assert.match(signInFile({}), /\.config\/agentrun\/auth\.json$/);
});

test('--record holds none of the sign-in\'s tokens in any line, text blob or the manifest, though a tool result carried each; a recording without a sign-in is unchanged', { timeout: 300_000 }, async (t) => {
  const { home, tokens } = await signInHome(t);
  const values = Object.values(tokens);
  const leaked = await run(t, {}, ['--json'], { AGENTRUN_HOME: home, DEMO_LEAK: JSON.stringify(values), DEMO_RESULT: '1' });
  assert.equal(leaked.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(leaked.result.processes.at(-1)));
  const files = filesIn(leaked.recording);
  assert.ok(files.some((file) => file.endsWith('events.jsonl')) && files.some((file) => file.endsWith('manifest.json')));
  for (const file of files) for (const value of values) assert.ok(!readFileSync(file).includes(value), `${file.slice(leaked.recording.length)} holds a token`);
  assert.ok(readFileSync(join(leaked.recording, 'events.jsonl'), 'utf8').includes('[redacted]'), 'the tool result is there, with the values taken out');
  // A text blob is redacted before it is hashed and named: the result's cited blob carried every value, and the recording passes the validator and the gallery gate (every blob hashes to its own name).
  const blobs = readdirSync(join(leaked.recording, 'blobs')).filter((name) => name.endsWith('.txt'));
  assert.equal(blobs.length, 1, 'the cited text blob');
  assert.equal(readFileSync(join(leaked.recording, 'blobs', blobs[0]), 'utf8').match(/\[redacted\]/g).length, values.length, 'every value in it is taken out');
  assert.deepEqual(validateRecording(leaked.recording), []);
  const dist = await mkdtemp(join(tmpdir(), 'reference-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  cpSync(leaked.recording, join(dist, 'recordings', 'leaked'), { recursive: true });
  // The build that ships recordings as files: an index of the manifest and each blob's path, no more.
  const manifest = JSON.parse(readFileSync(join(leaked.recording, 'manifest.json'), 'utf8'));
  const held = readdirSync(join(leaked.recording, 'blobs'));
  writeFileSync(join(dist, 'recordings', 'index.json'), JSON.stringify([{ id: 'leaked', manifest, blobs: Object.fromEntries(held.map((name) => [name.split('.')[0], `blobs/${name}`])) }]));
  writeFileSync(join(dist, 'gallery.js'), "window.AGENTRUN_GALLERY_INDEX = 'recordings/index.json';\n");
  const { gateProblems } = await import('../scripts/recording/gate.mjs');
  assert.deepEqual(gateProblems(dist), [], 'the gallery gate passes the redacted recording');
  // No sign-in: nothing to redact, nothing refused, and the lines are what they were.
  const bare = await mkdtemp(join(tmpdir(), 'reference-nosignin-'));
  t.after(() => rm(bare, { recursive: true, force: true }));
  const plain = await run(t, {}, ['--json'], { AGENTRUN_HOME: bare, DEMO_LEAK: JSON.stringify(values) });
  assert.equal(plain.result.processes.at(-1).outcome.status, 'complete');
  assert.ok(readFileSync(join(plain.recording, 'events.jsonl'), 'utf8').includes(values[0]), 'a recording without a sign-in is not touched');
  assert.ok(!readFileSync(join(plain.recording, 'events.jsonl'), 'utf8').includes('[redacted]'));
});

test('a sign-in file that cannot be read fails the record before the run, and the record-time scan refuses a secret that slipped through, naming the key and the file and never the value', async (t) => {
  const { scanRecording } = await import('./reference/secrets.ts');
  const unreadable = await mkdtemp(join(tmpdir(), 'reference-unreadable-'));
  t.after(() => rm(unreadable, { recursive: true, force: true }));
  mkdirSync(join(unreadable, 'auth.json'));
  await assert.rejects(() => run(t, {}, ['--json'], { AGENTRUN_HOME: unreadable }), /sign-in file .* cannot be read/);
  const recording = await mkdtemp(join(tmpdir(), 'reference-slipped-'));
  t.after(() => rm(recording, { recursive: true, force: true }));
  mkdirSync(join(recording, 'blobs'));
  const value = `made-up-slipped-token-${'y'.repeat(24)}`;
  writeFileSync(join(recording, 'blobs', 'a.txt'), `a blob with ${value} in it`);
  assert.throws(() => scanRecording(recording, [{ key: 'DEMO_SECRET', value }]), (error) => /DEMO_SECRET is in blobs\/a\.txt/.test(error.message) && !error.message.includes(value));
  assert.doesNotThrow(() => scanRecording(recording, []));
});

test('the child uses the sign-in file the recorder reads (AGENTRUN_HOME is handed down), a token the sign-in refreshes mid-run is redacted from the next write on, and a token that was written before the recorder saw the file change refuses the recording', { timeout: 300_000 }, async (t) => {
  const { home, tokens } = await signInHome(t);
  const files = (recording) => filesIn(recording).filter((file) => !file.endsWith('.png'));
  const holds = (recording, value) => files(recording).some((file) => readFileSync(file).includes(value));
  // (c) A child that reads its token from its own AGENTRUN_HOME gets the file the recorder reads, so what it returns is redacted.
  const child = await run(t, {}, ['--json'], { AGENTRUN_HOME: home, DEMO_LEAK_STEPS: 'homeToken' });
  assert.equal(child.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(child.result.processes.at(-1)));
  assert.ok(!holds(child.recording, tokens.access), 'the child\'s token is not in the recording');
  assert.ok(readFileSync(join(child.recording, 'events.jsonl'), 'utf8').includes('[redacted]'), 'and it was there to be redacted');
  // (d) A refresh mid-run: the sign-in rewrites auth.json with a new access token, and a later line carries it.
  const refreshed = `made-up-refreshed-access-token-${'r'.repeat(30)}`;
  const mid = await run(t, {}, ['--json'], { AGENTRUN_HOME: home, DEMO_LEAK_STEPS: 'rotate,homeToken', DEMO_ROTATE_TOKEN: refreshed });
  assert.equal(mid.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(mid.result.processes.at(-1)));
  assert.ok(!holds(mid.recording, refreshed), 'the refreshed token, unknown at the start, is not in the recording');
  assert.ok((readFileSync(join(mid.recording, 'events.jsonl'), 'utf8').match(/\[redacted\]/g) ?? []).length >= 1);
  // (e) An event carries the new token BEFORE the file shows it; the final read of auth.json catches it, and the recording is refused: no manifest, the key and the file named, the value never.
  const late = `made-up-late-access-token-${'l'.repeat(30)}`;
  const { home: lateHome } = await signInHome(t);
  const recording = join(await mkdtemp(join(tmpdir(), 'reference-late-')), 'recording');
  t.after(() => rm(join(recording, '..'), { recursive: true, force: true }));
  await assert.rejects(() => run(t, {}, ['--json', '--record', recording], { AGENTRUN_HOME: lateHome, DEMO_LEAK: JSON.stringify([late]), DEMO_LEAK_STEPS: 'leak,rotate', DEMO_ROTATE_TOKEN: late }), (error) => /credentials\.openai\.access is in /.test(error.message) && !error.message.includes(late));
  assert.ok(!existsSync(join(recording, 'manifest.json')), 'the refused recording is not a finished one');
});

test('a token the sign-in rotated twice during the run, which the child learned and returned in its result, is not in the recording: the child redacts what it tells the supervisor with every token it has seen', { timeout: 300_000 }, async (t) => {
  const { home } = await signInHome(t);
  const second = `made-up-second-access-token-${'s'.repeat(30)}`;
  const third = `made-up-third-access-token-${'h'.repeat(30)}`;
  const recording = join(await mkdtemp(join(tmpdir(), 'reference-rotated-')), 'recording');
  t.after(() => rm(join(recording, '..'), { recursive: true, force: true }));
  // The access token goes first -> second -> third inside one run; the result the child returns carries the second, which the supervisor's own list (the first, then the file's last) never held.
  const done = await run(t, {}, ['--json', '--record', recording], { AGENTRUN_HOME: home, DEMO_LEAK_STEPS: 'rotate,rotate2', DEMO_ROTATE_TOKEN: second, DEMO_ROTATE_TOKEN_2: third, DEMO_RESULT: '1', DEMO_RESULT_LEAK: second });
  assert.equal(done.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(done.result.processes.at(-1)));
  const files = filesIn(recording).filter((file) => !file.endsWith('.png'));
  for (const value of [second, third]) assert.ok(!files.some((file) => readFileSync(file).includes(value)), 'an intermediate token is not in the recording');
  assert.ok(files.some((file) => readFileSync(file, 'utf8').includes('[redacted]')), 'it was there to be redacted');
});

test('the final scan finds a token as a line stores it, JSON-escaped: one with a quote, a backslash or a newline', async (t) => {
  const { scanRecording } = await import('./reference/secrets.ts');
  const dir = await mkdtemp(join(tmpdir(), 'reference-scan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const value = 'made-up-token-with-"quote"-and-\\back\nline-' + 'q'.repeat(20);
  writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ data: { text: value } })}\n`);
  assert.ok(!readFileSync(join(dir, 'events.jsonl'), 'utf8').includes(value), 'the line holds only the escaped form');
  assert.throws(() => scanRecording(dir, [{ key: 'the key', value }]), /the key is in events\.jsonl/);
  writeFileSync(join(dir, 'events.jsonl'), '{"data":{"text":"[redacted]"}}\n');
  assert.doesNotThrow(() => scanRecording(dir, [{ key: 'the key', value }]));
});

test('the tracker keeps the union of every value seen, reads a changed auth.json before the next write, and reads it once more at the end', async (t) => {
  const { trackSecrets } = await import('./reference/secrets.ts');
  const { home, tokens } = await signInHome(t);
  const file = join(home, 'auth.json');
  const tracked = trackSecrets({ AGENTRUN_HOME: home }, { name: 'x' });
  assert.equal(tracked.redact(`a line with ${tokens.access}`), 'a line with [redacted]');
  const next = `made-up-next-access-token-${'n'.repeat(30)}`;
  assert.equal(tracked.redact(`a line with ${next}`), `a line with ${next}`, 'a token the file does not hold yet is not known');
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.credentials.openai.access = next;
  writeFileSync(file, JSON.stringify(stored));
  assert.equal(tracked.redact(`a line with ${next}`), 'a line with [redacted]', 'the changed file is read before the write');
  assert.equal(tracked.redact(`a line with ${tokens.access}`), 'a line with [redacted]', 'the old token is still known: the union');
  const last = `made-up-last-access-token-${'t'.repeat(30)}`;
  stored.credentials.openai.access = last;
  writeFileSync(file, JSON.stringify(stored));
  assert.ok(tracked.final().some((secret) => secret.value === last), 'the final read sees the newest token');
  assert.ok(tracked.final().some((secret) => secret.value === tokens.access), 'and every earlier one');


});

test('a crossing a tool kill takes still counts for a run kill at the same point: the run kill at n 2 fires on the second matching crossing', async (t) => {
  const kills = [];
  const real = process.kill;
  process.kill = (pid, signal) => { kills.push(signal); return true; };
  t.after(() => { process.kill = real; });
  const cross = crossings({ run: { point: 'transport.tool.started', kind: 'process', target: 'run', why: 'second', n: 2 }, tools: [{ point: 'transport.tool.started', kind: 'box', target: 'tool', why: 'first', n: 1 }] }, undefined);
  assert.equal(cross('transport.tool.started'), true, 'the tool kill takes the first crossing');
  assert.deepEqual(kills, []);
  assert.equal(cross('transport.tool.started'), false);
  assert.deepEqual(kills, ['SIGKILL'], 'the run kill is the second matching crossing, not the third');
});

test('a held kill waits for every tool call to return before it asks: a tool a parallel branch started while the filing was parked is never cut', async () => {
  const fired = [];
  const window = { open: 0 };
  const cross = crossings({ run: { point: 'vision.filing', kind: 'process', target: 'run', why: 'held', n: 1, hold: 3, waitMs: 30 }, tools: [] }, undefined, Date.now(), (crossing) => fired.push(crossing.point), window);
  cross('vision.filing');
  assert.ok(cross.park('vision.filing'), 'the first filing is parked');
  window.open = 1;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(fired, [], 'the wait is over, and a tool call is running: no kill yet');
  window.open = 0;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(fired, ['vision.filing'], 'the tool returned: now the kill is asked');
});

test('a look is kept with the images of its own read: a read that produced no image finds none (not the previous read\'s), and a film window keeps only the frames inside it', async () => {
  const { shownShots } = await import('./reference/looks.ts');
  const shown = shownShots();
  const afterTool = shown.extension.hooks[0].handlers.afterTool;
  const png = (text) => ({ type: 'image', data: Buffer.from(text).toString('base64'), mimeType: 'image/png' });
  const record = (path, args = {}) => ({ args: { path, model: 'm', native: false, ...args }, status: 'ok', facts: { key: 'k' } });
  await afterTool({ id: '1', name: 'read', arguments: { path: 'a.png' } }, { output: [png('A')], details: { evidence: 'evidence/a.json' } }, { conversationId: 7 });
  await afterTool({ id: '2', name: 'read', arguments: { path: 'b.png' } }, { output: [{ type: 'text', text: 'the file is gone' }], details: {} }, { conversationId: 7 });
  assert.equal(shown.of('7', record('b.png'), 'read'), undefined, 'the failed read finds no images, not a.png\'s');
  assert.equal(shown.of('7', record('a.png'), 'read').images.length, 1);
  assert.equal(shown.of('7', record('a.png'), 'read').receipt, 'evidence/a.json');
  await afterTool({ id: '3', name: 'read', arguments: { path: 'film.webm' } }, { output: [{ type: 'text', text: 'Frame at 1 s.' }, png('F1'), { type: 'text', text: 'Frame at 9 s.' }, png('F9')], details: {} }, { conversationId: 7 });
  assert.deepEqual(shown.of('7', record('film.webm', { from_s: 0, to_s: 5 }), 'read').images.map((image) => image.at), [1], 'only the frame inside the window');
  assert.deepEqual(shown.of('7', record('film.webm', { from_s: 5, to_s: 10 }), 'read').images.map((image) => image.at), [9]);
  // A screenshot is found as the newest of its tool.
  await afterTool({ id: '4', name: 'screenshot', arguments: {} }, { output: [png('S')], details: { evidence: 'evidence/shot.json' } }, { conversationId: 7 });
  assert.equal(shown.of('7', record('a screenshot result'), 'screenshot').images.length, 1);
});

test('a directory a run already used keeps its identity: a demo whose name differs from the saved run\'s resumes it under the saved name', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-identity-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'run');
  const first = await run(t, {}, ['--json', '--dir', dir]);
  assert.equal(first.result.processes.at(-1).outcome.status, 'complete');
  const saved = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).run;
  assert.match(saved, /^reference/, 'the run is named for its demo (and an invocation)');
  // The same directory again, by a demo of another name (a directory saved before the run was named for its demo): it is not refused, and stays what it was.
  const again = await run(t, { name: 'another-demo' }, ['--json', '--dir', dir]);
  assert.equal(again.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(again.result.processes.at(-1)));
  assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).run, saved, 'resumed under the saved name');
});

// ---- the place answers where the kill request is, and the supervisor honors it only with the attempt's nonce ---------------------------------------

test('askToBeKilled writes the request durably (whole, with the attempt\'s nonce), and the request written at requestFile(gen) is the one signals(gen) yields, for localPlace and a place with its own requestFile and signals', { timeout: 120_000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { localPlace } = await import('./reference/index.ts');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-request-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const asks = (file, nonce) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '-e', 'import("./examples/reference/crossings.ts").then((m) => m.askToBeKilled(process.argv[1], process.argv[2])({ point: "vision.filing", n: 2, pid: process.pid }))', file, nonce], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
    const wait = setInterval(() => { if (existsSync(file)) { clearInterval(wait); resolve(child); } }, 20);
  });
  const first = async (iterable) => { const iterator = iterable[Symbol.asyncIterator](); const next = await iterator.next(); await iterator.return?.(); return next.value; };
  const local = localPlace({ self: FIXTURE, paths: { id: 'r', root: tmp, work: join(tmp, 'work'), store: join(tmp, 'store') }, requestFile: (attempt) => join(tmp, `kill-${attempt}.json`) });
  assert.equal(local.requestFile(3), join(tmp, 'kill-3.json'));
  const a = await asks(local.requestFile(1), 'nonce-for-attempt-1');
  t.after(() => a.kill('SIGKILL'));
  assert.deepEqual(readdirSync(tmp).filter((name) => name.includes('kill-1')), ['kill-1.json'], 'written whole: no temporary file is left beside it');
  assert.deepEqual(await first(local.signals(1)), { kind: 'kill-request', crossing: { point: 'vision.filing', n: 2, pid: a.pid }, nonce: 'nonce-for-attempt-1' });
  // A place of its own: a requestFile outside the run\'s work/ (the disk place\'s <root>/signals/kill-<gen>.json) and a signals that reads that same file.
  mkdirSync(join(tmp, 'signals'));
  const own = (attempt) => join(tmp, 'signals', `kill-${attempt}.json`);
  const other = { ...local, requestFile: own, signals: (attempt) => localPlace({ self: FIXTURE, paths: local.paths, requestFile: own }).signals(attempt) };
  const b = await asks(other.requestFile(2), 'nonce-for-attempt-2');
  t.after(() => b.kill('SIGKILL'));
  assert.deepEqual(await first(other.signals(2)), { kind: 'kill-request', crossing: { point: 'vision.filing', n: 2, pid: b.pid }, nonce: 'nonce-for-attempt-2' });
});

const killSpec = async (t, extra = {}) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-nonce-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }], ...extra }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  return { tmp, options };
};

test('every order\'s KILL_REQUEST is the place\'s requestFile(gen); a request with the attempt\'s nonce kills, and a missing or wrong one is ignored with a host line', { timeout: 300_000 }, async (t) => {
  const { tmp, options } = await killSpec(t);
  mkdirSync(join(tmp, 'signals'));
  const orders = [];
  const own = (attempt) => join(tmp, 'signals', `kill-${attempt}.json`);
  const recording = join(tmp, 'recording');
  const result = await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile: own });
    return {
      ...inner,
      start: (order) => { orders.push(order.env); return inner.start(order); },
      recover: (last, kind, order) => { orders.push(order.env); return inner.recover(last, kind, order); },
      // Before the child\'s own request, forged ones: no nonce, and another nonce. A custom iterator, not a generator: the supervisor\'s return() must end a pending next().
      signals: (attempt) => ({ [Symbol.asyncIterator]() {
        const forged = attempt === 1 ? [{ kind: 'kill-request', crossing: { point: 'forged.no-nonce', n: 1 } }, { kind: 'kill-request', crossing: { point: 'forged.wrong-nonce', n: 1 }, nonce: 'not-this-attempts-nonce' }] : [];
        const real = inner.signals(attempt)[Symbol.asyncIterator]();
        return { next: async () => (forged.length ? { done: false, value: forged.shift() } : real.next()), return: () => real.return() };
      } }),
    };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.deepEqual(orders.map((env) => env.KILL_REQUEST), [own(1), own(2)], 'the order\'s KILL_REQUEST is the place\'s requestFile(gen), on start and recover alike');
  assert.ok(orders.every((env) => /^[0-9a-f]{32}$/.test(env.KILL_NONCE)) && orders[0].KILL_NONCE !== orders[1].KILL_NONCE, 'a fresh 16-byte nonce for each attempt');
  assert.ok(existsSync(own(1)) && JSON.parse(readFileSync(own(1), 'utf8')).nonce === orders[0].KILL_NONCE, 'the child wrote its request there, with its attempt\'s nonce');
  const lines = readEvents(recording).filter((line) => line.source === 'host');
  assert.deepEqual(lines.filter((line) => line.kind === 'kill').map((line) => line.data.crossing?.point), ['judge.asked verdict'], 'one kill line, at the real crossing: a forged request never makes one');
  assert.deepEqual(lines.filter((line) => line.kind === 'kill.request.ignored').map((line) => [line.data.point, line.data.reason]), [['forged.no-nonce', 'no nonce'], ['forged.wrong-nonce', 'wrong nonce']]);
  assert.ok(!JSON.stringify(lines).includes(orders[0].KILL_NONCE), 'the nonce is on no line');
});

test('the child reads KILL_NONCE once and removes it before anything starts: a command the child starts does not see it', { timeout: 300_000 }, async (t) => {
  const { options } = await killSpec(t, { kills: [] });
  process.env.DEMO_LEAK_STEPS = 'envProbe';
  let nonce;
  const { localPlace } = await import('./reference/index.ts');
  const result = await demo({ ...options, argv: ['--json', '--record', join(await mkdtemp(join(tmpdir(), 'reference-probe-')), 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    return { ...inner, start: (order) => { nonce = order.env.KILL_NONCE; return inner.start(order); } };
  } });
  assert.equal(result.processes.at(-1).outcome.status, 'complete', JSON.stringify(result.processes.at(-1)));
  assert.match(nonce, /^[0-9a-f]{32}$/, 'the order had one');
  assert.deepEqual(JSON.parse(readFileSync(join(result.dir, 'nonce-seen.json'), 'utf8')), { inProcess: false, inCommand: false });
});

test('one fresh run id per invocation, shared by its processes: a second run of one demo on a shared disk finds none of the first\'s signals, and the manifest is written before the place is released', { timeout: 300_000 }, async (t) => {
  const shared = await mkdtemp(join(tmpdir(), 'reference-shared-disk-'));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const { options } = await killSpec(t);
  const { localPlace } = await import('./reference/index.ts');
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

// ---- run.json host lines from place.status() --------------------------------------------------------------------------------------------------

test('the supervisor writes a run.json host line from place.status() when status, generation, holder or sealedSeq changes (start, kill, exit), none for a stable status or a place without status(), and the recording validates', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-runjson-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const runLines = (recording) => readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'run.json');
  const record = (paths, over) => ({ run: paths.id, status: 'running', generation: 1, sealedSeq: 0, holder: { driver: 'fake', host: 'h', bootId: 'b', pid: 1, since: 't' }, heartbeatAt: 'a', updatedAt: 'a', ...over });
  // A place whose own record changes at start, at the kill and at exit: each is a line, in that order, and nothing else is.
  const changing = join(tmp, 'changing');
  await demo({ ...options, argv: ['--kill', '--json', '--record', changing], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    let current = null;
    let generation = 0;
    return {
      ...inner,
      status: async () => ({ record: current }),
      start: async (order) => { generation += 1; current = record(paths, { generation, holder: { driver: 'fake', host: 'h', bootId: 'b', pid: generation, since: 't' } }); const runner = await inner.start(order); runner.exited.then(() => { if (current.status === 'running') current = { ...current, status: 'done', sealedSeq: 9, heartbeatAt: 'later' }; }); return runner; },
      recover: async (last, kind, order) => { generation += 1; current = record(paths, { generation, holder: { driver: 'fake', host: 'h', bootId: 'b', pid: generation, since: 't' } }); const next = await inner.recover(last, kind, order); next.runner.exited.then(() => { if (current.status === 'running') current = { ...current, status: 'done', sealedSeq: 9 }; }); return next; },
      kill: async (runner, kind) => { current = { ...current, status: 'paused', sealedSeq: 7 }; await inner.kill(runner, kind); },
    };
  } });
  const lines = runLines(changing);
  assert.deepEqual(lines.map((line) => [line.data.gen, line.data.status, line.data.generation, line.data.sealedSeq]), [[1, 'running', 1, 0], [1, 'paused', 1, 7], [2, 'running', 2, 0], [2, 'done', 2, 9]]);
  assert.ok(lines.every((line) => line.data.run && line.data.holder?.driver === 'fake'), 'the record verbatim');
  assert.deepEqual(validateRecording(changing), []);
  // A stable status: one line, however many times it is read. A heartbeat that moves is not a change.
  const stable = join(tmp, 'stable');
  await demo({ ...options, argv: ['--kill', '--json', '--record', stable], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    let beat = 0;
    return { ...inner, status: async () => { beat += 1; return { record: record(paths, { heartbeatAt: `beat-${beat}` }) }; } };
  } });
  assert.equal(runLines(stable).length, 1);
  assert.deepEqual(validateRecording(stable), []);
  // No status(): none. A reading that fails or is not a run record: none, and the run is fine.
  const none = join(tmp, 'none');
  const plain = await demo({ ...options, argv: ['--json', '--record', none] });
  assert.equal(runLines(none).length, 0);
  const broken = join(tmp, 'broken');
  const failed = await demo({ ...options, argv: ['--json', '--record', broken], place: ({ paths, self, destroyBoxes, requestFile }) => ({ ...localPlace({ self, paths, destroyBoxes, requestFile }), status: async () => { throw new Error('the status reader failed'); } }) });
  assert.equal(failed.processes.at(-1).outcome.status, 'complete');
  assert.equal(runLines(broken).length, 0);
  assert.equal(plain.processes.at(-1).outcome.status, 'complete');
});

test('a holder\'s host and boot id are labels in the recording (host-1, host-2, boot-1, ... by first appearance, the same label for the same value), and no real host name or boot id is in the finished recording', { timeout: 300_000 }, async (t) => {
  const { hostname } = await import('node:os');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-labels-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }] }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const real = { host: hostname(), boot: existsSync('/proc/sys/kernel/random/boot_id') ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : 'made-up-boot-id-for-a-machine-without-one' };
  const elsewhere = { host: 'another-box-for-the-test', boot: 'boot-id-of-another-box-for-the-test' };
  const recording = join(tmp, 'recording');
  // Generation 1 on this machine, generation 2 (after the kill) on another box, and a last record from this machine again.
  await demo({ ...options, argv: ['--kill', '--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    let current = null;
    const record = (who, generation, status) => ({ run: paths.id, status, generation, sealedSeq: generation, holder: { driver: 'fake', host: who.host, bootId: who.boot, pid: generation, since: 't' }, updatedAt: 'a' });
    return {
      ...inner, status: async () => ({ record: current }),
      start: async (order) => { current = record(real, 1, 'running'); return inner.start(order); },
      kill: async (runner, kind) => { current = { ...current, status: 'paused' }; await inner.kill(runner, kind); },
      recover: async (last, kind, order) => { current = record(elsewhere, 2, 'running'); const next = await inner.recover(last, kind, order); next.runner.exited.then(() => { current = record(real, 3, 'done'); }); return next; },
    };
  } });
  const lines = readEvents(recording).filter((line) => line.source === 'host' && line.kind === 'run.json');
  assert.deepEqual(lines.map((line) => [line.data.generation, line.data.status, line.data.holder.host, line.data.holder.bootId]), [
    [1, 'running', 'host-1', 'boot-1'], [1, 'paused', 'host-1', 'boot-1'], [2, 'running', 'host-2', 'boot-2'], [3, 'done', 'host-1', 'boot-1'],
  ], 'labels by first appearance; the same value keeps its label; a new box is a new holder');
  for (const file of filesIn(recording)) {
    const bytes = readFileSync(file);
    for (const value of [real.host, real.boot, elsewhere.host, elsewhere.boot]) assert.ok(!bytes.includes(value), `${file.slice(recording.length)} holds a real host name or boot id`);
  }
  assert.deepEqual(validateRecording(recording), []);
});

test('a run.json line is an allowlist: a holder\'s sandbox id, name and mountpoint and any other field are dropped, and a detail is text of at most 240 with every absolute path as <path>', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-allowlist-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const recording = join(tmp, 'recording');
  await demo({ ...options, argv: ['--json', '--record', recording], place: ({ paths, self, destroyBoxes, requestFile }) => ({
    ...localPlace({ self, paths, destroyBoxes, requestFile }),
    status: async () => ({ record: {
      run: paths.id, status: 'running', generation: 3, sealedSeq: 7, wakeAt: null, heartbeatAt: 'h', updatedAt: 'u', surprise: 'a field nobody listed',
      holder: { driver: 'archil', host: 'a-real-host-name', bootId: 'a-real-boot-id', pid: 12, since: 's', sandboxId: 'sbx-123456', name: 'sandbox-of-the-demo', mountpoint: '/mnt/archil/the-disk' },
      detail: `mounted at /mnt/archil/the-disk and ${paths.root}/store: ${'x'.repeat(400)}`,
    } }),
  }) });
  const [line] = readEvents(recording).filter((entry) => entry.source === 'host' && entry.kind === 'run.json');
  assert.deepEqual(Object.keys(line.data).sort(), ['detail', 'gen', 'generation', 'heartbeatAt', 'holder', 'run', 'sealedSeq', 'status', 'updatedAt', 'wakeAt']);
  assert.deepEqual(line.data.holder, { driver: 'archil', host: 'host-1', bootId: 'boot-1', pid: 12, since: 's' });
  assert.ok(line.data.detail.startsWith('mounted at <path>:') && line.data.detail.length <= 240, 'a path runs to the next delimiter');
  const text = readFileSync(join(recording, 'events.jsonl'), 'utf8');
  for (const leaked of ['sbx-123456', 'sandbox-of-the-demo', '/mnt/archil', 'a-real-host-name', 'a-real-boot-id', 'a field nobody listed']) assert.ok(!text.includes(leaked), `${leaked} is not in the recording`);

});

test('a kill request written in short pieces is whole when it is renamed into place: the supervisor reads the complete request', { timeout: 60_000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const tmp = await mkdtemp(join(tmpdir(), 'reference-request-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'kill-1.json');
  const crossings_ = new URL('./reference/crossings.ts', import.meta.url).href;
  const script = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const writeSync = fs.writeSync;
    fs.writeSync = (fd, data, offset = 0) => writeSync(fd, data, offset, Math.min(5, data.length - offset));
    syncBuiltinESMExports();
    const { askToBeKilled } = await import(${JSON.stringify(crossings_)});
    askToBeKilled(process.argv[1], 'a-nonce')({ point: 'judge.asked verdict', n: 1, pid: process.pid });`;
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script, file], { stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  for (let waited = 0; !existsSync(file) && waited < 20_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { point: 'judge.asked verdict', n: 1, pid: child.pid, nonce: 'a-nonce' }, 'the whole request, though each write took 5 bytes');
});

test('a path in a detail is replaced whole, spaces and all; and a machine named like one of the recording\'s own words is not redacted out of its lines', async () => {
  const { plainText } = await import('./reference/demo.ts');
  const { machineSecrets, redactorOf } = await import('./reference/secrets.ts');
  assert.equal(plainText('cannot open /tmp/Client Files/store: no such file'), 'cannot open <path>: no such file');
  const aliceHome = ['', 'home', 'alice'].join('/');
  assert.equal(plainText(`wrote ${aliceHome}/Private Documents/report.txt, then stopped`), 'wrote <path>, then stopped');
  assert.equal(machineSecrets('host').some((secret) => secret.key.includes('host name')), false, 'a machine named host: its name is a word of the recording');
  assert.equal(machineSecrets('greppy-mrb').some((secret) => secret.value === 'greppy-mrb'), true, 'an ordinary name is taken');
  const line = '{"channel":"live","source":"host","kind":"run.json","data":{"holder":{"host":"host-1"}}}';
  const redact = redactorOf(machineSecrets('host').filter((secret) => secret.key.includes('host name')));
  assert.equal(redact ? redact(line) : line, line, 'the lines of the format are unchanged');
});

test('the slow status tick does not queue a read behind one still running: a place whose reads take seconds is read a bounded number of times', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-slow-status-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference' }));
  Object.assign(process.env, { DEMO_SPEC: file, DEMO_LINGER_MS: '7000' });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  let reads = 0;
  const started = Date.now();
  await demo({ ...options, argv: ['--json', '--record', join(tmp, 'recording')], place: ({ paths, self, destroyBoxes, requestFile }) => ({
    ...localPlace({ self, paths, destroyBoxes, requestFile }),
    status: async () => { reads += 1; await new Promise((resolve) => setTimeout(resolve, 2500)); return { record: null }; },
  }) });
  // Boundary reads (start, exit, result) plus the ticks that found no read running; a tick queued behind every slow read would make six or more.
  assert.ok(reads <= 5, `the status was read ${reads} times in ${Date.now() - started} ms`);
});
