// The disk demo on fakes: an agent reviews ten invoices against a policy in its workspace, the workflow pays the approved ones through a simulated paid tool, and a last agent writes a report that cites the lines it read.
// Beats: the job finishes with every decision the key says; with --kill the process dies at the named crossing and the next resumes with every paid call made once; every paid call has a receipt, the recording validates
// and its cost is a number or unknown; with --handoff the run is released cleanly and a second process opens it (no kill). The expected values are fixed by hand from the invoice files (examples/disk/files.ts), not read back
// from a run. The scripted lead is the test fixture; a live run is checked by the same checks (examples/disk-review-checks.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { HELD, PAID, readsOf, reviewProblems } from './disk-review-checks.mjs';

const RUN = new URL('./disk/run.ts', import.meta.url).pathname;
const DEMO = JSON.parse(readFileSync(new URL('./disk/demo.json', import.meta.url), 'utf8'));
const PAID_NUMBERS = PAID.map(([invoice]) => invoice);
const PAID_CENTS = PAID.reduce((sum, [, cents]) => sum + cents, 0);

const scratch = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'disk-demo-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
/** `node examples/disk/run.ts <args>`: what `npm run demo:disk -- <args>` runs. */
const demo = (args) => {
  const ran = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', RUN, ...args], { encoding: 'utf8', timeout: 150_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  return ran;
};
const rows = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const charges = (dir) => rows(join(dir, 'ledger.jsonl')).filter((row) => row.kind === 'tool' && row.name === 'charge');

test('beat 1, the job: eight invoices paid once each and two held, as the policy says, the report written and every cite resolved', { timeout: 200_000 }, async (t) => {
  const root = await scratch(t);
  const dir = join(root, 'run');
  const recording = join(root, 'recording');
  const result = JSON.parse(demo(['--json', '--record', recording, '--dir', dir]).stdout);
  assert.deepEqual(result.processes.map((process) => process.outcome.status), ['complete']);
  const { record } = result;
  assert.equal(record.batch, 'october-vendors');
  const decisions = Object.fromEntries(record.entries.map((entry) => [entry.review.invoice, entry.review.decision]));
  for (const invoice of PAID_NUMBERS) assert.equal(decisions[invoice], 'approve', invoice);
  for (const invoice of HELD) assert.equal(decisions[invoice], 'hold', invoice);
  // The paid ones carry the paid tool's receipt, the held ones none.
  assert.deepEqual(record.entries.filter((entry) => entry.receipt).map((entry) => [entry.receipt.invoice, entry.receipt.receipt, entry.receipt.cents]), PAID.map(([invoice, cents]) => [invoice, `rcpt-${invoice}`, cents]));
  assert.equal(record.entries.filter((entry) => entry.receipt).reduce((sum, entry) => sum + entry.receipt.cents, 0), PAID_CENTS);
  assert.equal(record.report, 'report/index.html');
  assert.deepEqual(reviewProblems({ recording, dir, record }), []);
});

test('beat 2, a kill and a resume: the box goes at the fifth paid call, the next process finishes, and no charge is made twice', { timeout: 200_000 }, async (t) => {
  const root = await scratch(t);
  const recording = join(root, 'recording');
  const dir = join(root, 'run');
  const result = JSON.parse(demo(['--kill', '--json', '--record', recording, '--dir', dir]).stdout);
  assert.deepEqual(result.processes.map((process) => process.signal), ['SIGKILL', null]);
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.equal(DEMO.kill.point, 'effect.kept charge', 'demo.json names the one crossing');
  assert.deepEqual(result.kills.map((kill) => [kill.gen, kill.point]), [[1, 'effect.kept charge']]);
  const lines = readEvents(recording);
  const kill = lines.find((line) => line.source === 'host' && line.kind === 'kill');
  assert.equal(kill.data.crossing.point, 'effect.kept charge');
  const counted = fold(lines);
  assert.deepEqual([counted.processes, counted.kills, counted.repeated, counted.unknown, counted.measured], [2, 1, 0, 0, true]);
  // Every approved invoice was paid once in all: five before the kill, three after it, none of the first five again.
  assert.deepEqual(charges(dir).length, PAID.length);
  const perProcess = Object.values(Object.groupBy(charges(dir), (row) => row.incarnation)).map((group) => group.length);
  assert.deepEqual(perProcess, [5, 3], 'five charges before the kill, the other three after it, by two processes');
  // The run is the disk package's own: run.json names the demo's run (its name and a fresh id for each invocation) and says done at generation 2, which the next open after the kill took.
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.match(run.run, /^disk-[0-9a-f]{8}$/);
  assert.deepEqual([run.status, run.generation], ['done', 2]);
  assert.deepEqual(reviewProblems({ recording, dir, record: result.record }), []);
});

