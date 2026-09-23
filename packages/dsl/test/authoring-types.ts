import { z } from 'zod';
import {
  defineWorkflow, runTypedWorkflow, type Workflow, type WorkflowInput, type WorkflowOutput,
  type StandardJSONSchema,
} from '../dist/index.js';

const Request = z.strictObject({ subject: z.string(), limit: z.number().int().optional() });
const Brief = z.strictObject({ summary: z.string(), sources: z.array(z.string()) });
Request satisfies StandardJSONSchema;
const definition = {
  name: 'research', schemas: { Request, Brief }, input: 'Request',
  output: { schema: 'Brief', path: 'brief' },
  steps: [{ node: 'agent', label: 'research', instructions: 'Research the subject.', out: 'Brief', as: 'brief' }],
} as const;
const workflow = defineWorkflow({ ...definition, steps: [...definition.steps] });
const document: Workflow = workflow;
void document;
const input: WorkflowInput<typeof workflow> = { subject: 'battery recycling' };
const output: WorkflowOutput<typeof workflow> = { summary: 'Findings', sources: ['source'] };
void input; void output;
// @ts-expect-error subject is required by the schema.
const missingInput: WorkflowInput<typeof workflow> = {};
// @ts-expect-error actual output is inferred, not unknown or a caller-supplied generic.
const wrongOutput: WorkflowOutput<typeof workflow> = { summary: 4, sources: [] };
void missingInput; void wrongOutput;

async function consumer() {
  const result = await runTypedWorkflow(workflow, { subject: 'battery recycling' }, {});
  if (result.status === 'complete') {
    const summary: string = result.output.summary;
    const source: string | undefined = result.output.sources[0];
    // @ts-expect-error inferred output has no invented field.
    result.output.invented;
    // @ts-expect-error summary is a string, not a number.
    const number: number = result.output.summary;
    void summary; void source; void number;
  } else {
    // @ts-expect-error escalation has no completed output.
    result.output;
    result.escalation.kind;
  }
  // @ts-expect-error input cannot widen the workflow's inferred type.
  await runTypedWorkflow(workflow, { subject: 123 }, {});
  // @ts-expect-error missing required property.
  await runTypedWorkflow(workflow, {}, {});
  // @ts-expect-error schema identifiers are checked against the supplied registry.
  defineWorkflow({ ...definition, steps: [...definition.steps], output: { schema: 'Missing' } });
  // @ts-expect-error input schema must exist too.
  defineWorkflow({ ...definition, steps: [...definition.steps], input: 'Missing' });
}
void consumer;

const raw = defineWorkflow({
  name: 'raw', schemas: { State: { type: 'object' } }, input: 'State',
  output: { schema: 'State' }, steps: [{ node: 'code', label: 'keep', code: '() => ({})' }],
});
async function rawConsumer() {
  const result = await runTypedWorkflow(raw, {}, {});
  if (result.status === 'complete') {
    // @ts-expect-error raw JSON Schema does not magically acquire static value types.
    result.output.summary;
  }
}
void rawConsumer;
// @ts-expect-error an untyped Workflow cannot claim inferred schema types.
runTypedWorkflow(document, {}, {});
