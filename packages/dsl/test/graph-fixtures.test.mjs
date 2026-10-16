// The graph fixtures (test/fixtures/graph): one workflow per shape and what a driver kept running it, finished and cut.
// A graph panel reads them with `workflowGraph` and `nodeStatus`. The files are what generate.mjs writes, the workflows
// are valid and `workflowGraph` names the nodes `inspectWorkflow` does, and the statuses are the ones below, written from
// what each run did and not from what `nodeStatus` answers.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectWorkflow, validateWorkflow } from '@parcha/agentrun-dsl';
import { nodeStatus, workflowGraph } from '@parcha/agentrun-dsl/graph';
import { generate, SHAPES } from './fixtures/graph/generate.mjs';

const DIR = fileURLToPath(new URL('./fixtures/graph/', import.meta.url));
const read = (file) => JSON.parse(readFileSync(DIR + file, 'utf8'));

// Every node is `done` in a finished run, except what is listed. In a cut run the last node's commit never landed, so the
// frame has nothing for it (a code node binds no input) and it is `not-run`, the chain around it `working`.
const FINISHED = { route: { '/root/steps/1/branches/other/body': 'not-run' } };
const CUT = {
  sequence: { '/root': 'working', '/root/steps/2': 'not-run' },
  parallel: { '/root': 'working', '/root/steps/1': 'not-run' },
  route: { '/root': 'working', '/root/steps/1/branches/other/body': 'not-run', '/root/steps/2': 'not-run' },
  // A map item's `tail` was cut in every item: the items are still running, and what is above them is working.
  nested: { '/root': 'working', '/root/steps/0': 'working', '/root/steps/0/body': 'working', '/root/steps/0/body/steps/1': 'working', '/root/steps/1': 'not-run' },
  'map-v3': { '/root': 'working', '/root/steps/0': 'working', '/root/steps/0/body': 'working', '/root/steps/0/body/steps/1': 'working', '/root/steps/1': 'not-run' },
  'map-v4': { '/root': 'working', '/root/steps/0': 'working', '/root/steps/0/body': 'working', '/root/steps/0/body/steps/1': 'working', '/root/steps/1': 'not-run' },
};

test('the fixture files are what generate.mjs writes: nothing was edited by hand, and a run writes the same bytes twice', async () => {
  const written = await generate();
  const onDisk = readdirSync(DIR).filter((file) => file.endsWith('.json')).sort();
  assert.deepEqual(onDisk, Object.keys(written).sort());
  assert.equal(onDisk.length, Object.keys(SHAPES).length * 5);
  for (const [file, text] of Object.entries(written)) assert.equal(readFileSync(DIR + file, 'utf8'), text, file);
  assert.deepEqual(await generate(), written);
});

test('every fixture workflow is valid, and the graph names the nodes inspectWorkflow names', () => {
  for (const name of Object.keys(SHAPES)) {
    const workflow = read(`${name}.workflow.json`);
    assert.deepEqual(validateWorkflow(workflow), { ok: true }, name);
    assert.deepEqual(workflowGraph(workflow).nodes.map(({ path, kind, label }) => ({ path, kind, label })), inspectWorkflow(workflow).nodes.map(({ path, kind, label }) => ({ path, kind, label })), name);
  }
});

test('the shapes are the ones named: a parallel, a route, a nested map with a child workflow, and a map in each layout', () => {
  const kinds = (name) => new Set(workflowGraph(read(`${name}.workflow.json`)).edges.map((edge) => edge.kind));
  assert.deepEqual([...kinds('sequence')], ['next']);
  assert.ok(kinds('parallel').has('branch'));
  assert.ok(kinds('route').has('route'));
  assert.ok(kinds('nested').has('item') && kinds('nested').has('child'));
  assert.ok(kinds('map-v3').has('item') && kinds('map-v4').has('item'));
  assert.equal(read('map-v3.finished.items.json').length, 0, 'the whole-state layout keeps no items');
  assert.ok(read('map-v4.finished.items.json').length >= 3, 'the keyed layout keeps one record per item');
});

for (const name of Object.keys(SHAPES)) {
  for (const variant of ['finished', 'cut']) {
    test(`${name}, ${variant}: nodeStatus over the frame and the items`, () => {
      const graph = workflowGraph(read(`${name}.workflow.json`));
      const state = nodeStatus(graph, { pin: read(`${name}.${variant}.frame.json`), items: read(`${name}.${variant}.items.json`) });
      const except = (variant === 'finished' ? FINISHED : CUT)[name] ?? {};
      for (const node of graph.nodes) assert.equal(state[node.path], except[node.path] ?? 'done', `${node.label} ${node.path}`);
    });
  }
}
