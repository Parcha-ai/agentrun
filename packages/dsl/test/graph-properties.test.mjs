// nodeStatus, as properties over whole runs and not as cases. Every shape of the graph fixtures, a map inside a map's item two
// levels deep, and two runs that end on an item's failure are run on a memory journal with scripted tools (one item at a time, so
// the commits come in one order: nothing here is random). The journal's record after EACH commit is a run cut at that commit: a
// process that is gone leaves exactly what the commits before it wrote. For every such record, the whole-run read and the
// per-item read ({ item } for each item's record) must satisfy the invariants below. They are written from what a commit means,
// not from nodeStatus's code, and each earlier review finding on this module is a violation of one of them.
//   (a) monotone: across the commits of a run a node's status never goes back (done stays done, failed stays failed);
//   (b) done only when the record committed it: an instance of the node is in a `done` list, or it is a chain whose steps all are;
//   (c) whole-run read: nothing inside a map's or loop's body is done before that map or loop is;
//   (d) { item } read: the item's body is done exactly when the item's record says committed, and a map or loop inside the item
//       still follows (c);
//   (e) a map that ended on an item's failure, and everything that holds it, reads failed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, openJournal } from '@parcha/agentrun-dsl/recovery';
import { nodeStatus, workflowGraph } from '@parcha/agentrun-dsl/graph';
import { SHAPES } from './fixtures/graph/generate.mjs';

const code = (label, body = '({})') => ({ node: 'code', label, code: `s => (${body})` });
const lookup = (label, id) => ({ node: 'call', label, via: 'tool', tool: 'lookup', args: { id }, out: 'Found', as: label, deadline_s: 30 });
const schemas = { Any: { type: 'object' }, Item: { type: 'object' }, Found: { type: 'object', required: ['id', 'score'], properties: { id: { type: 'string' }, score: { type: 'number' } } } };
const flow = (name, root, extra = {}) => ({ v: 2, name, schemas, output: { schemaId: 'Any', path: 'final' }, root, ...extra });

const EXTRA = {
  // A map inside a map's item, two levels deep, each item doing a lookup and a code step.
  'map-in-map': { layout: 'v4', input: { rows: [{ cells: [{ id: 'a' }, { id: 'b' }] }, { cells: [{ id: 'c' }, { id: 'd' }] }] },
    workflow: flow('map-in-map', { node: 'chain', steps: [
      { node: 'map', label: 'rows', itemsPath: 'rows', as: 'r', resultPath: 'n', maxConcurrency: 1, body: { node: 'chain', steps: [
        { node: 'map', label: 'cells', itemsPath: 'row.cells', as: 'c', resultPath: 'score', maxConcurrency: 1, body: { node: 'chain', steps: [lookup('look', '{item.id}'), code('tally', '({ score: s.look.score })')] } },
        code('count', '({ n: s.c.length })'),
      ] } },
      code('finish', '({ final: { n: s.r.length } })'),
    ] }, { input: { schemaId: 'Item' } }) },
};
// The rows' items are objects with `cells`, which the outer map hands its body as `item`; the inner map reads them from there.
EXTRA['map-in-map'].workflow.root.steps[0].body.steps[0].itemsPath = 'item.cells';

// A loop whose body is two steps: the second pass's marks sit beside the first pass's, which was the shape of an earlier finding.
EXTRA.loop = { input: {}, workflow: flow('loop', { node: 'chain', steps: [
  { node: 'loop', label: 'again', maxIters: 3, until: { predicate: 'gte', path: 'n', n: 2 }, body: { node: 'chain', steps: [code('first', '({ n: (s.n || 0) + 1 })'), code('second', '({ m: (s.n || 0) })')] } },
  code('finish', '({ final: { n: s.n } })'),
] }) };

const failing = (name) => ({ layout: name === 'failing-v4' ? 'v4' : undefined, input: { items: [1, 2, 3] }, fails: true,
  workflow: flow(name, { node: 'chain', steps: [
    { node: 'map', label: 'each', itemsPath: 'items', as: 'outs', resultPath: 'score', maxConcurrency: 1, body: { node: 'chain', steps: [code('score', '(s.item === 2 ? (() => { throw new Error("item 2 failed"); })() : { score: s.item })')] } },
    code('finish', '({ final: { n: s.outs.length } })'),
  ] }, { input: { schemaId: 'Item' } }) });

const ALL = { ...SHAPES, ...EXTRA, 'failing-v3': failing('failing-v3'), 'failing-v4': failing('failing-v4') };

/** One run to its end (or its failure), and the journal's record after every commit, in order. */
async function history(shape) {
  const records = [];
  let record; let owned = false;
  const backend = {
    acquire: async () => { owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); records.push(structuredClone(next)); },
  };
  const driver = await openRecovery({ open: (bound) => openJournal(backend, bound) }, shape.workflow, { key: 'property', ...(shape.layout ? { layout: shape.layout } : {}) });
  const deps = withRecovery(driver, { runEffect: async ({ input: args }) => ({ id: String(args.id), score: Number(String(args.id).replace(/\D/g, '')) || 1 }) });
  try { await runWorkflow(shape.workflow, shape.input, deps); } catch (error) { if (!shape.fails) throw error; } finally { await driver.close(); }
  return records.filter((entry) => entry.state?.pin);
}

