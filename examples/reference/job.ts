// The job: find a company, read its registry page in the browser and its filing scan from the workspace, submit a
// cited record, judge it, and build the output. Every answer is scripted, so the output is the same on every run.
import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Workflow } from '@parcha/agentrun-dsl';
import { fixturePage } from '@parcha/pi-browser/testing';
import { pngBytes } from '@parcha/pi-vision/testing';
import type { Job } from './assemble.ts';
import type { Fakes } from './host.ts';

const REGISTRY = 'http://registry.example/companies/01234567';
const NEWS = 'http://news.example/acme-opens-a-second-plant';
const FILING = 'filing.png';

export const workflow = {
  v: 2,
  name: 'reference-company-check',
  schemas: {
    Input: { type: 'object', additionalProperties: false, required: ['company'], properties: { company: { type: 'string', minLength: 1 } } },
    Found: { type: 'object', required: ['urls'], properties: { urls: { type: 'array', items: { type: 'string' } } } },
    Record: {
      type: 'object', additionalProperties: false, required: ['answer', 'citations'],
      properties: { answer: { type: 'string' }, citations: { type: 'array', minItems: 1, items: { type: 'string', description: 'An evidence path a tool returned.' } } },
    },
    Verdict: { type: 'object', additionalProperties: false, required: ['supported'], properties: { supported: { type: 'boolean', description: 'Do the cited receipts support the answer?' } } },
    Result: {
      type: 'object', additionalProperties: false, required: ['company', 'answer', 'citations', 'supported'],
      properties: { company: { type: 'string' }, answer: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } }, supported: { type: 'boolean' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'search', via: 'tool', tool: 'search', args: { query: '{company}' }, out: 'Found', as: 'found', deadline_s: 10 },
    {
      node: 'agent', label: 'investigate', state: { company: '{company}', urls: '{found.urls}' }, out: 'Record', as: 'record', requires: ['found.urls'],
      instructions: `Read the company's registry page in the browser and its filing scan, ${FILING}, in the workspace. Answer when it was incorporated, citing both.`,
    },
    { node: 'judge', label: 'verdict', state: { answer: '{record.answer}', citations: '{record.citations}' }, out: 'Verdict', as: 'verdict' },
    { node: 'code', label: 'finish', code: 's => ({ result: { company: s.company, answer: s.record.answer, citations: s.record.citations, supported: s.verdict.supported } })' },
  ] },
} as const satisfies Workflow;

export const job: Job = { workflow, input: { company: 'Acme Ltd' }, files: { [FILING]: pngBytes(64, 32, [200, 30, 30]) } };

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));

const receipts = (message: Message | undefined) => (message ? textOf(message).match(/evidence\/[\w./-]+\.json/g) ?? [] : []);

// pi-durable gap: a cut call's `interrupted` diagnostic stays on pi's own entry and reaches the model only as this text.
const cut = (result: ToolResultMessage) => result.isError && textOf(result).includes('was interrupted and may have partially run');
/** The browser's typed failure in a result: its JSON answer's `code`. */
const failure = (result: ToolResultMessage): unknown => { try { return (JSON.parse(textOf(result)) as { code?: unknown }).code; } catch { return undefined; } };
/** The browser's answer to an action it will not send again until the page has been looked at: the one before may have
 *  applied. */
const unknown = (result: ToolResultMessage) => result.isError && failure(result) === 'effect_unknown';

/** The browser's account of a cut action, as `details.pendingEffect` of its notice and of its `effect_unknown` answer:
 *  the page when the action was sent and now, and what it sent when an observer watched (null without one). pi-browser
 *  gap: it does not carry these details yet, so until it does every cut action is `cannot tell`. */
export type PendingEffect = { callId: string; urlAtDispatch: string | null; urlNow: string | null; observed: boolean; sent: unknown[] | null };
/** Whether a cut page action applied: on the target now and elsewhere when it was sent, applied; still where it was and
 *  not the target, not applied; anything else (the page already on the target, a place unknown), cannot tell. */
