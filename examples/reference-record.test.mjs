// The recorder: the reference job run in this process with a recorder, a store read of the test's own standing in for the
// package's export, and the recording it leaves checked by the validator. The spools of a killed process are torn at the end.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { placeAt, run } from './reference/assemble.ts';
import { localHost } from './reference/host.ts';
import { fakes, job } from './reference/job.ts';
import { codeOf, finishRecording, moveImages, openRecorder } from './reference/record.ts';

const lines = (dir) => readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** A commit recorder of the test's own standing in for the package's: a snapshot, then two commits of two lines each. */
const commits = async (_input, write) => {
  const gen = 1;
  const line = (commit, order, over = {}) => write({ channel: 'durable', source: 'workflow', kind: 'agentrun.driver', gen, commit, order, data: { doc: 'agentrun.driver', value: { generation: gen, commit } }, ...over });
  line(1, 0, { snapshot: true });
  for (const commit of [2, 3]) for (const order of [0, 1]) line(commit, order);
  return async () => undefined;
};

test('the reference job leaves a recording the validator passes, with live, host and durable lines and every image as a blob', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'recording');
  const place = await placeAt(join(tmp, 'run'));
  const store = join(place.store, 'run.sqlite');
  const recorder = openRecorder({ dir, commits });
  const local = localHost(place, fakes, { recorder });
  const result = await run(place, local.host, job);
  assert.equal(result.status, 'complete');
  recorder.memo('vision:look:k', { answer: 'x', image: { type: 'image', mimeType: 'image/png', data: Buffer.from('png bytes').toString('base64') } });
  await recorder.detach();
  const resultBlob = recorder.blob(readFileSync(join(place.root, 'out', 'record.json')), 'json');
  finishRecording(dir, {
    title: 'test', task: 'reference', model: 'faux/faux-1', generations: result.generation, kills: 0, code: codeOf(join(import.meta.dirname, '..')),
    cost: { usd: 0, parts: { 'faux/faux-1': 0 } }, source: { run: place.id, store }, result: { blob: resultBlob, title: 'The record' },
  });
  assert.deepEqual(validateRecording(dir), []);
  const all = lines(dir);
  assert.ok(all.some((line) => line.channel === 'live' && line.source === 'workflow' && line.kind === 'node.start' && typeof line.path === 'string'), 'a workflow event with its path');
  assert.ok(all.some((line) => line.channel === 'live' && line.source === 'browser' && line.kind === 'launched'), 'a browser session row');
  assert.ok(all.some((line) => line.source === 'host' && line.kind === 'process.started'));
  assert.ok(all.some((line) => line.source === 'host' && line.kind === 'result' && line.blobs?.length === 1));
  assert.ok(all.some((line) => line.channel === 'live' && line.kind === 'EvidenceRecord' && line.blobs?.length === 1), 'a receipt filed as a blob');
  assert.equal(all.filter((line) => line.channel === 'durable' && line.kind === 'agentrun.driver').length, 5);
  assert.equal(all.filter((line) => line.snapshot === true).length, 1, 'a snapshot at the process\'s open');
  const memo = all.find((line) => line.kind === 'pi.memo');
  assert.deepEqual([memo.commit, memo.order, memo.data.value.image.type, 'data' in memo.data.value.image, memo.blobs.length], [3, 2, 'image', false, 1], 'a memo follows its commit\'s lines, its image as a blob');
  assert.ok(existsSync(join(dir, 'blobs')) && readdirSync(join(dir, 'blobs')).length >= 3);
  assert.equal(existsSync(join(dir, '.spool')), false, 'the spool is gone');
  assert.equal(JSON.stringify(all).includes(Buffer.from('png bytes').toString('base64')), false);
});

test('a process killed mid-write leaves a torn last spool line, which the merge drops', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'recording');
  const recorder = openRecorder({ dir });
  recorder.host('process.started', { pid: 1 });
  appendFileSync(join(dir, '.spool', readdirSync(join(dir, '.spool')).find((name) => name.startsWith('live-'))), '{"channel":"live","sou');
  finishRecording(dir, { title: 't', task: 't', model: 'm', generations: 1, kills: 0, code: { repo: 'r', commit: 'c', packages: {} }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  assert.equal(lines(dir).length, 1);
  assert.deepEqual(validateRecording(dir), []);
});

test('an image block leaves the line for blobs/ and keeps its type, mime type and hash', () => {
  const kept = [];
  const moved = moveImages({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64') }] }, (bytes, extension) => { kept.push([bytes.toString(), extension]); return 'f'.repeat(64); });
  assert.deepEqual(moved.data, { content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/jpeg', blob: 'f'.repeat(64) }] });
  assert.deepEqual([kept, moved.blobs], [[['jpeg', 'jpg']], ['f'.repeat(64)]]);
});

test('every live line passes the redactor before it is written', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'recording');
  const recorder = openRecorder({ dir, redact: (text) => text.replaceAll('hunter2', '[redacted]') });
  recorder.live('browser', 'updated', { url: 'http://x/?p=hunter2' });
  finishRecording(dir, { title: 't', task: 't', model: 'm', generations: 1, kills: 0, code: { repo: 'r', commit: 'c', packages: {} }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').includes('hunter2'), false);
});
