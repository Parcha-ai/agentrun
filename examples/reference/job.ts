// The job: find a company, read its registry page in the browser and its filing scan from the workspace, submit a
// cited record, judge it, and build the output. Every answer is scripted, so the output is the same on every run.
import type { Message, ToolCall } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Workflow } from '@parcha/agentrun-dsl';
import { fixturePage } from '@parcha/pi-browser/testing';
import { pngBytes } from '@parcha/pi-vision/testing';
import type { Job } from './assemble.ts';
import type { Fakes } from './host.ts';

const REGISTRY = 'https://registry.example/companies/01234567';
const NEWS = 'https://news.example/acme-opens-a-second-plant';
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

/** The lead reads the page the browser opened on, then the scan, then submits the receipts its tools returned. */
function model(messages: readonly Message[]) {
  const results = messages.filter((message) => message.role === 'toolResult');
  if (results.length === 0) return call('browser_read', { what: 'markdown' });
  if (results.length === 1) return call('read', { path: FILING });
  const cited = [...new Set(results.flatMap((result) => textOf(result).match(/evidence\/[\w./-]+\.json/g) ?? []))];
  return call('submit', { answer: 'Acme Ltd was incorporated on 2019-03-04.', citations: cited });
}

export const fakes: Fakes = {
  model,
  tools: { search: () => ({ urls: [REGISTRY, NEWS] }) },
  judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.92 }])) }),
  pages: {
    [REGISTRY]: fixturePage(REGISTRY, 'Acme Ltd. Company number 01234567. Incorporated on 2019-03-04. Status: active.', 'Acme Ltd - Company register'),
    [NEWS]: fixturePage(NEWS, 'Acme opens a second plant.', 'Acme opens a second plant'),
  },
  // The fake browser opens on the first search result: it has no navigation of its own.
  start: REGISTRY,
};
