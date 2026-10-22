// `nodeStatus` with the run's terminal result: an escalate node that fired is never in the driver's frame (the run ends
// there, nothing commits it), so the frame alone shows it not-run and the containers around it working. Given the result,
// the escalate node it names is `escalated`, and so is every container on its path: the run ended there. Without a result
// the status is what it was.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openJournal, openRecovery, withRecovery } from '@parcha/agentrun-dsl/recovery';
import { nodeStatus, workflowGraph } from '@parcha/agentrun-dsl/graph';
import { SHAPES } from './fixtures/graph/generate.mjs';

const DIR = new URL('./fixtures/graph/', import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, DIR), 'utf8'));
// A recorded run that stopped at its fourth step: the graph of the revision it ran, the driver's frame at its last commit,
// and the run's terminal result (its status and the escalation's execution path; the fixture's note says what was renamed).
// It is a recording, so it lives beside the generated graph fixtures, not among them.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/escalated-run.json', import.meta.url), 'utf8'));

test('a recorded run that escalated at its fourth step: that node is escalated and so is the chain; before it done, after it not-run', () => {
  const { graph, frame, result } = recorded;
  const state = nodeStatus(graph, { pin: frame, result });
  assert.equal(state['/root/steps/3'], 'escalated', 'the escalate node that fired');
  assert.equal(state['/root'], 'escalated', 'the run ended in the chain, so the chain is not working');
  for (const path of ['/root/steps/0', '/root/steps/1', '/root/steps/2']) assert.equal(state[path], 'done', path);
  const after = graph.nodes.map((node) => node.path).filter((path) => /^\/root\/steps\/(\d+)/.test(path) && Number(path.split('/')[3]) > 3);
  assert.ok(after.length > 10);
  for (const path of after) assert.equal(state[path], 'not-run', path);
  // The frame alone, as before: the escalate node not-run, the chain still working.
  const alone = nodeStatus(graph, { pin: frame });
  assert.equal(alone['/root/steps/3'], 'not-run');
  assert.equal(alone['/root'], 'working');
});

test('an escalation named only by a field the DSL does not write (`node`) is not read: the status is byte for byte the frame\'s', () => {
  const { graph, frame, result } = recorded;
  const byNode = { status: 'escalated', escalation: { node: result.escalation.executionPath, label: result.escalation.label } };
  assert.equal(JSON.stringify(nodeStatus(graph, { pin: frame, result: byNode })), JSON.stringify(nodeStatus(graph, { pin: frame })));
});

test('no result, or a result that names no escalation in the graph, gives the status byte for byte as before', () => {
  const sources = [[recorded.graph, { pin: recorded.frame }]];
  for (const shape of Object.keys(SHAPES)) {
    const graph = workflowGraph(read(`${shape}.workflow.json`));
    for (const run of ['finished', 'cut']) sources.push([graph, { pin: read(`${shape}.${run}.frame.json`), items: read(`${shape}.${run}.items.json`) }]);
  }
  for (const [graph, source] of sources) {
    const before = JSON.stringify(nodeStatus(graph, source));
    for (const result of [undefined, null, { status: 'complete' }, { status: 'escalated' }, { status: 'escalated', escalation: {} },
      { status: 'escalated', escalation: { executionPath: '/root/steps/99' } }, { status: 'escalated', escalation: { executionPath: 7 } },
      // Only an escalation marks a node: a run that failed or was cancelled leaves the frame's reading as it is, for now.
      { status: 'failed', escalation: { executionPath: '/root/steps/3' } }, { status: 'cancelled', escalation: { executionPath: '/root/steps/3' } }]) {
      assert.equal(JSON.stringify(nodeStatus(graph, { ...source, result })), before, JSON.stringify(result));
    }
  }
  assert.ok(sources.length > 10);
});

// ---- a nested escalation, recorded by the driver on a memory journal -------------------------------------------------

const code = (label, body = '({})') => ({ node: 'code', label, code: `s => (${body})` });
const schemas = { Any: { type: 'object' } };
// A map whose body is a route: an item of kind a takes branch a; an item of kind b runs a check and then stops for a person.
const nested = { v: 2, name: 'nested-escalate', schemas, output: { schemaId: 'Any', path: 'final' }, root: { node: 'chain', steps: [
  code('seed', '({ rows: [{ kind: "a" }, { kind: "b" }] })'),
  { node: 'map', label: 'pages', itemsPath: 'rows', as: 'outs', maxConcurrency: 1, body: { node: 'route', label: 'kind', valuePath: 'item.kind', otherwise: 'a', branches: {
    a: { body: code('take-a', '({ got: "a" })') },
    b: { body: { node: 'chain', steps: [code('check-b', '({ checked: true })'), { node: 'escalate', label: 'stop-b', when: { predicate: 'field_true', path: 'checked' }, kind: 'needs_input', stage: 'b', summary: 'A b page needs a person.' }, code('after-b')] } },
  } } },
  code('finish', '({ final: { n: s.outs.length } })'),
] } };

