// The rig: the reference job and each synthetic case run once, then the structural gates read what each run left.
// A case passes when its run ends with the status it expects, exactly its expected gates fail, and exactly the tools
// it expects filed receipts `failed`. A run killed and resumed passes every gate, a run with two agent steps passes
// every gate, and tampered copies of a run show the gates catch what they claim to.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeBackend } from '@parcha/pi-browser/testing';
import { placeAt, run } from './reference/assemble.ts';
import { cases } from './reference/cases/index.ts';
import { filed, gates } from './reference/gates.ts';
import { localHost } from './reference/host.ts';
import { fakes, job } from './reference/job.ts';
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
  assert.deepEqual(refusalOf(otherInput), { status: 'refused', code: 'RUN_STORE_BINDING_MISMATCH', moved: ['input'] });
  assert.notEqual(otherInput.detail.saved.input, otherInput.detail.requested.input);
  const otherWorkflow = await runAt({ ...job, workflow: { ...job.workflow, name: 'another-company-check' } });
  assert.deepEqual(refusalOf(otherWorkflow), { status: 'refused', code: 'RUN_STORE_BINDING_MISMATCH', moved: ['binding'] });
  assert.deepEqual(await record(), delivered, 'nothing was delivered for the refused jobs');
});
