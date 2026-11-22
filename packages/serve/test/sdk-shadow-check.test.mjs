import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serve, client, follow } from './support.mjs';
import { landWorkflows, promoteChecked } from './learned-workflow-seed-support.mjs';
import { promotionsOf, promotionOf, championOf, recordPromotion } from '../dist/learn/promote.js';
import { heldNamesOf } from '../dist/learn/compile.js';
import { workflowDigest } from '../dist/runner/workflow-first.js';
import { toolFlowsFor } from '../dist/runner/promotion.js';
import { secretsShown } from '../dist/learning.js';
import { learningStoreOf } from '../dist/learn/store-of.js';
import { learningCommit } from '../dist/learn/commit.js';

const tool = { name: 'mcp:backend/status', description: 'Read release status.', input_schema: { type: 'object' }, permission: 'allow', price_usd: 0 };
// The draft takes a task that names its release: a JSON task without one is not an input of it.
const flow = { name: 'status', description: 'Read release status.', workflow: { v: 2, name: 'status', schemas: { Input: { type: 'object', properties: { release: { type: 'string' } }, required: ['release'] }, Answer: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'] } }, input: { schemaId: 'Input' }, output: { schemaId: 'Answer', path: 'answer' }, root: { node: 'call', label: 'read', via: 'tool', tool: tool.name, args: {}, out: 'Answer', as: 'answer', deadline_s: 5 } } };
const nextFlow = { ...flow, description: 'Newer status draft.', workflow: { ...flow.workflow, root: { ...flow.workflow.root, args: { mode: 'new' } } } };
const TASK = '{"release":"r1"}';
const RELEASES = 5;
// compile_after 1 unless a test sets it: the check decides on one native turn, as a managed check of such an agent
// decides on its one input. The workflow is landed, so no compile is due either way.
async function setup(t, runtime = 'eve', runner = true, learning = { compile_after: 1 }) {
  const server = await serve(t, { runner });
  const id = `shadow-${runtime}`;
  assert.equal((await server.api('POST', '/agents', { definition: { id, name: id, instructions: 'Report readiness.', sdk: { runtime }, learning, tools: [] } })).status, 201);
  await landWorkflows(server.data, id, [flow]);
  const start = async (key, input = TASK) => {
    const response = await server.api('POST', `/agents/${id}/sdk-runs`, { runtime, input, instructions: 'Report readiness.', workflow_tools: [tool] }, { 'Idempotency-Key': key });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body;
  };
  const send = receipt => client(server.baseUrl, receipt.token);
  const records = () => promotionsOf(server.store.settings, id);
  const latest = async name => (await records()).findLast(one => one.workflow === name);
  return { ...server, id, start, send, records, latest };
}
const report = (receipt, patch = {}) => ({ type: 'workflow_check', id: receipt.learning.check.id, digest: receipt.learning.check.digest, outcome: 'answered', answer: '{"ready":true}', ...patch });
const evidence = [
  { type: 'tool', id: 'native', name: tool.name, status: 'started', input: {} },
  { type: 'tool', id: 'native', name: tool.name, status: 'completed', output: { ready: true } },
];
const assisted = [
  { type: 'tool', id: 'existing-workflow', name: 'learned_workflow', status: 'started', input: { name: flow.name } },
  { type: 'tool', id: 'existing-workflow', name: 'learned_workflow', status: 'completed', output: '{"ready":true}' },
];
async function finish(server, receipt, event, completion = {}, extra = []) {
  const sdk = server.send(receipt), path = `/sdk-runs/${receipt.run_id}`;
  assert.equal((await sdk('POST', `${path}/events`, { sequence: 1, events: [...evidence, ...extra, ...(event ? [event] : [])] })).status, 200);
  assert.equal((await sdk('POST', `${path}/complete`, { status: 'completed', answer: '{"ready":true}', ...completion })).status, 200);
  await follow(server.api, receipt.run_id, [completion.status ?? 'completed']);
}
const cancel = (server, receipt) => server.send(receipt)('POST', `/sdk-runs/${receipt.run_id}/complete`, { status: 'cancelled', answer: '' });
/** Lands `next` as the folder's newest revision of the status workflow, as a recompile or an owner's edit would. */
async function land(server, next = nextFlow) {
  const folder = learningStoreOf(server.data, server.id);
  const committed = await learningCommit(folder, { runId: `land-${workflowDigest({ workflow: JSON.stringify(next.workflow) })}`, reason: 'A separately compiled revision.', files: [
    { path: 'workflows/status/workflow.json', text: JSON.stringify(next.workflow) },
    { path: 'workflows/status/README.md', text: `---\nname: status\ndescription: ${next.description}\n---\n` },
  ] });
  assert.equal(committed.ok, true, JSON.stringify(committed));
}
/** Moves the reservation of `receipt`'s check two hours back, past its deadline, as a turn the backend never completed. */
async function expire(server, receipt) {
  const pending = promotionOf(await server.records(), flow.name, receipt.learning.check.digest);
  assert.equal(pending.decided, 'replaying');
  await recordPromotion(server.store.settings, server.id, { ...pending, at: new Date(Date.now() - 2 * 3_600_000).toISOString() }, () => true);
}
const settleDeps = async (server, receipt) => {
  const { sdkInbox } = await import('../dist/sdk/runs.js');
  return { store: server.store, agentId: server.id, launch: (await server.store.runs.launch(receipt.run_id)).body, inbox: await sdkInbox(server.store, receipt.run_id), shown: async () => secretsShown([]), log() {} };
};

for (const runtime of ['claude-agent-sdk', 'codex-sdk', 'eve']) test(`${runtime}: a compiled draft is withheld, checked against a native answer, then promoted for a fresh run`, async t => {
  const server = await setup(t, runtime);
  const first = await server.start('independent');
  assert.deepEqual(first.learning.workflows, [], 'an unchecked draft never enters model context');
  assert.equal(first.learning.check.workflow.name, flow.name);
  assert.equal(first.learning.check.digest, workflowDigest({ workflow: JSON.stringify(flow.workflow) }));
  assert.equal((await server.latest(flow.name)).via, 'sdk', 'the reservation says it is a connected agent check');
  assert.deepEqual(await server.start('independent'), first, 'idempotent admission keeps the exact candidate');
  const concurrent = await server.start('concurrent');
  assert.equal(concurrent.learning.check, undefined, 'only one native turn reserves the candidate');
  assert.deepEqual(concurrent.learning.workflows, []);
  await finish(server, first, report(first));
  const champion = championOf(await server.records(), flow.name);
  assert.equal(champion?.digest, first.learning.check.digest);
  assert.equal(champion?.via, 'sdk');
  assert.equal(champion?.check.n, 1, 'the promotion explicitly describes one held-out native turn');
  assert.equal(champion?.check.agreed, 1);
  assert.deepEqual(champion?.check.of, [first.run_id]);
  assert.equal(champion?.check.fresh_reads, undefined, 'every call answered from the recording');
  const next = await server.start('promoted');
  assert.equal(next.learning.check, undefined);
  assert.deepEqual(next.learning.workflows.map(one => one.name), [flow.name]);
  await server.api('PUT', `/agents/${server.id}/definition`, { definition: { instructions: 'Report readiness.', learning: false } });
  const off = await server.start('off');
  assert.deepEqual(off.learning, { enabled: false, revision: null, context: '', workflows: [] });
  for (const receipt of [concurrent, next, off]) await cancel(server, receipt);
});

test('a different native answer holds the draft, and the held digest is not checked again', async t => {
  const server = await setup(t);
  const first = await server.start('different');
  await finish(server, first, report(first, { answer: '{"ready":false}' }));
  const records = await server.records();
  assert.equal(championOf(records, flow.name), undefined);
  assert.equal(records.at(-1).decided, 'hold');
  assert.equal(records.at(-1).via, 'sdk');
  assert.match(records.at(-1).reason, /connected SDK checks do not use a semantic grader/);
  assert.doesNotMatch(records.at(-1).reason, /AGENT_MODEL_FAST/);
  const next = await server.start('not-reused');
  assert.deepEqual(next.learning.workflows, []);
  assert.equal(next.learning.check, undefined, 'a held digest is not silently checked again');
  await cancel(server, next);
});

// The evidence bar of a managed check: it decides once, on compile_after inputs. A connected agent's check collects its
// native turns until it holds compile_after of them, the native agent answering each, and then decides once on them all.
const DIGEST = workflowDigest({ workflow: JSON.stringify(flow.workflow) });
async function checkTurn(server, key, answer = '{"ready":true}') {
  const receipt = await server.start(key);
  assert.equal(receipt.learning.check?.digest, DIGEST, `${key} checks the draft`);
  assert.deepEqual(receipt.learning.workflows, [], `${key}: the native agent answers it, no workflow serves`);
  await finish(server, receipt, report(receipt, { answer }));
  return receipt;
}
function stillChecking(records, turns) {
  assert.equal(championOf(records, flow.name), undefined, `${turns} checked turn(s) promote nothing`);
  const waiting = promotionOf(records, flow.name, DIGEST);
  assert.equal(waiting.decided, 'replaying', JSON.stringify(waiting));
  assert.equal(waiting.via, 'sdk');
  assert.equal(waiting.runs, undefined, 'it waits for the next turn the draft takes');
  assert.equal(waiting.check.n, undefined, 'a check still collecting turns has no decision\'s numbers');
  assert.equal(waiting.check.turns?.n, turns, JSON.stringify(waiting.check));
  assert.match(waiting.reason, new RegExp(`${turns} of 3 native turns`));
  return waiting;
}

test('one agreeing native turn does not promote a draft its agent checks on compile_after turns; the third decides', async t => {
  const server = await setup(t, 'eve', true, { compile_after: 3 });
  const first = await checkTurn(server, 'turn-1');
  stillChecking(await server.records(), 1);
  const second = await server.start('turn-2');
  assert.equal(second.learning.check?.digest, DIGEST, 'the next turn the draft takes checks it');
  const concurrent = await server.start('while-checking');
  assert.equal(concurrent.learning.check, undefined, 'one turn at a time is reserved');
  assert.deepEqual(concurrent.learning.workflows, [], 'an unpromoted draft never serves');
  await cancel(server, concurrent);
  await finish(server, second, report(second));
  stillChecking(await server.records(), 2);
  const third = await checkTurn(server, 'turn-3');
  const champion = championOf(await server.records(), flow.name);
  assert.equal(champion?.digest, DIGEST);
  assert.equal(champion.via, 'sdk');
  assert.deepEqual([champion.check.n, champion.check.agreed, champion.check.alone], [3, 3, 3]);
  assert.deepEqual(champion.check.of, [third.run_id, second.run_id, first.run_id], 'the turns it decided on, newest first');
  assert.deepEqual(champion.check.outcomes, { answered: 3, handed_back: 0, failed: 0, skipped_write: 0 });
  assert.equal(champion.check.turns, undefined, 'the decision carries the numbers, not the turns collected');
  assert.match(champion.reason, /checked on 3 of the agent's inputs.*: promoted$/);
  const served = await server.start('served');
  assert.equal(served.learning.check, undefined);
  assert.deepEqual(served.learning.workflows.map(one => one.name), [flow.name]);
  await cancel(server, served);
});

test('compile_after checked turns with too few agreeing hold the draft; a disagreement alone does not hold it early', async t => {
  const server = await setup(t, 'eve', true, { compile_after: 3 });
  const first = await checkTurn(server, 'differs', '{"ready":false}');
  const waiting = stillChecking(await server.records(), 1);
  assert.deepEqual(waiting.check.turns.disagreements.map(one => one.run), [first.run_id]);
  await checkTurn(server, 'agrees-1');
  await checkTurn(server, 'agrees-2');
  const held = promotionOf(await server.records(), flow.name, DIGEST);
  assert.equal(held.decided, 'hold', JSON.stringify(held));
  assert.equal(championOf(await server.records(), flow.name), undefined);
  assert.deepEqual([held.check.n, held.check.agreed, held.check.alone], [3, 2, 3], '2 of 3 agree: under agree_min 0.8');
  assert.deepEqual(held.check.disagreements.map(one => one.run), [first.run_id]);
  assert.equal(held.check.turns, undefined);
  assert.equal(held.check.attempt, 1);
  assert.match(held.reason, /recompiles it once/);
  assert.ok(heldNamesOf(await server.records()).has(flow.name), 'its hold asks the one recompile');
});

test('a turn past its deadline is one failed row of the turns collected, not a decision of its own', async t => {
  const server = await setup(t, 'eve', false, { compile_after: 3 });
  const abandoned = await server.start('abandoned');
  await expire(server, abandoned);
  const swept = await server.start('sweeps');
  assert.equal(swept.learning.check?.digest, DIGEST, 'the check still collects turns, so the sweeping turn is reserved');
  const records = await server.records();
  assert.equal(championOf(records, flow.name), undefined);
  const reserved = promotionOf(records, flow.name, DIGEST);
  assert.equal(reserved.decided, 'replaying', JSON.stringify(reserved));
  assert.deepEqual(reserved.runs, [swept.run_id]);
  assert.equal(reserved.check.n, undefined);
  assert.equal(reserved.check.turns?.n, 1, JSON.stringify(reserved.check));
  assert.equal(reserved.check.turns.outcomes.failed, 1);
  assert.deepEqual(reserved.check.turns.of, [abandoned.run_id]);
  assert.match(reserved.reason, /1 of 3 native turns/);
  await cancel(server, swept);
});

test('a turn lands once: a deadline, a give-back or a second settle that read the same reservation finds it gone', async t => {
  const server = await setup(t, 'eve', true, { compile_after: 3 });
  const receipt = await server.start('settled');
  const reserved = promotionOf(await server.records(), flow.name, DIGEST);
  assert.deepEqual(reserved.runs, [receipt.run_id]);
  await finish(server, receipt, report(receipt));
  const collected = stillChecking(await server.records(), 1);
  // Each read the reservation before the completion's row landed, as a deadline sweep and a settle can at once.
  const { releaseSdkCheck, sdkCheckDeadline, sdkCheckTurn } = await import('../dist/runner/promotion.js');
  const deps = { store: server.store, agentId: server.id, shown: async () => secretsShown([]), log() {} };
  const late = [
    await sdkCheckDeadline(deps, reserved),
    await releaseSdkCheck(deps, reserved, 'its native turn ended before the backend completed it'),
    await sdkCheckTurn(deps, reserved, { of: receipt.run_id, input: TASK, agent: '{"ready":true}', outcome: 'answered', answer: '{"ready":false}' }, was => was?.replay_id === reserved.replay_id),
  ];
  assert.deepEqual(late.map(one => one?.won), [false, false, false], 'none of them lands');
  const after = promotionOf(await server.records(), flow.name, DIGEST);
  assert.deepEqual(after, collected, 'the completion\'s row stands: no failed row, no release, no second row');
  assert.deepEqual(after.check.turns.outcomes, { answered: 1, handed_back: 0, failed: 0, skipped_write: 0 });
  assert.equal(after.check.released, undefined);
});

/** A reserved turn that fails, so it cannot be the check's baseline: given back, and counted. */
async function giveBack(server, key) {
  const receipt = await server.start(key);
  assert.equal(receipt.learning.check?.digest, DIGEST, `${key} is reserved`);
  await finish(server, receipt, report(receipt), { status: 'failed' });
}

test('only give-backs in a row stop the check: a turn that lands starts the count again', async t => {
  const server = await setup(t, 'eve', true, { compile_after: 3 });
  for (let at = 1; at < RELEASES; at++) await giveBack(server, `before-${at}`);
  assert.equal((await server.latest(flow.name)).check.released, RELEASES - 1);
  await checkTurn(server, 'turn-1');
  assert.equal(stillChecking(await server.records(), 1).check.released, undefined, 'the landed turn starts the count again');
  for (let at = 1; at < RELEASES; at++) await giveBack(server, `between-${at}`);
  assert.equal((await server.latest(flow.name)).check.released, RELEASES - 1, `${2 * (RELEASES - 1)} give-backs, never ${RELEASES} in a row`);
  await checkTurn(server, 'turn-2');
  const third = await checkTurn(server, 'turn-3');
  const champion = championOf(await server.records(), flow.name);
  assert.equal(champion?.digest, DIGEST, 'the third turn decides it');
  assert.deepEqual([champion.check.n, champion.check.agreed, champion.check.of[0]], [3, 3, third.run_id]);
  assert.equal(champion.check.released, undefined, 'no turn was given back since the last one landed');
});

// A turn that cannot be the check's baseline gives the reservation back: nothing is decided, and the next turn the draft
// takes is reserved in its place.
const releases = {
  'incomplete evidence': first => [report(first), { evidence_complete: false }],
  'failed check': first => [report(first, { outcome: 'failed', answer: undefined, reason: 'No trustworthy input binding.' })],
  'missing check': () => [undefined],
  'workflow-assisted turn': first => [report(first), {}, assisted],
  'skipped write': first => [report(first, { outcome: 'skipped_write', answer: undefined, skipped: { tool: tool.name }, reason: 'This exact call was absent from the native recording.' })],
  'redacted answer': (first, server) => [report(first, { answer: first.token }), { answer: server.token }],
};
for (const [scenario, turn] of Object.entries(releases)) test(`a turn that cannot be the baseline releases its reservation: ${scenario}`, async t => {
  const server = await setup(t);
  const first = await server.start(scenario);
  const [event, completion, extra] = turn(first, server);
  await finish(server, first, event, completion, extra);
  const waiting = promotionOf(await server.records(), flow.name, first.learning.check.digest);
  assert.equal(championOf(await server.records(), flow.name), undefined);
  assert.equal(waiting.decided, 'replaying', JSON.stringify(waiting));
  assert.equal(waiting.via, 'sdk');
  assert.equal(waiting.runs, undefined, 'no turn is reserved while it waits');
  assert.equal(waiting.check.released, 1);
  assert.match(waiting.reason, /given back \(1 of 5/);
  assert.ok(!JSON.stringify(await server.records()).includes(server.token));
  const next = await server.start(`${scenario} again`);
  assert.equal(next.learning.check?.digest, first.learning.check.digest, 'the next turn the draft takes checks it');
  assert.notEqual(next.learning.check.id, first.learning.check.id);
  assert.deepEqual((await server.latest(flow.name)).runs, [next.run_id]);
  await finish(server, next, report(next));
  const champion = championOf(await server.records(), flow.name);
  assert.equal(champion?.check.released, undefined, 'the turn that landed started the give-back count again');
  assert.deepEqual(champion?.check.of, [next.run_id]);
});

test('a cancelled turn is given back uncounted: cancels never stop the check', async t => {
  const server = await setup(t);
  const { settleSdkCheck } = await import('../dist/sdk/check.js');
  for (let at = 1; at <= RELEASES + 1; at++) {
    const receipt = await server.start(`cancel-${at}`);
    assert.equal(receipt.learning.check?.digest, DIGEST, `cancel ${at} is reserved`);
    if (at % 2) await finish(server, receipt, report(receipt), { status: 'cancelled' });
    else {
      // The run stopped before the backend completed its turn.
      const deps = await settleDeps(server, receipt);
      await settleSdkCheck({ ...deps, inbox: { ...deps.inbox, completion: undefined, closed: 'cancelled' } });
      await cancel(server, receipt);
    }
    const waiting = await server.latest(flow.name);
    assert.equal(waiting.decided, 'replaying', `cancel ${at} leaves it waiting: ${waiting.reason}`);
    assert.equal(waiting.check.released, undefined, 'a cancel is not a give-back');
    assert.doesNotMatch(waiting.reason, /of 5/);
  }
  const landed = await server.start('lands');
  await finish(server, landed, report(landed));
  assert.equal(championOf(await server.records(), flow.name)?.digest, DIGEST);
});

/** A turn the native agent completes with no check reserved, and whether its run's end asked the compile turn for a
 *  revision of the status workflow (its kept learning compiled it: runner/learning-end.ts compileAskOf). */
async function byHand(server, key) {
  const receipt = await server.start(key);
  assert.equal(receipt.learning.check, undefined, `${key}: a held digest is not checked again`);
  await finish(server, receipt);
  const kept = await server.store.learning.proposals(server.id, { limit: 50 });
  return kept.some(one => one.runId === receipt.run_id && one.proposal?.compiled?.workflow === flow.name);
}
/** Five give-backs in a row on `digest`, then the hold they write: never stopped, a revise a compile asks. */
async function heldOnGiveBacks(server, digest, tag) {
  for (let at = 1; at <= RELEASES; at++) {
    const receipt = await server.start(`${tag}-failed-${at}`);
    assert.equal(receipt.learning.check?.digest, digest, `${tag} give-back ${at} is reserved`);
    await finish(server, receipt, report(receipt), { status: 'failed' });
  }
  const held = promotionOf(await server.records(), flow.name, digest);
  assert.equal(held.decided, 'hold');
  assert.equal(held.check.stopped, undefined, 'give-backs never stop it for good');
  assert.equal(held.check.released, RELEASES);
  assert.equal(held.check.n, 0);
  assert.match(held.reason, /the connected agent gave back 5 reserved native turns in a row/);
  assert.ok(heldNamesOf(await server.records()).has(flow.name), 'its hold asks a compile for a revision');
  return held;
}
/** The revise of a give-back hold is asked by the compile_after-th run of the agent's own since the hold, never earlier. */
async function revisedAfter(server, compileAfter, tag) {
  for (let at = 1; at < compileAfter; at++) assert.equal(await byHand(server, `${tag}-after-${at}`), false, `${tag}: ${at} run(s) since the hold ask no revise`);
  assert.equal(await byHand(server, `${tag}-after-${compileAfter}`), true, `${tag}: run ${compileAfter} since the hold asks it`);
}
const NEXT_DIGEST = workflowDigest({ workflow: JSON.stringify(nextFlow.workflow) });

// Batch 28 item 1: a give-back hold has no disagreements to revise from, so its revise comes at a first compile's
// cadence: once the agent has compile_after completed runs of its own since the hold, the ending one counted. A client
// that never sends a shadow check then costs one compile per compile_after runs, never one per hold.
test(`${RELEASES} give-backs in a row hold the check, never for good: the revise is asked after compile_after runs`, async t => {
  const server = await setup(t, 'eve', true, { compile_after: 3 });
  await heldOnGiveBacks(server, DIGEST, 'first');
  await revisedAfter(server, 3, 'first');
  await land(server);
  const next = await server.start('recompiled');
  assert.equal(next.learning.check?.digest, NEXT_DIGEST, 'the revision reserves a turn');
  const fresh = await server.latest(flow.name);
  assert.equal(fresh.check.released, undefined, 'its give-back count starts at 0');
  assert.equal(fresh.check.attempt, 1, 'give-backs spend no recompile');
  await cancel(server, next);
});

// #3411 review (P1): the fifth give-back can be a completed turn with no shadow report. Its hold is written before that
// run ends, so the run neither asks the revise itself nor counts as one of the compile_after runs since the hold.
test('a hold written by a completed turn with no shadow report: that turn is not one of the compile_after runs since it', async t => {
  const server = await setup(t, 'eve', true, { compile_after: 3 });
  for (let at = 1; at < RELEASES; at++) await giveBack(server, `failed-${at}`);
  const last = await server.start('no-report');
  assert.equal(last.learning.check?.digest, DIGEST, 'the fifth turn is reserved');
  await finish(server, last);
  const held = await server.latest(flow.name);
  assert.deepEqual([held.decided, held.check.released, held.check.stopped], ['hold', RELEASES, undefined], held.reason);
  const kept = await server.store.learning.proposals(server.id, { limit: 50 });
  assert.ok(!kept.some(one => one.runId === last.run_id && one.proposal?.compiled?.workflow === flow.name), 'the turn that wrote the hold asks no revise');
  await revisedAfter(server, 3, 'after');
});

test('two give-back holds in a row: neither revise comes before compile_after runs, and the second works as the first', async t => {
  const server = await setup(t, 'eve', true, { compile_after: 3 });
  const first = await heldOnGiveBacks(server, DIGEST, 'first');
  await revisedAfter(server, 3, 'first');
  await land(server);
  const second = await heldOnGiveBacks(server, NEXT_DIGEST, 'second');
  assert.equal(second.check.attempt, first.check.attempt, 'the second hold spends no recompile either');
  await revisedAfter(server, 3, 'second');
  assert.equal(promotionOf(await server.records(), flow.name, NEXT_DIGEST).check.stopped, undefined, 'still never stopped for good');
});

// #3390 review: the revise a give-back hold asks is no recompile either. Its draft failing its checks is that attempt's
// failed draft (asked once more), and only a second failed revise is the recompile's, which stops.
test('a revise of a give-back hold whose draft fails is asked once more; a second failure stops', async t => {
  const server = await setup(t);
  for (let at = 1; at <= RELEASES; at++) await giveBack(server, `failed-${at}`);
  const held = await server.latest(flow.name);
  const { recordDraftFailed } = await import('../dist/runner/learning-end.js');
  const runId = held.runs[0];
  const compile = { mode: 'revise', workflow: flow.name, held: { workflow: flow.name, digest: held.digest, reason: held.reason, check: held.check }, reference: '', traces: [], tools: [], judges: false };
  await recordDraftFailed({ store: server.store, log() {} }, { runId, agentId: server.id, compile, workflow: flow.name, errors: ['workflow: no root'] });
  const first = await server.latest(flow.name);
  assert.deepEqual([first.check.attempt, first.check.stopped], [1, undefined], 'the held attempt, not the recompile');
  assert.match(first.reason, /compiles it once more/);
  assert.ok(heldNamesOf(await server.records()).has(flow.name), 'still asks a revision');
  const later = await server.start('compiles-again');
  await cancel(server, later);
  await recordDraftFailed({ store: server.store, log() {} }, { runId: later.run_id, agentId: server.id, compile, workflow: flow.name, errors: ['workflow: no root'] });
  const second = await server.latest(flow.name);
  assert.deepEqual([second.check.attempt, second.check.stopped], [2, true], 'the second failed revise is the recompile, and it stops');
});

test('a JSON task the draft does not take, and a protected start, reserve no check', async t => {
  const server = await setup(t, 'eve', false);
  const other = await server.start('other-task', '{"build":7}');
  assert.equal(other.learning.check, undefined, 'a task with no release is not an input of the draft');
  for (const field of ['input', 'instructions']) {
    const response = await server.api('POST', `/agents/${server.id}/sdk-runs`, {
      runtime: 'eve', input: TASK, instructions: 'Report readiness.', workflow_tools: [tool], [field]: field === 'input' ? `{"release":"${server.token}"}` : server.token,
    }, { 'Idempotency-Key': `protected-${field}` });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.learning.check, undefined, `a redacted ${field} is not an intact baseline`);
  }
  assert.deepEqual(await server.records(), []);
  const prose = await server.start('prose', 'Is release r1 ready?');
  assert.ok(prose.learning.check, 'a prose task is reserved: the client resolves its input from the turn');
});

test('a turn past its deadline is one failed input through the check, and a recompile that ends there stops', async t => {
  const server = await setup(t, 'eve', false);
  const first = await server.start('abandoned');
  await expire(server, first);
  const swept = await server.start('sweeps');
  assert.equal(swept.learning.check, undefined, 'the decided digest is not reserved again');
  const held = promotionOf(await server.records(), flow.name, first.learning.check.digest);
  assert.equal(held.decided, 'hold');
  assert.equal(held.via, 'sdk');
  assert.equal(held.replay_id, first.learning.check.id);
  assert.equal(held.check.n, 1);
  assert.equal(held.check.outcomes.failed, 1);
  assert.equal(held.check.attempt, 1);
  assert.equal(held.check.stopped, undefined);
  assert.match(held.reason, /checked on 1 of the agent's inputs/);
  assert.match(held.reason, /recompiles it once/);
  assert.ok(heldNamesOf(await server.records()).has(flow.name), 'its hold asks the one recompile');
  await land(server);
  const recompiled = await server.start('recompiled');
  assert.equal(recompiled.learning.check?.digest, workflowDigest({ workflow: JSON.stringify(nextFlow.workflow) }));
  assert.equal((await server.latest(flow.name)).check.attempt, 2);
  await expire(server, recompiled);
  await server.start('sweeps-again');
  const stopped = promotionOf(await server.records(), flow.name, recompiled.learning.check.digest);
  assert.equal(stopped.decided, 'hold');
  assert.equal(stopped.check.stopped, true, 'repeated deadlines end stopped');
  assert.ok(!heldNamesOf(await server.records()).has(flow.name), 'nothing compiles again');
});

test('a turn closed before the backend completed it gives its check back; an expired one is a failed input', async t => {
  const server = await setup(t, 'eve', false);
  const { settleSdkCheck } = await import('../dist/sdk/check.js');
  const first = await server.start('stopped');
  const deps = await settleDeps(server, first);
  await settleSdkCheck({ ...deps, inbox: { ...deps.inbox, closed: 'cancelled' } });
  const waiting = await server.latest(flow.name);
  assert.equal(waiting.decided, 'replaying');
  assert.equal(waiting.check.released, undefined, 'a stopped run is a cancel, not a give-back');
  assert.match(waiting.reason, /stopped before the backend completed it/);
  const second = await server.start('expires');
  const later = await settleDeps(server, second);
  await settleSdkCheck({ ...later, inbox: { ...later.inbox, closed: 'expired' } });
  const held = await server.latest(flow.name);
  assert.equal(held.decided, 'hold');
  assert.equal(held.check.outcomes.failed, 1);
  assert.deepEqual(held.check.of, [second.run_id]);
});

test('a start that could not be admitted gives its turn back uncounted', async t => {
  const server = await setup(t, 'eve', false);
  const { releaseSdkCheck } = await import('../dist/runner/promotion.js');
  const first = await server.start('admitted');
  const pending = await server.latest(flow.name);
  await releaseSdkCheck({ store: server.store, agentId: server.id, shown: async () => secretsShown([]), log() {} }, pending, 'its start could not be admitted', false);
  const waiting = await server.latest(flow.name);
  assert.equal(waiting.decided, 'replaying');
  assert.equal(waiting.check.released, undefined, 'no turn ran, so none counts');
  assert.doesNotMatch(waiting.reason, /of 5/);
  const next = await server.start('next');
  assert.equal(next.learning.check?.digest, first.learning.check.digest);
});

test('a newer revision sets aside one still waiting for a turn', async t => {
  const server = await setup(t);
  const first = await server.start('waits');
  await finish(server, first, report(first), { status: 'cancelled' });
  await land(server);
  const next = await server.start('newer');
  assert.equal(next.learning.check?.digest, workflowDigest({ workflow: JSON.stringify(nextFlow.workflow) }));
  const aside = promotionOf(await server.records(), flow.name, first.learning.check.digest);
  assert.equal(aside.decided, 'hold');
  assert.equal(aside.check.stopped, true);
  assert.match(aside.reason, /a newer revision of it landed/);
  assert.equal((await server.latest(flow.name)).check.attempt, 1, 'setting it aside spends no recompile');
  await cancel(server, next);
});

test('a given-back turn of a check a newer revision overtook writes nothing over the newer record', async t => {
  const server = await setup(t, 'eve', false);
  const { settleSdkCheck } = await import('../dist/sdk/check.js');
  const first = await server.start('overtaken');
  await land(server);
  const owner = { workflow: flow.name, digest: workflowDigest({ workflow: JSON.stringify(nextFlow.workflow) }), at: new Date().toISOString(), decided: 'hold', reason: 'The owner held this revision for correction.' };
  await recordPromotion(server.store.settings, server.id, owner, () => true);
  assert.equal((await cancel(server, first)).status, 200);
  await settleSdkCheck(await settleDeps(server, first));
  await settleSdkCheck({ ...(await settleDeps(server, first)), inbox: { ...(await settleDeps(server, first)).inbox, completion: undefined, closed: 'expired' } });
  assert.deepEqual(await server.latest(flow.name), owner, 'the owner\'s hold stays the workflow\'s newest, so the compile still reads it');
  assert.ok(heldNamesOf(await server.records()).has(flow.name));
});

test('a newer revision\'s hold that lands while a release is written is not hidden by it', async t => {
  const server = await setup(t, 'eve', false);
  const { releaseSdkCheck } = await import('../dist/runner/promotion.js');
  await server.start('racing');
  const pending = await server.latest(flow.name);
  const owner = { workflow: flow.name, digest: workflowDigest({ workflow: JSON.stringify(nextFlow.workflow) }), at: new Date().toISOString(), decided: 'hold', reason: 'The owner held this revision for correction.' };
  // The newer hold lands during the release's own await, after its first read of the records.
  const shown = async () => { await recordPromotion(server.store.settings, server.id, owner, () => true); return secretsShown([]); };
  await releaseSdkCheck({ store: server.store, agentId: server.id, shown, log() {} }, pending, 'its native turn was cancelled');
  assert.deepEqual(await server.latest(flow.name), owner);
});

test('fresh reads the shadow made are kept on the check record', async t => {
  const server = await setup(t);
  const first = await server.start('fresh');
  await finish(server, first, report(first, { fresh_reads: 2 }));
  assert.equal(championOf(await server.records(), flow.name)?.check.fresh_reads, 2);
});

test('shadow report is bound to one run, candidate, and immutable event sequence', async t => {
  const server = await setup(t, 'eve', false), first = await server.start('first'), second = await server.start('second');
  const sdk = server.send(first), path = `/sdk-runs/${first.run_id}/events`;
  for (const patch of [{ id: 'foreign-check' }, { digest: 'foreign-digest' }, { outcome: 'approved' }, { answer: undefined }, { agreed: true }, { fresh_reads: 0 }, { fresh_reads: 257 }]) {
    const response = await sdk('POST', path, { sequence: 1, events: [report(first, patch)] });
    assert.equal(response.status, 422, JSON.stringify(response.body));
  }
  assert.equal((await server.send(second)('POST', `/sdk-runs/${second.run_id}/events`, { sequence: 1, events: [report(first)] })).status, 422);
  const batch = { sequence: 1, events: [report(first)] };
  assert.equal((await sdk('POST', path, batch)).status, 200);
  assert.equal((await sdk('POST', path, batch)).status, 200);
  assert.equal((await sdk('POST', path, { sequence: 2, events: [report(first)] })).status, 422);
  assert.equal((await sdk('POST', path, { sequence: 1, events: [report(first, { answer: 'different' })] })).status, 409);
});

test('server-native learned_workflow tool also withholds drafts without promotion records', async t => {
  const server = await setup(t, 'eve', false);
  const laid = [{ ...flow, workflow: JSON.stringify(flow.workflow) }];
  const deps = { store: server.store, agentId: server.id, log() {} };
  assert.deepEqual(await toolFlowsFor(deps, {}, laid, {}), []);
  await promoteChecked(server.store.settings, server.id, [flow]);
  assert.deepEqual(await toolFlowsFor(deps, {}, laid, {}), laid);
  const record = championOf(await server.records(), flow.name);
  await recordPromotion(server.store.settings, server.id, { ...record, decided: 'hold', reason: 'Owner held it.' }, () => true);
  assert.deepEqual(await toolFlowsFor(deps, {}, laid, {}), []);
});

test('shadow agreement uses the owner-selected decision fields, not unrelated response text', async t => {
  const server = await setup(t);
  await server.api('PUT', `/agents/${server.id}/definition`, { definition: { instructions: 'Report readiness.', learning: { compile_after: 1, agree_on: ['ready'], agree_min: 1, alone_min: 1 } } });
  const first = await server.start('decision-fields');
  await finish(server, first, report(first, { answer: '{"ready":true,"explanation":"Different phrasing"}' }));
  const champion = championOf(await server.records(), flow.name);
  assert.equal(champion?.check.agreed, 1);
  assert.deepEqual(champion?.check.agree_on, ['ready']);
  assert.equal(champion?.check.agree_min, 1);
  assert.equal(champion?.check.alone_min, 1);
});

test('a newer compiled revision cannot displace the checked champion before its own independent check', async t => {
  const server = await setup(t);
  const first = await server.start('one');
  await finish(server, first, report(first));
  const original = first.learning.check.workflow;
  await land(server);
  const checking = await server.start('new-draft');
  assert.notEqual(checking.learning.check.digest, first.learning.check.digest);
  assert.deepEqual(checking.learning.workflows, [], 'baseline excludes even the old champion');
  const concurrent = await server.start('while-checking');
  assert.equal(concurrent.learning.check, undefined);
  assert.deepEqual(concurrent.learning.workflows, [original], 'the older checked bytes are read from their own commit');
  await finish(server, checking, report(checking, { answer: '{"ready":false}' }));
  const held = await server.start('new-held');
  assert.deepEqual(held.learning.workflows, [original]);
  for (const receipt of [concurrent, held]) await cancel(server, receipt);
});

test('a delayed report cannot replace a reservation already given back', async t => {
  const server = await setup(t, 'eve', false), receipt = await server.start('not-native');
  const sdk = server.send(receipt), path = `/sdk-runs/${receipt.run_id}`;
  assert.equal((await sdk('POST', `${path}/events`, { sequence: 1, events: [...evidence, ...assisted, report(receipt)] })).status, 200);
  assert.equal((await sdk('POST', `${path}/complete`, { status: 'completed', answer: '{"ready":true}' })).status, 200);
  const { settleSdkCheck } = await import('../dist/sdk/check.js');
  const deps = await settleDeps(server, receipt);
  await settleSdkCheck(deps);
  assert.equal(championOf(await server.records(), flow.name), undefined);
  const waiting = await server.latest(flow.name);
  assert.equal(waiting.decided, 'replaying');
  assert.equal(waiting.check.released, 1);
  await settleSdkCheck({ ...deps, inbox: { ...deps.inbox, batches: [{ sequence: 1, events: [...evidence, report(receipt)] }] } });
  assert.deepEqual(await server.latest(flow.name), waiting, 'a delayed check cannot replace the record kept');
});
