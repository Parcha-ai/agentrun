// The rig: the reference job and each synthetic case run once, then the structural gates read what each run left.
// A case passes when its run ends with the status it expects, exactly its expected gates fail, and exactly the tools
// it expects filed receipts `failed`. A run killed and resumed passes every gate, a run with two agent steps passes
// every gate, and tampered copies of a run show the gates catch what they claim to.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeBackend } from '@parcha/pi-browser/testing';
import { placeAt, run } from './reference/assemble.ts';
import { cases } from './reference/cases/index.ts';
import { filed, gates } from './reference/gates.ts';
import { localHost } from './reference/host.ts';
import { fakes, job, lead } from './reference/job.ts';
import { summary } from './reference/run.ts';

const reference = { name: 'reference', job, fakes, expect: { status: 'complete', failing: [], filedFailed: [] } };
const failingOf = (runDir, ofJob) => gates(runDir, ofJob).filter(({ ok }) => !ok).map(({ id }) => id);
const failures = (runDir) => gates(runDir, job).filter(({ ok }) => !ok).map(({ id, detail }) => [id, detail]);
const ledgerOf = async (runDir) => (await readFile(join(runDir, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));

/** A copy of a run beside it, changed by `change`. */
async function tampered(runDir, name, change) {
  const copy = join(runDir, '..', name);
  await cp(runDir, copy, { recursive: true });
  await change(copy);
  return copy;
}

/** One run of a case in a directory of its own, removed after the test. */
async function runOf(t, ofCase) {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-rig-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const place = await placeAt(join(tmp, 'run'));
  const local = localHost(place, ofCase.fakes);
  const result = await run(place, local.host, ofCase.job);
  return { runDir: place.root, result, view: summary(place, result, local) };
}

for (const ofCase of [reference, ...cases]) {
  test(`${ofCase.name}: ends ${ofCase.expect.status}, fails ${ofCase.expect.failing.join(', ') || 'no gate'}, files ${ofCase.expect.filedFailed.join(', ') || 'nothing'} failed`, { timeout: 120_000 }, async (t) => {
    const { runDir, result, view } = await runOf(t, ofCase);
    assert.equal(result.status, ofCase.expect.status, result.message);
    // The task's refusal keeps its code and the failure's own words, in the result and in what the CLI prints.
    if (ofCase.expect.refused) for (const shown of [result, view]) {
      assert.equal(shown.code, ofCase.expect.refused.code);
      assert.ok(shown.message.includes(ofCase.expect.refused.says), shown.message);
    }
    assert.deepEqual(failingOf(runDir, ofCase.job), ofCase.expect.failing, JSON.stringify(gates(runDir, ofCase.job), null, 2));
    assert.deepEqual(filed(runDir).filter(({ read }) => read.ok && read.value.status === 'failed').map(({ read }) => read.value.tool), ofCase.expect.filedFailed);
  });
}

// A process of the run: the reference job, its browser backend in the test process so it outlives a kill, and SIGKILL
// in the lead's request after `KILL_AT` tool results.
const at = (path) => new URL(path, import.meta.url).href;
const CHILD = `
import { remoteDriver, remoteProvider } from '${import.meta.resolve('@parcha/pi-browser/testing')}';
import { placeAt, run } from '${at('./reference/assemble.ts')}';
import { localHost } from '${at('./reference/host.ts')}';
import { fakes, job } from '${at('./reference/job.ts')}';
const place = await placeAt(process.env.DIR);
const model = (messages) => {
  if (messages.filter((message) => message.role === 'toolResult').length === Number(process.env.KILL_AT)) process.kill(process.pid, 'SIGKILL');
  return fakes.model(messages);
};
const browser = { provider: () => remoteProvider(process.env.BACKEND), driver: remoteDriver(process.env.BACKEND) };
await run(place, localHost(place, { ...fakes, model }, { browser }).host, job);
`;

test('a run killed after the browser read and resumed by a second process passes every gate', { timeout: 120_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-rig-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const served = await new FakeBackend({ start: fakes.start, pages: fakes.pages }).serve();
  t.after(() => served.close());
  const child = join(tmp, 'child.mjs');
  await writeFile(child, CHILD);
  const env = { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp, DIR: join(tmp, 'run'), BACKEND: served.url };
  const ended = (extra) => new Promise((resolve) => spawn(process.execPath, ['--no-warnings=ExperimentalWarning', child], { env: { ...env, ...extra }, stdio: 'ignore' })
    .on('close', (code, signal) => resolve(signal ?? code)));
  assert.deepEqual([await ended({ KILL_AT: '2' }), await ended({})], ['SIGKILL', 0]);
  assert.deepEqual(gates(join(tmp, 'run'), job).filter(({ ok }) => !ok), []);
  const cut = (await ledgerOf(join(tmp, 'run'))).filter((row) => row.name === 'turn 2');
  assert.equal(new Set(cut.map((row) => row.pid)).size, 2, 'the turn the kill cut was asked once in each process, and the gate let it');
  assert.ok(cut[0].conversation && cut[0].conversation === cut[1].conversation, 'both processes name the same conversation');
});

test('two agent steps in one process are two conversations, each asked its turns once', { timeout: 120_000 }, async (t) => {
  const steps = [...job.workflow.root.steps];
  steps.splice(2, 0, { ...steps[1], label: 'recheck', as: 'recheck' });
  const twoLeads = { ...job, workflow: { ...job.workflow, root: { ...job.workflow.root, steps } } };
  const { runDir, result } = await runOf(t, { job: twoLeads, fakes });
  assert.equal(result.status, 'complete', result.message);
  assert.deepEqual(failingOf(runDir, twoLeads), [], JSON.stringify(gates(runDir, twoLeads), null, 2));
  const firsts = (await ledgerOf(runDir)).filter((row) => row.kind === 'model' && row.name === 'turn 0');
  assert.deepEqual([firsts.length, new Set(firsts.map((row) => row.pid)).size, new Set(firsts.map((row) => row.conversation)).size], [2, 1, 2]);
});

test('the gates are not vacuous: a cited failed receipt, a tool run twice, a turn asked twice in one process and a page judged with no read each fail theirs', { timeout: 120_000 }, async (t) => {
  const [loginWall] = cases;
  const { runDir } = await runOf(t, loginWall);
  const failedRead = filed(runDir).find(({ read }) => read.ok && read.value.status === 'failed').path;

  const cites = await tampered(runDir, 'cites-failed', async (dir) => {
    const record = JSON.parse(await readFile(join(dir, 'out', 'record.json'), 'utf8'));
    record.record.citations.push(failedRead);
    await writeFile(join(dir, 'out', 'record.json'), JSON.stringify(record));
  });
  assert.deepEqual(failingOf(cites, loginWall.job), ['no-failed-evidence-cited']);

  const rows = await ledgerOf(runDir);
  const browser = (name) => rows.filter((row) => row.kind === 'browser' && row.name === name);
  assert.deepEqual([browser('page.read').length, browser('page.judge').length], [2, 2], 'the lead read the wall again once, and each read was judged');
  const again = [rows.find((row) => row.kind === 'tool'), rows.find((row) => row.kind === 'model'), browser('page.judge')[0]];
  const repeats = await tampered(runDir, 'repeats', (dir) => appendFile(join(dir, 'ledger.jsonl'), again.map((row) => `${JSON.stringify(row)}\n`).join('')));
  assert.deepEqual(Object.fromEntries(gates(repeats, loginWall.job).filter(({ ok }) => !ok).map(({ id, detail }) => [id, detail])), {
    'fakes-called-once': `tool:search ran 2 times; model:turn 0 of ${again[1].conversation} was asked twice in one process`,
    'browser-ops-ran': '3 page judgments for 2 page reads',
  });
});

test('a record that cites a browser read fails browser-ops-ran when the ledger shows no page run', { timeout: 120_000 }, async (t) => {
  const { runDir } = await runOf(t, reference);
  const unrun = await tampered(runDir, 'unrun', async (dir) => {
    const kept = (await ledgerOf(dir)).filter((row) => !(row.kind === 'browser' && row.name === 'page.run'));
    await writeFile(join(dir, 'ledger.jsonl'), kept.map((row) => `${JSON.stringify(row)}\n`).join(''));
  });
  assert.deepEqual(failures(unrun), [['browser-ops-ran', 'the record cites a browser read, and page.run never ran']]);
});

test('a missing ledger or store fails the gates that read it, and says which; a missing events log fails none', { timeout: 120_000 }, async (t) => {
  const { runDir } = await runOf(t, reference);
  assert.deepEqual(failures(await tampered(runDir, 'no-ledger', (dir) => rm(join(dir, 'ledger.jsonl')))), [['fakes-called-once', 'no ledger.jsonl'], ['browser-ops-ran', 'no ledger.jsonl']]);
  assert.deepEqual(failures(await tampered(runDir, 'no-store', (dir) => rm(join(dir, 'durable'), { recursive: true }))),
    [['nodes-end', 'no durable/run.sqlite'], ['browser-sessions-released', 'no durable/run.sqlite']]);
  assert.deepEqual(failures(await tampered(runDir, 'no-events', (dir) => rm(join(dir, 'events.jsonl')))), [], 'status rows are for people; the gates read the store');
  const corrupt = failures(await tampered(runDir, 'corrupt-store', (dir) => writeFile(join(dir, 'durable', 'run.sqlite'), 'not a database')));
  assert.deepEqual(corrupt.map(([id]) => id), ['nodes-end', 'browser-sessions-released'], 'the other gates still report');
  for (const [, detail] of corrupt) assert.match(detail, /^durable\/run\.sqlite could not be read: /);
});

test('a ledger cut mid-line fails the gates that read it, and the others still report', { timeout: 120_000 }, async (t) => {
  const { runDir } = await runOf(t, reference);
  const cut = (name) => async (dir) => writeFile(join(dir, name), (await readFile(join(dir, name), 'utf8')).slice(0, -10));
  const lastLine = async (name) => (await readFile(join(runDir, name), 'utf8')).trim().split('\n').length;
  const ledgerError = `ledger.jsonl line ${await lastLine('ledger.jsonl')} does not parse`;
  assert.deepEqual(failures(await tampered(runDir, 'ledger-cut', cut('ledger.jsonl'))), [['fakes-called-once', ledgerError], ['browser-ops-ran', ledgerError]]);
  assert.deepEqual(failures(await tampered(runDir, 'events-cut', cut('events.jsonl'))), []);
});

test('a second job on a directory that holds another job\'s run is refused, naming what moved, and gets nothing of the first', { timeout: 180_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-rig-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const runAt = async (ofJob) => {
    const place = await placeAt(join(tmp, 'run'));
    return run(place, localHost(place, fakes).host, ofJob);
  };
  const record = async () => JSON.parse(await readFile(join(tmp, 'run', 'out', 'record.json'), 'utf8')).record;
  assert.equal((await runAt(job)).status, 'complete');
  const delivered = await record();
  assert.equal((await runAt(job)).status, 'complete', 'the same job again is the saved run');
  const refusalOf = ({ status, code, detail }) => ({ status, code, moved: detail?.moved });
  const otherInput = await runAt({ ...job, input: { company: 'Other Ltd' } });
  assert.deepEqual(refusalOf(otherInput), { status: 'refused', code: 'RUN_STORE_BINDING_MISMATCH', moved: ['input.company'] });
  const otherWorkflow = await runAt({ ...job, workflow: { ...job.workflow, name: 'another-company-check' } });
  assert.deepEqual(refusalOf(otherWorkflow), { status: 'refused', code: 'RUN_STORE_BINDING_MISMATCH', moved: ['workflow.name'] });
  assert.deepEqual(await record(), delivered, 'nothing was delivered for the refused jobs');
});

test('a directory whose store is where an earlier version kept it is refused, naming both paths, and nothing runs', { timeout: 60_000 }, async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-rig-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'run');
  await mkdir(join(root, 'store'), { recursive: true });
  await writeFile(join(root, 'store', 'run.sqlite'), 'a store an earlier version wrote');
  const place = await placeAt(root);
  const local = localHost(place, fakes);
  await assert.rejects(run(place, local.host, job), (error) => error.code === 'RUN_STORE_ELSEWHERE'
    && error.message.includes(join(root, 'store', 'run.sqlite')) && error.message.includes(join(root, 'durable', 'run.sqlite')));
  assert.equal(existsSync(join(root, 'durable')), false, 'no store was opened');
  assert.deepEqual(local.ledger(), [], 'no fake was called');
});