test('beat 3, receipts with cost: a receipt for each paid call, a recording that validates, a cost that is a number or unknown', { timeout: 200_000 }, async (t) => {
  const root = await scratch(t);
  const recording = join(root, 'recording');
  const dir = join(root, 'run');
  demo(['--kill', '--record', recording, '--dir', dir]);
  assert.deepEqual(validateRecording(recording), []);
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.equal(manifest.providers, 'scripted', 'on fakes the manifest says so');
  assert.ok(manifest.cost.usd === null || typeof manifest.cost.usd === 'number', 'a number or unknown, never a value it did not earn');
  assert.equal(manifest.kills, 1);
  // The run kept each paid call's answer under the call's own id: eight answers, each the receipt of its invoice.
  const answers = readdirSync(join(dir, 'answers')).map((name) => JSON.parse(readFileSync(join(dir, 'answers', name), 'utf8')));
  assert.equal(answers.length, PAID.length);
  assert.deepEqual(answers.map((answer) => answer.value.receipt).sort(), PAID_NUMBERS.map((invoice) => `rcpt-${invoice}`));
});

test('the template: demo.json names the claim, the kill and the panels, SETUP-PROMPT.md names every key and program and nothing more, the job is data, the README has the fixed shape', () => {
  assert.ok(DEMO.claim && DEMO.title && DEMO.kill.point && DEMO.kill.why && DEMO.targets.includes('local'));
  assert.ok(DEMO.title.split(' ').length >= 2 && DEMO.title.split(' ').length <= 5, 'a gallery title is 2 to 5 words');
  assert.deepEqual(DEMO.panels, ['workflow', 'disk']);
  const prompt = readFileSync(new URL('./disk/SETUP-PROMPT.md', import.meta.url), 'utf8');
  const named = [...DEMO.keys.map((key) => key.env), ...DEMO.programs.map((program) => program.cmd)];
  for (const name of named) assert.ok(prompt.includes(`\`${name}\``), `SETUP-PROMPT.md names ${name}`);
  const mentioned = new Set([...prompt.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map((match) => match[1]));
  for (const env of mentioned) assert.ok(DEMO.keys.some((key) => key.env === env), `SETUP-PROMPT.md names ${env}, which demo.json does not list`);
  const job = readFileSync(new URL('./disk/job.ts', import.meta.url), 'utf8');
  assert.ok(!/process\.env|faux|testing/.test(job.replace(/^\/\/.*$/gm, '')), 'job.ts reads no environment and imports no fake');
  const readme = readFileSync(new URL('./disk/README.md', import.meta.url), 'utf8');
  for (const heading of ['## What you will see', '## Keys and programs', '## How it is built']) assert.ok(readme.includes(heading), `README has ${heading}`);
  assert.ok(readme.includes('npm run demo:disk') && readme.includes('-- --live'));
  assert.ok(existsSync(new URL('./disk/run.ts', import.meta.url)));
});

test('beat 4, a handoff: the run is released cleanly at the fifth paid call and a second process opens it from the disk, with no kill anywhere', { timeout: 200_000 }, async (t) => {
  const root = await scratch(t);
  const recording = join(root, 'recording');
  const dir = join(root, 'run');
  const result = JSON.parse(demo(['--handoff', '--json', '--record', recording, '--dir', dir]).stdout);
  // Two processes, the first one ended by itself (exit 0, no signal), the second delivered.
  assert.deepEqual(result.processes.map((process) => [process.exit, process.signal]), [[0, null], [0, null]]);
  assert.deepEqual(result.processes.map((process) => process.outcome.status), ['released', 'complete']);
  assert.deepEqual(result.kills, []);
  assert.deepEqual(validateRecording(recording), []);
  const lines = readEvents(recording);
  const host = lines.filter((line) => line.source === 'host');
  assert.deepEqual(host.filter((line) => ['kill', 'kill.failed', 'kill.request.ignored', 'revoke', 'fenced', 'signals.failed'].includes(line.kind)), [], 'a handoff writes no kill, revoke or fence');
  assert.equal(host.filter((line) => line.kind === 'process.started').length, 2);
  const handoffs = host.filter((line) => line.kind === 'handoff');
  assert.equal(handoffs.length, 1);
  assert.deepEqual([handoffs[0].data.gen, handoffs[0].data.point, handoffs[0].data.n], [1, 'effect.kept charge', 5]);
  assert.ok(handoffs[0].data.why.length > 0 && handoffs[0].data.why.length <= 240);
  assert.equal(host.filter((line) => line.kind === 'handoff.failed').length, 0);
  const manifest = JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.generations, manifest.kills, manifest.handoffs], [2, 0, 1], 'generations = 1 + landed kills + landed handoffs');
  assert.match(handoffs[0].data.from, /^host-\d+$/, 'the releasing holder is a label, never a machine');
  // The disk's own record: sealed sleeping by the first holder, then done by the second at generation 2.
  const statuses = host.filter((line) => line.kind === 'run.json').map((line) => line.data.status);
  assert.ok(statuses.includes('sleeping'), `the run was sealed sleeping between the two processes: ${statuses}`);
  assert.equal(statuses.at(-1), 'done');
  const counted = fold(lines);
  assert.deepEqual([counted.processes, counted.kills, counted.unknown, counted.measured], [2, 0, 0, true]);
  assert.equal(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).generation, 2);
  // The release is at the planned crossing: five charges by the first process, the other three by the second, none twice.
  assert.equal(charges(dir).length, PAID.length);
  assert.deepEqual(Object.values(Object.groupBy(charges(dir), (row) => row.incarnation)).map((group) => group.length), [5, 3]);
  assert.deepEqual(reviewProblems({ recording, dir, record: result.record }), []);
  // Receipts are unique in the run and stable across the replay: the report, written by the second host, cites reads the first host made, and every receipt is stated once.
  const reads = readsOf(lines);
  assert.equal(new Set(reads.map((read) => read.receipt)).size, reads.length);
  assert.deepEqual([...new Set(reads.map((read) => read.gen))].sort(), [1, 2], 'reads were made on both hosts');
  const html = readFileSync(join(dir, 'work', 'report', 'index.html'), 'utf8');
  const cited = [...html.matchAll(/data-receipt="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(cited.some((receipt) => reads.find((read) => read.receipt === receipt)?.gen === 1), 'a cite of the report rests on a read of the first host');
  assert.equal(JSON.stringify(lines).includes('kill'), false, 'the word kill is nowhere in a handoff recording');
});