export function landed(effect: PendingEffect | undefined, target: string): 'applied' | 'not applied' | 'cannot tell' {
  if (!effect?.urlAtDispatch || !effect.urlNow || effect.urlAtDispatch === target) return 'cannot tell';
  return effect.urlNow === target ? 'applied' : effect.urlNow === effect.urlAtDispatch ? 'not applied' : 'cannot tell';
}
const pendingOf = (result: ToolResultMessage | undefined) => (result?.details as { pendingEffect?: PendingEffect } | undefined)?.pendingEffect;

/** The lead opens the first search result, reads it, reads the scan, then submits `answer` citing the receipts `cite`
 *  keeps of those the page read and the scan read returned (default: all of them). It acts as a model would:
 *  - a read that errs is asked again, three attempts in all;
 *  - a page action a crash cut, or one the browser will not send again (`effect_unknown`), is never asked again
 *    before the lead looks: it takes a snapshot, as the browser asks, and decides from the browser's details
 *    (`landed`): applied, it goes on; not applied, it runs it again, three runs in all; cannot tell, it asks no more.
 *    The browser refuses the first run after a cut even when the lead looked before it, so a refused run is looked
 *    at again the same way: only a look after the refusal lets the run through, and the refused run applied nothing.
 *  A page it did not open is not read: the record cites only what ran and says why. */
export function lead(answer = 'Acme Ltd was incorporated on 2019-03-04.', cite = (page: string[], scan: string[]) => [...page, ...scan]) {
  return (messages: readonly Message[]) => {
    const first = textOf(messages.find((message) => message.role === 'user')!).match(/https?:\/\/[^"\s\\]+/)?.[0] ?? '';
    const reads = [call('browser_read', { what: 'markdown' }), call('read', { path: FILING })];
    let page: 'opened' | 'unknown' | 'failed' | undefined;
    let runs = 0;
    // A cut or refused page action, until the look after it decides.
    let looking: ToolResultMessage | undefined;
    const kept: (ToolResultMessage | undefined)[] = [];
    let tries = 0;
    for (const result of messages.filter((message): message is ToolResultMessage => message.role === 'toolResult')) {
      if (page === undefined) {
        if (result.toolName === 'snapshot') {
          const seen = landed(pendingOf(result) ?? pendingOf(looking), first);
          looking = undefined;
          if (seen === 'applied') page = 'opened';
          else if (seen === 'cannot tell' || runs >= 3) page = 'unknown';
        } else {
          runs += 1;
          if (!result.isError) page = 'opened';
          else if (cut(result) || unknown(result)) looking = result;
          else page = 'failed';
        }
        // A page it did not open is not read.
        if (page !== undefined && page !== 'opened') kept.push(undefined);
        continue;
      }
      tries += 1;
      if (result.isError && tries < 3) continue;
      kept.push(result.isError ? undefined : result);
      tries = 0;
    }
    if (page === undefined) return looking !== undefined ? call('snapshot', {}) : call('run', { code: `await page.goto(${JSON.stringify(first)})` });
    if (kept.length < reads.length) return reads[kept.length]!;
    const why = page === 'unknown' ? 'Whether the registry page was opened is not known' : 'The registry page could not be opened';
    return call('submit', {
      answer: page === 'opened' ? answer : `${why}, so the filing scan is cited alone.`,
      citations: [...new Set(cite(page === 'opened' ? receipts(kept[0]) : [], receipts(kept[1])))],
    });
  };
}

export const fakes: Fakes = {
  model: lead(),
  tools: { search: () => ({ urls: [REGISTRY, NEWS] }) },
  // Scripted: it calls no model, so it costs 0 and used nothing (not unknown).
  judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.92 }])), usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 }),
  pages: {
    [REGISTRY]: fixturePage(REGISTRY, 'Acme Ltd. Company number 01234567. Incorporated on 2019-03-04. Status: active.', 'Acme Ltd - Company register'),
    [NEWS]: fixturePage(NEWS, 'Acme opens a second plant.', 'Acme opens a second plant'),
  },
  // The fake browser has no navigation: it opens on the first search result, and `run` returns the code it was given.
  start: REGISTRY,
};
