// examples/moves, offline: one run on the reference entry (`demo()`), three agent nodes and two hand-overs, with the scripted lead and stand-in
// sandboxes. No network, no key. The run is made once; each test reads a different part of what it left.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rotatingHost } from './moves/rotate.ts';
import { NEVER_SAYS, SAYS } from './moves/config.ts';
import { parseReply } from './moves/tools.ts';

const RUN = fileURLToPath(new URL('./moves/run.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const THREADS = 8;
const made = () => `value-${randomBytes(12).toString('hex')}`;
const secrets = { ANTHROPIC_API_KEY: made(), MODAL_TOKEN_ID: made(), MODAL_TOKEN_SECRET: made() };

let base;
let record;
let run;

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'moves-test-'));
  record = join(base, 'recording');
    run = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', RUN, '--handoff', '--record', record, '--dir', join(base, 'run')], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...secrets },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
});
after(() => base && rmSync(base, { recursive: true, force: true }));

/** Where the stand-in sandboxes wrote their ledger: beside the run's workspace. */
const boxDir = () => join(base, 'run', 'boxes');
const lines = () => readFileSync(join(record, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const count = (kind) => lines().filter((l) => l.source === 'host' && l.kind === kind).length;

test('one run, three processes, two planned hand-overs and nothing else: no kill, no revoke, no fence, no failed hand-over', () => {
  assert.equal(run.code, 0, run.out.slice(-600));
  assert.match(run.out, /complete in 3 processes, 2 handoffs/);
  assert.equal(count('process.started'), 3);
  assert.equal(count('handoff'), 2);
  for (const kind of ['kill', 'revoke', 'fenced', 'handoff.failed']) assert.equal(count(kind), 0, kind);
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  assert.deepEqual([manifest.generations, manifest.kills, manifest.handoffs], [3, 0, 2]);
  const statuses = lines().filter((l) => l.kind === 'run.json').map((l) => l.data.status);
  assert.deepEqual(statuses, ['running', 'sleeping', 'running', 'sleeping', 'running', 'done']);
});

test('the recording is a valid agentrun.recording/1, and each hand-over was applied exactly once, repeated 0', () => {
  const valid = spawnSync(process.execPath, [join(REPO, 'scripts/recording/validate.mjs'), record], { encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const folded = JSON.parse(spawnSync(process.execPath, [join(REPO, 'scripts/recording/fold.mjs'), record], { encoding: 'utf8' }).stdout);
  assert.equal(folded.paid.total, 2, 'hand_over and hand_back');
  assert.equal(folded.repeated, 0);
});

test('the session picked the best of 8 threads, and the answer node read it back on the first machine', () => {
  const manifest = JSON.parse(readFileSync(join(record, 'manifest.json'), 'utf8'));
  const result = JSON.parse(readFileSync(join(record, 'blobs', `${manifest.result.blob}.json`), 'utf8')).record;
  assert.equal(result.picked, 4);
  assert.match(result.answer, /Thread 4 won with a final loss of/);
  assert.doesNotMatch(result.answer, /THINKING LOST/, 'thinking blocks stayed in the node\'s own context');
});

test('a forked child answers: the node forked 8 conversations and every one reported a metric, its settings and a GPU line', () => {
  const forkResult = lines().find((l) => l.kind === 'tool_execution_end' && l.data.toolName === 'fork_threads');
  const text = forkResult.data.entry.model[0].content[0].text;
  const rows = text.split('\n');
  assert.equal(rows.length, THREADS);
  rows.forEach((row, i) => {
    assert.match(row, new RegExp(`^thread ${i + 1}: `));
    const parsed = parseReply(row);
    assert.equal(typeof parsed.metric, 'number', row);
    assert.ok(parsed.settings && parsed.gpu, row);
  });
  assert.equal(new Set(forkResult.data.entry.model[0].details.threads).size, THREADS, 'eight different conversations');
});

test('each thread had a sandbox of its own, asked to be an H100 on gVisor, and every sandbox was ended', () => {
  const boxes = readFileSync(join(boxDir(), 'boxes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const created = boxes.filter((b) => b.ev === 'create');
  assert.equal(created.length, THREADS);
  assert.equal(new Set(created.map((b) => b.id)).size, THREADS);
  for (const b of created) assert.deepEqual([b.spec.gpu, b.spec.isolation, typeof b.spec.image, b.spec.labels.run], ['H100!', 'gvisor', 'string', 'moves']);
  assert.deepEqual(boxes.filter((b) => b.ev === 'destroy').map((b) => b.id).sort(), created.map((b) => b.id).sort(), 'the same eight, ended');
});

test('no secret value is in the recording, the sandboxes\' ledger or what the run printed', () => {
  const walk = (dir, hits = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, hits);
      else for (const [name, value] of Object.entries(secrets)) if (readFileSync(full).includes(value)) hits.push(`${name} in ${entry.name}`);
    }
    return hits;
  };
  assert.deepEqual(walk(base), []);
  assert.deepEqual(walk(boxDir()), []);
  for (const value of Object.values(secrets)) assert.ok(!run.out.includes(value));
  assert.equal(readFileSync(join(record, 'events.jsonl'), 'utf8').match(/\/home\/|\/Users\//g), null, 'no home path in the recording');
});

test('the live parts take their keys out of the environment and hold them in a closure', async () => {
  const env = { ...process.env, ...secrets };
  Object.assign(process.env, secrets);
  const { live } = await import('./moves/model.ts');
  const parts = live({ env });
  for (const name of Object.keys(secrets)) {
    assert.equal(env[name], undefined);
    assert.equal(process.env[name], undefined, `${name} is gone from process.env`);
  }
  assert.deepEqual(Object.keys(parts.tools).sort(), ['hand_back', 'hand_over']);
  assert.equal(parts.models.lead, 'anthropic/claude-sonnet-5-5');
});

test('the wording is the agreed one in the spec and the README, and never the words the example does not use', () => {
  const spec = JSON.parse(readFileSync(new URL('./moves/demo.json', import.meta.url), 'utf8'));
  assert.equal(spec.claim, SAYS);
  const readme = readFileSync(new URL('./moves/README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  assert.ok(readme.includes(SAYS));
  for (const never of NEVER_SAYS) { assert.doesNotMatch(readme, never); assert.doesNotMatch(spec.claim, never); }
});

test('the rotating host starts attempt 1 and 3 on the first host and attempt 2 on the second, and routes the rest by the handle', async () => {
  const log = [];
  const host = (name) => ({ start: async (_ref, _token, attempt) => (log.push(`start ${name} ${attempt.attempt}`), { driver: name }), status: async (h) => (log.push(`status ${h.driver}`), 'running'), stop: async (h) => void log.push(`stop ${h.driver}`) });
  const rotating = rotatingHost({ local: host('local'), modal: host('modal') }, ['local', 'modal']);
  const handles = [];
  for (const attempt of [1, 2, 3]) handles.push(await rotating.start({}, 'token', { attempt }));
  await rotating.status(handles[1]);
  await rotating.stop(handles[2]);
  assert.deepEqual(log, ['start local 1', 'start modal 2', 'start local 3', 'status modal', 'stop local']);
  assert.equal(await rotating.status({ driver: 'elsewhere' }), 'unknown');
});
