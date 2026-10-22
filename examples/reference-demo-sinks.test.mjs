// The harness's SINKS (what leaves demo()): K1 the JSON the CLI prints, K2 the summary it prints, K3 the result it returns, K4 an error it throws (a
// place's start included); and the SOURCE, a run process's own error line. A key a run process printed (its stderr) or carried in an error message
// never reaches any of them: the run's tracked redaction when it records, the scanner's credential pass always, and the rest of the text is kept.
// Out of scope by design: a key split across lines, or encoded.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inspect } from 'node:util';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURE, run } from './reference-demo-helpers.mjs';
import { ledgerOut, render, uncutRefusal } from './reference/kill-anywhere.ts';
import { referenceOutput } from './reference/run.ts';
import { BoxError } from '@parcha/pi-transport';

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
  test(`K4: ${plant.name} in the CAUSE of a real pi-transport BoxError a place's start threw never reaches the thrown error as Node prints it (util.inspect: the cause chain and every property); its class, code and the rest are kept`, { timeout: 300_000 }, async (t) => {
    const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_WITH_PLACE: 'start-fails-cause', DEMO_START_FAILS_TEXT: `the library said token ${plant.secret}\n${KEPT}` }, argv: ['--json'] });
    assert.ok(out.error, 'the run fails');
    const shown = inspect(out.error, { depth: 10 });
    never(shown, 'K4, util.inspect of the error');
    assert.ok(shown.includes(KEPT), 'the rest of the cause is kept');
    assert.equal(out.error.name, 'BoxError');
    assert.ok(out.error instanceof BoxError && out.error instanceof Error, 'a library caller\'s instanceof holds');
    assert.equal(out.error.code, 'unknown');
    assert.ok(out.error.cause instanceof Error, 'the cause chain is kept, redacted');
  });
  for (const [shape, about] of [['start-fails-nested', 'an error inside an array property'], ['start-fails-map-cause', 'a Map as the cause'], ['start-fails-timeout', 'a DOMException (a TimeoutError)'], ['start-fails-cyclic', 'a cyclic plain-object property'], ['start-fails-cause-cycle', 'a cause cycle']]) {
    test(`K4: ${plant.name} in ${about} a place's start threw never reaches the thrown error as Node prints it; its name stays readable, and no RangeError replaces it`, { timeout: 300_000 }, async (t) => {
      const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_WITH_PLACE: shape, DEMO_START_FAILS_TEXT: `token ${plant.secret}` }, argv: ['--json'] });
      assert.ok(out.error, 'the run fails');
      assert.equal(out.error instanceof RangeError, false, 'not a stack overflow');
      const shown = inspect(out.error, { depth: 10 });
      never(shown, 'K4, util.inspect of the error');
      assert.equal(typeof out.error.name, 'string', 'its name is readable');
      assert.doesNotThrow(() => String(out.error));
      if (shape === 'start-fails-timeout') { assert.equal(out.error.name, 'TimeoutError'); assert.ok(out.error instanceof DOMException, 'a DOMException still'); assert.ok(String(out.error.stack).startsWith('TimeoutError: '), 'the stack still names its class'); }
      if (shape === 'start-fails-map-cause') { assert.deepEqual(out.error.withheldProperties, ['cause'], 'what was withheld is named'); assert.equal(Object.hasOwn(out.error, 'cause'), false, 'and not left behind as undefined'); }
    });
  }
  test(`K4: ${plant.name} in a string PROPERTY of the error a place's start threw never reaches the thrown error as Node prints it; the property's name and the rest are kept`, { timeout: 300_000 }, async (t) => {
    const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_WITH_PLACE: 'start-fails-property', DEMO_START_FAILS_TEXT: `the runner printed token ${plant.secret}\n${KEPT}` }, argv: ['--json'] });
    assert.ok(out.error, 'the run fails');
    const shown = inspect(out.error, { depth: 10 });
    never(shown, 'K4, util.inspect of the error');
    assert.equal(out.error.code, 'START_FAILED');
    assert.ok(typeof out.error.stderr === 'string' && out.error.stderr.includes(KEPT), 'the property is kept, redacted');
  });
  test(`K4: ${plant.name} in a place's start error never reaches the error demo() throws (its message and its stack); the rest is kept`, { timeout: 300_000 }, async (t) => {
    const out = await sinkRun(t, { record: plant.record, spec: plant.spec, env: { ...plant.env, DEMO_WITH_PLACE: 'start-fails', DEMO_START_FAILS_TEXT: `the place printed token ${plant.secret}\n${KEPT}` }, argv: ['--json'] });
    assert.ok(out.error, 'the run fails');
    never(out.error.message, 'K4, the message');
    never(String(out.error.stack), 'K4, the stack');
    assert.ok(out.error.message.includes(KEPT), 'the rest of the error is kept');
  });
}

