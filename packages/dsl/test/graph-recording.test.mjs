// The nested shape's recording (test/fixtures/graph/nested.recording.jsonl): the durable lines of the run of a map whose body
// runs a child workflow, in the keyed layout, killed after two lookups and resumed by a second process
// (`node examples/graph/run.ts --kill --record <dir>`, cut by record.mjs). A graph panel steps from these lines to
// nodeStatus's source: the latest `agentrun.driver` document's frame (`state.pin`) and the `agentrun.items` documents. The
// test reads the lines back that way, at every commit, through nodeStatus.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeStatus, workflowGraph } from '@parcha/agentrun-dsl/graph';

const DIR = fileURLToPath(new URL('./fixtures/graph/', import.meta.url));
const workflow = JSON.parse(readFileSync(`${DIR}nested.workflow.json`, 'utf8'));
const lines = readFileSync(`${DIR}nested.recording.jsonl`, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const graph = workflowGraph(workflow);

/** The source nodeStatus reads, from the durable lines up to `stop` (exclusive): each document at its latest revision. */
function sourceAt(stop) {
  const documents = new Map();
  for (const line of lines.slice(0, stop)) {
    const { doc, key, value } = line.data;
    documents.set(`${doc}\u0000${key ?? ''}`, { doc, value });
  }
  const held = [...documents.values()];
  const driver = held.find((entry) => entry.doc === 'agentrun.driver');
  return driver?.value.state?.pin ? { pin: driver.value.state.pin, items: held.filter((entry) => entry.doc === 'agentrun.items').map((entry) => entry.value) } : undefined;
}

test('the recording is durable lines of the workflow\'s own documents, in the keyed layout, across a kill: two generations, no clock, pid or path in the bytes', () => {
  assert.ok(lines.length >= 40);
  assert.deepEqual([...new Set(lines.map((line) => `${line.channel}/${line.source}`))], ['durable/workflow']);
  assert.deepEqual([...new Set(lines.map((line) => line.data.doc))].sort(), ['agentrun.driver', 'agentrun.effects', 'agentrun.items', 'agentrun.states', 'agentrun.task']);
  assert.deepEqual([...new Set(lines.map((line) => line.gen))].sort(), [1, 2], 'a process was killed and a second resumed the run');
  const drivers = lines.filter((line) => line.data.doc === 'agentrun.driver');
  assert.equal(drivers.at(-1).data.value.state.schema, 'agentrun.frozen_run.v4');
  assert.deepEqual(lines.map((line) => line.t), lines.map((_, index) => index), 'every line\'s time is its place in the file');
  assert.doesNotMatch(readFileSync(`${DIR}nested.recording.jsonl`, 'utf8'), /\/tmp\/|\/home\/|ubuntu|"pid"|\b(?!1792000000000\b)\d{13}\b/);
  const generations = lines.map((line) => line.gen);
  assert.deepEqual(generations, [...generations].sort(), 'the generation never decreases in file order');
});

test('at the end of the recording every node of the nested workflow is done', () => {
  const state = nodeStatus(graph, sourceAt(lines.length));
  for (const node of graph.nodes) assert.equal(state[node.path], 'done', `${node.label} ${node.path}`);
});

test('at every commit the status is read from the lines so far: a node outside the map that was done stays done, and one inside it never goes back to not-run', () => {
  const stops = [...new Set(lines.map((line) => line.commit))].sort((a, b) => a - b);
  assert.ok(stops.length >= 15, `${stops.length} commits`);
  let before = {};
  const seen = new Set();
  for (const commit of stops) {
    const upTo = lines.filter((line) => line.commit <= commit).length;
    const source = sourceAt(upTo);
    if (!source) continue;
    const state = nodeStatus(graph, source);
    assert.deepEqual(Object.keys(state), graph.nodes.map((node) => node.path));
    // A node outside a map's body is done for good. A node inside one covers the items seen so far: it is done when every one
    // of them is, and the next item that starts makes it working again, never not-run.
    for (const [path, was] of Object.entries(before)) {
      if (was !== 'done') continue;
      if (path.includes('/body')) assert.notEqual(state[path], 'not-run', `${path} not-run at commit ${commit}`);
      else assert.equal(state[path], 'done', `${path} undone at commit ${commit}`);
    }
    for (const value of Object.values(state)) seen.add(value);
    before = state;
  }
  assert.deepEqual([...seen].sort(), ['done', 'not-run', 'working'], 'the run is seen not started, working and done');
});

test('at the kill, between the two processes: the map is working, some items are done, the step after the map has not run, and the resumed process finishes it', () => {
  const firstOfSecond = lines.findIndex((line) => line.gen === 2);
  assert.ok(firstOfSecond > 0);
  const atKill = nodeStatus(graph, sourceAt(firstOfSecond));
  assert.equal(atKill['/root/steps/0'], 'working');
  assert.equal(atKill['/root/steps/1'], 'not-run');
  assert.equal(atKill['/root'], 'working');
  assert.ok(Object.entries(atKill).some(([path, value]) => path.startsWith('/root/steps/0/body') && value === 'done'), 'a node inside the map is already done');
  assert.ok(Object.entries(atKill).some(([path, value]) => path.startsWith('/root/steps/0/body') && value !== 'done'), 'and one inside it is not');
});
