// kills, crossings and ledgers: where a kill lands, the judge seam's caps, live tools, box cleanup and the live host's crossings.
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
import { BOX_CROSSINGS, localPlace, priceJudge, chooseBrowser, crossings, demo, tapBox, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from '@parcha/agentrun-harness';
import { ORIGINAL, FIXTURE, BASELINE, run, composeHost, destroyBoxes, meterKnown, RUN_LABEL, localBoxes, ctx, finish, lines, planFor, recordingPlace, specWith, SITES, signInHome, filesIn, killSpec, boxed } from './reference-demo-helpers.mjs';

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
test('the judge seam has no cap: 801 questions and 3,000,000 tokens are all sent, and none is refused', async () => {
  let sent = 0;
  const judge = priceJudge(async () => { sent += 1; return { answers: {}, usage: { input_tokens: 3_745, output_tokens: 0 } }; });
  for (let index = 0; index < 801; index += 1) await judge({ label: 'q' });
  assert.equal(sent, 801, 'every question was sent: --max-usd is the run\'s dollar stop, and TypeSafe rate-limits');
});
test('the judge seam prices at Jev\'s public list price when the answer reports usage and no price of its own, and keeps a price it reports', async (t) => {
  assert.deepEqual([JEV_LIST_PRICE.inputUsdPerMillionTokens, JEV_LIST_PRICE.outputUsdPerMillionTokens], [0.042, 0]);
  assert.match(JEV_LIST_PRICE.source, /TypeSafe cookbook, 2026-07, jev-1.12/);
  assert.equal(jevCost({ input_tokens: 1_000_000, output_tokens: 1_000_000 }), 0.042, 'output is free at list price');
  const priced = await priceJudge(async () => ({ answers: {}, usage: { input_tokens: 500_000, output_tokens: 3 } }))({ label: 'q' });
  assert.equal(priced.cost_usd, 0.021);
  const own = await priceJudge(async () => ({ answers: {}, usage: { input_tokens: 500_000, output_tokens: 3 }, cost_usd: 0.5 }))({ label: 'q' });
  assert.equal(own.cost_usd, 0.5);
});
test('a scripted tool is handed the run\'s place, so it can read the run\'s evidence files and the job\'s files', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('@parcha/agentrun-harness');
  const place = await placeAt(join(tmp, 'run'));
  let seen;
  const local = localHost(place, { model: () => { throw new Error('unused'); }, tools: { look: (_args, context) => { seen = context; return {}; } }, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' });
  await local.host.tools.runEffect({ node: { tool: 'look' }, input: {}, effect: { id: 'e', argsHash: 'h' } });
  assert.deepEqual(seen.place, { root: place.root, work: place.work });
});
test('live parts: merged member by member FIRST, then the crossings and the judge seam wrap the final host: a live judge is priced at the list price, a live status keeps its crossings, tools and decisions keep what the host had', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-compose-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('@parcha/agentrun-harness');
  const place = await placeAt(join(tmp, 'run'));
  const host = localHost(place, { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' }).host;
  const probe = { name: 'probe', tools: [] };
  host.tools = { ...host.tools, extensions: [probe], answered: async () => undefined };
  const crossed = [];
  const statuses = [];
  const liveJudge = async () => ({ answers: {}, usage: { input_tokens: 1, output_tokens: 0 } });
  composeHost(host, { tools: { runEffect: async () => 'live' }, decisions: { runJudge: liveJudge }, status: (event) => { statuses.push(event); } }, (point) => { crossed.push(point); return false; }, { open: 0 });
  assert.deepEqual(host.tools.extensions, [probe], 'the host\'s extensions stay');
  assert.equal(typeof host.tools.answered, 'function', 'and its answered');
  await host.status({ source: 'workflow', event: { type: 'node.start' } });
  assert.deepEqual(statuses.length, 1, 'the live status still ran');
  assert.ok(crossed.includes('event workflow.node.start'), 'and it has its crossing');
  const answered = await host.decisions.runJudge({ label: 'q' });
  assert.equal(answered.cost_usd, jevCost({ input_tokens: 1, output_tokens: 0 }), 'the live judge is priced through the seam');
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
  // Both due at the same crossing (n 1 each): the tool kill takes it, and the run kill is not lost, it lands at the next matching one.
  kills.length = 0;
  const both = crossings({ run: { point: 'transport.tool.started', kind: 'process', target: 'run', why: 'same', n: 1 }, tools: [{ point: 'transport.tool.started', kind: 'box', target: 'tool', why: 'same', n: 1 }] }, undefined);
  assert.equal(both('transport.tool.started'), true);
  assert.deepEqual(kills, []);
  both('transport.tool.started');
  assert.deepEqual(kills, ['SIGKILL'], 'the pending run kill lands at the next matching crossing');
  both('transport.tool.started');
  assert.deepEqual(kills, ['SIGKILL'], 'and only once');
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
// ---- the demo's own Jev caps, and a model whose key the demo does not declare ----------------------------------------------------------------------

test('models.judge.caps is refused at load, before any process starts: the harness has no Jev cap', { timeout: 300_000 }, async (t) => {
  const { refuseJudgeCaps } = await import('../packages/harness/dist/demo-spec.js');
  assert.doesNotThrow(() => refuseJudgeCaps({ name: 'x', models: { judge: { jev: true } } }));
  assert.doesNotThrow(() => refuseJudgeCaps({ name: 'x' }));
  assert.throws(() => refuseJudgeCaps({ name: 'x', models: { judge: { jev: true, caps: { requests: 801 } } } }), /models\.judge\.caps is gone: the harness has no Jev cap\. --max-usd is the run's dollar stop/);
  await assert.rejects(() => run(t, { models: { judge: { jev: true, caps: { requests: 801 } } }, keys: [{ oneOf: [{ env: 'TYPESAFE_API_KEY', required: true, where: 'w', why: 'y' }], why: 'a Jev key' }] }, ['--json']), /models\.judge\.caps is gone/);
});
test('a demo that names models.judge (Jev) without a Jev key group is refused at load, naming the group to add; a TYPESAFE_API_KEY or an OPENROUTER_API_KEY group is enough, and no key is implied', { timeout: 300_000 }, async (t) => {
  await assert.rejects(() => run(t, { models: { judge: { jev: true } } }, ['--json']), /models\.judge \(Jev\) but declares no key for it: add a keys group .*TYPESAFE_API_KEY.*OPENROUTER_API_KEY/s);
  await assert.rejects(() => run(t, { models: { judge: { jev: true } }, keys: [{ env: 'GEMINI_API_KEY', required: true, where: 'w', why: 'y' }] }, ['--json']), /declares no key for it/);
  for (const env of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY']) {
    const ok = await run(t, { models: { judge: { jev: true } }, keys: [{ oneOf: [{ env, required: true, where: 'w', why: 'y' }], why: 'a Jev key', for: 'live' }] }, ['--json']);
    assert.equal(ok.result.processes.at(-1).outcome.status, 'complete', env);
  }
  // A demo that names no Jev judge is not asked for the key.
  assert.equal((await run(t, { models: { lead: { needs: ['text'] } } }, ['--json'])).result.processes.at(-1).outcome.status, 'complete');

});
test('a live host whose fallback judge is the fakes\' (already tapped) has each crossing counted once; a judge the live parts supply is tapped here', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-tap-once-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { localHost, placeAt } = await import('@parcha/agentrun-harness');
  const { composeHost } = await import('../packages/harness/dist/demo.js');
  const place = await placeAt(join(tmp, 'run'));
  const crossed = [];
  const cross = (point) => { crossed.push(point); return false; };
  const fakes = { model: () => { throw new Error('unused'); }, tools: {}, judge: async () => ({ answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }), pages: {}, start: 'about:blank' };
  // The entry taps the fakes when the live parts supply tools; the live parts here supply tools only.
  const { tapFakes } = await import('@parcha/agentrun-harness');
  const host = localHost(place, tapFakes(fakes, cross)).host;
  composeHost(host, { tools: { runEffect: async () => 'live' } }, cross, { open: 0 }, true, true);
  await host.decisions.runJudge({ label: 'verdict' });
  assert.deepEqual(crossed.filter((point) => point.startsWith('judge.')), ['judge.asked verdict', 'judge.answered verdict'], 'once, not twice');
  // A judge the live parts supply has no crossings of its own: it is tapped.
  crossed.length = 0;
  const other = localHost(place, tapFakes(fakes, cross)).host;
  composeHost(other, { decisions: { runJudge: async () => ({ answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }) } }, cross, { open: 0 }, true, true);
  await other.decisions.runJudge({ label: 'verdict' });
  assert.deepEqual(crossed.filter((point) => point.startsWith('judge.')), ['judge.asked verdict', 'judge.answered verdict']);


});
// ---- a kill's n counts every crossing, and it lands at the first eligible one at or after the nth ------------------------------------------------------------

test('a kill\'s n counts EVERY crossing of its point, eligible or not, and lands at the first ELIGIBLE one at or after the nth (the kill line keeps the ordinal it landed on); it is unlanded only when the run ends before any eligible crossing at or after n', () => {
  const withWindow = (n, eligibility) => {
    const kills = [];
    const window = { open: 0 };
    const cross = crossings({ run: { point: 'p', kind: 'process', target: 'run', why: 'x', n }, tools: [] }, undefined, Date.now(), (crossing) => kills.push(crossing), window);
    for (const eligible of eligibility) { window.open = eligible ? 0 : 1; cross('p'); }
    return kills.map((kill) => [kill.point, kill.n]);
  };
  assert.deepEqual(withWindow(3, [true, true, true, true]), [['p', 3]], 'all eligible: the nth');
  assert.deepEqual(withWindow(3, [true, false, false, true, true]), [['p', 4]], 'the 3rd and the 2nd are inside a call: it lands at the 4th, and says so');
  assert.deepEqual(withWindow(3, [false, true, true, false, true]), [['p', 3]], 'the 3rd is eligible even though the first was not (the old count would have waited for a 5th)');
  assert.deepEqual(withWindow(3, [true, true, false, false]), [], 'the run ends before any eligible crossing at or after n: unlanded');
  assert.deepEqual(withWindow(1, [false, false, true]), [['p', 3]], 'n 1 with the first ones ineligible');
  assert.equal(withWindow(2, [true, true, true, true]).length, 1, 'once');
});
test('a kill at a point that is often ineligible lands every time across 8 runs, and the result and the summary say planned n and landed n when they differ', { timeout: 600_000 }, async (t) => {
  for (let index = 0; index < 8; index += 1) {
    const { result, recording } = await run(t, { kills: [{ point: 'event workflow.node.start', why: 'a node starts, often while another branch\'s call is in flight', n: 4 }] }, ['--kill', '--json'], { DEMO_FANOUT: '1' });
    assert.deepEqual(result.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']], `run ${index}: ${JSON.stringify(result.processes.map((process) => process.signal))}`);
    assert.deepEqual(result.unlanded, [], `run ${index}`);
    const [kill] = result.kills;
    assert.equal(kill.planned, 4);
    assert.ok(kill.n >= 4, `landed at n=${kill.n}, at or after the planned 4`);
    const line = readEvents(recording).find((entry) => entry.source === 'host' && entry.kind === 'kill');
    assert.equal(line.data.crossing.n, kill.n, 'the kill line keeps the ordinal it landed on');
  }
  const lines = [];
  const log = console.log;
  // The summary says it when they differ.
  const { summarize } = await import('../packages/harness/dist/demo.js');
  console.log = (...args) => lines.push(args.join(' '));
  try { summarize({ spec: { name: 'x' } }, { processes: [{ outcome: { status: 'complete' } }], kills: [{ gen: 1, point: 'p', kind: 'process', why: 'w', n: 12, planned: 10 }, { gen: 2, point: 'q', kind: 'process', why: 'w', n: 3, planned: 3 }], failedKills: [], failedSignals: [], unlanded: [], usd: 0, maxUsd: null, overBudget: false }); } finally { console.log = log; }
  assert.ok(lines.some((line) => line.includes('at p (planned n=10, landed at n=12): w')) && lines.some((line) => line.includes('at q: w') && !line.includes('planned')), lines.join('\n'));
  // The default line names how the run ended and no counts; `--kill` and `--debug` add them.
  const first = (counts) => {
    const out = [];
    console.log = (...args) => out.push(args.join(' '));
    try { summarize({ spec: { name: 'x' } }, { processes: [{ outcome: { status: 'complete' } }], kills: [], failedKills: [], failedSignals: [], unlanded: [], usd: 0, maxUsd: null, overBudget: false }, counts); } finally { console.log = log; }
    return out[0];
  };
  assert.equal(first(), 'x: complete');
  assert.equal(first(true), 'x: complete in 1 process, 0 kills');
  // The cost line: none when nothing was priced (unless a cap is set), unknown only when a priced part has no price.
  const costLine = (result) => {
    const out = [];
    console.log = (...args) => out.push(args.join(' '));
    try { summarize({ spec: { name: 'x' } }, { processes: [{ outcome: { status: 'complete' } }], kills: [], failedKills: [], failedSignals: [], unlanded: [], maxUsd: null, overBudget: false, ...result }); } finally { console.log = log; }
    return out.find((line) => line.startsWith('cost')) ?? null;
  };
  assert.equal(costLine({ usd: null, priced: false }), null);
  assert.equal(costLine({ usd: null, priced: false, maxUsd: 1 }), 'cost: none (cap $1)');
  assert.equal(costLine({ usd: null, priced: true }), 'cost: unknown');
  assert.equal(costLine({ usd: 0.3, priced: true }), 'cost: $0.3');

});
test('a kill line carries the crossing\'s own number: a held kill the point\'s count (not the process\'s), and a storm the process\'s crossing counter (not zero)', async () => {
  const fired = [];
  const held = crossings({ run: { point: 'vision.filing', kind: 'process', target: 'run', why: 'held', n: 1, hold: 1 }, tools: [] }, undefined, Date.now(), (crossing) => fired.push(crossing.n));
  for (const other of ['judge.asked a', 'judge.answered a', 'model.request turn 0']) held(other);
  held('vision.filing');
  assert.ok(held.park('vision.filing') instanceof Promise);
  assert.deepEqual(fired, [1], 'the first filing is the first crossing of its point, whatever came before');
  const storm = crossings({ run: { storm: true, kills: 1, gapMs: 0 }, tools: [] }, undefined, Date.now() - 10_000, (crossing) => fired.push(crossing.n));
  storm('event workflow.node.start');
  storm('judge.asked a');
  assert.ok(fired.at(-1) > 0, `a storm kill has the process's crossing number, not 0: ${fired.at(-1)}`);


});
// ---- the live host's crossings ------------------------------------------------------------------------------------------------------------------

test('a kill at "judge.asked <label>" or "model.request turn <n>" lands on a live-shaped host (no tapFakes: the judge and model are the live host\'s), the resume pays the judge once, and repeated is 0', { timeout: 300_000 }, async (t) => {
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }];
  const keys = [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }]];
  const browser = Object.fromEntries(['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  const judged = (dir) => readFileSync(join(dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row)).filter((row) => row.kind === 'judge');
  for (const point of ['judge.asked verdict', 'model.request turn 1']) {
    const { result, recording } = await run(t, { keys, programs, kills: [{ point, why: `a kill at ${point} on a live host` }] }, ['--live', '--kill', '--json'], { DEMO_LIVE_PROBE: '1', ...browser });
    assert.deepEqual(result.processes.map((process) => [process.signal, process.outcome?.status ?? null]), [['SIGKILL', null], [null, 'complete']], `${point}: ${JSON.stringify(result.processes)}`);
    assert.deepEqual(result.kills.map((kill) => kill.point), [point]);
    assert.deepEqual(result.unlanded, []);
    assert.equal(judged(result.dir).length, 1, `${point}: the judge was paid for once across the kill and the resume`);
    const counted = fold(readEvents(recording));
    assert.deepEqual([counted.processes, counted.kills, counted.repeated], [2, 1, 0], point);
  }
});
// ---- LiveParts.tools ---------------------------------------------------------------------------------------------------------------------------

test('on --live the effect door dispatches to LiveParts.tools (with its receipt); a tool missing there runs from the fakes only when demo.json says local: "fakes", else the call fails "no live source"; on fakes nothing changes', { timeout: 300_000 }, async (t) => {
  const programs = [{ name: 'fixture spec', env: 'DEMO_SPEC' }, { name: 'fixture probe', env: 'DEMO_LIVE_PROBE' }, { name: 'fixture tools', env: 'DEMO_LIVE_TOOLS' }];
  const keys = [[{ env: 'BROWSERBASE_API_KEY' }, { env: 'BROWSERBASE_PROJECT_ID' }]];
  const browser = Object.fromEntries(['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID'].map((name) => [name, `value-for-${name.toLowerCase()}`]));
  const answers = (dir) => readdirSync(join(dir, 'answers')).map((name) => JSON.parse(readFileSync(join(dir, 'answers', name), 'utf8')));
  const fromLive = (dir) => answers(dir).some((answer) => answer.value?.from === 'live');
  // A live tool: dispatched through the door, its answer kept as the receipt (the same wrapper as a fakes tool).
  const live = await run(t, { keys, programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_LIVE_TOOLS: 'search', ...browser });
  assert.equal(live.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(live.result.processes.at(-1)));
  assert.ok(fromLive(live.result.dir), 'the live tool ran, and its receipt is the kept answer');
  // A tool missing from the live tools, declared local: "fakes": the fakes\' own runs.
  const declared = await run(t, { keys, programs, tools: [{ name: 'search', local: 'fakes', hosted: null }] }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_LIVE_TOOLS: 'other', ...browser });
  assert.equal(declared.result.processes.at(-1).outcome.status, 'complete', JSON.stringify(declared.result.processes.at(-1)));
  assert.ok(!fromLive(declared.result.dir) && answers(declared.result.dir).length > 0, 'the fakes\' search ran');
  // Not declared: the call fails clearly.
  const missing = await run(t, { keys, programs }, ['--json', '--live'], { DEMO_LIVE_PROBE: '1', DEMO_LIVE_TOOLS: 'other', ...browser });
  assert.notEqual(missing.result.processes.at(-1).outcome.status, 'complete');
  assert.ok(JSON.stringify(missing.result.processes.at(-1)).includes('no live source for search') || readFileSync(join(missing.recording, 'events.jsonl'), 'utf8').includes('no live source for search'), 'it says why');
  // On fakes, live tools are never looked at.
  const fakes = await run(t, {}, ['--json'], { DEMO_LIVE_PROBE: '1', DEMO_LIVE_TOOLS: 'search' });
  assert.equal(fakes.result.processes.at(-1).outcome.status, 'complete');
  assert.ok(!fromLive(fakes.result.dir), 'fakes.tools never see LIVE');
  assert.ok(!existsSync(join(fakes.result.dir, 'models-seen.json')), 'the live hook is supplied and is never called on fakes');


});
