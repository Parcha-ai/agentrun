// Shared helpers of the reference entry's demo tests: the environment snapshot, the `run` and `specWith` drivers, the fake places and the fixtures the tests of several areas use.
// The helpers every file of the reference host's demo tests shares are in reference-demo-helpers.mjs (one non-test module; node --test runs each *.test.mjs file in its own process).
// The reference entry as a demo's platform (item A of the entry brief): the spec's kills list through the supervisor (a named crossing, a storm, a box kind),
// --input, --max-usd, the browser choice, and the box the job's tools run in. The demo here is the reference job itself, started through demo-fixture.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fold, readEvents } from '../scripts/recording/fold.mjs';
import { validateRecording } from '../scripts/recording/validate.mjs';
import { effectiveBoxes } from '../packages/harness/dist/demo-spec.js';
import { BOX_CROSSINGS, localPlace, priceJudge, chooseBrowser, crossings, demo, tapBox, JEV_LIST_PRICE, jevCost, killsOf, maxUsdOf, parseInput, plansOf } from '@parcha/agentrun-harness';

export const ORIGINAL = { ...process.env };

export const FIXTURE = new URL('./reference/demo-fixture.ts', import.meta.url).href;

export const BASELINE = new WeakMap();

export async function run(t, spec, argv, env = {}) {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-demo-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', ...spec }));
  // The environment as the test found it: the first call in a test records it, so a later call's restore cannot put back what an earlier call set.
  if (!BASELINE.has(t)) BASELINE.set(t, { ...process.env });
  const before = BASELINE.get(t);
  Object.assign(process.env, { DEMO_SPEC: file, ...env });
  // Back to the environment the test file started with, whatever order the hooks of several runs in one test come in.
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  // The supervisor is this process; it starts the fixture as each child.
  const { demo: fixtureDemo } = await import('@parcha/agentrun-harness');
  // The supervisor needs the same fakes and job the fixture runs (it serves the fake browser's pages): the fixture's own module, imported.
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  const recording = join(tmp, 'recording');
  const result = await fixtureDemo({ ...options, argv: ['--record', recording, ...argv] });
  return { result, recording, tmp };
}

// ---- the review of #518: one test for each thread ---------------------------------------------------------------------------------------------

export const { composeHost, destroyBoxes, meterKnown } = await import('../packages/harness/dist/demo.js');

export const { RUN_LABEL } = await import('../packages/harness/dist/boxes.js');

export const { localBoxes } = await import('@parcha/pi-transport/box/local');

export const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');

export const { finish } = await import('@parcha/pi-transport');

export const lines = () => { const kept = []; return { kept, recorder: { live: (source, kind, data) => kept.push([source, kind, data.crossing ?? data.killed ?? null]) } }; };

export const planFor = (point) => crossings({ run: undefined, tools: [{ point, kind: 'box', why: 'x', target: 'tool', n: 1 }] }, undefined, Date.now(), undefined, { open: 0 });

// A place that wraps the local one and records what the supervisor does through it, with the recording's kill lines it could see at each call.
export function recordingPlace(calls, recordDir, options = {}) {
  return ({ paths, self, destroyBoxes, requestFile }) => {
    const inner = localPlace({ self, paths, destroyBoxes, requestFile });
    const killLinesNow = () => {
      try {
        return readdirSync(join(recordDir, '.spool')).filter((name) => name.startsWith('supervisor-')).flatMap((name) => readFileSync(join(recordDir, '.spool', name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))).filter((line) => line.kind === 'kill').length;
      } catch { return 0; }
    };
    return {
      ...inner, name: 'fake', kills: options.kills ?? ['process', 'box'], ...(options.token ? { token: (attempt) => `mount-token-${attempt}` } : {}),
      start: async (order) => { calls.push({ call: 'start', gen: order.gen, stdin: order.stdin, secretInEnv: Object.values(order.env).includes(order.stdin) }); return inner.start(order); },
      kill: async (runner, kind) => {
        calls.push({ call: 'kill', kind, killLines: killLinesNow() });
        await inner.kill(runner, kind);
        if (options.killThrows) throw Object.assign(new Error('the provider would not confirm'), { code: 'KILL_FAILED' });
      },
      recover: async (last, kind, order) => { calls.push({ call: 'recover', kind, gen: order.gen, stdin: order.stdin }); return inner.recover(last, kind, order); },
      release: async () => { calls.push({ call: 'release' }); },
    };
  };
}

export const specWith = async (t, spec) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-place-'));
  t.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = join(tmp, 'demo.json');
  writeFileSync(file, JSON.stringify(spec));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  return { tmp, options };
};

