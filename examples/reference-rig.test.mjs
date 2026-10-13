// The rig: the reference job and each synthetic case run once, then the structural gates read what each run left.
// A case passes when its run ends with the status it expects, exactly its expected gates fail, and exactly the tools
// it expects filed receipts `failed`. A run killed and resumed passes every gate, and two tampered copies of a run
// show the gates catch what they claim to.
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

const reference = { name: 'reference', job, fakes, expect: { status: 'complete', failing: [], filedFailed: [] } };
const failingOf = (runDir, ofJob) => gates(runDir, ofJob).filter(({ ok }) => !ok).map(({ id }) => id);

/** One run of a case in a directory of its own, removed after the test. */
async function runOf(t, ofCase) {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-rig-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const place = await placeAt(join(tmp, 'run'));
  const result = await run(place, localHost(place, ofCase.fakes).host, ofCase.job);
  return { runDir: place.root, result };
}

for (const ofCase of [reference, ...cases]) {
  test(`${ofCase.name}: ends ${ofCase.expect.status}, fails ${ofCase.expect.failing.join(', ') || 'no gate'}, files ${ofCase.expect.filedFailed.join(', ') || 'nothing'} failed`, { timeout: 120_000 }, async (t) => {
    const { runDir, result } = await runOf(t, ofCase);
    assert.equal(result.status, ofCase.expect.status, result.error);
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
  const cut = (await readFile(join(tmp, 'run', 'ledger.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.name === 'turn 2');
  assert.equal(new Set(cut.map((row) => row.pid)).size, 2, 'the turn the kill cut was asked once in each process, and the gate let it');
});

test('the gates are not vacuous: a cited failed receipt, a tool run twice and a turn asked twice in one process each fail theirs', { timeout: 120_000 }, async (t) => {
  const [loginWall] = cases;
  const { runDir } = await runOf(t, loginWall);
  const failedRead = filed(runDir).find(({ read }) => read.ok && read.value.status === 'failed').path;

  const cites = join(runDir, '..', 'cites-failed');
  await cp(runDir, cites, { recursive: true });
  const record = JSON.parse(await readFile(join(cites, 'out', 'record.json'), 'utf8'));
  record.record.citations.push(failedRead);
  await writeFile(join(cites, 'out', 'record.json'), JSON.stringify(record));
  assert.deepEqual(failingOf(cites, loginWall.job), ['no-failed-evidence-cited']);

  const repeats = join(runDir, '..', 'repeats');
  await cp(runDir, repeats, { recursive: true });
  const rows = (await readFile(join(repeats, 'ledger.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  await appendFile(join(repeats, 'ledger.jsonl'), [rows.find((row) => row.kind === 'tool'), rows.find((row) => row.kind === 'model')].map((row) => `${JSON.stringify(row)}\n`).join(''));
  const [fakesGate] = gates(repeats, loginWall.job).filter(({ id }) => id === 'fakes-called-once');
  assert.equal(fakesGate.ok, false);
  assert.match(fakesGate.detail, /tool:search ran 2 times; model:turn 0 was asked twice in one process/);
});
