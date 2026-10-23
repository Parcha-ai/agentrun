// The promotion gate's queue keeps one comparison per name. A DEMOTION or CONFIRM ask (a champion's standing, which the
// uses called for) is never replaced by a CHALLENGER ask: the challenger waits (its next hold asks again). A demotion or
// confirm arriving while a challenger is queued replaces it. This is C attempt 1's sequence: a run's settle asks the gated
// demotion, the same curate's save asks a challenge, and the demotion was dropped six times. Without challenger asks
// (no --challenge-on-hold) nothing changes.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MCC_GATE_BOTH, partsOfMccBoth } from './mcc.mjs';
import { asyncGate } from './promotion-gate.mjs';

const NAME = 'merchant-mcc-risk';
const CHAMP = 'a'.repeat(64);
const [N1, N2, N3] = ['b', 'c', 'e'].map((c) => c.repeat(64));
const rev = (sha256) => ({ sha256, workflow: {} });

/** A gate whose bank runs wait until `release()`, so a first comparison holds the running slot while others are asked. */
async function heldGate(t) {
  const dir = await mkdtemp(join(tmpdir(), 'lc-gate-precedence-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release;
  const gateOpen = new Promise((resolve) => { release = resolve; });
  const order = [];
  const runOne = async ({ sha256, company }) => {
    await gateOpen;
    order.push(`${sha256.slice(0, 1)}:${company.cik}`);
    return { outcome: 'complete', score: { against: 'stage1', mccCorrect: sha256 !== CHAMP, riskCorrect: true }, costUsd: 0.05 };
  };
  const logs = [];
  const gate = asyncGate({ bank: [{ cik: 'm0' }], runOne, dir, scoreParts: partsOfMccBoth, parts: MCC_GATE_BOTH, concurrency: 1, gatedDemotion: true, log: (l) => logs.push(l) });
  const verdicts = () => readFileSync(join(dir, 'verdicts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { gate, release, verdicts, logs };
}

test('C attempt 1\'s sequence: a gated demotion asked, then a challenge in the same curate; the demotion stays queued and runs', async (t) => {
  const g = await heldGate(t);
  // A first challenge is running when the uses call for the demotion.
  g.gate.ask({ name: NAME, candidate: rev(N1), serving: rev(CHAMP), main: 'x', challenger: { run: 'run-36' } });
  const demotion = g.gate.ask({ name: NAME, candidate: rev(CHAMP), serving: null, main: 'x', demotion: true });
  const challenge = g.gate.ask({ name: NAME, candidate: rev(N2), serving: rev(CHAMP), main: 'x', challenger: { run: 'run-33' } });
  assert.equal(demotion.status, 'queued');
  assert.equal(challenge.status, 'waiting', 'the challenger waits behind the queued demotion');
  assert.deepEqual(g.gate.pending().map((p) => [p.candidate.slice(0, 1), p.state]), [['b', 'running'], ['a', 'queued']]);
  g.release();
  await g.gate.idle();
  const lines = g.verdicts();
  assert.deepEqual(lines.map((l) => [l.candidate.slice(0, 1), Boolean(l.demotion), Boolean(l.challenger)]), [['b', false, true], ['a', true, false]], 'the demotion ran; the waiting challenger did not');
  assert.ok(g.logs.some((l) => /waits behind the queued demotion/.test(l)), g.logs.join('\n'));
});

test('a confirm is not replaced by a challenger either; a demotion or confirm replaces a queued challenger', async (t) => {
  const g = await heldGate(t);
  g.gate.ask({ name: NAME, candidate: rev(N1), serving: rev(CHAMP), main: 'x', challenger: { run: 'run-1' } });
  assert.equal(g.gate.ask({ name: NAME, candidate: rev(N2), serving: rev(CHAMP), main: 'x', challenger: { run: 'run-2' } }).status, 'queued');
  assert.equal(g.gate.ask({ name: NAME, candidate: rev(CHAMP), serving: rev(N3), main: 'x', confirm: true }).status, 'queued', 'a confirm replaces the queued challenger');
  assert.equal(g.gate.ask({ name: NAME, candidate: rev(N3), serving: rev(CHAMP), main: 'x', challenger: { run: 'run-3' } }).status, 'waiting');
  assert.deepEqual(g.gate.pending().map((p) => [p.candidate.slice(0, 1), p.state]), [['b', 'running'], ['a', 'queued']]);
  g.release();
  await g.gate.idle();
});

test('without challenger asks the queue is as before: the newest ask of a name replaces the queued one, whatever its kind', async (t) => {
  const g = await heldGate(t);
  g.gate.ask({ name: NAME, candidate: rev(N1), serving: rev(CHAMP), main: 'x' });
  g.gate.ask({ name: NAME, candidate: rev(CHAMP), serving: null, main: 'x', demotion: true });
  assert.equal(g.gate.ask({ name: NAME, candidate: rev(N2), serving: rev(CHAMP), main: 'x' }).status, 'queued');
  assert.deepEqual(g.gate.pending().map((p) => [p.candidate.slice(0, 1), p.state]), [['b', 'running'], ['c', 'queued']]);
  g.release();
  await g.gate.idle();
});