test('a cut or refused page action: the lead looks before anything else, and the browser\'s pendingEffect details decide', () => {
  const target = 'http://registry.example/companies/01234567';
  const start = 'http://start.example/';
  const effect = (urlAtDispatch, urlNow) => ({ callId: 'c1', urlAtDispatch, urlNow, observed: false, sent: null });
  const result = (toolName, isError, text, details) => ({ role: 'toolResult', toolName, isError, content: [{ type: 'text', text }], ...(details ? { details } : {}) });
  const cutRun = result('run', true, '<harness>\n[error] Tool run was interrupted and may have partially run\n</harness>');
  const refusedRun = (pendingEffect) => result('run', true, JSON.stringify({ ok: false, code: 'effect_unknown', retryable: true, effect: 'possibly_effected', message: '...' }), pendingEffect && { pendingEffect });
  const user = { role: 'user', content: `Read the page. {"urls":["${target}"]}` };
  const next = (...results) => lead()([user, ...results]).content[0].name;
  const look = (pendingEffect) => result('snapshot', false, '[0] main', pendingEffect && { pendingEffect });
  assert.equal(next(cutRun), 'snapshot', 'a cut run is looked at, never asked again blind');
  assert.equal(next(refusedRun()), 'snapshot', 'so is a refused one');
  assert.equal(next(cutRun, look(effect(start, target))), 'browser_read', 'applied: it goes on to read the page');
  assert.equal(next(cutRun, look(effect(start, start))), 'run', 'not applied: it runs it again');
  assert.equal(next(refusedRun(effect(start, target)), look()), 'browser_read', 'the refusal\'s details decide as the look\'s do');
  assert.equal(next(cutRun, look(effect(null, target))), 'read', 'the page when sent unknown: cannot tell, the scan next');
  assert.equal(next(cutRun, look(effect(target, target))), 'read', 'already on the target when sent: cannot tell');
  assert.equal(next(cutRun, look()), 'read', 'no details, as the browser answers today: cannot tell');
  assert.equal(next(cutRun, look(effect(start, start)), cutRun, look(effect(start, start)), cutRun, look(effect(start, start))), 'read', 'three runs in all, then no more');
  // The browser refuses the first run after a cut even when the lead looked before it; a look after the refusal
  // lets the run through. The refused run was not sent, so the page applies once.
  const notApplied = effect(start, start);
  const sequence = [cutRun, look(notApplied), refusedRun(notApplied), look(notApplied)];
  assert.deepEqual(sequence.map((_, at) => next(...sequence.slice(0, at + 1))), ['snapshot', 'run', 'snapshot', 'run'],
    'cut, look, run, refused, look again, run');
  assert.equal(next(...sequence, result('run', false, '{"value":"ran"}')), 'browser_read', 'the third run applied: it goes on');
  assert.equal(next(...sequence, cutRun, look(notApplied)), 'read', 'that third run cut too: three in all, no more');
  assert.equal(next(cutRun, look(notApplied), refusedRun(), look()), 'read', 'refused, and no details on either: cannot tell');
});
