// The reference child as an app module (examples/reference/child-app.ts) under `pi-durable-disk run --dir <dir> --app`: one open path, the disk package's own. The job runs on fakes to the end, its
// outcome line carries the record, and run.json's final status `done` carries the record and the store's hash too (a box place has only run.json). A kill -9 (a crossing that ends the process) and the
// same command again resumes the run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeBackend } from '@parcha/pi-browser/testing';

const CLI = fileURLToPath(new URL('../packages/pi-durable-disk/dist/cli.js', import.meta.url));
const APP = fileURLToPath(new URL('./reference/child-app.ts', import.meta.url));
const FIXTURE = new URL('./reference/demo-fixture.ts', import.meta.url);

async function instance(t, env) {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-app-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const spec = join(tmp, 'demo.json');
  writeFileSync(spec, JSON.stringify({ name: 'reference' }));
  process.env.DEMO_SPEC = spec;
  const { options } = await import(FIXTURE.href);
  const backend = new FakeBackend({ start: options.fakes.start, pages: options.fakes.pages });
  const served = await backend.serve();
  t.after(() => served.close());
  const dir = join(tmp, 'run');
  const start = (extra = {}) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'run', '--dir', dir, '--app', APP, '--id', 'reference'], {
      env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DEMO_SPEC: spec, DEMO_ENTRY: FIXTURE.href, BACKEND: served.url, BROWSER: 'fake', ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', (code, signal) => resolve({ code, signal, stderr: stderr.slice(-400), outcome: stdout.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((row) => row.outcome)?.outcome }));
  });
  return { dir, start };
}

test('the reference job runs to the end under pi-durable-disk run --app: exit 0, the outcome line has the record, and run.json is done with the record and the store\'s hash', { timeout: 180_000 }, async (t) => {
  const { dir, start } = await instance(t, {});
  const result = await start();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.outcome.status, 'complete');
  assert.equal(result.outcome.record.company, 'Acme Ltd');
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.equal(run.status, 'done');
  assert.deepEqual(run.detail.record, result.outcome.record, 'run.json has the record: a box place reads only that');
  assert.match(run.detail.storeSha256, /^[0-9a-f]{64}$/);
});

test('kill -9 at a crossing and the same command again resumes the run, on the disk package\'s own claim: generation 2, the record the uninterrupted run\'s', { timeout: 240_000 }, async (t) => {
  const { dir, start } = await instance(t, {});
  const plan = { tools: [], run: { point: 'judge.asked verdict', kind: 'process', target: 'run', why: 'kill -9', n: 1 } };
  const killed = await start({ PLAN: JSON.stringify(plan), CROSS_LOG: join(dir, '..', 'crossings.jsonl') });
  assert.equal(killed.signal, 'SIGKILL', 'the crossing ended the process');
  const resumed = await start();
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.deepEqual([resumed.outcome.status, resumed.outcome.generation], ['complete', 2]);
  assert.equal(resumed.outcome.record.company, 'Acme Ltd');
  assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).status, 'done');
});

test('nothing is written under the run\'s directory before the claim is open: the recorder\'s lines wait in memory and are written, in order, in the directory the mount then shows', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-app-open-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const spec = join(tmp, 'demo.json');
  writeFileSync(spec, JSON.stringify({ name: 'reference' }));
  process.env.DEMO_SPEC = spec;
  const { options } = await import(FIXTURE.href);
  const { prepareChild } = await import('./reference/demo.ts');
  // The run's directory does not exist yet: the mountpoint is bare until the claim mounts the disk, and whatever is written there is hidden by it.
  const root = join(tmp, 'mountpoint');
  const record = join(root, 'record');
  const prepared = await prepareChild(options, { RECORD_DIR: record, BACKEND: 'http://127.0.0.1:1' }, { id: 'reference', root, work: join(root, 'work'), store: join(root, 'store') });
  prepared.recorder.host('process.started', { gen: 1, pid: 1 });
  prepared.recorder.live('workflow', 'first', { n: 1 });
  prepared.recorder.live('workflow', 'second', { n: 2 });
  assert.equal(existsSync(root), false, 'the recorder, the spool and the started file wrote nothing before the open');
  assert.throws(() => prepared.recorder.blob('x', 'txt'), /before the run is open/, 'a write that cannot wait fails loudly');
  // The mount appears, and the claim is open: the recorder starts and the held lines come out, in order.
  mkdirSync(root, { recursive: true });
  await prepared.open();
  const spool = join(record, '.spool');
  const lines = readdirSync(spool).filter((name) => name.startsWith('live-')).flatMap((name) => readFileSync(join(spool, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  assert.deepEqual(lines.filter((line) => line.source === 'workflow').map((line) => line.kind), ['first', 'second'], 'no line lost, in the order they were produced');
  assert.ok(lines.some((line) => line.source === 'host' && line.kind === 'process.started'));
  await prepared.recorder.detach();
});
