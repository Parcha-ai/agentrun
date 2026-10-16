// The graph fixtures: one workflow per shape, run on a memory journal with scripted fakes, and what the recovery driver
// kept: the snapshot's frame (`pin`) and, in the keyed layout, the map items' records. A graph panel's test reads these
// with `workflowGraph` and `nodeStatus`; `node test/fixtures/graph/generate.mjs` writes them under this directory, and
// test/graph-fixtures.test.mjs checks the files are what this script produces.
//
// Each shape has a finished run and a cut one (the process ended before one node's commit landed). Files, for a shape
// `<name>` and a variant `finished` or `cut`: `<name>.workflow.json`, `<name>.<variant>.frame.json` (the snapshot's `pin`),
// `<name>.<variant>.items.json` (the map items' records as a list, `[]` outside the keyed layout).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { openRecovery, withRecovery, openJournal } from '@parcha/agentrun-dsl/recovery';

const code = (label, body = '({})') => ({ node: 'code', label, code: `s => (${body})` });
const lookup = (label, id = 'x') => ({ node: 'call', label, via: 'tool', tool: 'lookup', args: { id }, out: 'Found', as: label, deadline_s: 30 });
const schemas = {
  Any: { type: 'object' },
  Item: { type: 'object' },
  Found: { type: 'object', required: ['id', 'score'], properties: { id: { type: 'string' }, score: { type: 'number' } } },
};
const flow = (name, root, extra = {}) => ({ v: 2, name, schemas, output: { schemaId: 'Any', path: 'final' }, root, ...extra });

const child = { v: 2, name: 'child-lookup', schemas: { ...schemas, ChildIn: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  input: { schemaId: 'ChildIn' }, output: { schemaId: 'Any', path: 'res' },
  root: { node: 'chain', steps: [lookup('fetch', '{id}'), code('shape', '({ res: { ok: true } })')] } };

/** The six shapes: a sequence, a parallel, a route, a nested map with a child workflow, and one map in each layout. */
export const SHAPES = {
  sequence: { workflow: flow('sequence', { node: 'chain', steps: [lookup('search'), code('score', '({ score: s.search.score * 2 })'), code('finish', '({ final: { score: s.score } })')] }), input: {}, cut: 'finish' },
  parallel: { workflow: flow('parallel', { node: 'chain', steps: [
    { node: 'parallel', label: 'fan', branches: [lookup('left', 'l'), lookup('right', 'r'), code('note', '({ note: 1 })')] },
    code('finish', '({ final: { left: s.left.score, right: s.right.score } })'),
  ] }), input: {}, cut: 'finish' },
  route: { workflow: flow('route', { node: 'chain', steps: [
    code('seed', '({ pick: "a/b" })'),
    { node: 'route', label: 'choose', valuePath: 'pick', branches: { 'a/b': { body: lookup('slash', 's') }, other: { body: code('other', '({ taken: "other" })') } }, otherwise: 'other' },
    code('finish', '({ final: { taken: s.slash.id } })'),
  ] }), input: {}, cut: 'finish' },
  nested: { workflow: flow('nested', { node: 'chain', steps: [
    { node: 'map', label: 'each', itemsPath: 'items', as: 'outs', resultPath: 'sub', body: { node: 'chain', steps: [
      { node: 'workflow', label: 'sub', workflow: child, input: { id: '{item.id}' }, out: 'Any', as: 'sub' },
      code('tail', '({ done: true })'),
    ] } },
    code('finish', '({ final: { n: s.outs.length } })'),
  ] }, { input: { schemaId: 'Item' } }), input: { items: [{ id: 'i0' }, { id: 'i1' }, { id: 'i2' }] }, cut: 'tail', layout: 'v4' },
  'map-v3': { workflow: mapFlow('map-v3'), input: { items: ['a', 'b', 'c'].map((id) => ({ id })) }, cut: 'tally' },
  'map-v4': { workflow: mapFlow('map-v4'), input: { items: ['a', 'b', 'c'].map((id) => ({ id })) }, cut: 'tally', layout: 'v4' },
};
function mapFlow(name) {
  return flow(name, { node: 'chain', steps: [
    { node: 'map', label: 'each', itemsPath: 'items', as: 'found', resultPath: 'score', body: { node: 'chain', steps: [lookup('look', '{item.id}'), code('tally', '({ score: s.look.score * 2 })')] } },
    code('finish', '({ final: { n: s.found.length } })'),
  ] }, { input: { schemaId: 'Item' } });
}
// `nested` is a map, so its child workflow runs per item in the keyed layout; `layout` says which layout a shape's run uses.

const KEY = 'graph-fixture';
const answer = (id) => ({ id: String(id), score: Number(String(id).replace(/\D/g, '')) || 1 });

function journal() {
  let record; let owned = false;
  const backend = {
    acquire: async () => { if (owned) throw new Error('Run already has a live owner'); owned = true; return async () => { owned = false; }; },
    read: async () => record && structuredClone(record),
    write: async (next) => { record = structuredClone(next); },
  };
  return { store: { open: (bound) => openJournal(backend, bound) }, record: () => record };
}

/** One run of a shape: to its end, or (`cut`) until the commit of the node with that label never lands. Returns what the
 *  driver kept: the snapshot's frame and the map items' records, in key order. */
export async function capture(shape, { cut } = {}) {
  const { workflow, input, layout } = shape;
  const kept = journal();
  const driver = await openRecovery(kept.store, workflow, { key: KEY, ...(layout ? { layout } : {}) });
  const deps = withRecovery(driver, { runEffect: async ({ input: args }) => answer(args.id) });
  if (cut) deps.recovery = { ...deps.recovery, commit: (node, ...rest) => (node.label === cut ? Promise.reject(new Error(`cut at ${cut}`)) : driver.recovery.commit(node, ...rest)) };
  try { await runWorkflow(workflow, input, deps); } catch (error) { if (!cut) throw error; } finally { await driver.close(); }
  const record = kept.record();
  // A clock is an absolute deadline in milliseconds; the fixture keeps each key and fixes its value so two runs write the same bytes.
  const items = Object.entries(record.items ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => ({ ...value, clocks: Object.fromEntries(Object.keys(value.clocks ?? {}).map((key) => [key, 1792000000000])) }));
  return { frame: record.state.pin, items };
}

/** The fixture files as text, by name; written under `directory` when one is given. */
export async function generate(directory) {
  const files = {};
  for (const [name, shape] of Object.entries(SHAPES)) {
    files[`${name}.workflow.json`] = shape.workflow;
    for (const variant of ['finished', 'cut']) {
      const { frame, items } = await capture(shape, variant === 'cut' ? { cut: shape.cut } : {});
      files[`${name}.${variant}.frame.json`] = frame;
      files[`${name}.${variant}.items.json`] = items;
    }
  }
  const text = (value) => `${JSON.stringify(value, null, 2)}\n`;
  if (directory) { mkdirSync(directory, { recursive: true }); for (const [file, value] of Object.entries(files)) writeFileSync(`${directory}/${file}`, text(value)); }
  return Object.fromEntries(Object.entries(files).map(([file, value]) => [file, text(value)]));
}

if (import.meta.main) {
  const out = fileURLToPath(new URL('./', import.meta.url));
  const written = await generate(out);
  console.log(`wrote ${Object.keys(written).length} files under ${out}`);
}
