// jobRecordOf on SYNTHETIC recordings: the chart record's workflow part (CLASSIFY-CONTRACT.md "v3: the chart record"). Every line below is built here; no real recording is read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JOB_TOOLS, jobRecordOf } from './job-record.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const keyOf = (sha, n = 'h1') => `agentrun:1:${sha}:${n}`;

let counter = 0;
const id = () => `call_${(counter += 1)}`;
/** An assistant entry of a conversation that makes tool calls. */
const assistant = (conv, calls, stopReason = 'toolUse') => ({ kind: 'pi.assistant', conv, data: { model: [{ role: 'assistant', content: calls.map(({ id: callId, name, arguments: args }) => ({ type: 'toolCall', id: callId, name, arguments: args ?? {} })), stopReason }] } });
const toolResult = (conv, callId, toolName, body, isError = false) => ({ kind: 'pi.tool-result', conv, data: { model: [{ role: 'toolResult', toolCallId: callId, toolName, isError, content: [{ type: 'text', text: JSON.stringify(body) }] }] } });
const call = (name, args) => ({ id: id(), name, arguments: args });
const usage = (conv, models) => ({ kind: 'pi.usage', conv, data: { value: { models, tools: {} } } });
const priced = (input, output, total, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, cost: { total } });
const task = (taskId, key, state, workflow = { v: 2, name: 'w' }) => ({ kind: 'agentrun.workflow', conv: 1, data: { id: taskId, conversationId: 1, kind: 'agentrun.workflow', input: { key, workflow, input: {} }, state } });
const done = (status) => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } });
const node = (key, path, attempt, conversation) => ({ kind: 'agentrun.nodes', path, data: { key: `${key}:wf:step:${path}:a${attempt}`, value: { conversation, startedMs: 1, closed: true } } });
const effect = (key, path, tool, status = 'completed') => ({ kind: 'agentrun.effects', path, data: { key: `${key}\u0000step:${path}#call:0`, value: { driver: key, status, intent: { tool, args: {} } } } });

/** A root agent that loads a saved workflow, then runs it: the load and the run are agentrun calls with results. */
function rootRuns({ key, saved, extra = [] }) {
  const load = call('agentrun', { action: 'load', name: saved.name });
  const run = call('agentrun', { action: 'run' });
  return [
    assistant(1, [load]), toolResult(1, load.id, 'agentrun', { preview: 'p', workflow: {}, saved }),
    assistant(1, [run]), toolResult(1, run.id, 'agentrun', { run: { key, taskId: 20, started: 'created' }, outcome: { status: 'complete' } }),
    ...extra,
  ];
}

test('the job tools are the six that do the job', () => {
  assert.deepEqual(JOB_TOOLS, ['fetch_page', 'search_web', 'browse', 'read_document', 'sic2_groups', 'sic_codes']);
});

test('no execution: an agent run. No job call at all is (null, null); the root\'s calls alone are a share of 0 and no fallback verdict', () => {
  assert.deepEqual(jobRecordOf([]), { executions: [], workflowShare: null, agentFallback: null });
  const none = [assistant(1, [call('answer', { sic4: '1' }), call('learn', {})])];
  assert.deepEqual(jobRecordOf(none), { executions: [], workflowShare: null, agentFallback: null });
  const alone = [assistant(1, [call('search_web', {}), call('fetch_page', {}), call('agentrun', { action: 'describe' })])];
  assert.deepEqual(jobRecordOf(alone), { executions: [], workflowShare: 0, agentFallback: null });
});

test('a complete execution with no root job calls: every job call is inside, and the agent did not fall back (1, false)', () => {
  const key = keyOf(SHA_A);
  const inside = [call('search_web', {}), call('read_document', {}), call('read_document', {}), call('submit', {})];
  const events = [
    ...rootRuns({ key, saved: { name: 'classify', digest: SHA_B }, extra: [assistant(1, [call('answer', {}), call('learn', {})])] }),
    task(20, key, { status: 'running' }), task(20, key, done('complete')),
    node(key, '/root', 0, 23), assistant(23, inside),
    usage(23, { 'gw/m': priced(30, 4000, 0.0159, 100, 20) }),
  ];
  const record = jobRecordOf(events);
  assert.equal(record.workflowShare, 1);
  assert.equal(record.agentFallback, false);
  assert.equal(record.executions.length, 1, 'the latest line per task, not one per line');
  assert.deepEqual(record.executions[0], { key, name: 'classify', revision: SHA_B, outcome: 'complete', toolCalls: 3, costUsd: 0.0159, tokensIn: 150, tokensOut: 4000 });
});

