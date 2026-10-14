// The reference directory's one entry: its names are a surface another example imports, so they are listed here.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
