// The job: one agent checks a document against a checklist of marks, by writing code (the `code` tool: bash and
// `vision.judge`) that follows pi-vision's verify skill: every page rendered through its crop box, Jev asked each page's
// kind and each mark's yes or no and box, the two file numbers cut out and compared. A tool then resolves each row's
// receipts to the looks that back them and builds the cited result. It is data: no host code, no model named. Another
// kind of document is another checklist file in `checklist/` and another PDF.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workflow } from '@parcha/agentrun-dsl';
import type { Job } from '../reference/index.ts';
import sample from './sample/sample.json' with { type: 'json' };

/** pi-vision's verify skill, as the package ships it. */
const VERIFY = readFileSync(join(dirname(fileURLToPath(import.meta.resolve('@parcha/pi-vision'))), '..', 'skills', 'verify', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\n/, '');

export const CHECKLIST = 'delaware-certified-copy.json';

const TASK = `Check the PDF in \`document\` (a file in your workspace) against the checklist in \`checklist\` (a JSON file in your workspace), by writing code with the \`code\` tool, following the verify skill below. Run its step 1 and then its step 2 as two scripts, each with the task line set to this document and checklist; change nothing else in them. Then submit exactly what step 2 returned. Write nothing the answers do not say: this checks whether each mark is there and where, not whether the document is genuine.

The verify skill:
${VERIFY}`;

const Cite = {
  type: 'object', additionalProperties: false, required: ['fragment', 'receipts'],
  properties: { fragment: { type: 'string', minLength: 1 }, receipts: { type: 'array', items: { type: 'string' } } },
} as const;
const Row = {
  type: 'object', additionalProperties: false, required: ['id', 'mark', 'value', 'p', 'note', 'cites'],
  properties: {
    id: { type: 'string', minLength: 1 }, mark: { type: 'string', minLength: 1 }, value: { type: 'string', enum: ['yes', 'no'] },
    p: { type: 'number', minimum: 0, maximum: 1 }, note: { type: 'string' }, cites: { type: 'array', items: Cite },
  },
} as const;

export const workflow = {
  v: 2,
  name: 'document-check',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['document', 'checklist'],
      properties: {
        document: { type: 'string', pattern: '^[\\w.-]+\\.pdf$', description: 'The PDF to check, a file in the workspace.' },
        checklist: { type: 'string', pattern: '^[\\w.-]+\\.json$', description: 'The checklist of marks, a file in the workspace.' },
      },
    },
    Marks: {
      type: 'object', additionalProperties: false, required: ['document', 'every', 'rows', 'table'],
      properties: { document: { type: 'string', minLength: 1 }, every: { type: 'boolean' }, rows: { type: 'array', minItems: 1, items: Row }, table: { type: 'string' } },
    },
    Cited: {
      type: 'object', required: ['format', 'title', 'rows'],
      properties: { format: { type: 'string', const: 'agentrun.cited/1' }, title: { type: 'string' }, rows: { type: 'array' }, document_check: { type: 'object' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Cited', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'agent', label: 'marks', out: 'Marks', as: 'marks', tools: ['code'], thinking: 'low', state: { document: '{document}', checklist: '{checklist}' }, instructions: TASK },
    // A tool resolves every receipt to the look that backs it and builds the cited result.
    { node: 'call', label: 'cite', via: 'tool', tool: 'cite', args: { document: '{document}', checklist: '{checklist}', every: '{marks.every}', rows: '{marks.rows}' }, out: 'Cited', as: 'result', deadline_s: 60 },
  ] },
} as const satisfies Workflow;

const file = (...path: string[]) => new Uint8Array(readFileSync(join(import.meta.dirname, ...path)));

/** The default input: the filed pages, every mark there. `--input test-copy` (fixtures/test-copy.json) checks the altered copy. */
export const job = {
  workflow,
  input: { document: sample.files.filed, checklist: CHECKLIST },
  files: {
    [sample.files.filed]: file('sample', sample.files.filed),
    [sample.files.test_copy]: file('sample', sample.files.test_copy),
    [CHECKLIST]: file('checklist', CHECKLIST),
  },
} satisfies Job;
export default job;