/** Ends the processes a test left running and returns when they are gone: a test that fakes a kill leaves the real child writing under the run's directory, and the directory's removal fails (ENOTEMPTY) while it does. Call it in a `finally`, before the test ends. */
export const reap = async (pids) => {
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  const deadline = Date.now() + 10_000;
  for (const pid of pids) {
    while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
};

export const SITES = { registry: { title: 'The company registry', description: 'Company records: number, incorporation date, status.', startUrl: 'http://registry.example/companies/01234567' } };

// ---- secrets in a recording ------------------------------------------------------------------------------------------------------------------

/** A sign-in home with made-up tokens (derived from their names, so no literal in this file looks like a credential). */
export const signInHome = async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'reference-signin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const tokens = Object.fromEntries(['access', 'refresh', 'idToken'].map((field) => [field, `made-up-${field}-token-${'x'.repeat(24)}`]));
  const key = `made-up-provider-key-${'z'.repeat(24)}`;
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ version: 1, hostId: 'host-for-the-test', credentials: { openai: { type: 'oauth', ...tokens, expires: 1_900_000_000_000, clientId: 'client-for-the-test', scopes: ['scope-for-the-test'] }, other: { type: 'api_key', key } } }));
  return { home, tokens: { ...tokens, key } };
};

export const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)]));

export const killSpec = async (t, extra = {}) => {
  const tmp = await mkdtemp(join(tmpdir(), 'reference-nonce-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const file = join(tmp, 'spec.json');
  writeFileSync(file, JSON.stringify({ name: 'reference', kills: [{ point: 'judge.asked verdict', why: 'asked through the place' }], ...extra }));
  Object.assign(process.env, { DEMO_SPEC: file });
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in ORIGINAL)) delete process.env[name]; Object.assign(process.env, ORIGINAL); });
  const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
  return { tmp, options };
};

// ---- a box place's recording, brought home ------------------------------------------------------------------------------------------------------

/** A place whose child writes its recording in a directory of its own (a box's, here a folder; the child writes the recording's clock there itself, from RECORD_STARTED), and that brings it home the way the seam says: blobs first (hash-checked, temp name, rename), then the new bytes of each spool file up to its last whole line. */
export const boxed = (tmp, { failOn, calls = [], kind = 'process' } = {}) => ({ paths, self, destroyBoxes, requestFile }) => {
  const inner = localPlace({ self, paths, ...(kind === 'box' ? { destroyBoxes: async () => undefined } : {}), requestFile });
  const dirs = new Map();
  const offsets = new Map();
  let into;
  const dir = (attempt) => join(tmp, 'box', `record-${attempt}`);
  const home = {
    dir,
    bringHome: async (target, { final = false } = {}) => {
      calls.push({ final, manifest: existsSync(join(target, 'manifest.json')), attempts: [...dirs.keys()] });
      const failure = failOn?.({ final, calls: calls.length });
      if (failure) throw Object.assign(new Error(`the box could not be read at ${tmp}/box: ${failure}`), { code: failure });
      for (const [attempt, from] of dirs) {
        const blobs = join(from, 'blobs');
        for (const name of existsSync(blobs) ? readdirSync(blobs).filter((entry) => !entry.startsWith('.')) : []) {
          const bytes = readFileSync(join(blobs, name));
          if (createHash('sha256').update(bytes).digest('hex') !== name.split('.')[0]) throw Object.assign(new Error('a blob does not hash to its name'), { code: 'BLOB_MISMATCH' });
          mkdirSync(join(target, 'blobs'), { recursive: true });
          if (!existsSync(join(target, 'blobs', name))) { const temporary = join(target, 'blobs', `.${name}.tmp-${process.pid}`); writeFileSync(temporary, bytes); renameSync(temporary, join(target, 'blobs', name)); }
        }
        const spool = join(from, '.spool');
        for (const name of existsSync(spool) ? readdirSync(spool).filter((entry) => entry.endsWith('.jsonl')) : []) {
          const text = readFileSync(join(spool, name), 'utf8');
          const done = offsets.get(`${attempt}/${name}`) ?? 0;
          const whole = text.slice(0, text.lastIndexOf('\n') + 1);
          if (whole.length > done) { appendFileSync(join(target, '.spool', name), whole.slice(done)); offsets.set(`${attempt}/${name}`, whole.length); }
        }
      }
    },
  };
  const start = async (order) => { into = order.env.RECORD_DIR; const own = dir(order.gen); mkdirSync(own, { recursive: true }); dirs.set(order.gen, own); return { order: { ...order, env: { ...order.env, RECORD_DIR: own } } }; };
  return {
    ...inner, recordHome: home,
    start: async (order) => { const { order: next } = await start(order); return inner.start(next); },
    recover: async (last, kindOf, order) => { const { order: next } = await start(order); return inner.recover(last, kindOf, next); },
  };
};