// The reference examples' own sinks. Those entry points track no secrets, so only the credential-shaped plant can be pinned there; the tracked plain-word
// plant is pinned at K1 to K4 with --record above. (The reference examples could take a run's tracked list: a follow-up.)
test('K5: kill-anywhere\'s refusal of an uncut run that did not complete never carries a key its stderr or outcome held; the rest is kept', () => {
  const fromStderr = uncutRefusal({ stderr: `the tool printed token ${KEY}\n${KEPT}` });
  assert.equal(fromStderr.message.includes(KEY), false);
  assert.ok(fromStderr.message.includes(KEPT) && fromStderr.message.startsWith('the uncut job did not complete'));
  const fromOutcome = uncutRefusal({ outcome: { status: 'refused', code: 'X', message: `token ${KEY}\n${KEPT}` } });
  assert.equal(fromOutcome.message.includes(KEY), false);
  assert.ok(fromOutcome.message.includes(KEPT));
});

test('K6: kill-anywhere\'s ledger, as returned and printed (JSON or rendered), never carries a key a check\'s detail or a kill\'s outcome held', () => {
  const counted = { browser: {}, committedTurns: [], effects: {}, judge: {}, receipts: [], requests: 0, toolResults: [] };
  const ledger = { seed: 1, ms: 1, kills: [{ process: 1, plan: { point: 'p', n: 1 }, landed: null, generation: 1, ms: 1, outcome: `refused: token ${KEY}` }], processes: 1, browserCalls: [], runInterrupted: [], counted, reference: counted, pageRuns: [], trail: [], gates: [], covered: [], final: { status: 'refused', generation: 1, record: null }, checks: [{ name: 'the last process completed the run', ok: false, detail: `token ${KEY}\n${KEPT}` }] };
  const out = ledgerOut(ledger);
  assert.equal(JSON.stringify(out).includes(KEY), false, 'the JSON print');
  assert.ok(JSON.stringify(out).includes(KEPT));
  const rendered = render(out).join('\n');
  assert.ok(rendered.length > 0, 'the ledger renders');
  assert.equal(rendered.includes(KEY), false, 'the rendered print');
});

test('K7: the reference run\'s printed output (text and JSON) never carries a key a refused run\'s message held; the rest is kept', () => {
  const view = { status: 'refused', output: null, evidence: [], did: { disk: { generation: 1 }, workflow: {}, browser: {}, evidence: {}, vision: { looks: 0, misses: 0 } }, ledger: { calls: {} }, usage: {}, message: `token ${KEY}\n${KEPT}` };
  const result = { status: 'refused', code: 'NODE_FAILED', message: `the tool printed token ${KEY}\n${KEPT}` };
  const text = referenceOutput(view, result, '/run', false).join('\n');
  assert.equal(text.includes(KEY), false, 'the text print');
  assert.ok(text.includes(KEPT));
  const json = referenceOutput(view, result, '/run', true).join('\n');
  assert.equal(json.includes(KEY), false, 'the JSON print');
});

const { errorOutcome, handedOut, handedOutError } = await import('../packages/harness/dist/demo.js');

test('the SOURCE: a run process\'s error outcome line passes the process\'s OWN redaction (a value only it tracks, with no credential shape) and the credential pass', () => {
  const own = `signinonly${'z'.repeat(14)}`;
  const line = errorOutcome(new Error(`the sign-in printed ${own}\ntoken ${KEY}\n${KEPT}`), (text) => text.replaceAll(own, '[REDACTED:signin]'));
  assert.equal(line.includes(own), false, 'the process\'s own tracked value');
  assert.equal(line.includes(KEY), false, 'a credential-shaped key');
  assert.ok(line.includes(KEPT));
  assert.equal(JSON.parse(line).outcome.status, 'error');
});

