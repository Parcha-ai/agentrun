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
import { readJournal } from '@parcha/agentrun-pi/durable';
import { RUN_KEY } from './reference/assemble.ts';
import { gates } from './reference/gates.ts';
import { fakes, job } from './reference/job.ts';

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

// The child is the CLI's run with changes the test owns: the browser backend lives in this process, so its ledger
// outlives the child, and SIGKILL ends the child at one point. `KILL_AT`: the lead's request after that many tool
// results. `KILL_IN`: `search-admitted` as the tool door is asked (the call admitted, never sent), `search-landed` once
// the door has answered (sent, its result not committed), `page-attach` as the browser attaches to a session (no run
// sent yet), `page-run` as a page is asked to run (the run recorded, never sent), `page-ran` once the page has run and
// before its answer reaches the model,
// `judge-asked` once the judge has answered and before the answer is recorded, `event:<type>:<label>` just before that
// status row is written; a door point with `:<n>` kills at the n-th call. `OTHER` runs the job under another workflow
// name, and `TWICE` with a second `search` step that calls the tool with the same arguments. It is a file, not `--input-type=module -e`: the disk run's watchdog worker
// inherits that flag and cannot start.
const at = (path) => new URL(path, import.meta.url).href;
const CHILD = `
import { remoteDriver, remoteProvider } from '${import.meta.resolve('@parcha/pi-browser/testing')}';
import { placeAt, run } from '${at('./reference/assemble.ts')}';
import { localHost } from '${at('./reference/host.ts')}';
import { fakes, job } from '${at('./reference/job.ts')}';
import { summary } from '${at('./reference/run.ts')}';
const place = await placeAt(process.env.DIR);
const kill = (point) => { if (process.env.KILL_IN === point) process.kill(process.pid, 'SIGKILL'); };
const model = (messages) => {
  if (messages.filter((message) => message.role === 'toolResult').length === Number(process.env.KILL_AT)) process.kill(process.pid, 'SIGKILL');
  return fakes.model(messages);
};
const remote = remoteDriver(process.env.BACKEND);
const driver = async (...args) => {
  kill('page-attach');
  const page = await remote(...args);
  let ran = false;
  return new Proxy(page, { get: (target, name) => (name === 'run' ? async (input) => { kill('page-run'); const out = await target.run(input); ran = true; return out; }
    : name === 'url' ? () => { if (ran) kill('page-ran'); return target.url(); }
    : typeof target[name] === 'function' ? target[name].bind(target) : target[name]) });
};
const local = localHost(place, { ...fakes, model }, { browser: { provider: () => remoteProvider(process.env.BACKEND), driver } });
const door = local.host.tools.runEffect;
let calls = 0;
local.host.tools.runEffect = async (params) => {
  calls += 1;
  for (const point of ['search-admitted', \`search-admitted:\${calls}\`]) kill(point);
  const value = await door(params);
  for (const point of ['search-landed', \`search-landed:\${calls}\`]) kill(point);
  return value;
};
const judge = local.host.decisions.runJudge;
local.host.decisions.runJudge = async (request) => { const answer = await judge(request); kill('judge-asked'); return answer; };
const status = local.host.status;
local.host.status = (event) => { if (event.source === 'workflow') kill(\`event:\${event.event.type}:\${event.event.label}\`); return status(event); };
const [search, ...rest] = job.workflow.root.steps;
const twice = { ...job, workflow: { ...job.workflow, root: { ...job.workflow.root, steps: [search, { ...search, label: 'search-again', as: 'again' }, ...rest] } } };
const ofJob = process.env.OTHER ? { ...job, workflow: { ...job.workflow, name: 'another-company-check' } } : process.env.TWICE ? twice : job;
console.log(JSON.stringify(summary(place, await run(place, local.host, ofJob), local)));
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
  assert.deepEqual(calls, { 'tool:search': 1, 'model:turn 0': 1, 'browser:page.run': 1, 'model:turn 1': 1, 'browser:page.read': 1, 'model:turn 2': 2, 'model:turn 3': 1, 'judge:verdict': 1 });
  assert.equal(new Set(rows.filter((row) => row.name === 'turn 2').map((row) => row.pid)).size, 2, 'once in each process');
  const ops = (op) => backend.ledger.filter((row) => row.op === op).length;
  assert.deepEqual({ create: ops('create'), release: ops('release'), page: backend.dispatched.map((row) => row.op) }, { create: 1, release: 1, page: ['run', 'read'] },
    'one session, kept across the kill by the resumed run\'s reconcile and released once');
});

/** Processes killed at `kill` (one point, or one per process), the processes `between` on the same directory, and one
 *  that resumes it: the journal the kills left, the views of those between and of the last, the run's ledger, the
 *  backend's page operations and the gates that fail. */
async function killedAndResumed(t, kill, { between = [], env: every = {} } = {}) {
  const tmp = await scratch(t);
  const dir = join(tmp, 'run');
  const backend = new FakeBackend({ start: fakes.start, pages: fakes.pages });
  const served = await backend.serve();
  t.after(() => served.close());
  const env = { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DIR: dir, BACKEND: served.url, ...every };
  const child = join(tmp, 'child.mjs');
  await writeFile(child, CHILD);
  const killed = [];
  for (const point of [kill].flat()) killed.push(await node([child], { ...env, ...point }));
  const cut = readJournal(join(dir, 'store', 'run.sqlite'), RUN_KEY);
  const others = [];
  for (const extra of between) others.push(JSON.parse((await node([child], { ...env, ...extra })).stdout));
  const resumed = await node([child], env);
  for (const each of killed) assert.equal(each.signal, 'SIGKILL', each.stderr);
  assert.equal(resumed.code, 0, resumed.stderr);
  const rows = (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const failing = gates(dir, job).filter(({ ok }) => !ok).map(({ id }) => id);
  return { cut, journal: readJournal(join(dir, 'store', 'run.sqlite'), RUN_KEY), view: JSON.parse(resumed.stdout), others, rows, pages: backend.dispatched.map((row) => row.op), failing };
}
const named = (rows, kind) => rows.filter((row) => row.kind === kind).map((row) => row.name);

test('killed after the search answered and before its result committed, the resumed run takes the answer and sends nothing again', { timeout: 120_000 }, async (t) => {
  const { view, rows, failing } = await killedAndResumed(t, { KILL_IN: 'search-landed' });
  assert.deepEqual(view.output, OUTPUT, 'the same record');
  assert.deepEqual(named(rows, 'tool'), ['search'], 'the search ran once, in the killed process');
  assert.deepEqual(failing, []);
});

test('killed after the search was admitted and before it was sent, the resumed run is refused and never sends it', { timeout: 120_000 }, async (t) => {
  const { view, rows } = await killedAndResumed(t, { KILL_IN: 'search-admitted' });
  assert.deepEqual({ status: view.status, code: view.code, output: view.output }, { status: 'refused', code: 'FROZEN_EFFECT_UNKNOWN', output: null });
  assert.deepEqual(named(rows, 'tool'), [], 'no process sent the search');
});

const SCAN_ONLY = { answer: 'Whether the registry page was opened is not known, so the filing scan is cited alone.', citations: [LOOK] };
const recordOf = (view) => ({ answer: view.output.answer, citations: view.output.citations });

test('killed inside the first browser run, recorded and not yet sent, the lead looks before anything else, cannot tell, and cites only the scan', { timeout: 120_000 }, async (t) => {
  const { view, pages, failing } = await killedAndResumed(t, { KILL_IN: 'page-run' });
  assert.deepEqual(recordOf(view), SCAN_ONLY, 'the browser gives no details of the cut run yet, so the look cannot tell');
  assert.deepEqual(pages, ['snapshot', 'close'], 'the page never ran, and was not read');
  assert.deepEqual(failing, []);
});

test('killed as the browser attached, before the run was recorded, the lead still looks first and runs nothing blind', { timeout: 120_000 }, async (t) => {
  const { view, pages, failing } = await killedAndResumed(t, { KILL_IN: 'page-attach' });
  assert.deepEqual(recordOf(view), SCAN_ONLY);
  assert.ok(!pages.includes('run'), 'no second run before the browser says the first did not apply');
  assert.deepEqual(failing, []);
});

test('two kills in the page step: never the full record without the page run, never the page run twice', { timeout: 180_000 }, async (t) => {
  const { view, pages, failing } = await killedAndResumed(t, [{ KILL_IN: 'page-run' }, { KILL_AT: '2' }]);
  const runs = pages.filter((op) => op === 'run').length;
  assert.ok(runs <= 1, `the page ran ${runs} times`);
  if (runs === 0) { assert.deepEqual(recordOf(view), SCAN_ONLY); assert.ok(!pages.includes('read'), 'a page that never ran is not read'); }
  else assert.deepEqual(view.output, OUTPUT);
  assert.deepEqual(failing, []);
});

test('killed after the page ran and before its answer reached the lead, the page runs once', { timeout: 120_000 }, async (t) => {
  const { view, pages, failing } = await killedAndResumed(t, { KILL_IN: 'page-ran' });
  assert.deepEqual(pages.filter((op) => op === 'run'), ['run'], 'counted by the fake backend itself');
  assert.ok([JSON.stringify(SCAN_ONLY), JSON.stringify(recordOf({ output: OUTPUT }))].includes(JSON.stringify(recordOf(view))), JSON.stringify(view.output));
  assert.deepEqual(failing, []);
});

test('a different job on a killed run\'s directory is refused, and the run still resumes with the answer it was owed', { timeout: 180_000 }, async (t) => {
  const { others: [other], view, rows, failing } = await killedAndResumed(t, { KILL_IN: 'search-landed' }, { between: [{ OTHER: '1' }] });
  assert.deepEqual({ status: other.status, code: other.code, output: other.output }, { status: 'refused', code: 'RUN_STORE_BINDING_MISMATCH', output: null });
  assert.deepEqual(view.output, OUTPUT, 'the killed run resumed after the refusal, with the same record');
  assert.deepEqual(named(rows, 'tool'), ['search'], 'the search ran once');
  assert.deepEqual(failing, []);
});

test('a different job on a killed run\'s directory is refused before the killed run\'s task is released: it does not progress in that process', { timeout: 180_000 }, async (t) => {
  const { others: [other] } = await killedAndResumed(t, { KILL_IN: 'page-run' }, { between: [{ OTHER: '1' }] });
  assert.equal(other.code, 'RUN_STORE_BINDING_MISMATCH');
  // The counts are the killed process's alone. Released early, the saved task runs on with the refused job's host and these become 3, 1 and 2, and a second browser session launches.
  assert.deepEqual(other.did.workflow, { 'node.start': 2, 'effect.attempt': 1, 'node.end': 1 });
  assert.equal(other.did.browser.launched, 1);
});

test('two steps call the search with the same arguments: each is answered by its own call, never by the other\'s', { timeout: 240_000 }, async (t) => {
  const sent = await killedAndResumed(t, { KILL_IN: 'search-landed:2' }, { env: { TWICE: '1' } });
  assert.deepEqual(sent.view.output, OUTPUT, 'the second call, sent before the kill, is answered from its own answer');
  assert.deepEqual(named(sent.rows, 'tool'), ['search', 'search']);
  const unsent = await killedAndResumed(t, { KILL_IN: 'search-admitted:2' }, { env: { TWICE: '1' } });
  assert.deepEqual({ status: unsent.view.status, code: unsent.view.code }, { status: 'refused', code: 'FROZEN_EFFECT_UNKNOWN' },
    'the second call, admitted and never sent, is not answered with the first call\'s answer');
  assert.deepEqual(named(unsent.rows, 'tool'), ['search']);
});

// Kill points from the ten-kill ledger's seeds whose runs were valid and failed the gates as they were.

test('a turn two kills cut is asked once in each of three processes, and every gate passes', { timeout: 180_000 }, async (t) => {
  const { view, rows, failing } = await killedAndResumed(t, [{ KILL_AT: '1' }, { KILL_AT: '1' }]);
  assert.deepEqual(view.output, OUTPUT);
  const turn = rows.filter((row) => row.kind === 'model' && row.name === 'turn 1');
  assert.deepEqual([turn.length, new Set(turn.map((row) => row.incarnation)).size], [3, 3]);
  assert.deepEqual(failing, []);
});

for (const [label, path] of [['search', '/root/steps/0'], ['investigate', '/root/steps/1'], ['verdict', '/root/steps/2']]) {
  test(`killed just before ${label}'s node.end row, the journal already holds the step committed, and the resumed run passes every gate`, { timeout: 180_000 }, async (t) => {
    const { cut, view, failing } = await killedAndResumed(t, { KILL_IN: `event:node.end:${label}` });
    assert.ok(cut.state.pin.done.includes(path), `${path} is committed: ${JSON.stringify(cut.state.pin.done)}`);
    assert.deepEqual(view.output, OUTPUT);
    assert.deepEqual(failing, []);
  });
}

test('killed after the judge answered and before the answer was recorded, the resumed run asks it again, once', { timeout: 120_000 }, async (t) => {
  const { view, rows, failing } = await killedAndResumed(t, { KILL_IN: 'judge-asked' });
  assert.deepEqual(view.output, OUTPUT);
  assert.equal(named(rows, 'judge').length, 2);
  assert.deepEqual(failing, []);
});

test('killed after the judge\'s answer was recorded, the resumed run takes the recorded decision and does not ask again', { timeout: 120_000 }, async (t) => {
  const { view, rows, failing } = await killedAndResumed(t, { KILL_IN: 'event:judge.answered:verdict' });
  assert.deepEqual(view.output, OUTPUT);
  assert.deepEqual(named(rows, 'judge'), ['verdict'], 'asked once, in the killed process');
  assert.deepEqual(failing, []);
});

test('a run killed once with nothing to settle opens its journal once in each process: two generations', { timeout: 120_000 }, async (t) => {
  const { cut, journal, view } = await killedAndResumed(t, { KILL_AT: '2' });
  assert.deepEqual(view.output, OUTPUT);
  assert.deepEqual([cut.generation, journal.generation], [1, 2], 'one open by the killed process, one by the resumed one');
});
