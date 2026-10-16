// The job of the disk demo, as data (the template's contract for agent.run() and the playground): a workflow that validates against the DSL's schema, its default
// input, and no files. It names no model, reads no environment and has no side effect. The scripted lead, the `charge` tool's fake and the judge are in fakes.ts.
//
// An agent settles ten invoices of one batch through a paid tool, `charge`, one call each, then writes the settlement note. Each charge is a `call` node: it costs real
// money outside the run, so the run keeps the tool's answer before it commits it, and a run that is resumed after the box it lived in was lost takes that answer
// instead of paying again.
import type { Workflow } from '@parcha/agentrun-dsl';

/** One invoice of the default batch: ten, a few dollars each. */
const INVOICES = Array.from({ length: 10 }, (_, index) => ({ invoice: `INV-${String(index + 1).padStart(3, '0')}`, cents: 1250 + 175 * index }));

export const workflow = {
  v: 2,
  name: 'disk-settle-invoices',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['batch', 'invoices'],
      properties: {
        batch: { type: 'string', minLength: 1, description: 'The name of the batch, for the settlement note.' },
        invoices: {
          type: 'array', minItems: 1, description: 'The invoices to charge, each once.',
          items: {
            type: 'object', additionalProperties: false, required: ['invoice', 'cents'],
            properties: { invoice: { type: 'string', description: 'The invoice number: the charge\'s idempotency key.' }, cents: { type: 'integer', minimum: 1, description: 'The amount to charge, in cents.' } },
          },
        },
      },
    },
    Charge: {
      type: 'object', required: ['invoice', 'receipt', 'cents'],
      properties: { invoice: { type: 'string' }, receipt: { type: 'string', description: 'The paid tool\'s receipt for this charge.' }, cents: { type: 'integer' } },
    },
    Note: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: { type: 'string', description: 'One sentence for the finance team: how many invoices were settled and for how much.' } } },
    Result: {
      type: 'object', additionalProperties: false, required: ['batch', 'charged', 'cents', 'receipts', 'note'],
      properties: {
        batch: { type: 'string' }, charged: { type: 'integer' }, cents: { type: 'integer' },
        receipts: { type: 'array', items: { type: 'object' } }, note: { type: 'string' },
      },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    {
      // One at a time: the order of the charges is the order of the invoices, and a kill between two of them leaves one finished and the next not begun.
      node: 'map', label: 'charges', itemsPath: 'invoices', as: 'charges', resultPath: 'charge', maxConcurrency: 1,
      body: { node: 'call', label: 'charge', via: 'tool', tool: 'charge', args: { invoice: '{item.invoice}', cents: '{item.cents}' }, out: 'Charge', as: 'charge', deadline_s: 30 },
    },
    {
      node: 'agent', label: 'note', out: 'Note', as: 'note', state: { batch: '{batch}', charged: '{charges}' },
      instructions: 'Every invoice in charged has been paid once. Write the settlement note for the batch.',
    },
    {
      node: 'code', label: 'finish',
      code: '(s) => ({ result: { batch: s.batch, charged: s.charges.length, cents: s.charges.reduce((sum, c) => sum + c.cents, 0), receipts: s.charges, note: s.note.note } })',
    },
  ] },
} as const satisfies Workflow;

export const job = { workflow, input: { batch: 'october-vendors', invoices: INVOICES }, files: {} } as const;

export default job;
