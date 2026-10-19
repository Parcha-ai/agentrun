// The reference directory's one entry: its names are a surface another example imports, so they are listed here.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as entry from '@parcha/agentrun-harness';
import { fakes, job } from './reference/job.ts';

test('the entry exports the names another example builds on, and nothing else', () => {
  assert.deepEqual(Object.keys(entry).sort(), ['BOX_CROSSINGS', 'JEV_CAPS', 'JEV_LIST_PRICE', 'RUN_KEY', 'VisionLooks', 'capJudge', 'chooseBrowser', 'codeOf', 'cost', 'crossings', 'demo', 'finishRecording', 'jevCost', 'keepLooks', 'killsOf', 'localHost', 'localPlace', 'maxUsdOf', 'openRecorder', 'openSupervisor', 'packageCommitRecorder', 'parseInput', 'placeAt', 'plansOf', 'run', 'shownShots', 'tapBox', 'tapFakes', 'tapHost']);
  for (const name of ['tapBox', 'demo', 'crossings', 'tapFakes', 'tapHost', 'chooseBrowser', 'killsOf', 'maxUsdOf', 'parseInput', 'plansOf', 'run', 'cost', 'placeAt', 'localHost', 'openRecorder', 'openSupervisor', 'finishRecording', 'codeOf', 'packageCommitRecorder']) assert.equal(typeof entry[name], 'function', name);
});

test('another example runs a job of its own through the entry alone', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-entry-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const place = await entry.placeAt(join(tmp, 'run'));
  const local = entry.localHost(place, fakes);
  const result = await entry.run(place, local.host, job);
  assert.equal(result.status, 'complete');
  assert.equal(local.ledger().some((row) => row.kind === 'tool'), true);
});

test('run takes vision options over the example\'s: an extra onLook runs beside the example\'s own, and limits are the caller\'s', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-entry-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const place = await entry.placeAt(join(tmp, 'run'));
  const local = entry.localHost(place, fakes);
  const looks = [];
  const asked = [];
  let built = 0;
  const result = await entry.run(place, local.host, job, { vision: ({ harness }) => {
    built += 1;
    assert.equal(harness, undefined, 'the run is not open when the extension is built');
    return { onLook: (look) => { looks.push(look); }, limits: (conversation) => { asked.push(conversation.conversationId); return undefined; } };
  } });
  assert.equal(result.status, 'complete');
  assert.equal(built, 1);
  assert.ok(looks.length >= 1, 'the caller\'s onLook saw the look');
  assert.ok(asked.length >= 1, 'the caller\'s limits were asked');
  const events = (await readFile(join(place.root, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.source === 'vision' && 'look' in event).length, looks.length, 'the example\'s own record of looks is unchanged');
});

test('Fakes.responses sets how many model turns one process can take: one is too few for the reference job', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-entry-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const place = await entry.placeAt(join(tmp, 'run'));
  const result = await entry.run(place, entry.localHost(place, { ...fakes, responses: 1 }).host, job);
  assert.notEqual(result.status, 'complete', 'the lead takes four turns, and the provider had one queued');
});

test('reconcile reports an applied call exactly once, in the receipt the driver appends: from the kept answer when none is listed, never when one is, and the calls end [failed, applied]', async () => {
  const { reconcileEffects, appliedOnce } = await import('../packages/harness/dist/assemble.js');
  const { fold } = await import('../scripts/recording/fold.mjs');
  const effect = (id, calls) => ({ id, argsHash: `h-${id}`, intent: { tool: 'search' }, ...(calls ? { calls } : {}) });
  const settle = async (unknown, tools) => {
    const done = [];
    await reconcileEffects(unknown, async (id, value, receipt) => { done.push([id, value, (receipt?.calls ?? []).map((call) => call.outcome)]); }, tools);
    return done;
  };
  // the first send failed, the retry applied, the kill landed before the door listed it: the effect holds [failed]; the receipt adds applied
  assert.deepEqual(await settle([effect('a', [{ outcome: 'failed' }])], { answered: async () => ({ args: {}, value: 1 }) }), [['a', 1, ['applied']]]);
  // an applied call already listed: the receipt adds none, and the effect still completes
  assert.deepEqual(await settle([effect('b', [{ outcome: 'failed' }, { outcome: 'applied' }])], { answered: async () => ({ args: {}, value: 1 }) }), [['b', 1, []]]);
  // nothing to answer it from: nothing is completed or reported; an effect with no intent is left alone
  assert.deepEqual(await settle([effect('c')], {}), []);
  assert.deepEqual(await settle([{ id: 'd', argsHash: 'h' }], { answered: async () => ({ args: {}, value: 1 }) }), []);
  // a rerun answers by the effect's id, and says so; it is a NEW execution, so it is listed even when an applied call already is
  assert.deepEqual(await settle([effect('e')], { rerun: async ({ id }) => ({ args: {}, value: id }) }), [['e', 'e', ['applied']]]);
  assert.deepEqual(await settle([effect('f', [{ outcome: 'applied' }])], { rerun: async ({ id }) => ({ args: {}, value: id }) }), [['f', 'f', ['applied']]]);
  // the kept answer is asked by the effect, so two effects with one argsHash are not given each other's answer
  const asked = [];
  await settle([effect('p1'), effect('p2')], { answered: async (each) => { asked.push(each.id); return each.id === 'p1' ? { args: {}, value: 'one' } : undefined; } });
  assert.deepEqual(asked, ['p1', 'p2']);
  assert.deepEqual(appliedOnce([{ outcome: 'failed' }], { outcome: 'applied' }), { calls: [{ outcome: 'failed' }, { outcome: 'applied' }], added: true });
  // the record that results folds to repeated 0
  const line = (commit, gen, calls) => ({ channel: 'durable', source: 'workflow', gen, commit, order: 0, t: commit, kind: 'agentrun.effects', data: { doc: 'agentrun.effects', key: 'run\u0000step#call:0', value: { name: 'search', argsHash: 'h', status: 'completed', calls } } });
  const counted = fold([line(1, 1, [{ outcome: 'failed' }]), line(2, 2, [{ outcome: 'failed' }, { outcome: 'applied' }])]);
  assert.deepEqual([counted.repeated, counted.repeatedNotMeasured], [0, 0]);
});

test('a tool that throws null or undefined reaches the caller as it threw, not as a TypeError', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-entry-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const place = await entry.placeAt(join(tmp, 'run'));
  for (const thrown of [null, undefined, 'text']) {
    const local = entry.localHost(place, { ...fakes, tools: { search: () => { throw thrown; } } });
    await assert.rejects(() => local.host.tools.runEffect({ node: { tool: 'search' }, input: {}, effect: { id: 'x', argsHash: 'h' }, call: () => undefined }), (error) => error === thrown);
  }
});