test('an escalated execution plus root job calls: a fraction, and the agent fell back (a fraction, true)', () => {
  const key = keyOf(SHA_A);
  const events = [
    ...rootRuns({ key, saved: { name: 'classify', digest: SHA_B }, extra: [assistant(1, [call('search_web', {}), call('fetch_page', {})])] }),
    task(20, key, done('escalated')),
    node(key, '/root', 0, 23), assistant(23, [call('search_web', {}), call('sic_codes', {}), call('read_document', {})]),
    usage(23, { 'gw/m': priced(10, 20, 0.5) }),
  ];
  const record = jobRecordOf(events);
  assert.equal(record.executions[0].outcome, 'escalated');
  assert.equal(record.executions[0].toolCalls, 3);
  assert.equal(record.workflowShare, 3 / 5);
  assert.equal(record.agentFallback, true);
});

test('failed and aborted tasks keep their words, and a task that has not ended has no outcome', () => {
  const out = (state, n) => jobRecordOf([task(n, keyOf(SHA_A, `h${n}`), state)]).executions[0].outcome;
  assert.equal(out({ status: 'terminal', outcome: { status: 'failed' } }, 1), 'failed');
  assert.equal(out({ status: 'terminal', outcome: { status: 'aborted' } }, 2), 'aborted');
  assert.equal(out({ status: 'running' }, 3), null);
});

test('two executions in one run: each its own key, revision, calls, cost and tokens; the share is over both', () => {
  const k1 = keyOf(SHA_A, 'h1'), k2 = keyOf(SHA_B, 'h2');
  const l1 = call('agentrun', { action: 'load', name: 'one' }), r1 = call('agentrun', { action: 'run' });
  const l2 = call('agentrun', { action: 'load', name: 'two' }), r2 = call('agentrun', { action: 'run' });
  const events = [
    assistant(1, [l1]), toolResult(1, l1.id, 'agentrun', { workflow: {}, saved: { name: 'one', digest: 'd1' } }),
    assistant(1, [r1]), toolResult(1, r1.id, 'agentrun', { run: { key: k1 } }),
    assistant(1, [l2]), toolResult(1, l2.id, 'agentrun', { workflow: {}, saved: { name: 'two', digest: 'd2' } }),
    assistant(1, [r2]), toolResult(1, r2.id, 'agentrun', { run: { key: k2 } }),
    task(20, k1, done('complete')), task(21, k2, done('escalated')),
    node(k1, '/root', 0, 23), assistant(23, [call('fetch_page', {})]), usage(23, { m: priced(1, 2, 0.01) }),
    node(k2, '/root', 0, 24), assistant(24, [call('fetch_page', {}), call('browse', {})]), usage(24, { m: priced(3, 4, 0.02) }),
  ];
  const record = jobRecordOf(events);
  assert.deepEqual(record.executions.map(({ key, name, revision, outcome, toolCalls, costUsd, tokensIn, tokensOut }) => ({ key, name, revision, outcome, toolCalls, costUsd, tokensIn, tokensOut })), [
    { key: k1, name: 'one', revision: 'd1', outcome: 'complete', toolCalls: 1, costUsd: 0.01, tokensIn: 1, tokensOut: 2 },
    { key: k2, name: 'two', revision: 'd2', outcome: 'escalated', toolCalls: 2, costUsd: 0.02, tokensIn: 3, tokensOut: 4 },
  ]);
  assert.equal(record.workflowShare, 1);
  assert.equal(record.agentFallback, false);
});

test('a map node and a child workflow: every node attempt under the run key is the execution\'s, and a call node\'s effect counts', () => {
  const key = keyOf(SHA_A);
  const events = [
    task(20, key, done('complete')),
    node(key, '/root/items/0/body', 0, 23), node(key, '/root/items/1/body', 0, 24), node(key, '/root/items/1/body', 1, 25), // a map's items, one a retried attempt
    node(key, '/root/workflow/root', 0, 26), // the child workflow's node
    assistant(23, [call('search_web', {})]), assistant(24, [call('fetch_page', {})]), assistant(25, [call('fetch_page', {})]), assistant(26, [call('browse', {}), call('browse', {})]),
    usage(23, { m: priced(1, 1, 0.1) }), usage(24, { m: priced(1, 1, 0.1) }), usage(25, { m: priced(1, 1, 0.1) }), usage(26, { m: priced(1, 1, 0.1) }),
    effect(key, '/root/steps/0', 'fetch_page'), effect(key, '/root/steps/1', 'answer'), // a job tool called by a call node, and one that is not a job tool
    effect(keyOf(SHA_B, 'other'), '/root/steps/0', 'fetch_page'), // another run's effect
    assistant(99, [call('read_document', {})]), // an unrelated conversation: the root's
  ];
  const record = jobRecordOf(events);
  assert.equal(record.executions[0].toolCalls, 6, 'four node conversations (1+1+1+2) and one call-node effect');
  assert.ok(Math.abs(record.executions[0].costUsd - 0.4) < 1e-12);
  assert.equal(record.workflowShare, 6 / 7);
  assert.equal(record.agentFallback, true);
});

