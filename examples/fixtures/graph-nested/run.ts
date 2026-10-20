// The nested graph shape (a map whose body runs a child workflow) as a demo of the reference entry: `node examples/fixtures/graph-nested/run.ts
// --kill --record <dir>` runs it on scripted tools with no key, kills the process once two lookups are kept, and resumes the run in a
// fresh process. The recording's durable lines (the store's commits) are what a graph panel reads: the driver's frame and the map items'
// records at each commit. packages/dsl/test/fixtures/graph/record.mjs cuts the fixture from such a recording.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { demo } from '@parcha/agentrun-harness';
import type { Fakes } from '@parcha/agentrun-harness';
import { SHAPES } from '../../../packages/dsl/test/fixtures/graph/generate.mjs';

const spec = JSON.parse(readFileSync(fileURLToPath(new URL('./demo.json', import.meta.url)), 'utf8'));
const shape = SHAPES.nested;
const fakes: Fakes = {
  model: () => { throw new Error('this job asks no model'); },
  tools: { lookup: (args) => ({ id: String(args.id), score: Number(String(args.id).replace(/\D/g, '')) || 1 }) },
  judge: async () => { throw new Error('this job asks no judge'); },
  pages: {},
  start: '',
};
export const options = { self: import.meta.url, spec, job: { workflow: shape.workflow, input: shape.input }, fakes, layout: 'v4' as const };
await demo(options);
