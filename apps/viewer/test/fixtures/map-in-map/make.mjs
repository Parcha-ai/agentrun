// A map inside a map's item, run by the DSL's own fixture driver (packages/dsl/test/fixtures/graph/generate.mjs) in both
// layouts, to its end and cut at the third commit of 'tally': what the driver kept, as runs.json beside this file.
// Rebuild the DSL first (npm run build -w @parcha/agentrun-dsl), then: node apps/viewer/test/fixtures/map-in-map/make.mjs
import { writeFileSync } from 'node:fs';
const { capture } = await import(new URL('../../../../../packages/dsl/test/fixtures/graph/generate.mjs', import.meta.url).href);
const schemas = { Any: { type: 'object' }, Item: { type: 'object' }, Found: { type: 'object', required: ['id', 'score'], properties: { id: { type: 'string' }, score: { type: 'number' } } } };
const lookup = (label, id) => ({ node: 'call', label, via: 'tool', tool: 'lookup', args: { id }, out: 'Found', as: label, deadline_s: 30 });
const code = (label, body) => ({ node: 'code', label, code: `s => (${body})` });
const workflow = { v: 2, name: 'twice', schemas, output: { schemaId: 'Any', path: 'final' }, input: { schemaId: 'Item' }, root: { node: 'chain', steps: [
  { node: 'map', label: 'rows', itemsPath: 'rows', as: 'outs', resultPath: 'row', maxConcurrency: 1, body: { node: 'chain', steps: [
    { node: 'map', label: 'cells', itemsPath: 'item.cells', as: 'found', resultPath: 'score', maxConcurrency: 1, body: { node: 'chain', steps: [lookup('look', '{item.id}'), code('tally', '({ score: s.look.score * 2 })')] } },
    code('row', '({ row: s.found.length })'),
  ] } },
  code('finish', '({ final: { n: s.outs.length } })'),
] } };
const input = { rows: [{ cells: [{ id: 'a' }, { id: 'b' }] }, { cells: [{ id: 'c' }, { id: 'd' }] }] };
const out = {};
for (const layout of ['v3', 'v4']) for (const variant of ['finished', 'cut']) {
  out[`${layout}.${variant}`] = await capture({ workflow, input, layout }, variant === 'cut' ? { cut: { label: 'tally', nth: 3 } } : {});
}
writeFileSync(new URL('runs.json', import.meta.url), `${JSON.stringify({ workflow, input, runs: out }, null, 2)}\n`);