// A handoff that does not land is a `handoff.failed` line with its reason, never an unlanded kill. The entry is the disk demo's with a handoff planned and, for two of the reasons, a place that reports the run otherwise than it was
// (a wrapper over the disk place: the supervisor decides from what the place says). It is written beside the example so that the packages resolve.
const failing = async (t, { n = 5, wrap = '' } = {}) => {
  const root = await scratch(t);
  const entry = new URL(`./disk-handoff-${process.pid}-${Math.random().toString(36).slice(2, 8)}.ts`, import.meta.url);
  t.after(() => rm(entry, { force: true }));
  writeFileSync(entry, `import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demo } from '@parcha/agentrun-harness';
import { localPlace } from '@parcha/pi-durable-disk';
import { fakes } from './disk/fakes.ts';
import { job } from './disk/job.ts';
const raw = JSON.parse(readFileSync(new URL('./disk/demo.json', import.meta.url), 'utf8'));
const { kills, kill, ...spec } = raw;
spec.handoffs = [{ ...raw.handoffs[0], n: ${n} }];
const make = localPlace({ app: fileURLToPath(import.meta.resolve('@parcha/agentrun-harness/child-app')) });
const wrap = ${JSON.stringify(wrap)};
const place = (ctx) => {
  const made = make(ctx);
  if (wrap === 'exit') {
    const end = async (runner) => ({ ...runner, exited: runner.exited.then((exit) => ({ ...exit, exit: 1 })) });
    return { ...made, start: async (order) => end(await made.start(order)), recover: async (last, kind, order) => { const r = await made.recover(last, kind, order); return { ...r, runner: await end(r.runner) }; } };
  }
  // As the Archil place reports a clean end: the host driver's word stopped in place of exit 0 (a non-zero exit stays as it is).
  if (wrap === 'stopped') {
    const end = async (runner) => ({ ...runner, exited: runner.exited.then((exit) => (exit.exit === 0 ? { ...exit, exit: 'stopped' } : exit)) });
    return { ...made, start: async (order) => end(await made.start(order)), recover: async (last, kind, order) => { const r = await made.recover(last, kind, order); return { ...r, runner: await end(r.runner) }; } };
  }
  if (wrap === 'unsealed') return { ...made, status: async () => { const s = await made.status(); return { ...s, record: s.record && { ...s.record, sealedSeq: null } }; } };
  if (wrap === 'status') return { ...made, status: async () => { const s = await made.status(); return { ...s, record: s.record && { ...s.record, status: 'running' } }; } };
  return made;
};
export const options = { self: import.meta.url, spec, job, fakes, place };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await demo(options);
`);
  const recording = join(root, 'recording');
  const ran = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', fileURLToPath(entry), '--handoff', '--json', '--record', recording, '--dir', join(root, 'run')], { encoding: 'utf8', timeout: 150_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return { ran, lines: readEvents(recording), recording, result: ran.stdout.trim() ? JSON.parse(ran.stdout) : null };
};
const failedOf = (lines) => lines.filter((line) => line.source === 'host' && line.kind === 'handoff.failed').map((line) => line.data);

