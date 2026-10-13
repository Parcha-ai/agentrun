// The reference assembly, run as a stranger would: `run.ts --json` with no key and nothing in the environment but
// PATH, HOME and TMPDIR. Then a process killed inside the lead's request after the browser read, and a second process
// that resumes the same directory and delivers the same record.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeBackend } from '@parcha/pi-browser/testing';
import { fakes } from './reference/job.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const READ = 'evidence/investigate/browser_read-be8651870263.json';
const LOOK = 'evidence/investigate/look-8f3e9456ddc1.json';
const OUTPUT = { company: 'Acme Ltd', answer: 'Acme Ltd was incorporated on 2019-03-04.', citations: [READ, LOOK], supported: true };
const EXPECTED = JSON.parse(await readFile(new URL('./reference/expected.json', import.meta.url), 'utf8'));

/** One process: its exit, the signal that ended it, and what it printed. */
function node(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reference-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the job on the no-key host prints the same record, receipts and calls on every run, each fake called once', { timeout: 120_000 }, async (t) => {
  const tmp = await scratch(t);
  const ran = await node(['examples/reference/run.ts', '--json'], { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), EXPECTED);
});

test('a relative --dir with a trailing slash runs the same job and names the receipts it filed', { timeout: 120_000 }, async (t) => {
  const tmp = await scratch(t);
  const ran = await node(['examples/reference/run.ts', '--json', '--dir', `${relative(ROOT, join(tmp, 'run'))}/`], { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp });
  assert.equal(ran.code, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), EXPECTED);
  assert.deepEqual(JSON.parse(await readFile(join(tmp, 'run', 'out', 'record.json'), 'utf8')).evidence, [READ, LOOK]);
});

// The child is the CLI's run with two changes the test owns: the browser backend lives in this process, so its ledger
// outlives the child, and the lead's request after `KILL_AT` tool results ends the child with SIGKILL. It is a file, not
// `--input-type=module -e`: the disk run's watchdog worker inherits that flag and cannot start.
const at = (path) => new URL(path, import.meta.url).href;
const CHILD = `
import { remoteDriver, remoteProvider } from '${import.meta.resolve('@parcha/pi-browser/testing')}';
import { placeAt, run } from '${at('./reference/assemble.ts')}';
import { localHost } from '${at('./reference/host.ts')}';
import { fakes, job } from '${at('./reference/job.ts')}';
import { summary } from '${at('./reference/run.ts')}';
const place = await placeAt(process.env.DIR);
const model = (messages) => {
  if (messages.filter((message) => message.role === 'toolResult').length === Number(process.env.KILL_AT)) process.kill(process.pid, 'SIGKILL');
  return fakes.model(messages);
};
const browser = { provider: () => remoteProvider(process.env.BACKEND), driver: remoteDriver(process.env.BACKEND) };
const local = localHost(place, { ...fakes, model }, { browser });
console.log(JSON.stringify(summary(place, await run(place, local.host, job), local)));
`;

test('killed in the lead\'s request after the browser read, a second process resumes the directory and delivers the same record', { timeout: 120_000 }, async (t) => {
  const tmp = await scratch(t);
  const dir = join(tmp, 'run');
  const backend = new FakeBackend({ start: fakes.start, pages: fakes.pages });
  const served = await backend.serve();
  t.after(() => served.close());
  const env = { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DIR: dir, BACKEND: served.url };
  const child = join(tmp, 'child.mjs');
  await writeFile(child, CHILD);

  const killed = await node([child], { ...env, KILL_AT: '2' });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.deepEqual(backend.dispatched.map((row) => row.op), ['run', 'read'], 'the page was opened and read before the kill');
  const eventsOf = async () => (await readFile(join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const cut = (await eventsOf()).length;

  const resumed = await node([child], env);
  assert.equal(resumed.code, 0, resumed.stderr);
  const view = JSON.parse(resumed.stdout);
  assert.equal(view.status, 'complete');
  assert.deepEqual(view.output, OUTPUT, 'the same record, citing the same receipts');
  assert.deepEqual(view.evidence, [READ, LOOK], 'the read filed once: no receipt was filed twice');
  assert.equal(view.did.disk.generation, 2);
  assert.deepEqual(view.did.browser, { launched: 1, updated: 1, 'reconcile.kept': 1, released: 1 }, 'the resumed run kept the session the killed one opened');
  // The disk run's open resumes the workflow's task; the task runs no step until the browser has reconciled.
  const first = (await eventsOf()).slice(cut, cut + 2).map((event) => (event.source === 'browser' && 'reconciled' in event ? 'reconcile' : `${event.source} ${event.event?.type}`));
  assert.deepEqual(first, ['reconcile', 'workflow node.start'], 'the resumed process reconciled the browser before any step ran');

  // Asked again: only the request the kill cut. Not repeated: the search (answered from its receipt), the browser's
  // `run` and read (their results were committed), the judge, and every other request.
  const rows = (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const calls = rows.reduce((counts, row) => ({ ...counts, [`${row.kind}:${row.name}`]: (counts[`${row.kind}:${row.name}`] ?? 0) + 1 }), {});
  assert.deepEqual(calls, { 'tool:search': 1, 'model:turn 0': 1, 'model:turn 1': 1, 'model:turn 2': 2, 'model:turn 3': 1, 'judge:verdict': 1 });
  assert.equal(new Set(rows.filter((row) => row.name === 'turn 2').map((row) => row.pid)).size, 2, 'once in each process');
  const ops = (op) => backend.ledger.filter((row) => row.op === op).length;
  assert.deepEqual({ create: ops('create'), release: ops('release'), page: backend.dispatched.map((row) => row.op) }, { create: 1, release: 1, page: ['run', 'read'] },
    'one session, kept across the kill by the resumed run\'s reconcile and released once');
});
