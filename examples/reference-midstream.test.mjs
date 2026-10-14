// A real recording, made on whichever pi this tree runs on: the faux model streams, process 1 is killed mid-stream of turn 0, process 2
// resumes. The re-asked fold reads pi.live version 1 (pi-durable 1.1.0); on another version it is not measured, and this test fails to
// say so rather than adapting. The pi-1-2 job runs it on pi 1.2. It needs the store export (`recordCommits`) and skips without it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { FakeBackend } from '@parcha/pi-browser/testing';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { codeOf, finishRecording, openSupervisor } from './reference/record.ts';
import { fakes } from './reference/job.ts';

const exported = await import('@parcha/agentrun-pi/durable').then((durable) => typeof durable.recordCommits === 'function' && typeof durable.snapshotLines === 'function', () => false);
// A resume happens inside the disk run's open, so the commits that restart an ask are the recorder's only through the disk's beforeResume hook.
const diskDir = dirname(fileURLToPath(import.meta.resolve('@parcha/pi-durable-disk')));
const hook = readdirSync(diskDir).some((file) => file.endsWith('.js') && readFileSync(join(diskDir, file), 'utf8').includes('before-resume'));
const at = (path) => new URL(path, import.meta.url).href;
const CHILD = `
import { remoteDriver, remoteProvider } from '${import.meta.resolve('@parcha/pi-browser/testing')}';
import { placeAt, run } from '${at('./reference/assemble.ts')}';
import { localHost } from '${at('./reference/host.ts')}';
import { fakes, job } from '${at('./reference/job.ts')}';
import { openRecorder } from '${at('./reference/record.ts')}';
import { packageCommitRecorder } from '${at('./reference/record-store.ts')}';
const place = await placeAt(process.env.DIR);
const model = (messages) => {
  if (process.env.KILL_AFTER_MS && messages.filter((message) => message.role === 'toolResult').length === 0) setTimeout(() => process.kill(process.pid, 'SIGKILL'), Number(process.env.KILL_AFTER_MS));
  return fakes.model(messages);
};
const browser = { provider: () => remoteProvider(process.env.BACKEND), driver: remoteDriver(process.env.BACKEND), createDeadlineMs: 3_000 };
const recorder = openRecorder({ dir: process.env.RECORD_DIR, commits: await packageCommitRecorder() });
const result = await run(place, localHost(place, { ...fakes, model }, { browser, recorder }).host, job);
await recorder.detach();
console.log(JSON.stringify({ status: result.status }));
`;
const go = (file, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', file], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.on('close', (code, signal) => resolve({ code, signal, out }));
});

test('killed mid-stream and resumed: turn 0 is asked twice (proven from pi.live), four turns commit, pi.live is version 1', { skip: exported && hook ? false : 'the store export (recordCommits) or the disk package\'s beforeResume hook is not in this build', timeout: 180_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-midstream-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const backend = new FakeBackend({ start: fakes.start, pages: fakes.pages });
  const served = await backend.serve();
  t.after(() => served.close());
  const dir = join(tmp, 'recording');
  const supervisor = openSupervisor({ dir });
  const child = join(tmp, 'child.mjs');
  await writeFile(child, CHILD);
  const env = { HOME: tmp, TMPDIR: tmp, DIR: join(tmp, 'run'), BACKEND: served.url, RECORD_DIR: dir };
  supervisor.host('process.started', { gen: 1 });
  const killed = await go(child, { ...env, KILL_AFTER_MS: '200' });
  assert.equal(killed.signal, 'SIGKILL', killed.out);
  supervisor.host('kill', { gen: 1, label: 'mid-stream turn 0', crossing: null });
  supervisor.host('process.started', { gen: 2 });
  const resumed = await go(child, env);
  assert.equal(JSON.parse(resumed.out.trim()).status, 'complete', resumed.out);
  finishRecording(dir, { title: 'mid-stream', task: 'reference', model: 'faux/faux-1', generations: 2, kills: 1, code: codeOf(join(import.meta.dirname, '..')), cost: { usd: 0, parts: {} }, source: { run: 'reference', store: join(tmp, 'run', 'store', 'run.sqlite') } });
  assert.deepEqual(validateRecording(dir), []);
  const lines = readEvents(dir);
  const versions = new Set(lines.filter((line) => line.kind === 'pi.live').map((line) => line.data?.version));
  assert.deepEqual([...versions], [1], 'pi.live is data.version 1: another version means the re-asked fold is not measured');
  const counted = fold(lines);
  assert.deepEqual([counted.reAsked, counted.modelTurnsCommitted, counted.repeated, counted.askedTwice], [{ turns: 1, asks: 2 }, 4, { effects: 0, agentToolCalls: 0 }, 0]);
  assert.ok(readFileSync(join(dir, 'manifest.json'), 'utf8').includes('@earendil-works/pi-durable'));
});
