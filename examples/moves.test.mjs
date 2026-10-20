// examples/moves, offline: the three generations of one session through the real CLI (`run --dir` on a local directory, the run's
// disk stood in for by that directory), with the scripted model and stand-in sandboxes. No network, no key.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../packages/pi-durable-disk/src/cli.ts', import.meta.url));
const APP = fileURLToPath(new URL('./moves/app.ts', import.meta.url));
const THREADS = 8;

/** One incarnation: `run --dir` as a child process, its output kept, resolved when it has ended. */
function generation(dir, host, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'run', '--dir', dir, '--app', APP], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), MOVES_MODE: 'offline', MOVES_HOST: host, MOVES_LEDGER_DIR: join(dir, '..', 'ledger'), ...extraEnv },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err }); });
  });
}
const runJson = (dir) => JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function wholeRun() {
  const base = mkdtempSync(join(tmpdir(), 'moves-'));
  const dir = join(base, 'run');
  mkdirSync(join(base, 'ledger'), { recursive: true });
  const steps = [];
  for (const host of ['local', 'modal', 'local']) {
    const result = await generation(dir, host);
    assert.equal(result.code, 0, `generation on ${host}: ${result.err.slice(-600)}`);
    steps.push({ host, record: runJson(dir) });
  }
  return { base, dir, steps, boxes: lines(join(base, 'ledger', 'boxes.jsonl')) };
}

import { modalHost } from '../packages/pi-durable-disk/src/hosts/modal.ts';
import { INHERIT, modalHostOptions } from './moves/live.ts';
import { moves } from './moves/run.ts';
import { movesExtensions } from './moves/tools.ts';
import { NoteError, notePath, readNote, writeNote } from './moves/notes.ts';
import { NEVER_SAYS, SAYS } from './moves/config.ts';
import { lstatSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';

test('three generations: local, a Modal VM, local; two planned moves, then done', async (t) => {
  const run = await wholeRun();
  t.after(() => rmSync(run.base, { recursive: true, force: true }));
  assert.deepEqual(run.steps.map((s) => [s.record.generation, s.record.status]), [[1, 'paused'], [2, 'paused'], [3, 'done']]);
  assert.deepEqual([run.steps[0].record.detail.moveTo, run.steps[0].record.detail.from], ['modal', 'local']);
  assert.deepEqual([run.steps[1].record.detail.moveTo, run.steps[1].record.detail.from], ['local', 'modal']);
  assert.equal(typeof run.steps[2].record.sealedSeq, 'number', 'released and sealed');
});

test('generation 2 forks 8 threads, each with its own H100 gVisor sandbox, and generation 3 reads the pick', async (t) => {
  const run = await wholeRun();
  t.after(() => rmSync(run.base, { recursive: true, force: true }));
  const created = run.boxes.filter((b) => b.ev === 'create');
  assert.equal(created.length, THREADS, 'one sandbox per thread, none for the root');
  assert.equal(new Set(created.map((b) => b.id)).size, THREADS, 'eight different sandboxes');
  for (const b of created) assert.deepEqual([b.spec.gpu, b.spec.isolation], ['H100!', 'gvisor']);
  assert.equal(run.boxes.filter((b) => b.ev === 'destroy').length, THREADS, 'every sandbox ended when the session left the VM');
  const threads = JSON.parse(readFileSync(join(run.dir, 'work', 'threads.json'), 'utf8')).threads;
  assert.equal(threads.length, THREADS);
  assert.ok(threads.every((th) => typeof th.metric === 'number' && th.settings), 'every thread reported a metric and its settings');
  const result = JSON.parse(readFileSync(join(run.dir, 'work', 'result.json'), 'utf8'));
  const best = threads.reduce((a, b) => (b.metric < a.metric ? b : a));
  assert.equal(result.picked, best.n, 'the pick is the lowest metric');
  const report = JSON.parse(readFileSync(join(run.dir, 'work', 'report.json'), 'utf8'));
  assert.deepEqual([report.generation, report.picked], [3, best.n]);
  assert.deepEqual([report.previousDetail.moveTo, report.previousDetail.from], ['local', 'modal']);
});

test('the root has no command tool: its tools write and read notes, move, fork, pick, and nothing starts a process', () => {
  const ext = movesExtensions({ work: '/nonexistent', generation: () => 1, where: 'local', threads: THREADS, hands: () => undefined });
  assert.deepEqual(ext.root.tools.map((tool) => tool.name).sort(), ['fork_threads', 'move_to', 'pick', 'read_note', 'write_note']);
  assert.deepEqual(ext.thread.tools.map((tool) => tool.name).sort(), ['gpu_bash', 'gpu_write'], 'a thread has the sandbox tools and none of the root\'s');
});

test('the root\'s file tools stay inside work/: no /proc, no environment, no path outside, no link', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'moves-notes-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const work = join(base, 'work');
  mkdirSync(work);
  writeNote(work, 'a/b.md', 'hi');
  assert.equal(readNote(work, 'a/b.md'), 'hi');
  for (const bad of ['/proc/self/environ', '../../proc/self/environ', '../outside.txt', '/etc/passwd', 'a/../../x', '', 'x\0y']) {
    assert.throws(() => readNote(work, bad), NoteError, `read ${JSON.stringify(bad)}`);
    assert.throws(() => writeNote(work, bad, 'x'), NoteError, `write ${JSON.stringify(bad)}`);
  }
  writeFileSync(join(base, 'secret.txt'), 'outside');
  symlinkSync(join(base, 'secret.txt'), join(work, 'link.txt'));
  symlinkSync(base, join(work, 'dir-link'));
  assert.throws(() => readNote(work, 'link.txt'), NoteError, 'a link to a file outside');
  assert.throws(() => readNote(work, 'dir-link/secret.txt'), NoteError, 'a link to a directory outside');
  assert.throws(() => writeNote(work, 'dir-link/new.txt', 'x'), NoteError);
  assert.ok(!readdirSync(base).includes('new.txt'));
  assert.equal(lstatSync(join(work, 'a', 'b.md')).isFile(), true);
  assert.throws(() => notePath(work, '.'), NoteError, 'work/ itself is not a file');
});

