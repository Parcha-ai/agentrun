// demo:kill --record: the killed and resumed run leaves an agentrun.recording/1 directory that the validator passes, with the supervisor's
// own process.started, kill and result lines, and the counters folded from it equal the ledger's.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { killAnywhere } from './reference/kill-anywhere.ts';

test('a seeded run with two kills records: valid, one start per process, a kill line per kill, and the counters equal the ledger', { timeout: 300_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'kill-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = join(tmp, 'recording');
  const ledger = await killAnywhere({ seed: 21, kills: 2, record: dir });
  assert.deepEqual(ledger.checks.filter((check) => !check.ok), []);
  assert.deepEqual(validateRecording(dir), []);
  const lines = readEvents(dir);
  const supervisor = lines.filter((line) => line.source === 'host' && line.channel === 'live');
  assert.equal(supervisor.filter((line) => line.kind === 'process.started').length, ledger.processes);
  assert.equal(supervisor.filter((line) => line.kind === 'kill').length, 2);
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).kills, supervisor.filter((line) => line.kind === 'kill').length, 'the manifest counts the kill lines the supervisor wrote');
  assert.ok(supervisor.every((line) => line.gen === undefined), 'the supervisor\'s lines carry no event-level gen');
  assert.equal(supervisor.filter((line) => line.kind === 'result').length, 1);
  const counted = fold(lines);
  assert.deepEqual([counted.processes, counted.kills, counted.paid.total, counted.unknown, counted.modelTurns.committed], [ledger.processes, 2, 1, 0, ledger.counted.committedTurns.length]);
});

test('a directory that already holds a recording, finished or not, is refused before anything runs', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'kill-record-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const unfinished = join(tmp, 'unfinished');
  mkdirSync(join(unfinished, '.spool'), { recursive: true });
  await assert.rejects(() => killAnywhere({ seed: 21, kills: 0, record: unfinished }), /already holds a recording/);
  const finished = join(tmp, 'finished');
  mkdirSync(finished, { recursive: true });
  writeFileSync(join(finished, 'manifest.json'), '{}');
  await assert.rejects(() => killAnywhere({ seed: 21, kills: 0, record: finished }), /already holds a recording/);
});
