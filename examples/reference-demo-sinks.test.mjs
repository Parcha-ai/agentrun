// The harness's SINKS (what leaves demo()): K1 the JSON the CLI prints, K2 the summary it prints, K3 the result it returns, K4 an error it throws (a
// place's start included); and the SOURCE, a run process's own error line. A key a run process printed (its stderr) or carried in an error message
// never reaches any of them: the run's tracked redaction when it records, the scanner's credential pass always, and the rest of the text is kept.
// Out of scope by design: a key split across lines, or encoded.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE, run } from './reference-demo-helpers.mjs';

const KEPT = 'and a plain line after it';
const KEY = `sk-${'q'.repeat(8)}${'7'.repeat(26)}`;
const TRACKED = `plainword${'x'.repeat(14)}`;
const TRACKING = { keys: [{ env: 'DEMO_TRACKED_TOKEN', why: 'a value the run tracks', where: 'the test', required: false, for: 'live' }] };

/** A run of the fixture with `env`, recorded (`--record`) or not, with what the CLI printed captured: its result or its error. */
async function sinkRun(t, { record, spec = {}, env, argv }) {
  const printed = [];
  const log = console.log;
  console.log = (...args) => { printed.push(args.join(' ')); };
  try {
    if (record) return await run(t, spec, argv, env).then((done) => ({ result: done.result, printed }), (error) => ({ error, printed }));
    const tmp = await mkdtemp(join(tmpdir(), 'reference-demo-sinks-'));
    t.after(() => rm(tmp, { recursive: true, force: true }));
    const file = join(tmp, 'demo.json');
    writeFileSync(file, JSON.stringify({ name: 'reference', ...spec }));
    const before = { ...process.env };
    Object.assign(process.env, { DEMO_SPEC: file, ...env });
    t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
    const { demo: fixtureDemo } = await import('@parcha/agentrun-harness');
    const { options } = await import(`${FIXTURE}?options=${Date.now()}`);
    return await fixtureDemo({ ...options, argv: [...argv, '--dir', join(tmp, 'run')] }).then((result) => ({ result, printed }), (error) => ({ error, printed }));
  } finally { console.log = log; }
}

const PLANTS = [
  { name: 'a credential-shaped key, with --record', record: true, secret: KEY, spec: {}, env: {} },
  { name: 'a credential-shaped key, with no recording', record: false, secret: KEY, spec: {}, env: {} },
  { name: 'a tracked plain-word value, with --record', record: true, secret: TRACKED, spec: TRACKING, env: { DEMO_TRACKED_TOKEN: TRACKED } },
];

for (const plant of PLANTS) {
  const never = (text, where) => assert.equal(text.includes(plant.secret), false, `${where}: no planted value`);
  test(`K1 + K3: ${plant.name} in a run process's stderr never reaches the --json output or the returned result; the rest is kept`, { timeout: 300_000 }, async (t) => {
    const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_STDERR_SECRET: plant.secret }, argv: ['--json'] });
    assert.ok(out.result, String(out.error?.message));
    never(JSON.stringify(out.result), 'K3, the result');
    never(out.printed.join('\n'), 'K1, the --json output');
    assert.ok(JSON.stringify(out.result.processes).includes(KEPT), 'the rest of the stderr is kept');
  });
  test(`K2: ${plant.name} in a run process's stderr never reaches the summary`, { timeout: 300_000 }, async (t) => {
    const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_STDERR_SECRET: plant.secret }, argv: [] });
    assert.ok(out.result, String(out.error?.message));
    never(out.printed.join('\n'), 'K2, the summary');
    never(JSON.stringify(out.result), 'K3, the result');
  });
  test(`K1 + K3 + the source: ${plant.name} in a run process's error message never reaches its outcome line, the --json output or the result; the rest is kept`, { timeout: 300_000 }, async (t) => {
    const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_RESULT_THROWS: '1', DEMO_RESULT_THROWS_TEXT: `the hook printed token ${plant.secret}\n${KEPT}` }, argv: ['--json'] });
    assert.ok(out.result, String(out.error?.message));
    never(JSON.stringify(out.result.processes.at(-1).outcome), 'the source, the outcome line');
    never(JSON.stringify(out.result), 'K3, the result');
    never(out.printed.join('\n'), 'K1, the --json output');
    assert.ok(JSON.stringify(out.result.processes.at(-1).outcome).includes(KEPT), 'the rest of the message is kept');
  });
  test(`K2: ${plant.name} in a run process's error message never reaches the summary`, { timeout: 300_000 }, async (t) => {
    const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_RESULT_THROWS: '1', DEMO_RESULT_THROWS_TEXT: `the hook printed token ${plant.secret}\n${KEPT}` }, argv: [] });
    assert.ok(out.result, String(out.error?.message));
    never(out.printed.join('\n'), 'K2, the summary');
    assert.ok(out.printed.join('\n').includes('stopped:'), 'the summary names the stop');
  });
  test(`K4: ${plant.name} in a place's start error never reaches the error demo() throws (its message and its stack); the rest is kept`, { timeout: 300_000 }, async (t) => {
    const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_WITH_PLACE: 'start-fails', DEMO_START_FAILS_TEXT: `the place printed token ${plant.secret}\n${KEPT}` }, argv: ['--json'] });
    assert.ok(out.error, 'the run fails');
    never(out.error.message, 'K4, the message');
    never(String(out.error.stack), 'K4, the stack');
    assert.ok(out.error.message.includes(KEPT), 'the rest of the error is kept');
  });
}