/** Every file under `dir`, read as bytes: does any contain `needle`? */
function filesContaining(dir, needle) {
  const hits = [];
  const walk = (path) => {
    for (const name of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.isFile() && readFileSync(full).includes(needle)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

test('no secret reaches a tool, a sandbox, a file, the store or a log: the values are in the instance and nowhere else', async (t) => {
  // Values made for this test, so they look like nothing real and appear nowhere else.
  const made = () => `value-${randomBytes(12).toString('hex')}`;
  const secrets = { ANTHROPIC_API_KEY: made(), MODAL_TOKEN_ID: made(), MODAL_TOKEN_SECRET: made() };
  const base = mkdtempSync(join(tmpdir(), 'moves-secrets-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'run');
  mkdirSync(join(base, 'ledger'), { recursive: true });
  let output = '';
  for (const host of ['local', 'modal', 'local']) {
    const result = await generation(dir, host, secrets);
    assert.equal(result.code, 0, result.err.slice(-600));
    output += result.out + result.err;
  }
  for (const [name, value] of Object.entries(secrets)) {
    assert.ok(!output.includes(value), `${name} is not in any output of the instance`);
    assert.deepEqual(filesContaining(base, value), [], `${name} is in no file of the run directory, its store or the ledger`);
  }
  const report = JSON.parse(readFileSync(join(dir, 'work', 'report.json'), 'utf8'));
  assert.deepEqual(report.keyLikeVariablesInTheInstance, [], 'the instance itself holds no key-like variable once it has started');
  const threads = JSON.parse(readFileSync(join(dir, 'work', 'threads.json'), 'utf8')).threads;
  for (const th of threads) assert.match(th.reply, /key-like variables seen: \[\]/, `thread ${th.n} saw no key-like variable in its sandbox`);
});

test('thinking stays on across the three generations: the earlier thinking blocks are in the context of the next', async (t) => {
  const run = await wholeRun();
  t.after(() => rmSync(run.base, { recursive: true, force: true }));
  const report = JSON.parse(readFileSync(join(run.dir, 'work', 'report.json'), 'utf8'));
  assert.match(report.answer, /The earlier thinking is in my context\./);
  assert.doesNotMatch(report.answer, /THINKING LOST/);
});

test('no process line says a kill, and the wording is the one the example is allowed', () => {
  const readme = readFileSync(new URL('./moves/README.md', import.meta.url), 'utf8');
  assert.ok(readme.replace(/\s+/g, ' ').includes(SAYS), 'the README says it in the agreed words');
  for (const never of NEVER_SAYS) assert.doesNotMatch(readme, never);
});

/** The supervisor's side with stand-in hosts: each `startOn` is one generation of the real CLI on a local directory. */
function standIns(base, { failOn } = {}) {
  const dir = join(base, 'run');
  mkdirSync(join(base, 'ledger'), { recursive: true });
  const log = { started: [], stopped: [], said: [], cleaned: 0 };
  const running = [];
  const deps = {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    say: (line) => log.said.push(line),
    async startOn(where, demand) {
      if (failOn === where) throw new Error(`the ${where} host would not start`);
      const id = `${where}-incarnation-${log.started.length + 1}`;
      log.started.push({ id, where, demand });
      running.push(generation(dir, where));
      return { where, id, handle: id };
    },
    async status() {
      return existsSync(join(dir, 'run.json')) ? runJson(dir) : null;
    },
    async stop(one) {
      log.stopped.push(one.id);
      await running[log.started.findIndex((s) => s.id === one.id)];
    },
    async work(name) {
      return readFileSync(join(dir, 'work', name), 'utf8');
    },
    async cleanup() {
      await Promise.all(running);
      log.cleaned += 1;
      return { removed: ['run'], left: [] };
    },
  };
  return { deps, log, dir };
}

test('the supervisor moves the run local -> modal -> local, demanding the paused ones, and stops each incarnation once', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'moves-sup-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { deps, log } = standIns(base);
  const report = await moves(deps);
  assert.deepEqual(report.generations.map((g) => [g.generation, g.where, g.status]), [[1, 'local', 'paused'], [2, 'modal', 'paused'], [3, 'local', 'done']]);
  assert.deepEqual(log.started.map((s) => [s.where, s.demand]), [['local', false], ['modal', true], ['local', true]], 'only the first start is a new run; the next two start a paused one');
  assert.deepEqual(log.stopped, log.started.map((s) => s.id), 'every incarnation stopped, once, in the order it ran');
  assert.equal(log.cleaned, 1);
  assert.equal(report.threads.length, THREADS);
  assert.equal(report.picked, report.threads.reduce((a, b) => (b.metric < a.metric ? b : a)).n);
  assert.match(report.answer, /won with a loss of/);
  assert.deepEqual(report.ledger, { started: log.started.map((s) => s.id), left: [] });
  assert.ok(report.generations.every((g) => typeof g.record.sealedSeq === 'number'));
});

test('a host that will not start ends the take: the earlier incarnation is stopped, the cleanup runs, the error is the host\'s', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'moves-fail-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const { deps, log } = standIns(base, { failOn: 'modal' });
  await assert.rejects(moves(deps), /the modal host would not start/);
  assert.deepEqual(log.stopped, ['local-incarnation-1']);
  assert.equal(log.cleaned, 1);
});

test('the Modal host is built from Secret names and variable names only, with the disk mounted on a VM and no value anywhere', () => {
  const sdk = { apps: {}, images: {}, secrets: { fromName: async () => ({}) }, sandboxes: {} };
  const options = modalHostOptions({ sdk, image: 'ubuntu:24.04', appName: 'app', runId: 'moves-abc123', uid: 1000, gid: 1000, secrets: ['moves-model-key', 'moves-modal-token'], prepare: async () => {} });
  assert.doesNotThrow(() => modalHost(options), 'modalHost accepts it');
  assert.equal(options.runtime, 'vm', 'the session\'s VM has its own kernel, so the disk mounts');
  assert.deepEqual(options.secrets, ['moves-model-key', 'moves-modal-token']);
  assert.deepEqual(options.inheritEnv, [...INHERIT]);
  assert.deepEqual(options.env, { MOVES_HOST: 'modal' }, 'the instance\'s plain environment holds no key');
  assert.ok(!('gpu' in options), 'the VM has no GPU: the threads\' sandboxes do');
});