test('an unpriced node makes the execution\'s cost null, never 0 and never the priced part', () => {
  const key = keyOf(SHA_A);
  const base = [task(20, key, done('complete')), node(key, '/root/items/0/body', 0, 23), node(key, '/root/items/1/body', 0, 24), assistant(23, [call('fetch_page', {})]), assistant(24, [call('fetch_page', {})])];
  // A bucket without a price.
  let record = jobRecordOf([...base, usage(23, { m: priced(5, 6, 0.1) }), usage(24, { m: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0, cost: null } })]);
  assert.equal(record.executions[0].costUsd, null);
  assert.equal(record.executions[0].tokensIn, 12, 'tokens are still counted');
  assert.equal(record.executions[0].tokensOut, 14);
  // All buckets priced: the sum.
  record = jobRecordOf([...base, usage(23, { m: priced(5, 6, 0.1) }), usage(24, { m: priced(1, 1, 0.2) })]);
  assert.ok(Math.abs(record.executions[0].costUsd - 0.3) < 1e-12);
  // A model answer that ended in an error was perhaps billed and has no price: null.
  record = jobRecordOf([...base, usage(23, { m: priced(5, 6, 0.1) }), usage(24, { m: priced(1, 1, 0.2) }), assistant(24, [], 'error')]);
  assert.equal(record.executions[0].costUsd, null);
});

test('a saved revision against a draft: the load before the run names it; an inspect of another workflow after the load makes it a draft with the run key\'s sha256', () => {
  const saved = keyOf(SHA_A, 'in1'), draft = keyOf(SHA_B, 'in2');
  const inspect = call('agentrun', { action: 'inspect', workflow: { v: 2 } }), run = call('agentrun', { action: 'run' });
  const events = [
    ...rootRuns({ key: saved, saved: { name: 'classify', digest: 'digest-of-the-save' } }),
    assistant(1, [inspect]), toolResult(1, inspect.id, 'agentrun', { preview: 'p', workflow: { v: 2 } }),
    assistant(1, [run]), toolResult(1, run.id, 'agentrun', { run: { key: draft } }),
    task(20, saved, done('complete')), task(21, draft, done('complete')),
  ];
  const [first, second] = jobRecordOf(events).executions;
  assert.deepEqual([first.name, first.revision], ['classify', 'digest-of-the-save']);
  assert.deepEqual([second.name, second.revision], [null, SHA_B]);
  // An inspect with no workflow argument re-inspects the held draft: the load still stands.
  const again = call('agentrun', { action: 'inspect' }), run2 = call('agentrun', { action: 'run' });
  const held = [...rootRuns({ key: saved, saved: { name: 'classify', digest: 'd' } }).slice(0, 2), assistant(1, [again]), toolResult(1, again.id, 'agentrun', { workflow: {} }), assistant(1, [run2]), toolResult(1, run2.id, 'agentrun', { run: { key: saved } }), task(20, saved, done('complete'))];
  assert.deepEqual([jobRecordOf(held).executions[0].name, jobRecordOf(held).executions[0].revision], ['classify', 'd']);
});

test('a draft with no load anywhere: name null and the sha256 of the run key (also for an again run)', () => {
  const key = `${keyOf(SHA_B, 'in2')}:2`;
  const run = call('agentrun', { action: 'run' });
  const events = [assistant(1, [run]), toolResult(1, run.id, 'agentrun', { run: { key } }), task(20, key, done('complete'))];
  const [execution] = jobRecordOf(events).executions;
  assert.equal(execution.name, null);
  assert.equal(execution.revision, SHA_B);
});

test('a load that is an error, or that comes after the run, is not the execution\'s revision', () => {
  const key = keyOf(SHA_A);
  const bad = call('agentrun', { action: 'load', name: 'missing' }), run = call('agentrun', { action: 'run' }), late = call('agentrun', { action: 'load', name: 'late' });
  const events = [
    assistant(1, [bad]), toolResult(1, bad.id, 'agentrun', { message: 'no such workflow' }, true),
    assistant(1, [run]), toolResult(1, run.id, 'agentrun', { run: { key } }),
    assistant(1, [late]), toolResult(1, late.id, 'agentrun', { workflow: {}, saved: { name: 'late', digest: 'late-digest' } }),
    task(20, key, done('complete')),
  ];
  const [execution] = jobRecordOf(events).executions;
  assert.deepEqual([execution.name, execution.revision], [null, SHA_A]);
});
