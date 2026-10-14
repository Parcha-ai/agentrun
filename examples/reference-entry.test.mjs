// The reference directory's one entry: its names are a surface another example imports, so they are listed here.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as entry from './reference/index.ts';
import { fakes, job } from './reference/job.ts';

test('the entry exports the names another example builds on, and nothing else', () => {
  assert.deepEqual(Object.keys(entry).sort(), ['RUN_KEY', 'codeOf', 'finishRecording', 'localHost', 'openRecorder', 'openSupervisor', 'packageCommitRecorder', 'placeAt', 'run']);
  for (const name of ['run', 'placeAt', 'localHost', 'openRecorder', 'openSupervisor', 'finishRecording', 'codeOf', 'packageCommitRecorder']) assert.equal(typeof entry[name], 'function', name);
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

test('settle reports an applied call exactly once: from the kept answer when none is listed, never when one is, and the calls end [failed, applied]', async () => {
  const { settleEffects, appliedOnce } = await import('./reference/assemble.ts');
  const { fold } = await import('../scripts/recording/fold.mjs');
  const effect = (id, status = 'unknown') => ({ id, status, argsHash: `h-${id}`, intent: { tool: 'search', argsHash: `i-${id}` } });
  const journalOf = (effects) => {
    const written = { called: [], completed: [] };
    return { written, journal: { effects: () => effects, called: async (id, calls) => { written.called.push([id, calls.map((call) => call.outcome)]); }, complete: async (id) => { written.completed.push(id); } } };
  };
  // the first send failed, the retry applied, the kill landed before the door listed it: the kept answer carries the failed call
  const killed = journalOf([effect('a')]);
  await settleEffects(killed.journal, { answered: async () => ({ args: {}, value: 1, calls: [{ outcome: 'failed' }] }) });
  assert.deepEqual(killed.written, { called: [['a', ['failed', 'applied']]], completed: ['a'] });
  // an applied call already listed: none is added, and the effect still completes
  const listed = journalOf([effect('b')]);
  await settleEffects(listed.journal, { answered: async () => ({ args: {}, value: 1, calls: [{ outcome: 'failed' }, { outcome: 'applied' }] }) });
  assert.deepEqual(listed.written, { called: [], completed: ['b'] });
  // nothing to answer it from: nothing is reported
  const open = journalOf([effect('c')]);
  await settleEffects(open.journal, {});
  assert.deepEqual(open.written, { called: [], completed: [] });
  assert.deepEqual(appliedOnce([{ outcome: 'failed' }], { outcome: 'applied' }), { calls: [{ outcome: 'failed' }, { outcome: 'applied' }], added: true });
  // the record that results folds to repeated 0
  const line = (commit, gen, calls, snapshot) => ({ channel: 'durable', source: 'workflow', gen, commit, order: 0, t: commit, ...(snapshot ? { snapshot: true } : {}), kind: 'agentrun.effects', data: { doc: 'agentrun.effects', key: 'run\u0000step#call:0', value: { status: 'completed', calls } } });
  assert.equal(fold([line(1, 1, [{ outcome: 'failed' }]), line(2, 2, [{ outcome: 'failed' }, { outcome: 'applied' }])]).repeated.effects, 0);
});
