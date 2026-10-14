// The film's first slice, no key and no spend: one agent conversation on this machine whose browser is a Chrome inside a
// throwaway Docker box. The scripted lead opens a NASA page in that Chrome through pi-browser, reads it, and cites the read; the
// recorder writes the run as `agentrun.recording/1`, with the browser's frames (the tile) and the box's life as live lines.
//
//   node examples/apollo-film/dry-run.ts --record <dir> [--dir <run directory>]
//
// Needs Docker and the network (the page is nasa.gov's). Placement is "by config": no Jev picks anything here, and a recording
// made by this file is a dry run, never published.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Workflow } from '@parcha/agentrun-dsl';
import { codeOf, finishRecording, localHost, openRecorder, openSupervisor, packageCommitRecorder, placeAt, run, type BrowserPlane, type Fakes, type Job } from '../reference/index.ts';
import { fold } from '../../scripts/recording/fold.mjs';
import { startChromeBox, CHROME_IMAGE } from './chrome-box.ts';
import { startTile } from './tile.ts';

type Source = { id: string; title: string; kind: string; credit: string; page: string };
export const sources = JSON.parse(readFileSync(join(import.meta.dirname, 'sources.json'), 'utf8')) as { items: Source[] };

const workflow = {
  v: 2,
  name: 'apollo-film-dry-run',
  schemas: {
    Input: { type: 'object', additionalProperties: false, required: ['topic'], properties: { topic: { type: 'string', minLength: 1 } } },
    Found: { type: 'object', required: ['pages'], properties: { pages: { type: 'array', items: { type: 'string' } } } },
    Record: {
      type: 'object', additionalProperties: false, required: ['answer', 'citations'],
      properties: { answer: { type: 'string' }, citations: { type: 'array', minItems: 1, items: { type: 'string', description: 'An evidence path a tool returned.' } } },
    },
    Verdict: { type: 'object', additionalProperties: false, required: ['supported'], properties: { supported: { type: 'boolean', description: 'Do the cited receipts support the answer?' } } },
    Result: {
      type: 'object', additionalProperties: false, required: ['topic', 'answer', 'citations', 'credits', 'supported'],
      properties: { topic: { type: 'string' }, answer: { type: 'string' }, citations: { type: 'array', items: { type: 'string' } }, credits: { type: 'array', items: { type: 'string' } }, supported: { type: 'boolean' } },
    },
  },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Result', path: 'result' },
  root: { node: 'chain', steps: [
    { node: 'call', label: 'sources', via: 'tool', tool: 'sources', args: { topic: '{topic}' }, out: 'Found', as: 'found', deadline_s: 10 },
    {
      node: 'agent', label: 'browse', state: { topic: '{topic}', pages: '{found.pages}' }, out: 'Record', as: 'record', requires: ['found.pages'],
      instructions: 'Open the first page in the browser, read it, and say in one sentence what NASA says it is, citing the receipt of your read.',
    },
    { node: 'judge', label: 'verdict', state: { answer: '{record.answer}', citations: '{record.citations}' }, out: 'Verdict', as: 'verdict' },
    { node: 'code', label: 'finish', code: 's => ({ result: { topic: s.topic, answer: s.record.answer, citations: s.record.citations, credits: s.found.pages, supported: s.verdict.supported } })' },
  ] },
} as const satisfies Workflow;

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));

/** The lead: open the first page, read it, cite the read's receipt. A step that errs is asked again, three tries in all. */
export function lead(messages: readonly Message[]) {
  const first = textOf(messages.find((message) => message.role === 'user')!).match(/https?:\/\/[^"\s\\]+/)?.[0] ?? '';
  const results = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
  const ran = results.filter((result) => result.toolName === 'run');
  const read = results.filter((result) => result.toolName === 'browser_read');
  if (!ran.some((result) => !result.isError)) return ran.length >= 3 ? call('submit', { answer: 'The page could not be opened.', citations: ['none'] }) : call('run', { code: `await page.goto(${JSON.stringify(first)})` });
  const good = read.find((result) => !result.isError);
  if (!good) return read.length >= 3 ? call('submit', { answer: 'The page was opened but not read.', citations: ['none'] }) : call('browser_read', { what: 'markdown' });
  const receipt = textOf(good).match(/evidence\/[\w./-]+\.json/g) ?? [];
  const title = textOf(good).match(/^#\s*(.+)$/m)?.[1] ?? 'the page';
  return call('submit', { answer: `NASA's page "${title.slice(0, 120)}" was read in a Chrome inside a Docker box.`, citations: [...new Set(receipt)].slice(0, 3) });
}

const fakes: Fakes = {
  model: lead,
  tools: { sources: () => ({ pages: sources.items.map((item) => item.page) }) },
  judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.92 }])), usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 }),
  pages: {},
  start: 'about:blank',
};

const job: Job = { workflow, input: { topic: 'Apollo 11' } };

if (import.meta.main) {
  const { values } = parseArgs({ options: { record: { type: 'string' }, dir: { type: 'string' } } });
  if (values.record === undefined) throw new Error('usage: dry-run.ts --record <dir> [--dir <run directory>]');
  const [{ cdpProvider }, { stagehandDriver }] = await Promise.all([import('@parcha/pi-browser/providers/cdp'), import('@parcha/pi-browser/driver/stagehand')]);
  const place = await placeAt(values.dir);
  const chrome = await startChromeBox({ labels: { run: place.id } });
  const recorder = openRecorder({ dir: values.record, commits: await packageCommitRecorder(), supervisor: openSupervisor({ dir: values.record }) });
  recorder.live('transport', 'box.created', { box: chrome.boxId, provider: 'docker', image: CHROME_IMAGE, role: 'browser', facts: chrome.box.facts() });
  const tile = startTile(chrome.endpoint, recorder);
  const provider = cdpProvider({ endpoint: chrome.endpoint, extensionId: chrome.extensionId });
  const browser: BrowserPlane = { provider: () => provider, driver: stagehandDriver() };
  const local = localHost(place, fakes, { browser, recorder });
  let chromeLog = '';
  const result = await run(place, local.host, job).finally(async () => {
    await tile.stop();
    chromeLog = await chrome.log();
    recorder.live('transport', 'box.ended', { box: chrome.boxId, frames: tile.frames() });
    await chrome.destroy();
    await recorder.detach();
  });
  const resultBlob = result.status === 'complete' ? recorder.blob(JSON.stringify(result.output, null, 2), 'json') : undefined;
  finishRecording(values.record, {
    title: 'Apollo 11 film, dry run: a Chrome in a Docker box reads NASA (placement by config, not published)', task: workflow.name, model: `${local.host.models.lead.provider}/${local.host.models.lead.modelId}`,
    generations: result.generation, kills: 0, code: codeOf(join(import.meta.dirname, '..', '..')),
    cost: (lines) => fold(lines).cost,
    source: { run: place.id, store: join(place.store, 'run.sqlite') },
    ...(resultBlob === undefined ? {} : { result: { blob: resultBlob, title: 'The record' } }),
  });
  console.log(`dry run: ${result.status}, ${tile.frames()} frames, recording at ${values.record}, run at ${place.root}`);
  if (process.env.FILM_DEBUG === '1') console.log(`--- chrome log\n${chromeLog}`);
  if (result.status === 'refused') console.log(`  ${result.code}: ${result.message}`);
  if (result.status === 'stopped') console.log(`  stopped: ${JSON.stringify(result.stop)}`);
  if (result.status === 'escalated') console.log(`  escalated: ${JSON.stringify(result.escalation)}`);
  if (result.status !== 'complete') process.exitCode = 1;
}
