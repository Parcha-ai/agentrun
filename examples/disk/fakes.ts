// The disk demo on fakes: a scripted lead that does the two jobs the workflow gives its agent (review one invoice; write the report), the paid tool's fake and the judge. The lead reads through the same `read_lines`
// tool and cites the receipts the tool shows, as the live model does; it is the test fixture, not what a gallery shows. Nothing here is the job: job.ts is data.
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Fakes } from '@parcha/agentrun-harness';
import { DiskReview } from './tools.ts';

const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

type Cite = { path: string; from: number; to: number; receipt: string };
type Entry = { review: { invoice: string; decision: string; cents: number; reason: string; cites: Cite[] }; receipt: { receipt: string } | null };

/** The reads a node has made so far, from the tool results it holds: the lines each returned and the receipt each stated. */
function reads(messages: readonly Message[]) {
  return messages.filter((message) => message.role === 'toolResult').map((message) => {
    const parts = typeof message.content === 'string' ? [message.content] : message.content.map((block) => (block.type === 'text' ? block.text : ''));
    return { lines: parts[0] ?? '', receipt: /receipt (\S+):/.exec(parts[1] ?? '')?.[1] ?? '' };
  });
}

/** One invoice, decided by the policy the way the policy reads (rule 1: a PO written PO- and four digits; rule 2: $50.00 or less). */
function review(messages: readonly Message[], path: string) {
  const done = reads(messages);
  if (done.length === 0) return call('read_lines', { path: 'policy.md' });
  if (done.length === 1) return call('read_lines', { path });
  const [policy, invoice] = done as [typeof done[number], typeof done[number]];
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(invoice.lines)?.[1] ?? '';
  const cents = Math.round(Number(field('Amount').replace('$', '')) * 100);
  const noPo = !/^PO-\d{4}$/.test(field('PO'));
  const over = cents > 5000;
  const hold = noPo || over;
  const cites: Cite[] = [
    { path, from: noPo ? 2 : 4, to: noPo ? 3 : 5, receipt: invoice.receipt },
    { path: 'policy.md', from: noPo ? 2 : 3, to: noPo ? 3 : 4, receipt: policy.receipt },
  ];
  if (!hold) cites.push({ path, from: 4, to: 5, receipt: invoice.receipt });
  const reason = noPo ? 'It names no purchase order, which rule 1 requires.' : over ? 'Its amount is over $50.00, which rule 2 forbids.' : 'It names a purchase order and its amount is within $50.00, so rules 1 and 2 pass.';
  return call('submit', { invoice: field('Invoice'), decision: hold ? 'hold' : 'approve', cents, reason, cites });
}

const link = (cite: Cite) => `<a href="${cite.path}#line=${cite.from},${cite.to}" data-receipt="${cite.receipt}">line ${cite.from + 1}</a>`;

/** The report: a row for each entry, each cite linked through the receipt of the read, written with the write tool, then submitted. */
function report(messages: readonly Message[]) {
  const first = messages.find((message) => message.role === 'user');
  const text = first ? textOf(first) : '';
  // The node's state is the first line of its message; anything the host adds comes after it.
  const entries = (JSON.parse(text.split('\n').find((line) => line.startsWith('{')) ?? '{}') as { entries: Entry[] }).entries;
  if (!messages.some((message) => message.role === 'toolResult')) {
    const rows = entries.map(({ review: r }) => `<tr><td>${r.invoice}</td><td>${r.decision === 'approve' ? 'paid' : 'held'}</td><td>${r.reason} ${r.cites.map(link).join(' ')}</td></tr>`).join('\n');
    const html = `<!doctype html><meta charset="utf-8"><title>Invoice review</title><style>body{font:16px system-ui;margin:2rem}td{padding:.25rem .75rem}</style><h1>Invoice review</h1><table>\n${rows}\n</table>\n`;
    return call('write', { path: 'report/index.html', content: html });
  }
  const paid = entries.filter((entry) => entry.review.decision === 'approve');
  const held = entries.filter((entry) => entry.review.decision === 'hold');
  const first1 = held[0]!.review.cites[0]!;
  return call('submit', { answer: `${paid.length} invoices were paid, once each; ${held.length} were held: ${held.map((entry) => entry.review.invoice).join(' and ')} (see the report; for example ${link(first1)}).`, report: 'report/index.html' });
}

function lead(messages: readonly Message[]) {
  const first = messages.find((message) => message.role === 'user');
  const text = first ? textOf(first) : '';
  // The report node's state holds the entries (whose cites carry paths too); a review's holds the invoice's path alone.
  if (text.includes('"entries"')) return report(messages);
  return review(messages, /"path":\s*"(invoices\/[\w.-]+)"/.exec(text)?.[1] ?? 'invoices/INV-001.txt');
}

export const fakes: Fakes = {
  model: lead,
  lead: { input: ['text'] },
  extensions: [DiskReview],
  // The paid tool (simulated: no money moves): a receipt that names the invoice, so a charge made twice would show as the same receipt twice. The host's ledger counts each call it receives.
  tools: { charge: (args) => ({ invoice: String(args.invoice), receipt: `rcpt-${String(args.invoice)}`, cents: Number(args.cents) }) },
  // Scripted: it calls no model, so it costs 0 and used nothing (not unknown).
  judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.92 }])), usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 }),
  pages: {},
  start: 'about:blank',
};