const definitionPath = (path) => path.replace(/\/items\/\d+\/body/g, '/body').replace(/\/iterations\/\d+(?=\/|$)/g, '');
const itemsOf = (record) => Object.values(record.items ?? {});
const sourceOf = (record) => ({ pin: record.state.pin, items: itemsOf(record) });
/** Every execution path the record says was committed, from the frame and from the items. */
function committed(record) {
  const paths = new Set(record.state.pin.done);
  for (const item of itemsOf(record)) {
    for (const path of item.frame?.done ?? []) paths.add(path);
    if (item.status === 'committed') paths.add(`${item.map}/items/${item.index}/body`);
  }
  return paths;
}

for (const [name, shape] of Object.entries(ALL)) {
  test(`${name}: the invariants hold at every commit of the run, whole and item by item`, async () => {
    const records = await history(shape);
    assert.ok(records.length >= 3, `${records.length} commits`);
    const graph = workflowGraph(shape.workflow);
    const nodes = new Map(graph.nodes.map((node) => [node.path, node]));
    const containers = graph.nodes.filter((node) => node.kind === 'map' || node.kind === 'loop');
    const enclosing = (path) => containers.filter((container) => path.startsWith(`${container.path}/body`));
    const stepsOf = (node) => graph.nodes.filter((other) => other.path.startsWith(`${node.path}/steps/`) && /^\d+$/.test(other.path.slice(`${node.path}/steps/`.length)));
    let before; const itemBefore = new Map();
    let sawPartial = false;

    for (const [index, record] of records.entries()) {
      const where = `${name} after commit ${index + 1} of ${records.length}`;
      const state = nodeStatus(graph, sourceOf(record));
      const done = committed(record);
      const definitions = new Set([...done].map(definitionPath));
      // (a) a node's status never goes back.
      if (before) for (const [path, was] of Object.entries(before)) {
        if (was === 'done') assert.equal(state[path], 'done', `(a) ${where}: ${path} was done`);
        if (was === 'failed') assert.equal(state[path], 'failed', `(a) ${where}: ${path} was failed`);
      }
      for (const node of graph.nodes) {
        if (state[node.path] !== 'done') continue;
        // (b) done only when the record committed it, or it is a chain whose steps all are.
        const steps = node.kind === 'chain' ? stepsOf(node) : [];
        assert.ok(definitions.has(node.path) || (steps.length > 0 && steps.every((step) => state[step.path] === 'done')), `(b) ${where}: ${node.path} is done and nothing committed it`);
        // (c) nothing inside a map's or loop's body is done before that map or loop is.
        for (const container of enclosing(node.path)) assert.equal(state[container.path], 'done', `(c) ${where}: ${node.path} is done inside ${container.path}, which is ${state[container.path]}`);
      }
      // (e) a failed map, and everything that holds it, reads failed.
      const partial = record.state.pin.partial;
      if (partial) {
        sawPartial = true;
        const failedPath = definitionPath(partial.path);
        assert.equal(state[failedPath], 'failed', `(e) ${where}: the map ${failedPath}`);
        for (const node of graph.nodes) if (failedPath.startsWith(`${node.path}/`)) assert.equal(state[node.path], 'failed', `(e) ${where}: ${node.path} holds the failed map`);
      }
      // (d) each item's record, read on its own.
      for (const item of itemsOf(record)) {
        const itemPath = `${item.map}/items/${item.index}`;
        const own = nodeStatus(graph, [item], { item: itemPath });
        const mapPath = definitionPath(item.map), bodyPath = `${mapPath}/body`;
        assert.ok(nodes.has(bodyPath), `${where}: ${bodyPath} is a node`);
        assert.equal(own[bodyPath] === 'done', item.status === 'committed', `(d) ${where}: ${itemPath} is ${item.status} and its body reads ${own[bodyPath]}`);
        const prior = itemBefore.get(itemPath);
        if (prior) for (const [path, was] of Object.entries(prior)) {
          if (was === 'done') assert.equal(own[path], 'done', `(a) ${where}: ${itemPath}: ${path} was done`);
          if (was === 'failed') assert.equal(own[path], 'failed', `(a) ${where}: ${itemPath}: ${path} was failed`);
        }
        itemBefore.set(itemPath, own);
        for (const node of graph.nodes) {
          if (!node.path.startsWith(`${bodyPath}/`) || own[node.path] !== 'done') continue;
          // A map or loop inside the item (the body itself, if it is one, or deeper) still follows (c).
          for (const container of enclosing(node.path)) if (container.path.startsWith(bodyPath)) assert.equal(own[container.path], 'done', `(d) ${where}: ${itemPath}: ${node.path} is done inside ${container.path}, which is ${own[container.path]}`);
        }
      }
      before = state;
    }
    // The run's end, to say the invariants were not satisfied by a run that never got anywhere.
    const last = nodeStatus(graph, sourceOf(records.at(-1)));
    if (shape.fails) assert.ok(sawPartial, 'the run ended on an item\'s failure and the driver kept it');
    else for (const node of graph.nodes) if (node.kind !== 'route' || !/branches\/other\//.test(node.path)) assert.ok(['done', 'not-run'].includes(last[node.path]), `${name} ends with ${node.path} ${last[node.path]}`);
    if (!shape.fails) assert.equal(last['/root'], 'done', `${name} ends done`);
    assert.ok(records.some((record) => itemsOf(record).length > 0) === Boolean(shape.layout === 'v4'), 'the keyed layout keeps items, the whole-state one does not');
  });
}
