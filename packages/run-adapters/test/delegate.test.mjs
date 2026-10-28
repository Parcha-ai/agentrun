// delegateTool: a lead hands a task to a named sub-agent, which runs as a durable child node on the faux harness. Each
// test is one thing a host depends on: the child's own prompt and tools, depth 1, the fixed answer, the money and the
// replay, the deadline share, one child at a time, and the events nested under the lead's call.
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { DELEGATE_RESULT_SCHEMA, DELEGATE_TOOL, delegateProblems, delegateTool, RUNNER_RECORDS } from '@parcha/agentrun-adapters';
import { fauxAdapter, memorySessionStore } from '@parcha/agentrun-adapters/testing';

const test = (name, fn) => nodeTest(name, { timeout: 30_000 }, fn);
async function until(ready, what) {
  for (const end = Date.now() + 5_000; !ready();) {
    if (Date.now() > end) throw new Error(`gave up waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ran = [];
const tool = (name) => ({ name, description: `The ${name} tool.`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, replay: 'safe', call: async (args) => { ran.push([name, args]); return { text: `${name} found` }; } });
const LEAD_TOOLS = [tool('search'), tool('fetch'), tool('write')];
const CHECKER = 'You check each claim against its cited source.';
const AGENTS = {
  'checker': { description: 'Checks claims against their sources.', system: CHECKER, tools: ['fetch'] },
  'analyst': { description: 'Works the numbers.', system: 'You work the numbers.', tools: ['search', 'fetch'], deadlineShare: 0.25 },
};
const ANSWER = { answer: 'All three claims hold.', citations: [{ url: 'https://example.com/a', quote: 'q' }], gaps: [] };
const call = (t, args, callId = 'toolu_1', signal = new AbortController().signal) => t.call(args, { callId, signal });

test('a delegate runs its agent as a child node: its system prompt verbatim, only its own tools, and the fixed answer back to the lead as JSON', async () => {
  const specs = [];
  const adapter = fauxAdapter({ script: (spec) => { specs.push(spec); return [{ call: 'fetch', args: { q: 'claim 1' } }, { submit: ANSWER }]; } });
  const events = [];
  const t = delegateTool({ agents: AGENTS, tools: LEAD_TOOLS, adapter, store: memorySessionStore(), parentKey: 'step:lead', onEvent: (e) => events.push(e) });
  assert.equal(t.name, DELEGATE_TOOL);
  assert.equal(t.replay, 'safe');
  assert.deepEqual(t.inputSchema.properties.agent.enum, ['checker', 'analyst']);
  const result = await call(t, { agent: 'checker', task: 'Check the three claims.', context: 'Draft so far.' });
  assert.deepEqual(JSON.parse(result.text), ANSWER);
  assert.equal(result.isError, undefined);
  const [spec] = specs;
  assert.equal(spec.key, 'step:step:lead/delegate:toolu_1');
  assert.equal(spec.system[0], CHECKER, "the agent's system prompt reaches the child byte for byte");
  assert.deepEqual(spec.tools.map((x) => x.name).sort(), ['fetch', 'submit'], 'only its own tools, and no delegate');
  assert.ok(ran.some(([name]) => name === 'fetch'));
  // Its events are the lead's call's: nested by the delegate tag.
  assert.ok(events.length > 0 && events.every((e) => e.delegate?.agent === 'checker' && e.delegate.callId === 'toolu_1' && e.delegate.parentKey === 'step:lead'));
  assert.ok(events.some((e) => e.type === 'request_start') && events.some((e) => e.type === 'tool_start' && e.name === 'fetch'));
});

test("the tools subset, checked when the tool is made: an agent naming a tool the lead lacks is refused by name, and so is one naming delegate (depth 1)", () => {
  assert.match(delegateProblems({ agents: { a: { description: 'd', system: 's', tools: ['browse'] } }, tools: LEAD_TOOLS }).join('; '), /the agent a names the tool browse, which the lead does not have/);
  assert.match(delegateProblems({ agents: { a: { description: 'd', system: 's', tools: [DELEGATE_TOOL] } }, tools: [...LEAD_TOOLS, { ...tool(DELEGATE_TOOL) }] }).join('; '), /may not delegate further \(depth 1\)/);
  assert.throws(() => delegateTool({ agents: { a: { description: 'd', system: 's', tools: ['browse'] } }, tools: LEAD_TOOLS, adapter: fauxAdapter({ script: () => [] }), store: memorySessionStore(), parentKey: 'k' }), /browse/);
  assert.match(delegateProblems({ agents: { 'Bad Name': { description: 'd', system: 's', tools: [] } }, tools: [] }).join(';'), /not lowercase/);
  assert.match(delegateProblems({ agents: { a: { description: 'd', system: 's', tools: [], deadlineShare: 0 } }, tools: [] }).join(';'), /not in \(0, 1\]/);
});

test("a child never runs a tool outside its list, though the lead has it: the call is refused and nothing runs", async () => {
  ran.length = 0;
  const adapter = fauxAdapter({ script: () => [{ call: 'write', args: { q: 'x' } }, { submit: ANSWER }] });
  const t = delegateTool({ agents: AGENTS, tools: LEAD_TOOLS, adapter, store: memorySessionStore(), parentKey: 'step:lead' });
  await call(t, { agent: 'checker', task: 'Check it.' });
  assert.deepEqual(ran.filter(([name]) => name === 'write'), [], 'write never ran');
});

test('the fixed answer: a child submission outside {answer, citations, gaps} is refused, as any submit is, and the corrected one comes back', async () => {
  const adapter = fauxAdapter({ script: () => [{ submit: { answer: 'no citations' } }, { submit: { ...ANSWER, extra: 1 } }, { submit: ANSWER }] });
  const t = delegateTool({ agents: AGENTS, tools: LEAD_TOOLS, adapter, store: memorySessionStore(), parentKey: 'step:lead' });
  const result = await call(t, { agent: 'checker', task: 'Check it.' });
  assert.deepEqual(JSON.parse(result.text), ANSWER);
  assert.deepEqual(adapter.calls.filter((c) => c === 'submit').length, 3, 'two refused, the third accepted');
  assert.deepEqual(DELEGATE_RESULT_SCHEMA.required, ['answer', 'citations']);
});

test("the money and the replay: a child cut off mid-run resumes from its own store when the lead's call runs again, its paid requests never sent twice and each booked under the child's key through the lead's check", async () => {
  const store = memorySessionStore();
  const asked = [];
  const beforeRequest = (r) => { asked.push(r.key); };
  const script = () => [{ say: 'one' }, { call: 'fetch' }, { hang: true }, { submit: ANSWER }];
  // The first process: two paid requests and a fetch, then it dies inside the child.
  const dying = fauxAdapter({ script });
  const dead = new AbortController();
  const first = delegateTool({ agents: AGENTS, tools: LEAD_TOOLS, adapter: dying, store, parentKey: 'step:lead', beforeRequest });
  const stalled = call(first, { agent: 'checker', task: 'Check it.' }, 'toolu_7', dead.signal);
  await until(() => dying.requests >= 2 && dying.calls.length >= 1, 'two requests and a tool call');
  dead.abort(new Error('the process died'));
  await stalled;
  // The next process: the lead's harness runs the same call (same id) again; the child resumes, nothing is re-sent.
  const next = fauxAdapter({ script: () => script().filter((a) => !('hang' in a)) });
  const again = delegateTool({ agents: AGENTS, tools: LEAD_TOOLS, adapter: next, store, parentKey: 'step:lead', beforeRequest });
  const result = await call(again, { agent: 'checker', task: 'Check it.' }, 'toolu_7');
  assert.deepEqual(JSON.parse(result.text), ANSWER);
  assert.deepEqual(next.opened.map((o) => o.state), ['open_turn'], 'the same child session, found open');
  assert.deepEqual([next.requests, next.calls], [1, ['submit']], 'only the submit was asked for again');
  const key = 'step:step:lead/delegate:toolu_7';
  assert.deepEqual(store.keys(), [key]);
  assert.ok(asked.length >= 3 && asked.every((k) => k === key), "every paid request went through the lead's check, under the child's key");
  assert.equal((await store.read(key)).filter((r) => r.kind === RUNNER_RECORDS.request).length, 3, 'three paid requests booked in all');
  // Run once more after it finished: the recorded answer, nothing run.
  const finished = fauxAdapter({ script: () => [{ submit: { answer: 'NOT AGAIN', citations: [] } }] });
  const replayed = await call(delegateTool({ agents: AGENTS, tools: LEAD_TOOLS, adapter: finished, store, parentKey: 'step:lead' }), { agent: 'checker', task: 'Check it.' }, 'toolu_7');
  assert.deepEqual([JSON.parse(replayed.text), finished.requests], [ANSWER, 0]);
});

test("the deadline: a child gets its agent's share of the lead's time left, not all of it", async () => {
  const adapter = fauxAdapter({ script: () => [{ hang: true }] });
  const deadline = Date.now() + 1_600;
  const t = delegateTool({ agents: AGENTS, tools: LEAD_TOOLS, adapter, store: memorySessionStore(), parentKey: 'step:lead', deadlineAt: () => deadline });
  const started = Date.now();
  const result = await call(t, { agent: 'analyst', task: 'Work the numbers.' });
  const took = Date.now() - started;
  assert.equal(result.isError, true);
  assert.match(result.text, /timeout/);
  assert.ok(took < 1_000, `stopped at about a quarter of 1.6 s, not the lead's whole deadline (${took} ms)`);
});

test('one child at a time: a second delegate call waits for the first to finish', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const live = { now: 0, most: 0 };
  const slow = { name: 'fetch', description: 'slow', inputSchema: { type: 'object' }, replay: 'safe', call: async () => { live.now += 1; live.most = Math.max(live.most, live.now); await gate; live.now -= 1; return { text: 'ok' }; } };
  const adapter = fauxAdapter({ script: () => [{ call: 'fetch' }, { submit: ANSWER }] });
  const t = delegateTool({ agents: AGENTS, tools: [slow, tool('search'), tool('write')], adapter, store: memorySessionStore(), parentKey: 'step:lead' });
  const both = Promise.all([call(t, { agent: 'checker', task: 'one' }, 'toolu_a'), call(t, { agent: 'checker', task: 'two' }, 'toolu_b')]);
  await until(() => live.now === 1, 'the first child inside its fetch');
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(live.most, 1, 'the second child has not started while the first runs');
  release();
  const results = await both;
  assert.ok(results.every((r) => JSON.parse(r.text).answer === ANSWER.answer));
  assert.equal(live.most, 1);
});

test('an unknown agent or an empty task is an error the lead reads, and runs nothing', async () => {
  const adapter = fauxAdapter({ script: () => [{ submit: ANSWER }] });
  const t = delegateTool({ agents: AGENTS, tools: LEAD_TOOLS, adapter, store: memorySessionStore(), parentKey: 'step:lead' });
  const unknown = await call(t, { agent: 'browser-bot', task: 'x' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /not one of the agents \(checker, analyst\)/);
  assert.equal((await call(t, { agent: 'checker', task: '  ' })).isError, true);
  assert.equal(adapter.requests, 0);
});
