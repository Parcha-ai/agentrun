// The job contract: a job module exports `workflow` (as const satisfies Workflow), `job` (satisfies Job) and the job as its default.
import { defineJob, type Job, type Workflow } from '../dist/index.js';

export const workflow = {
  v: 2, name: 'audit', schemas: { Out: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } },
  output: { schemaId: 'Out', path: 'final' },
  root: { node: 'chain', steps: [{ node: 'code', label: 'finish', code: '() => ({ final: { ok: true } })' }] },
} as const satisfies Workflow;
const input = { project: 'example/project', dependencies: ['left-pad'] };
const files = { 'notes.txt': new Uint8Array([1, 2, 3]) };

export const job = { workflow, input, files } satisfies Job;
export default job;

// The literal workflow type flows through: the job's workflow still names its literal values.
const name: 'audit' = job.workflow.name;
const label: 'finish' = job.workflow.root.steps[0].label;
void name; void label;

// Job's exact shape: files is optional, and a job is a Job.
const withoutFiles: Job = { workflow, input };
const everything: Job = { workflow, input: {}, files: {} };
void withoutFiles; void everything;

// defineJob is an identity that keeps the workflow's literal type.
const defined = defineJob({ workflow, input, files });
const definedName: 'audit' = defined.workflow.name;
const asJob: Job = defined;
void definedName; void asJob;
export const bare = defineJob({ workflow, input });
const bareLabel: 'finish' = bare.workflow.root.steps[0].label;
void bareLabel;

// @ts-expect-error a job needs its input.
const missingInput: Job = { workflow };
// @ts-expect-error a job needs its workflow.
const missingWorkflow: Job = { input };
// @ts-expect-error files are bytes, not strings.
const textFiles: Job = { workflow, input, files: { 'notes.txt': 'text' } };
// @ts-expect-error input is an object, not a string.
const stringInput: Job = { workflow, input: 'text' };
// @ts-expect-error defineJob checks the same shape: no input.
defineJob({ workflow });
// @ts-expect-error and a workflow that is not one.
defineJob({ workflow: { v: 2 }, input: {} });
void missingInput; void missingWorkflow; void textFiles; void stringInput;