async function recordedRun(workflow, input = {}, options = {}) {
  let record; let owned = false;
  const backend = {
    acquire: async () => { if (owned) throw new Error('Run already has a live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); },
  };
  const driver = await openRecovery({ open: (bound) => openJournal(backend, bound) }, workflow, { key: 'escalated-run', ...options });
  const deps = withRecovery(driver, { runEffect: async () => ({}), runJudge: async () => { throw new Error('no judge'); } });
  try { return { result: await runWorkflow(workflow, input, deps), state: record.state, items: Object.values(record.items ?? {}) }; } finally { await driver.close(); }
}

test('an escalation inside a route branch inside a map item: the node, its branch, the route, the map and the root are escalated', async () => {
  const { result, state } = await recordedRun(nested);
  assert.equal(result.status, 'escalated');
  const graph = workflowGraph(nested);
  const status = nodeStatus(graph, { pin: state.pin, result });
  const at = (label) => status[graph.nodes.find((node) => node.label === label).path];
  const b = '/root/steps/1/body/branches/b/body';
  assert.deepEqual({ seed: at('seed'), pages: at('pages'), kind: at('kind'), branchB: status[b], checkB: at('check-b'), stopB: at('stop-b'), afterB: at('after-b'), takeA: at('take-a'), finish: at('finish'), root: status['/root'] }, {
    seed: 'done',
    pages: 'escalated', kind: 'escalated', branchB: 'escalated', stopB: 'escalated', root: 'escalated',
    // The map ended, so what finished inside it is done: no other item will run.
    checkB: 'done', takeA: 'done',
    afterB: 'not-run', finish: 'not-run',
  });
  // The escalation names the node at its execution path, inside the map's second item; the status is the node's.
  assert.match(result.escalation.executionPath ?? '', /^\/root\/steps\/1\/items\/1\/body\/branches\/b\/body\/steps\/1$/);
  // Without the result: the escalate node not-run, the map and the root working.
  const alone = nodeStatus(graph, { pin: state.pin });
  assert.deepEqual([alone[`${b}/steps/1`], alone['/root/steps/1'], alone['/root']], ['not-run', 'working', 'working']);
});

test('a failure the run collected before it escalated still shows on the containers above it; the escalate node is escalated', async () => {
  // A map that collects its failed items, then a stop after it: the second item fails and is collected, and the run escalates.
  // The keyed layout keeps each item's record, the failed one with its failure; the whole-state layout keeps none of it.
  const collecting = { v: 2, name: 'collect-then-escalate', schemas, output: { schemaId: 'Any', path: 'final' }, root: { node: 'chain', steps: [
    { node: 'map', label: 'pages', itemsPath: 'rows', as: 'outs', maxConcurrency: 1, onItemFailure: 'collect', failedAs: 'missed',
      body: code('read', '(() => { if (s.item.bad) throw new Error("unreadable"); return { ok: true }; })()') },
    { node: 'escalate', label: 'stop', when: { predicate: 'count_gte', path: 'missed', n: 1 }, kind: 'needs_input', stage: 'read', summary: 'A page was unreadable.' },
    code('finish', '({ final: { n: s.outs.length } })'),
  ] } };
  const { result, state, items } = await recordedRun(collecting, { rows: [{ bad: false }, { bad: true }] }, { layout: 'v4' });
  assert.equal(result.status, 'escalated');
  assert.ok(items.some((item) => item.status === 'failed'), 'the failed item is recorded');
  const graph = workflowGraph(collecting);
  const alone = nodeStatus(graph, { pin: state.pin, items });
  const status = nodeStatus(graph, { pin: state.pin, items, result });
  assert.equal(status['/root/steps/1'], 'escalated');
  assert.equal(status['/root/steps/2'], 'not-run');
  // What the frame shows of the collected failure stays: the root holds it, with or without the result.
  assert.equal(alone['/root'], 'failed');
  assert.equal(status['/root'], 'failed');
});

// A map whose body is a plain chain shared by every item: item 0 runs it through, item 1 stops at the escalate in it.
const sharedBody = { v: 2, name: 'shared-body-escalate', schemas, output: { schemaId: 'Any', path: 'final' }, root: { node: 'chain', steps: [
  code('seed', '({ rows: [{ stop: false }, { stop: true }] })'),
  { node: 'map', label: 'pages', itemsPath: 'rows', as: 'outs', maxConcurrency: 1, body: { node: 'chain', steps: [
    code('read', '({ read: true })'),
    { node: 'escalate', label: 'maybe-stop', when: { predicate: 'field_true', path: 'item.stop' }, kind: 'needs_input', stage: 'r', summary: 'This page needs a person.' },
    code('done-item', '({ ok: true })'),
  ] } },
  code('finish', '({ final: { n: s.outs.length } })'),
] } };

test('reading one committed map item with { item } and the run result: an escalation in another item does not mark this one escalated', async () => {
  // Item 0 (stop:false) runs the shared chain body to the end and commits; item 1 (stop:true) stops at the escalate in
  // that same body. The escalation's execution path is in item 1 (/root/steps/1/items/1/body/steps/1). Reading item 0 on
  // its own with the terminal result must not mark its body's step 1 escalated: definitionPath strips the index to the
  // shared body, so without item scoping item 0's view would show the escalate node it never ran as escalated.
  const { result, items } = await recordedRun(sharedBody, {}, { layout: 'v4' });
  assert.equal(result.status, 'escalated');
  assert.match(result.escalation.executionPath ?? '', /\/items\/1\/body\/steps\/1$/, 'the escalation fired at item 1 step 1');
  const graph = workflowGraph(sharedBody);
  const item0 = items.find((item) => item.index === 0);
  assert.ok(item0 && item0.status === 'committed', 'item 0 committed successfully');
  const status = nodeStatus(graph, { pin: item0.frame, items: [item0], result }, { item: '/root/steps/1/items/0' });
  const stepOf = (i) => '/root/steps/1/body/steps/' + i;
  assert.notEqual(status[stepOf(1)], 'escalated', "item 0's escalate step did not fire; it is not escalated in item 0's view");
  assert.equal(status[stepOf(0)], 'done', "item 0 ran the body's first step");
  assert.equal(status[stepOf(2)], 'done', "item 0 ran the body's last step and committed");
});
