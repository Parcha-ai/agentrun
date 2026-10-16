// The disk demo on fakes: the lead (a scripted turn that writes the settlement note), the paid tool's fake and the judge. Nothing here is the job: job.ts is data.
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Fakes } from '../reference/index.ts';

const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));

/** The lead's one turn: read how many invoices were charged from the node's state, and submit the note. */
function lead(messages: readonly Message[]) {
  const first = messages.find((message) => message.role === 'user');
  const charged = first ? [...textOf(first).matchAll(/"receipt"\s*:\s*"/g)].length : 0;
  return fauxAssistantMessage([fauxToolCall('submit', { note: `${charged} invoices settled, each charged once.` })], { stopReason: 'toolUse' });
}

export const fakes: Fakes = {
  model: lead,
  lead: { input: ['text'] },
  // The paid tool: a receipt that names the invoice, so a charge made twice would show as the same receipt twice. The host's ledger counts each call it receives.
  tools: { charge: (args) => ({ invoice: String(args.invoice), receipt: `rcpt-${String(args.invoice)}`, cents: Number(args.cents) }) },
  // Scripted: it calls no model, so it costs 0 and used nothing (not unknown).
  judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.92 }])), usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 }),
  pages: {},
  start: 'about:blank',
};
