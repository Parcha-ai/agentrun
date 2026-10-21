// The job of the disk demo, as data (the template's contract for agent.run() and the playground): a workflow that validates against the DSL's schema, its default input, and the files it works on. It names no model,
// reads no environment and has no side effect.
//
// An agent reviews ten invoices against the payment policy, one invoice at a time, in its own workspace on the disk. It reads the policy and the invoice with `read_lines` and decides: approve or hold, with the
// lines it relied on. The workflow, not the agent, makes the payment: an approved invoice goes to the paid tool `charge`, a `call` node, one at a time. It costs real money outside the run, so the run keeps the tool's
// answer before it commits it, and a run resumed on another host takes that answer instead of paying again. A last agent writes the report, a page that cites each decision's lines through the read calls that made
// them. The simulated tool moves no money.
import type { Workflow } from '@parcha/agentrun-dsl';
import { INVOICE_FILES, NUMBERS, pathOf, POLICY } from './files.ts';

const text = (value: string) => new TextEncoder().encode(value);

export const REVIEW = 'Review one invoice against the payment policy. The invoice is the file in `path` and the policy is `policy.md`, both in your workspace. Read each with read_lines, once per file; it returns the lines and a receipt. Decide from what the files say and nothing else: approve an invoice the policy lets us pay, hold any other. Submit invoice (its number), decision (approve or hold), cents (the invoice amount in cents), reason (one sentence that names the rule), and cites: one entry for each fact you relied on, with path, from, to (the lines it was on, numbered from 0, to not included, as read_lines states them) and receipt (the receipt read_lines showed for that read). Cite the line that holds the evidence.';
export const REPORT = 'Write the review report for the finance team as `report/index.html` with the write tool: one page, inline CSS, no script and no address outside the page. A heading, then one row for each invoice in entries: its number, the decision, the reason, where it was paid (an approved invoice\'s receipt names its host and driver: write them exactly as `HOST (DRIVER)`, for example `host-1 (daytona)`; a held invoice was not paid), and for each cite a link written exactly `<a href="PATH#line=FROM,TO" data-receipt="RECEIPT">line N</a>` (PATH, FROM, TO and RECEIPT from the cite; N is FROM + 1). The policy and the invoices are already copied beside the page, under `report/`, so the PATH of a cite links as it is. Say only what the entries say. Then submit answer (two sentences that point to the report: how many invoices were paid and which were held and why, each fact cited the same way) and report (`report/index.html`).';

export const workflow = {
  v: 2,
  name: 'disk-invoice-review',
  schemas: {
    Input: {
      type: 'object', additionalProperties: false, required: ['batch', 'invoices'],
      properties: {
        batch: { type: 'string', minLength: 1, description: 'The name of the batch.' },
        invoices: { type: 'array', minItems: 1, description: 'The invoice files to review, one at a time.', items: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', pattern: '^invoices/[\\w.-]+$' } } } },
      },
    },
    Cite: {
      type: 'object', additionalProperties: false, required: ['path', 'from', 'to', 'receipt'],
      properties: { path: { type: 'string' }, from: { type: 'integer', minimum: 0 }, to: { type: 'integer', minimum: 1 }, receipt: { type: 'string', description: 'The receipt read_lines showed for the read.' } },
    },
    Review: {
      type: 'object', additionalProperties: false, required: ['invoice', 'decision', 'cents', 'reason', 'cites'],
      properties: {
        invoice: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'hold'] }, cents: { type: 'integer', minimum: 0 },
        reason: { type: 'string', minLength: 1 }, cites: { type: 'array', minItems: 1, items: { $ref: '#/definitions/Cite' } },
      },
    },
    Charge: {
      type: 'object', required: ['invoice', 'receipt', 'cents'],
      properties: { invoice: { type: 'string' }, receipt: { type: 'string', description: 'The paid tool\'s receipt for this charge.' }, cents: { type: 'integer' } },
    },
    Answer: { type: 'object', additionalProperties: false, required: ['answer', 'report'], properties: { answer: { type: 'string', minLength: 1 }, report: { type: 'string', pattern: '^report/[\\w./-]+\\.html$' } } },
    Result: {
      type: 'object', additionalProperties: false, required: ['batch', 'entries', 'answer', 'report'],
      properties: { batch: { type: 'string' }, entries: { type: 'array', items: { type: 'object' } }, answer: { type: 'string' }, report: { type: 'string' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    {
      // One at a time: the invoices are reviewed and paid in the order of the batch, and a handoff between two of them leaves one finished and the next not begun.
      node: 'map', label: 'invoices', itemsPath: 'invoices', as: 'entries', resultPath: 'entry', maxConcurrency: 1,
      body: { node: 'chain', steps: [
        { node: 'agent', label: 'review', state: { path: '{item.path}' }, out: 'Review', as: 'review', tools: ['read_lines'], thinking: 'high', instructions: REVIEW },
        {
          node: 'route', label: 'settle', valuePath: 'review.decision', as: 'settle', branches: {
            approve: { body: { node: 'call', label: 'charge', via: 'tool', tool: 'charge', args: { invoice: '{review.invoice}', cents: '{review.cents}' }, out: 'Charge', as: 'charge', deadline_s: 30 } },
            hold: { body: { node: 'code', label: 'held', code: '() => ({})' } },
          },
        },
        { node: 'code', label: 'entry', code: '(s) => ({ entry: { review: s.review, receipt: s.charge ?? null } })' },
      ] },
    },
    { node: 'agent', label: 'report', state: { batch: '{batch}', entries: '{entries}' }, out: 'Answer', as: 'answer', tools: ['write'], thinking: 'high', instructions: REPORT },
    { node: 'code', label: 'finish', code: '(s) => ({ result: { batch: s.batch, entries: s.entries, answer: s.answer.answer, report: s.answer.report } })' },
  ] },
} as const satisfies Workflow;

/** The job: the batch, the ten invoices by path, and the files in the agent's workspace (each also under `report/`). */
export const job = {
  workflow,
  input: { batch: 'october-vendors', invoices: NUMBERS.map((number) => ({ path: pathOf(number) })) },
  // The files the review reads, and the same files beside the report's page (`report/`), so each cite links to a file the report carries: a reader opens the line a decision rests on in the page's own
  // folder, and the recording takes it with the page.
  files: Object.fromEntries([['policy.md', POLICY] as const, ...NUMBERS.map((number) => [pathOf(number), INVOICE_FILES[number]!] as const)].flatMap(([path, body]) => [[path, text(body)], [`report/${path}`, text(body)]])),
} as const;

export default job;
