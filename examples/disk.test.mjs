// The disk demo on fakes, the template's three beats (examples/disk): the job finishes and writes its payoff; with --kill the process dies at the named crossing, the next one
// resumes, and the recording's own fold reads repeated 0 and unknown 0 with every paid call made once; every paid call has a receipt, the recording validates, and its cost is a number
// or unknown. The expected values are fixed by hand from the scripted job (ten invoices of 1250 + 175 n cents), not read back from the run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';

const RUN = new URL('./disk/run.ts', import.meta.url).pathname;
const DEMO = JSON.parse(readFileSync(new URL('./disk/demo.json', import.meta.url), 'utf8'));
const INVOICES = Array.from({ length: 10 }, (_, index) => `INV-${String(index + 1).padStart(3, '0')}`);
const CENTS = INVOICES.map((_, index) => 1250 + 175 * index);

const scratch = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'disk-demo-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
/** `node examples/disk/run.ts <args>`: what `npm run demo:disk -- <args>` runs. */
const demo = (args) => {
  const ran = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', RUN, ...args], { encoding: 'utf8', timeout: 150_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  return ran;
};
const rows = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const charges = (dir) => rows(join(dir, 'ledger.jsonl')).filter((row) => row.kind === 'tool' && row.name === 'charge');

test('beat 1, the job: ten invoices charged once each, the settlement note written, every receipt named', { timeout: 200_000 }, async (t) => {
  const dir = join(await scratch(t), 'run');
  const result = JSON.parse(demo(['--json', '--dir', dir]).stdout);
  assert.deepEqual(result.processes.map((process) => process.outcome.status), ['complete']);
  const { record } = result;
  assert.equal(record.batch, 'october-vendors');
  assert.deepEqual([record.charged, record.cents], [10, CENTS.reduce((sum, cents) => sum + cents, 0)]);
  assert.deepEqual(record.receipts, INVOICES.map((invoice, index) => ({ invoice, receipt: `rcpt-${invoice}`, cents: CENTS[index] })));
  assert.equal(record.note, '10 invoices settled, each charged once.');
  assert.equal(charges(dir).length, 10, 'the paid tool was called once per invoice');
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
  // Every invoice was charged once in all: five before the kill, five after it, none of the first five again.
  assert.deepEqual(charges(dir).length, 10);
  const perProcess = Object.values(Object.groupBy(charges(dir), (row) => row.incarnation)).map((group) => group.length);
  assert.deepEqual(perProcess, [5, 5], 'five charges before the kill, the other five after it, by two processes');
  // The resumed run's payoff is the unkilled run's.
  assert.deepEqual(result.record.receipts.map((receipt) => receipt.invoice), INVOICES);
  assert.equal(result.record.charged, 10);
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
  // The run kept each paid call's answer under the call's own id: ten answers, each the receipt of its invoice.
  const answers = readdirSync(join(dir, 'answers')).map((name) => JSON.parse(readFileSync(join(dir, 'answers', name), 'utf8')));
  assert.equal(answers.length, 10);
  assert.deepEqual(answers.map((answer) => answer.value.receipt).sort(), INVOICES.map((invoice) => `rcpt-${invoice}`));
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