test('the SOURCE as the run process WRITES it (its own outcome line, as the place read it, before any sink): a token only the process tracks never reaches that line, and the rest of the message does', { timeout: 300_000 }, async (t) => {
  const own = `childonly${'w'.repeat(14)}`;
  const dir = await mkdtemp(join(tmpdir(), 'reference-demo-source-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const capture = join(dir, 'exit.json');
  const spec = { keys: [{ env: 'DEMO_CHILD_ONLY_TOKEN', why: 'a sign-in value only the run process holds', where: 'the test', required: false, for: 'live' }] };
  await sinkRun(t, { record: true, spec, env: { DEMO_WITH_PLACE: 'capture-exit', DEMO_CHILD_ONLY: own, DEMO_CAPTURE_FILE: capture, DEMO_RESULT_THROWS: '1', DEMO_RESULT_THROWS_TEXT: `the sign-in printed ${own}\n${KEPT}` }, argv: ['--json'] });
  const exit = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(exit.outcome?.status, 'error', 'the process wrote its error outcome line');
  assert.equal(JSON.stringify(exit.outcome).includes(own), false, 'the token only the process tracks is not in its own line');
  assert.ok(JSON.stringify(exit.outcome).includes(KEPT), 'the rest of its message is');
});

test('an AggregateError\'s errors are carried through the walker: none of them reaches util.inspect with a key, and they are kept', () => {
  const out = handedOutError(new AggregateError([new Error(`token ${KEY}\n${KEPT}`), 'plain'], 'several things failed'));
  assert.equal(inspect(out, { depth: 10 }).includes(KEY), false);
  assert.equal(out.errors.length, 2);
  assert.ok(out.errors[0].message.includes(KEPT));
});

test('a value SHARED by two branches (no cycle) survives in both, in a result and inside an error; only a cycle is cut', () => {
  const shared = { grids: [1, 2], note: `token ${KEY}` };
  const result = handedOut({ beat: shared, again: shared });
  assert.deepEqual(result.beat.grids, [1, 2]);
  assert.deepEqual(result.again.grids, [1, 2], 'the second reference is kept, not cut');
  assert.equal(JSON.stringify(result).includes(KEY), false);
  const error = handedOutError(Object.assign(new Error('failed'), { first: shared, second: shared }));
  assert.deepEqual([error.first?.grids, error.second?.grids], [[1, 2], [1, 2]]);
  const cyclic = { x: 1 };
  cyclic.self = cyclic;
  assert.equal(handedOut(cyclic).self, undefined, 'a cycle is cut');
});

/** A "diamond ladder": each level's two keys hold the same next level, so a walk that follows every path does 2^depth of them. */
const ladder = (depth) => { let level = { text: `token ${KEY}` }; for (let i = 0; i < depth; i += 1) level = { left: level, right: level }; return level; };
test('a value shared down a deep ladder is walked ONCE (linear, not once per path), in a result and inside an error, and stays in every branch', () => {
  for (const depth of [20, 30]) {
    const begun = Date.now();
    const result = handedOut({ ladder: ladder(depth) });
    const error = handedOutError(Object.assign(new Error('failed'), { details: ladder(depth) }));
    const took = Date.now() - begun;
    assert.ok(took < 1000, `depth ${depth} took ${took} ms`);
    let node = result.ladder;
    let fromError = error.details;
    for (let i = 0; i < depth; i += 1) { assert.equal(node.left, node.right, `level ${i}: one copy in both branches`); node = node.left; fromError = fromError.right; }
    assert.equal(node.text.includes(KEY), false);
    assert.ok(node.text.includes('withheld'));
    assert.equal(fromError.text.includes(KEY), false);
  }
});

test('an ERROR shared down a deep ladder (each error\'s two properties hold the same next error) is copied once, linear, and stays in both branches', () => {
  // Depth 14 first: a walk once per path fails there in seconds instead of hanging at 30.
  for (const depth of [14, 30]) {
    let level = new Error(`token ${KEY}`);
    for (let i = 0; i < depth; i += 1) level = Object.assign(new Error(`level ${i}`), { left: level, right: level });
    const begun = Date.now();
    const out = handedOutError(level);
    const took = Date.now() - begun;
    assert.ok(took < 1000, `depth ${depth} took ${took} ms`);
    let node = out;
    for (let i = 0; i < depth; i += 1) { assert.equal(node.left, node.right, `level ${i}: one copy in both branches`); node = node.left; }
    assert.equal(inspect(node).includes(KEY), false);
  }
});

test('a non-plain value NESTED in a plain object inside an error is withheld, named by its path, and not left behind; its plain siblings are kept', () => {
  const out = handedOutError(Object.assign(new Error('failed'), { details: { map: new Map([['stderr', `token ${KEY}`]]), keep: 'plain' } }));
  assert.equal(Object.hasOwn(out.details, 'map'), false, 'the Map key is absent from the copied details');
  assert.equal(out.details.keep, 'plain');
  assert.deepEqual(out.withheldProperties, ['details.map']);
  assert.equal(inspect(out, { depth: 10 }).includes(KEY), false);
});

