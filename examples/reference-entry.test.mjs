// The reference directory's one entry: its names are a surface another example imports, so they are listed here.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as entry from './reference/index.ts';
import { fakes, job } from './reference/job.ts';

test('the entry exports the names another example builds on, and nothing else', () => {
  assert.deepEqual(Object.keys(entry).sort(), ['RUN_KEY', 'codeOf', 'finishRecording', 'localHost', 'openRecorder', 'packageCommitRecorder', 'placeAt', 'run']);
  for (const name of ['run', 'placeAt', 'localHost', 'openRecorder', 'finishRecording', 'codeOf', 'packageCommitRecorder']) assert.equal(typeof entry[name], 'function', name);
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
