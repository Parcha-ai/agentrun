// The recorder: the reference job run in this process with a recorder, a store read of the test's own standing in for the
// package's export, and the recording it leaves checked by the validator. The spools of a killed process are torn at the end.
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as validator from '../scripts/recording/validate.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { placeAt, run } from './reference/assemble.ts';
import { localHost } from './reference/host.ts';
import { fakes, job } from './reference/job.ts';
import { codeOf, finishRecording, moveImages, openRecorder, openSupervisor } from './reference/record.ts';
import * as scan from './reference/scan.ts';

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
  const recorder = openRecorder({ dir, commits, supervisor: openSupervisor({ dir }) });
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
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).providers, 'scripted', 'the faux job is scripted');
  const all = lines(dir);
  assert.ok(all.some((line) => line.channel === 'live' && line.source === 'workflow' && line.kind === 'node.start' && typeof line.path === 'string'), 'a workflow event with its path');
  assert.ok(all.some((line) => line.channel === 'live' && line.source === 'browser' && line.kind === 'launched'), 'a browser session row');
  assert.ok(all.some((line) => line.source === 'host' && line.kind === 'process.started' && line.gen === undefined && line.data.gen === 1), 'the supervisor\'s line for the process, with no event-level gen');
  const payoff = all.find((line) => line.source === 'host' && line.kind === 'result');
  assert.deepEqual([payoff.gen, payoff.data.gen, typeof payoff.data.blob, payoff.data.title, payoff.blobs], [undefined, 1, 'string', 'The record', [payoff.data.blob]], 'the result is a supervisor line: no event-level gen, the process in data');
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
  finishRecording(dir, { title: 't', task: 't', model: 'm', generations: 1, kills: 0, code: { repo: 'r', commit: 'c', packages: { '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
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
  finishRecording(dir, { title: 't', task: 't', model: 'm', generations: 1, kills: 0, code: { repo: 'r', commit: 'c', packages: { '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8').includes('hunter2'), false);
});

test('a conversation the store names has its agent events recorded as live pi lines, with gen and seq, and nothing streams in', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'recording');
  const watched = [];
  const commits = async (_input, write) => {
    write({ channel: 'durable', source: 'pi', kind: 'pi.assistant', gen: 1, commit: 1, order: 0, conv: 5, snapshot: true, data: { doc: 'pi.agent', value: {} } });
    write({ channel: 'durable', source: 'pi', kind: 'pi.assistant', gen: 1, commit: 2, order: 0, conv: 5, data: { model: [] } });
    return async () => undefined;
  };
  const watch = async (_session, conv) => {
    watched.push(conv);
    return {
      start(listener) {
        void listener([{ type: 'turn_start' }, { type: 'message_update', changes: [] }, { type: 'message_end', entry: { id: 1, secret: 'hunter2' } }, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {} }, { type: 'turn_end' }]);
      },
      async stop() {},
    };
  };
  const recorder = openRecorder({ dir, commits, watch, supervisor: openSupervisor({ dir }), redact: (text) => text.replaceAll('hunter2', '[redacted]') });
  recorder.generation(1);
  await recorder.attach({ session: {}, context: {}, gen: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await recorder.detach();
  finishRecording(dir, { title: 't', task: 't', model: 'm', generations: 1, kills: 0, code: { repo: 'r', commit: 'c', packages: { '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  assert.deepEqual(watched, [5], 'one watcher per conversation, however many lines name it');
  const pi = lines(dir).filter((line) => line.channel === 'live' && line.source === 'pi');
  assert.deepEqual(pi.map((line) => line.kind), ['turn_start', 'message_end', 'tool_execution_start', 'turn_end']);
  assert.ok(pi.every((line) => line.gen === 1 && line.conv === 5), 'each carries the process\'s gen and its conversation');
  assert.deepEqual(pi.map((line) => line.seq), [0, 1, 2, 3]);
  assert.equal(JSON.stringify(pi).includes('hunter2'), false, 'redacted before it was written');
  assert.deepEqual(validateRecording(dir), []);
});

test('a resumed directory records its own process numbers: the second recording of one run is process 1, whatever the run\'s lease generation', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'recording');
  const recorder = openRecorder({ dir, supervisor: openSupervisor({ dir }) });
  recorder.generation(2);
  recorder.live('workflow', 'node.start', { type: 'node.start' });
  finishRecording(dir, { title: 't', task: 't', model: 'm', kills: 0, code: { repo: 'r', commit: 'c', packages: { '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generations, 1, 'the recording holds one process, whatever the lease says');
  assert.deepEqual(lines(dir).map((line) => [line.kind, line.gen ?? line.data.gen]), [['process.started', 1], ['node.start', 1]]);
  assert.deepEqual(validateRecording(dir), []);
});

test('a process start sorts before the lines it writes at the same millisecond, and detach stops a watcher still being set up', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'recording');
  let stopped = 0;
  const commits = async (_input, write) => {
    write({ channel: 'durable', source: 'pi', kind: 'pi.assistant', conv: 5, commit: 1, order: 0, snapshot: true, data: { model: [] } });
    return async () => undefined;
  };
  const watch = (_session, _conv) => new Promise((resolve) => setTimeout(() => resolve({ start() {}, async stop() { stopped += 1; } }), 30));
  const recorder = openRecorder({ dir, commits, watch, supervisor: openSupervisor({ dir }) });
  recorder.generation(1);
  await recorder.attach({ session: {}, context: {}, gen: 1 });
  await recorder.detach();
  assert.equal(stopped, 1, 'the watcher whose setup had not finished is stopped');
  finishRecording(dir, { title: 't', task: 't', model: 'm', kills: 0, code: { repo: 'r', commit: 'c', packages: { '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  const order = lines(dir).map((line) => line.kind);
  assert.ok(order.indexOf('process.started') < order.indexOf('pi.assistant'), order.join(','));
  // and at one millisecond exactly: the merge itself puts the start first
  const tied = join(tmp, 'tied');
  mkdirSync(join(tied, '.spool'), { recursive: true });
  writeFileSync(join(tied, '.spool', 'started'), new Date().toISOString());
  writeFileSync(join(tied, '.spool', 'durable-1.jsonl'), JSON.stringify({ channel: 'durable', source: 'pi', kind: 'pi.assistant', gen: 1, commit: 1, order: 0, snapshot: true, t: 7, data: {} }) + '\n');
  writeFileSync(join(tied, '.spool', 'supervisor-1.jsonl'), JSON.stringify({ channel: 'live', source: 'host', kind: 'process.started', t: 7, seq: 0, data: { gen: 1 } }) + '\n');
  finishRecording(tied, { title: 't', task: 't', model: 'm', kills: 0, code: { repo: 'r', commit: 'c', packages: {} }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  assert.deepEqual(lines(tied).map((line) => line.kind), ['process.started', 'pi.assistant']);
  // a kill and the next start, one millisecond apart in no order: the supervisor's own seq decides
  const sup = join(tmp, 'sup');
  mkdirSync(join(sup, '.spool'), { recursive: true });
  writeFileSync(join(sup, '.spool', 'started'), new Date().toISOString());
  writeFileSync(join(sup, '.spool', 'supervisor-1.jsonl'), [{ kind: 'process.started', seq: 0, t: 8 }, { kind: 'kill', seq: 1, t: 9 }, { kind: 'process.started', seq: 2, t: 9 }].map((line) => JSON.stringify({ channel: 'live', source: 'host', data: { gen: 1 }, ...line })).join('\n') + '\n');
  finishRecording(sup, { title: 't', task: 't', model: 'm', kills: 0, code: { repo: 'r', commit: 'c', packages: {} }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  assert.deepEqual(lines(sup).map((line) => line.seq), [0, 1, 2]);
  // the circle the ranks once made: a kill, the next start and the lines that process writes, all at one millisecond
  const circle = join(tmp, 'circle');
  mkdirSync(join(circle, '.spool'), { recursive: true });
  writeFileSync(join(circle, '.spool', 'started'), new Date().toISOString());
  writeFileSync(join(circle, '.spool', 'supervisor-1.jsonl'), [{ kind: 'process.started', seq: 0, t: 3, data: { gen: 1 } }, { kind: 'kill', seq: 1, t: 4, data: { gen: 1 } }, { kind: 'process.started', seq: 2, t: 4, data: { gen: 2 } }].map((line) => JSON.stringify({ channel: 'live', source: 'host', ...line })).join('\n') + '\n');
  writeFileSync(join(circle, '.spool', 'durable-2.jsonl'), JSON.stringify({ channel: 'durable', source: 'pi', kind: 'pi.assistant', gen: 2, commit: 1, order: 0, snapshot: true, t: 4, data: {} }) + '\n');
  writeFileSync(join(circle, '.spool', 'live-2.jsonl'), JSON.stringify({ channel: 'live', source: 'workflow', kind: 'node.start', gen: 2, t: 4, seq: 0, data: {} }) + '\n');
  finishRecording(circle, { title: 't', task: 't', model: 'm', kills: 0, code: { repo: 'r', commit: 'c', packages: {} }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') } });
  assert.deepEqual(lines(circle).map((line) => line.kind), ['process.started', 'kill', 'process.started', 'pi.assistant', 'node.start']);
});

test('the recorder scans before it finishes: a credential or a machine path in a line, a blob or the manifest writes no manifest', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const header = (over = {}) => ({ title: 't', task: 't', model: 'm', generations: 1, kills: 0, code: { repo: 'r', commit: 'c', packages: { '@earendil-works/pi-durable': '1.1.0', '@earendil-works/pi-ai': '1.1.0' } }, cost: { usd: 0, parts: {} }, source: { run: 'r', store: join(tmp, 'none.sqlite') }, ...over });
  const secret = `sk-${'a1'.repeat(20)}`;
  const machinePath = ['', 'home', 'someone', 'work', ''].join('/');
  const cases = [
    ['a line', (recorder) => recorder.live('workflow', 'node.start', { header: secret }), {}, /holds a provider secret in events\.jsonl/],
    ['a blob', (recorder) => recorder.blob(`token ${secret}`, 'txt'), {}, /holds a provider secret in blobs\/[0-9a-f]{64}\.txt/],
    // A JSON string in a text blob can hide the shape behind an escape; the scan decodes it, as the validator does.
    ['an escaped key in a text blob', (recorder) => recorder.blob(`"\\u0073k-${'a1'.repeat(20)}"`, 'txt'), {}, /holds a provider secret in blobs\/[0-9a-f]{64}\.txt/],
    ['a machine path', (recorder) => recorder.live('pi', 'message_end', { cwd: machinePath }), {}, /holds a machine path in events\.jsonl/],
    ['the manifest', () => undefined, { title: secret }, /holds a provider secret in manifest\.json/],
  ];
  for (const [where, act, over, message] of cases) {
    const dir = join(tmp, where.replaceAll(' ', '-'));
    const recorder = openRecorder({ dir });
    recorder.host('process.started', { pid: 1 });
    act(recorder);
    assert.throws(() => finishRecording(dir, header(over)), message, where);
    assert.ok(!existsSync(join(dir, 'manifest.json')), `${where}: not a finished recording`);
  }
  const clean = join(tmp, 'clean');
  openRecorder({ dir: clean }).host('process.started', { pid: 1 });
  finishRecording(clean, header());
  assert.deepEqual(validateRecording(clean), []);
  // A finished recording is refused before anything in it changes: its events stay the ones its manifest describes.
  const events = readFileSync(join(clean, 'events.jsonl'), 'utf8');
  openRecorder({ dir: clean }).live('workflow', 'node.start', { header: secret });
  assert.throws(() => finishRecording(clean, header()), /already holds a finished recording/);
  assert.equal(readFileSync(join(clean, 'events.jsonl'), 'utf8'), events);
});

test('one scanner: the validator and the gallery\'s gate use the recorder\'s own', () => {
  assert.equal(validator.credentialIn, scan.credentialIn);
  assert.equal(validator.credentialInValue, scan.credentialInValue);
  // The gate imports the scanner itself, by the same module.
  const gate = readFileSync(new URL('../scripts/recording/gate.mjs', import.meta.url), 'utf8');
  assert.match(gate, /^import \{ credentialIn \} from '\.\.\/\.\.\/examples\/reference\/scan\.ts';$/m);
});
