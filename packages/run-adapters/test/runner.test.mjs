// createHarnessRunner through the interpreter, as a DSL host runs it: runWorkflow, under withRecovery where a test says
// so, on the faux harness. Each test is one thing a host depends on.
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, openJournal, withRecovery, memoryStore } from '@parcha/agentrun-dsl/recovery';
import { createHarnessRunner, HarnessRunError, modelPortFor, RUNNER_RECORDS } from '@parcha/agentrun-adapters';
import { fauxAdapter as scriptedAdapter, memorySessionStore, FAUX_RECORDS } from '@parcha/agentrun-adapters/testing';

/** Every test fails in 30 s at most: a node a regression leaves waiting fails the run instead of hanging it. */
const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);
/** Wait for `ready()`, failing after 5 s: a loop that outlived its test would keep the file running. */
async function until(ready, what) {
  for (const end = Date.now() + 5_000; !ready();) {
    if (Date.now() > end) throw new Error(`gave up waiting: ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The adapter, with each session refusing its 21st turn: a regression whose turns make no paid request (so the turn
 *  limit never counts them) fails at once instead of re-sending forever. */
function atMostSends(adapter, most = 20) {
  const open = adapter.open.bind(adapter);
  adapter.open = async (spec, io) => {
    const session = await open(spec, io);
    const send = session.send.bind(session);
    let sends = 0;
    session.send = async (text) => {
      if (++sends > most) throw new Error(`more than ${most} turns`);
      return send(text);
    };
    return session;
  };
  return adapter;
}
/** The faux harness, bounded: every test's sessions refuse a 21st turn. */
const fauxAdapter = (options) => atMostSends(scriptedAdapter(options));

const SCHEMAS = { Out: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } };
const agent = (extra = {}) => ({ node: 'agent', label: 'task', instructions: 'Answer.', out: 'Out', as: 'final', ...extra });
const doc = (root, schemas = SCHEMAS) => ({ v: 2, name: 'harness', schemas, output: { schemaId: 'Out', path: 'final' }, root });
const lookup = { name: 'lookup', description: 'Look a thing up.', inputSchema: { type: 'object' }, replay: 'safe', call: async () => ({ text: 'found' }) };

/** A store with no owner lock, as one whose dead owner's lock the system released: a later process takes the journal
 *  while an earlier one still holds its handle. */
const unlocked = () => {
  let record;
  const backend = { acquire: async () => async () => {}, read: async () => record && structuredClone(record), write: async (next) => { record = structuredClone(next); } };
  return { open: (bound) => openJournal(backend, bound) };
};
/** One process of a run under the recovery driver. */
async function underRecovery(recovery, workflow, runNode) {
  const driver = await openRecovery(recovery, workflow, { key: 'run-1' });
  try { return await runWorkflow(workflow, {}, withRecovery(driver, { runNode }, { durableNodes: true })); } finally { await driver.close(); }
}

test('a node delivers through the injected submit; a rejected review is answered in the same session', async () => {
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ say: 'Working.' }, { submit: { answer: 'draft' } }, { submit: { answer: 'final' } }, { end: true }] });
  const reviews = [];
  const workflow = doc(agent({ verify: undefined }));
  const runner = createHarnessRunner(adapter, { store });
  const result = await runWorkflow(workflow, {}, {
    runNode: (request) => runner({ ...request, review: async (candidate) => { reviews.push(candidate.answer); return candidate.answer === 'final' ? { accepted: true } : { accepted: false, message: 'too rough' }; } }),
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual([result.output, reviews, adapter.opened.length, adapter.closed.length], [{ answer: 'final' }, ['draft', 'final'], 1, 1]);
});

test('the submit envelope carries a node schema with a root ref and defs, relocated under value', async () => {
  const schemas = { Out: { $ref: '#/definitions/Answer', definitions: { Answer: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } } } };
  const seen = [];
  const adapter = fauxAdapter({ script: (spec) => { seen.push(spec.tools.find((t) => t.name === 'submit').inputSchema); return [{ submit: { answer: 1 } }, { submit: { answer: 'ok' } }]; } });
  const result = await runWorkflow(doc(agent(), schemas), {}, { runNode: createHarnessRunner(adapter, { store: memorySessionStore() }) });
  assert.deepEqual(result.output, { answer: 'ok' });
  assert.equal(seen[0].properties.value.$ref, '#/properties/value/definitions/Answer');
  assert.equal(adapter.requests, 2, 'the wrong type was rejected by the schema, then the right one accepted');
});

test("tools: a node's [] gives none, an absent list gives every registered tool, and an unknown name is refused, final", async () => {
  const offered = [];
  const adapter = fauxAdapter({ script: (spec) => { offered.push(spec.tools.map((t) => t.name)); return [{ submit: { answer: 'ok' } }]; } });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup] });
  await runWorkflow(doc(agent({ tools: [] })), {}, { runNode });
  await runWorkflow(doc(agent()), {}, { runNode });
  assert.deepEqual(offered, [['submit'], ['lookup', 'submit']]);
  await assert.rejects(runNode({ kind: 'agent', label: 'task', system: [], user: '{}', schema: SCHEMAS.Out, tools: ['shell'] }), (error) => error instanceof HarnessRunError && error.reason === 'refused' && error.final === true && /names the tool shell/.test(error.message));
  assert.equal(adapter.requests, 2, 'the refused node spent nothing');
});

/** The adapter, keeping the tools the runner hands each session: a harness that calls one after its node ended. */
function keptTools(adapter) {
  const kept = [];
  const open = adapter.open.bind(adapter);
  adapter.open = async (spec, io) => { kept.push(new Map(spec.tools.map((t) => [t.name, t]))); return open(spec, io); };
  return { adapter, kept };
}
const REFUSED = (error) => error.message === 'the session has stopped; tool execution refused';

test('a host tool called after an accepted submit, or after the node stopped, never runs: the call rejects', async () => {
  let ran = 0;
  const counting = { ...lookup, call: async () => { ran += 1; return { text: 'found' }; } };
  // In the same turn as the accepted submit: the harness's call is answered an error, and the tool does not run.
  const ends = [];
  const after = keptTools(fauxAdapter({ script: () => [{ submit: { answer: 'ok' } }, { call: 'lookup' }] }));
  const runner = createHarnessRunner(after.adapter, { store: memorySessionStore(), tools: [counting], onEvent: (e) => { if (e.type === 'tool_end') ends.push([e.name, e.isError]); } });
  assert.deepEqual(await runner(stepRequest({ tools: ['lookup'] })), { answer: 'ok' });
  assert.deepEqual(ends, [['submit', false], ['lookup', true]]);
  // Later, from a harness still holding the tool: the call rejects with the refusal.
  await assert.rejects(after.kept[0].get('lookup').call({}, { callId: 'late', signal: new AbortController().signal }), REFUSED);
  // After a stop (here no_progress): the node failed, and a call that arrives afterwards rejects.
  const stopped = keptTools(fauxAdapter({ script: () => [] }));
  await assert.rejects(createHarnessRunner(stopped.adapter, { store: memorySessionStore(), tools: [counting] })(stepRequest({ tools: ['lookup'] })), (error) => error.reason === 'no_progress');
  await assert.rejects(stopped.kept[0].get('lookup').call({}, { callId: 'late', signal: new AbortController().signal }), REFUSED);
  assert.equal(ran, 0, 'the host tool never ran');
});

test('a fork is refused at create time, final, before anything is spent', async () => {
  const adapter = fauxAdapter({ script: () => [{ submit: { answer: 'ok' } }] });
  const recovery = memoryStore();
  await assert.rejects(underRecovery(recovery, doc(agent({ context: 'fork' })), createHarnessRunner(adapter, { store: memorySessionStore() })), /cannot fork|no caller transcript to fork/);
  assert.deepEqual([adapter.requests, adapter.opened.length], [0, 0]);
});

test('a refused node leaves no timer or listener behind', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
  const signal = new AbortController().signal;
  // Each turn is a paid request, so a node a regression lets through ends at its turn limit and fails here at once,
  // instead of re-sending turns that never count.
  const adapter = fauxAdapter({ script: () => Array.from({ length: 20 }, () => ({ say: 'thinking' })) });
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup], signal, maxTurns: 4 });
  const before = timers();
  const ask = (extra) => runNode({ kind: 'agent', label: 'task', system: [], user: '{}', schema: SCHEMAS.Out, ...extra });
  for (const extra of [{ context: 'fork' }, { tools: ['shell'] }, { maxTurns: 9 }]) await assert.rejects(ask(extra), (error) => error.final === true);
  assert.equal(adapter.requests, 0, 'every refusal came before anything was paid');
  assert.equal(timers(), before);
});

test("a node's max_turns applies within the runner's cap; one above it is refused, final; reaching it fails final, with no second attempt", async () => {
  const chatty = () => fauxAdapter({ script: () => Array.from({ length: 20 }, () => ({ say: 'thinking' })) });
  const withTurns = (runner, maxTurns) => (request) => runner({ ...request, maxTurns });
  // Above the host's cap: refused before anything runs.
  const capped = chatty();
  await assert.rejects(runWorkflow(doc(agent()), {}, { runNode: withTurns(createHarnessRunner(capped, { store: memorySessionStore(), maxTurns: 4 }), 5) }), (error) => error.reason === 'refused' && error.final === true);
  assert.equal(capped.requests, 0);
  // Within it: three paid requests, then turn_limit, final, so the recovery driver runs no second attempt.
  const limited = chatty();
  const recovery = memoryStore();
  await assert.rejects(underRecovery(recovery, doc(agent()), withTurns(createHarnessRunner(limited, { store: memorySessionStore(), maxTurns: 4 }), 3)), /turn_limit|task failed/);
  assert.deepEqual([limited.requests, limited.opened.length], [3, 1], 'one attempt, three turns');
});

test("beforeRequest gets the node's budget, its spend so far and the node; a refusal ends the node, final, with nothing more spent", async () => {
  const asked = [];
  const adapter = fauxAdapter({ script: () => [{ say: 'a', usd: 0.25 }, { say: 'b', usd: 0.25 }, { say: 'c', usd: 0.25 }, { submit: { answer: 'late' } }] });
  const beforeRequest = (request) => { asked.push(request); if (request.spentUsd >= 0.5) return { refuse: 'spend_cap_reached: $0.50 of $0.50' }; };
  const runNode = createHarnessRunner(adapter, { store: memorySessionStore(), beforeRequest });
  await assert.rejects(runWorkflow(doc(agent({ budget_usd: 0.5 })), {}, { runNode }), (error) => error.reason === 'refused' && error.final === true && /spend_cap_reached/.test(error.message));
  assert.equal(adapter.requests, 2);
  assert.deepEqual(asked.map((r) => [r.turn, r.spentUsd, r.budgetUsd, r.label, r.model]), [[1, 0, 0.5, 'task', 'faux'], [2, 0.25, 0.5, 'task', 'faux'], [3, 0.5, 0.5, 'task', 'faux']]);
  assert.match(asked[0].key, /^call:/);
});

/** The adapter, recording each turn the runner sends. */
function counted(adapter) {
  const sends = [];
  const open = adapter.open.bind(adapter);
  adapter.open = async (spec, io) => {
    const session = await open(spec, io);
    const send = session.send.bind(session);
    session.send = (text) => { sends.push(text); return send(text); };
    return session;
  };
  return { adapter, sends };
}
/** The adapter, with the sends numbered in `idle` (from 1) ending at once with no paid request. */
function idleOn(adapter, idle) {
  let n = 0;
  const open = adapter.open.bind(adapter);
  adapter.open = async (spec, io) => {
    const session = await open(spec, io);
    const send = session.send.bind(session);
    const turnEnd = session.turnEnd.bind(session);
    let now = false;
    session.send = async (text) => { now = idle.includes(++n); if (!now) return send(text); };
    session.turnEnd = () => (now ? Promise.resolve({ status: 'completed' }) : turnEnd());
    return session;
  };
  return { adapter, sends: () => n };
}
const idleRun = async (options) => {
  const { adapter, sends } = counted(fauxAdapter({ script: () => [] }));
  const started = Date.now();
  const error = await createHarnessRunner(adapter, { store: memorySessionStore(), ...options })(stepRequest()).then(() => undefined, (e) => e);
  return { error, sends: sends.length, requests: adapter.requests, ms: Date.now() - started };
};

test('turns that make no paid request end the node no_progress, final, after three in a row, whatever its turn limit', async () => {
  // Each turn ends at once with no request, so the paid-request count never moves: the runner's own bounds stop it.
  for (const maxTurns of [8, null]) {
    const run = await idleRun({ maxTurns });
    assert.ok(run.error instanceof HarnessRunError && run.error.reason === 'no_progress' && run.error.final === true, `maxTurns ${maxTurns}: ${run.error}`);
    assert.deepEqual([run.sends, run.requests, run.error.turns], [3, 0, 0], `maxTurns ${maxTurns}`);
    assert.ok(run.ms < 1000, 'at once');
  }
  // A turn that pays resets the count: two idle turns between paid ones, twice, never end the node.
  const mixed = idleOn(fauxAdapter({ script: () => [{ end: true }, { end: true }, { submit: { answer: 'ok' } }] }), [2, 3, 5, 6]);
  assert.deepEqual(await createHarnessRunner(mixed.adapter, { store: memorySessionStore() })(stepRequest()), { answer: 'ok' });
  assert.deepEqual([mixed.sends(), mixed.adapter.requests], [7, 3]);
});

test('sends have their own count against the turn limit, or maxSends when it is null: exhausted is turn_limit, final, and says so', async () => {
  // A limit below the no-progress bound is reached first.
  const capped = await idleRun({ maxTurns: 2 });
  assert.ok(capped.error?.reason === 'turn_limit' && capped.error.final === true, String(capped.error));
  assert.deepEqual([capped.sends, capped.requests], [2, 0]);
  assert.equal(capped.error.message, 'harness node stopped: turn_limit, 2 turns sent (the cap on sends) made 0 paid requests and 0 submissions');
  // With no turn limit, sends that each pay and never deliver stop at maxSends.
  const { adapter, sends } = counted(fauxAdapter({ script: () => Array.from({ length: 10 }, () => ({ end: true })) }));
  await assert.rejects(createHarnessRunner(adapter, { store: memorySessionStore(), maxTurns: null, maxSends: 4 })(stepRequest()), (error) => error.reason === 'turn_limit' && error.final === true && /4 turns sent \(the cap on sends\) made 4 paid requests/.test(error.message));
  // The paid requests reaching the limit first say nothing about sends.
  const paying = fauxAdapter({ script: () => Array.from({ length: 10 }, () => ({ say: 'thinking' })) });
  await assert.rejects(createHarnessRunner(paying, { store: memorySessionStore(), maxTurns: 2 })(stepRequest()), (error) => error.reason === 'turn_limit' && error.message === 'harness node stopped: turn_limit after 2 turns and 0 submissions');
  assert.deepEqual([sends.length, adapter.requests], [4, 4]);
  // Sends are never added to the paid requests: max_turns 1 with one send that pays once and submits succeeds.
  const one = fauxAdapter({ script: () => [{ submit: { answer: 'ok' } }] });
  assert.deepEqual(await createHarnessRunner(one, { store: memorySessionStore(), maxTurns: 1 })(stepRequest()), { answer: 'ok' });
  assert.equal(one.requests, 1);
});

test('maxSubmissions and timeoutMs default to the Pi runner\'s (5, 120 s) and end a node when reached', async () => {
  const rejecting = fauxAdapter({ script: () => Array.from({ length: 10 }, () => ({ submit: { answer: 7 } })) });
  await assert.rejects(runWorkflow(doc(agent()), {}, { runNode: createHarnessRunner(rejecting, { store: memorySessionStore() }) }), (error) => error.reason === 'submission_limit' && !error.final);
  assert.equal(rejecting.requests, 5);
  const twice = fauxAdapter({ script: () => Array.from({ length: 10 }, () => ({ submit: { answer: 7 } })) });
  await assert.rejects(runWorkflow(doc(agent()), {}, { runNode: createHarnessRunner(twice, { store: memorySessionStore(), maxSubmissions: 2 }) }), (error) => error.reason === 'submission_limit');
  assert.equal(twice.requests, 2);
  const slow = fauxAdapter({ script: () => [{ say: 'one' }, { hang: true }] });
  await assert.rejects(runWorkflow(doc(agent()), {}, { runNode: createHarnessRunner(slow, { store: memorySessionStore(), timeoutMs: 50 }) }), (error) => error.reason === 'timeout' && !error.final);
  assert.deepEqual(slow.closed.length, 1, 'the session was closed');
});

test('without a step every call opens a fresh session of its own, never one keyed by the label', async () => {
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: (spec) => [{ submit: { answer: spec.executionPath ?? 'x' } }] });
  const workflow = { v: 2, name: 'harness', schemas: { ...SCHEMAS, Many: { type: 'array' } }, output: { schemaId: 'Many', path: 'outs' }, root: { node: 'map', label: 'each', itemsPath: 'items', as: 'outs', body: agent({ as: 'final' }) } };
  await runWorkflow(workflow, { items: [1, 2, 3] }, { runNode: createHarnessRunner(adapter, { store }) });
  const keys = store.keys();
  assert.equal(keys.length, 3);
  assert.ok(keys.every((key) => /^call:[0-9a-f-]{36}$/.test(key)), keys.join(' '));
});

test('every event carries its node: the session key, the label and the execution path, also for map items running at once', async () => {
  const events = [];
  const adapter = fauxAdapter({ script: () => [{ say: 'hello' }, { call: 'lookup' }, { submit: { answer: 'ok' } }] });
  const workflow = { v: 2, name: 'harness', schemas: { ...SCHEMAS, Many: { type: 'array' } }, output: { schemaId: 'Many', path: 'outs' }, root: { node: 'map', label: 'each', itemsPath: 'items', as: 'outs', maxConcurrency: 2, body: agent({ as: 'final' }) } };
  await runWorkflow(workflow, { items: [1, 2] }, { runNode: createHarnessRunner(adapter, { store: memorySessionStore(), tools: [lookup], onEvent: (event) => events.push(event) }) });
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => typeof event.key === 'string' && event.label === 'task' && typeof event.executionPath === 'string'), 'every event names its node');
  const byKey = Map.groupBy(events, (event) => event.key);
  assert.equal(byKey.size, 2);
  for (const list of byKey.values()) {
    assert.equal(new Set(list.map((event) => event.executionPath)).size, 1, 'one node per session');
    assert.deepEqual(list.filter((e) => e.type === 'request_start').map((e) => e.turn), [1, 2, 3]);
    assert.ok(list.some((e) => e.type === 'request_end' && e.usage.usd === 0.001));
    assert.ok(list.some((e) => e.type === 'tool_start' && e.name === 'lookup'));
  }
});

test('under recovery a delivered step is answered from its record: the next process runs nothing and spends nothing', async () => {
  const store = memorySessionStore();
  const adapter = fauxAdapter({ script: () => [{ submit: { answer: 'kept' } }] });
  const workflow = doc({ node: 'chain', steps: [agent({ as: 'draft' }), { node: 'code', label: 'finish', code: '(s) => ({ final: s.draft })' }] });
  const recovery = memoryStore();
  // The first process delivers, then dies before the step commits.
  const driver = await openRecovery(recovery, workflow, { key: 'run-1' });
  const wrapped = withRecovery(driver, { runNode: createHarnessRunner(adapter, { store }) }, { durableNodes: true });
  wrapped.recovery = { ...wrapped.recovery, commit: (node, ...rest) => node.label === 'task' ? Promise.reject(new Error('the process died')) : driver.recovery.commit(node, ...rest) };
  await assert.rejects(runWorkflow(workflow, {}, wrapped), /the process died/);
  await driver.close();
  assert.equal(adapter.requests, 1);
  const resumed = await underRecovery(recovery, workflow, createHarnessRunner(adapter, { store }));
  assert.deepEqual([resumed.status, resumed.output, adapter.requests, adapter.opened.length], ['complete', { answer: 'kept' }, 1, 1]);
  const [key] = store.keys();
  assert.match(key, /^step:/);
  assert.equal((await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.accepted).length, 1);
});

test('a process that died inside a step resumes it under the same sessionId: no request or tool call is made again', async () => {
  const store = memorySessionStore();
  const recovery = unlocked();
  const script = () => [{ say: 'one' }, { call: 'lookup' }, { hang: true }, { submit: { answer: 'done' } }];
  const dying = fauxAdapter({ script });
  const workflow = doc(agent({ tools: ['lookup'] }));
  // The first process stops inside the step, after two paid requests and one tool call.
  const first = await openRecovery(recovery, workflow, { key: 'run-1' });
  const dead = new AbortController();
  const stalled = runWorkflow(workflow, {}, withRecovery(first, { runNode: createHarnessRunner(dying, { store, tools: [lookup], signal: dead.signal, timeoutMs: 5_000 }) }, { durableNodes: true }));
  await until(() => dying.requests >= 2 && dying.calls.length >= 1, 'two requests and a tool call');
  // The next process opens the same session, finds the turn open, and resumes it from its records.
  const next = fauxAdapter({ script: () => script().filter((action) => !('hang' in action)) });
  const resumed = await underRecovery(recovery, workflow, createHarnessRunner(next, { store, tools: [lookup] }));
  assert.deepEqual([resumed.status, resumed.output], ['complete', { answer: 'done' }]);
  assert.deepEqual(next.opened.map((o) => o.state), ['open_turn']);
  assert.deepEqual([next.requests, next.calls], [1, ['submit']], 'only the submit was asked for; the first two requests and the lookup were not made again');
  const [key] = store.keys();
  assert.match(key, /^step:/);
  assert.equal(next.opened[0].key, dying.opened[0].key, 'the same sessionId');
  // The first process is gone: nothing of it runs on.
  dead.abort(new Error('the first process is dead'));
  await first.close();
  await assert.rejects(stalled);
  assert.equal((await store.read(key)).filter((r) => r.kind === FAUX_RECORDS.request).length, 3);
});

test("the run's signal aborts the turn in flight, closes the session and rejects at once", async () => {
  const adapter = fauxAdapter({ script: () => [{ say: 'one' }, { hang: true }] });
  const controller = new AbortController();
  const running = runWorkflow(doc(agent()), {}, { signal: controller.signal, runNode: createHarnessRunner(adapter, { store: memorySessionStore(), signal: controller.signal, timeoutMs: 5_000 }) });
  await until(() => adapter.requests >= 1, 'a paid request');
  const started = Date.now();
  controller.abort(new Error('stop'));
  await assert.rejects(running);
  assert.ok(Date.now() - started < 1000, 'promptly');
  assert.deepEqual(adapter.closed.length, 1);
});

/** A node request under recovery, on step `s1`. */
const stepRequest = (extra = {}) => ({ kind: 'agent', label: 'task', system: [], user: '{}', schema: SCHEMAS.Out, tools: [], step: { sessionId: 's1', attempt: 0, earlierSessionIds: [] }, ...extra });
/** A first process whose paid request leaves and is cut off when the process dies; then the next process, on the same store. */
async function cutThenResume(maxTurns) {
  const store = memorySessionStore();
  const asked = [];
  const beforeRequest = (request) => { asked.push({ turn: request.turn, spentUsd: request.spentUsd }); };
  const dying = fauxAdapter({ script: () => [{ cut: true }] });
  const died = new AbortController();
  const first = createHarnessRunner(dying, { store, beforeRequest, maxTurns, signal: died.signal, timeoutMs: 5_000 })(stepRequest());
  await until(() => dying.requests >= 1, 'a paid request');
  died.abort(new Error('the process died'));
  await assert.rejects(first);
  const next = fauxAdapter({ script: () => [{ submit: { answer: 'ok' } }] });
  const outcome = await createHarnessRunner(next, { store, beforeRequest, maxTurns })(stepRequest()).then((value) => ({ value }), (error) => ({ error }));
  return { asked, outcome, next };
}

test('a paid request a crash cut off is a turn: max_turns 1 holds across the crash, and nothing more is paid for', async () => {
  const { asked, outcome, next } = await cutThenResume(1);
  assert.equal(asked.length, 1, 'the host was asked for one paid request in all');
  assert.equal(next.requests, 0);
  assert.equal(outcome.error?.reason, 'turn_limit');
  assert.equal(outcome.error?.final, true);
});

test("after a crash cut a paid request off, the host's beforeRequest sees it: the next request is turn 2, and what was spent is unknown", async () => {
  const { asked, outcome } = await cutThenResume(8);
  assert.deepEqual(asked, [{ turn: 1, spentUsd: 0 }, { turn: 2, spentUsd: null }]);
  assert.deepEqual(outcome.value, { answer: 'ok' });
});

test('a paid request a crash cut off is booked once as cut, at an unknown price, however many times the session is recovered', async () => {
  const store = memorySessionStore();
  const ends = [];
  const onEvent = (e) => { if (e.type === 'request_end') ends.push({ turn: e.turn, ...e.usage }); };
  // The first process: its paid request leaves and the process dies before an answer.
  const dying = fauxAdapter({ script: () => [{ cut: true }] });
  const died = new AbortController();
  const first = createHarnessRunner(dying, { store, onEvent, signal: died.signal, timeoutMs: 5_000 })(stepRequest());
  await until(() => dying.requests >= 1, 'a paid request');
  died.abort(new Error('the process died'));
  await assert.rejects(first);
  // The second process dies before its harness opens; the third delivers.
  const gone = { id: 'gone', version: '0', capabilities: () => ({ fork: false }), check: () => [], open: async () => { throw new Error('the box was lost'); } };
  await assert.rejects(createHarnessRunner(gone, { store, onEvent, timeoutMs: 5_000 })(stepRequest()));
  const next = fauxAdapter({ script: () => [{ submit: { answer: 'ok' } }] });
  assert.deepEqual(await createHarnessRunner(next, { store, onEvent })(stepRequest()), { answer: 'ok' });
  const cuts = (await store.read('step:s1')).filter((r) => r.kind === RUNNER_RECORDS.turn && r.data.cut === true);
  assert.deepEqual(cuts.map((r) => r.data), [{ usd: null, cut: true, turn: 1 }], 'one cut booking, for turn 1');
  assert.deepEqual(ends.filter((e) => e.cut), [{ turn: 1, input: 0, output: 0, cacheRead: 0, usd: null, estimated: true, cut: true }], 'the host was told once');
  assert.equal(ends.filter((e) => !e.cut).length, 1, "the third process's own request");
});

test('a session that opens after the run was stopped is interrupted and closed, so no harness outlives the node', async () => {
  const adapter = fauxAdapter({ script: () => [{ submit: { answer: 'late' } }], openDelayMs: 200 });
  const stop = new AbortController();
  const running = createHarnessRunner(adapter, { store: memorySessionStore(), timeoutMs: 5_000 })(stepRequest({ signal: stop.signal }));
  setTimeout(() => stop.abort(new Error('cancel')), 50);
  await assert.rejects(running, (error) => error.reason === 'aborted');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual([adapter.opened.length, adapter.closed.length, adapter.requests], [1, 1, 0]);
});

test("a stale runner's accepted submission is refused once a newer process opened the session: it ends fenced, and the next ask is not answered with it", async () => {
  const store = memorySessionStore();
  // The stale process: its review is where a newer process takes the session, between its submit and its accept.
  const stale = fauxAdapter({ script: () => [{ submit: { answer: 'stale' } }] });
  const review = async () => { await store.open('step:s1'); return { accepted: true }; };
  await assert.rejects(createHarnessRunner(stale, { store, timeoutMs: 5_000 })({ ...stepRequest(), review }), (error) => error instanceof HarnessRunError && error.reason === 'fenced' && error.final !== true);
  assert.equal((await store.read('step:s1')).filter((r) => r.kind === RUNNER_RECORDS.accepted).length, 0, 'no runner.accepted was written');
  // The live attempt delivers its own result. The faux harness resumes from the session's records, where the stale
  // process's request is step 0 of the script, so the live one's reply is step 1.
  const live = fauxAdapter({ script: () => [{ submit: { answer: 'stale' } }, { submit: { answer: 'live' } }] });
  assert.deepEqual(await createHarnessRunner(live, { store })(stepRequest()), { answer: 'live' });
});

/** An adapter whose one turn makes the paid requests `plan` says, in that order, then delivers through submit. */
function plannedAdapter(plan) {
  return {
    id: 'planned', version: '0', capabilities: () => ({ fork: false }), check: () => [],
    async open(spec, io) {
      let ended;
      const submit = spec.tools.find((t) => t.name === 'submit');
      return {
        state: 'new',
        async send() {
          ended = (async () => {
            for (const step of plan) {
              if (step.before) await io.models.beforeRequest({ model: 'm' });
              if ('after' in step) await io.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: step.after });
              if (step.both) await Promise.all([io.models.beforeRequest({ model: 'm' }), io.models.beforeRequest({ model: 'm' })]);
            }
            await submit.call({ value: { answer: 'ok' } }, { callId: 'c1', signal: io.signal });
            return { status: 'completed' };
          })();
        },
        async recover() {}, turnEnd: () => ended, async interrupt() {}, async close() {},
      };
    },
  };
}

test("two paid requests in flight at once, both answered: the next beforeRequest sees their sum, never an unknown spend", async () => {
  const asked = [];
  const runNode = createHarnessRunner(plannedAdapter([{ before: true }, { before: true }, { after: 0.25 }, { after: 0.5 }, { before: true }, { after: 0.125 }]), { store: memorySessionStore(), beforeRequest: (r) => { asked.push(r.spentUsd); } });
  assert.deepEqual(await runNode(stepRequest()), { answer: 'ok' });
  assert.deepEqual(asked, [0, 0, 0.75]);
});

test("a request booked at nothing (admitted, never sent) keeps the spend known, in this process and for a later one", async () => {
  const store = memorySessionStore();
  const asked = [];
  const beforeRequest = (r) => { asked.push(r.spentUsd); };
  // The first process: a request admitted and booked at 0 (it was never sent), then one at 0.5; the node is cut off.
  const first = createHarnessRunner(plannedAdapter([{ before: true }, { after: 0 }, { before: true }, { after: 0.5 }]), { store, beforeRequest });
  assert.deepEqual(await first(stepRequest()), { answer: 'ok' });
  assert.deepEqual(asked, [0, 0]);
  // What a later process reads: every admitted request has its booking, so its spend is the known sum (0.5), not
  // unknown (the reload rule counts an admitted request with no booking at an unknown cost).
  const records = await store.read('step:s1');
  assert.equal(records.filter((r) => r.kind === RUNNER_RECORDS.request).length, 2);
  assert.deepEqual(records.filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data.usd), [0, 0.5]);
});

test("a paid request booked at an unknown cost leaves the node's spend unknown from then on", async () => {
  const asked = [];
  const runNode = createHarnessRunner(plannedAdapter([{ before: true }, { after: null }, { before: true }, { after: 0.5 }, { before: true }]), { store: memorySessionStore(), beforeRequest: (r) => { asked.push(r.spentUsd); } });
  assert.deepEqual(await runNode(stepRequest()), { answer: 'ok' });
  assert.deepEqual(asked, [0, null, null]);
});

test("a paid request whose cost can't be recorded stops the node, saying so, not spending on uncounted", async () => {
  const store = memorySessionStore();
  const failing = { ...store, open: async (key) => { const writer = await store.open(key); return { ...writer, key, read: writer.read, append: async (records) => { if (records.some((r) => r.kind === RUNNER_RECORDS.turn)) throw new Error('the store is down'); return writer.append(records); } }; } };
  const adapter = fauxAdapter({ script: () => [{ say: 'one' }, { submit: { answer: 'ok' } }] });
  await assert.rejects(createHarnessRunner(adapter, { store: failing, timeoutMs: 5_000 })(stepRequest()), (error) => error instanceof HarnessRunError && error.reason === 'model_error' && /could not be recorded: the store is down/.test(error.message));
  assert.equal(adapter.requests, 1, 'nothing more was spent');
});

test('a stop that lands while the session store is being read rejects aborted at once, and opens no session, on either signal', async () => {
  for (const via of ['request', 'options']) {
    const store = memorySessionStore();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    // The session's records are slow to come back: the stop lands while the runner reads them through its writer.
    const slow = { ...store, open: async (key) => { const writer = await store.open(key); return { ...writer, key, append: writer.append, read: async () => { await held; return writer.read(); } }; } };
    const adapter = fauxAdapter({ script: () => [{ hang: true }] });
    const stop = new AbortController();
    const runner = createHarnessRunner(adapter, { store: slow, timeoutMs: 5_000, ...(via === 'options' ? { signal: stop.signal } : {}) });
    const running = runner(stepRequest(via === 'request' ? { signal: stop.signal } : {}));
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort(new Error('cancel'));
    const released = Date.now();
    release();
    await assert.rejects(running, (error) => error.reason === 'aborted', via);
    assert.ok(Date.now() - released < 200, `${via}: promptly`);
    assert.equal(adapter.opened.length, 0, `${via}: no session was opened`);
  }
});

test("modelPortFor, alone (a chat run's session): the runner's records and events, its turn limit and refusal, and a cut request booked once across processes", async () => {
  const store = memorySessionStore();
  const key = 'chat:c1';
  const events = [];
  const asked = [];
  const port = async (extra = {}) => modelPortFor(await store.open(key), { key, maxTurns: 3, beforeRequest: (r) => { asked.push([r.key, r.turn, r.spentUsd]); }, onEvent: (e) => events.push(e), ...extra });
  const runnerRecords = async () => (await store.read(key)).filter((r) => r.kind.startsWith('runner.')).map((r) => [r.kind, r.data]);

  // The first process: one answered request, then one a crash cuts off (it left, no answer came back).
  const first = await port();
  await first.models.beforeRequest({ model: 'm' });
  await first.models.afterRequest({ input: 10, output: 2, cacheRead: 0, usd: 0.5 });
  await first.models.beforeRequest({ model: 'm' });
  assert.deepEqual(await runnerRecords(), [[RUNNER_RECORDS.request, { turn: 1, model: 'm' }], [RUNNER_RECORDS.turn, { turn: 1, usd: 0.5 }], [RUNNER_RECORDS.request, { turn: 2, model: 'm' }]], "the runner's own records: each answer names its turn");
  assert.deepEqual([first.turns(), first.spentUsd()], [2, 0.5]);

  // The next process: the cut request counts as a turn, the spend is unknown, and it is booked once, as cut.
  events.length = 0;
  const second = await port();
  assert.deepEqual([second.turns(), second.spentUsd()], [2, null]);
  await second.bookCut();
  await second.bookCut();
  const third = await port();
  await third.bookCut();
  const cuts = (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.turn && r.data.cut === true).map((r) => r.data);
  assert.deepEqual(cuts, [{ usd: null, cut: true, turn: 2 }], 'booked once, across processes');
  assert.deepEqual(events, [{ type: 'request_end', turn: 2, usage: { input: 0, output: 0, cacheRead: 0, usd: null, estimated: true, cut: true }, key, label: key }], "the host is told once, with the session's key and the request's turn");

  // The turn limit counts the cut request; the host's beforeRequest saw the session's key, its turn and the spend.
  await third.models.beforeRequest({ model: 'm' });
  await assert.rejects(third.models.beforeRequest({ model: 'm' }), (e) => e instanceof HarnessRunError && e.reason === 'turn_limit');
  assert.deepEqual(asked, [[key, 1, 0], [key, 2, 0.5], [key, 3, null]]);
  // A refusal from the host refuses the request, and nothing is written for it.
  const refusing = await port({ maxTurns: null, beforeRequest: () => ({ refuse: 'over budget' }) });
  const before = (await store.read(key)).length;
  await assert.rejects(refusing.models.beforeRequest({ model: 'm' }), (e) => e instanceof HarnessRunError && e.reason === 'refused');
  assert.equal((await store.read(key)).length, before);
});

test('requests in flight together are each booked under the turn they were admitted as: answers in reverse, and a cut one booked by its own turn', async () => {
  const store = memorySessionStore();
  const key = 'chat:overlap';
  const ends = [];
  const port = async () => modelPortFor(await store.open(key), { key, onEvent: (e) => { if (e.type === 'request_end') ends.push([e.turn, e.usage.usd, e.usage.cut ?? false]); } });
  const turnsOf = async () => (await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => [r.data.turn, r.data.usd, r.data.cut ?? false]);

  // Two in flight, answered in reverse: each answer names its own turn, once.
  const a = await port();
  const t1 = await a.models.beforeRequest({ model: 'main' });
  const t2 = await a.models.beforeRequest({ model: 'small' });
  await a.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.02 }, t2);
  await a.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.01 }, t1);
  assert.deepEqual(ends, [[2, 0.02, false], [1, 0.01, false]]);
  assert.deepEqual(await turnsOf(), [[2, 0.02, false], [1, 0.01, false]]);

  // Two more in flight; the later one answers, the earlier is cut by a crash: only the cut one is booked, by its turn.
  const t3 = await a.models.beforeRequest({ model: 'main' });
  const t4 = await a.models.beforeRequest({ model: 'small' });
  await a.models.afterRequest({ input: 1, output: 1, cacheRead: 0, usd: 0.04 }, t4);
  assert.deepEqual([t3?.turn, t4?.turn], [3, 4]);
  ends.length = 0;
  const b = await port();
  await b.bookCut();
  await (await port()).bookCut();
  assert.deepEqual(ends, [[3, null, true]], 'turn 3 booked as cut, once, and turn 4 not again');
  assert.deepEqual((await turnsOf()).filter(([, , cut]) => cut), [[3, null, true]]);
});

test('two paid requests admitted at once, both inside the durable write: each gets its own turn and its own record', async () => {
  const inner = await memorySessionStore().open('chat:together');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = 0;
  // The session's writer, with the first two appends held open: both admissions are inside their write at once.
  const writer = { key: inner.key, read: () => inner.read(), append: async (records) => { if (held < 2) { held += 1; await gate; } await inner.append(records); } };
  const starts = [];
  const booking = await modelPortFor(writer, { key: 'chat:together', onEvent: (e) => { if (e.type === 'request_start') starts.push(e.turn); } });
  const both = Promise.all([booking.models.beforeRequest({ model: 'main' }), booking.models.beforeRequest({ model: 'small' })]);
  while (held < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  release();
  const tickets = await both;
  assert.deepEqual(tickets.map((t) => t.turn).sort(), [1, 2]);
  assert.deepEqual((await inner.read()).filter((r) => r.kind === RUNNER_RECORDS.request).map((r) => r.data.turn).sort(), [1, 2]);
  assert.deepEqual(starts.sort(), [1, 2]);
});