test('handoff.failed, "crossing not logged": the crossing is never taken, the job finishes, and no kill is reported as unlanded', { timeout: 200_000 }, async (t) => {
  const { ran, lines, result, recording } = await failing(t, { n: 99 });
  assert.notEqual(ran.status, 0, 'a handoff that did not land is a failed run');
  assert.deepEqual(failedOf(lines), [{ gen: 1, point: 'effect.kept charge', n: 99, reason: 'crossing not logged' }]);
  assert.equal(lines.filter((line) => line.kind === 'handoff').length, 0);
  assert.deepEqual(result.unlanded, []);
  assert.equal(result.processes.at(-1).outcome.status, 'complete');
  assert.equal(JSON.parse(readFileSync(join(recording, 'manifest.json'), 'utf8')).handoffs, 0);
  // The run ended done and sealed: a seal is present, and the missing crossing is still the reason (the crossing check comes before the seal's).
  const sealed = lines.filter((line) => line.source === 'host' && line.kind === 'run.json').at(-1).data;
  assert.equal(sealed.status, 'done');
  assert.ok(Number.isInteger(sealed.sealedSeq), 'a seal is present');
});

test('handoff.failed, "exit not 0": the crossing is logged but the process did not exit 0', { timeout: 200_000 }, async (t) => {
  const { ran, lines, result } = await failing(t, { wrap: 'exit' });
  assert.notEqual(ran.status, 0);
  assert.deepEqual(failedOf(lines), [{ gen: 1, point: 'effect.kept charge', n: 5, reason: 'exit not 0' }]);
  assert.equal(lines.filter((line) => line.kind === 'handoff').length, 0);
  assert.equal(result.handoffs, 0);
  assert.deepEqual(result.failedHandoffs, [{ gen: 1, point: 'effect.kept charge', reason: 'exit not 0' }]);
});

test('a handoff on a place whose clean end reads `stopped` (the Archil place) lands as on the local place', { timeout: 200_000 }, async (t) => {
  const { ran, lines, result } = await failing(t, { wrap: 'stopped' });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(failedOf(lines), []);
  assert.equal(lines.filter((line) => line.source === 'host' && line.kind === 'handoff').length, 1);
  assert.equal(result.handoffs, 1);
  assert.deepEqual(result.processes.map((process) => [process.exit, process.outcome?.status]), [['stopped', 'released'], ['stopped', 'complete']]);
});

test('handoff.failed, "not released": the process exited 0 but the last run.json does not show the run released', { timeout: 200_000 }, async (t) => {
  const { ran, lines } = await failing(t, { wrap: 'status' });
  assert.notEqual(ran.status, 0);
  assert.deepEqual(failedOf(lines), [{ gen: 1, point: 'effect.kept charge', n: 5, reason: 'not released' }]);
  assert.equal(lines.filter((line) => line.kind === 'handoff').length, 0);
});

test('handoff.failed, "not released": a record that says sleeping without the released generation\'s seal is not a completed release', { timeout: 200_000 }, async (t) => {
  const { ran, lines } = await failing(t, { wrap: 'unsealed' });
  assert.notEqual(ran.status, 0);
  assert.deepEqual(failedOf(lines), [{ gen: 1, point: 'effect.kept charge', n: 5, reason: 'not released' }]);
  assert.equal(lines.filter((line) => line.kind === 'handoff').length, 0);
});
