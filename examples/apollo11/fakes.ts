// The run with no key: a scripted lead and scripted eyes stand in for the models, and the files are the real ones. The eyes answer a
// page with NASA's typed transcript of it, a photo with its caption's class and a film window with a line that says no model looked;
// every answer says it is scripted, and so does the recording. Nothing here is a model's reading.
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Part } from '@parcha/pi-vision';
import { fakeEyes } from '@parcha/pi-vision/testing';
import type { Fakes } from '../reference/index.ts';
import { fileOf, type Dataset, type PhotoItem } from './dataset.ts';
import type { TypedLine } from './account.ts';
import { tools } from './tools/index.ts';
import { ASKS } from './workflow.ts';

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));

/** The first JSON object in a node's prompt that `is` the state it looks for. */
function stateOf(prompt: string, is: (value: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  for (let start = prompt.indexOf('{'); start >= 0; start = prompt.indexOf('{', start + 1)) {
    for (let end = prompt.lastIndexOf('}'); end > start; end = prompt.lastIndexOf('}', end - 1)) {
      try { const parsed = JSON.parse(prompt.slice(start, end + 1)) as Record<string, unknown>; if (parsed && typeof parsed === 'object' && is(parsed)) return parsed; } catch { /* not this slice */ }
    }
  }
  return undefined;
}

/** The host sink's receipt path in a read's result, and the eyes' words: what follows the head that names the receipt. */
function lookOf(result: ToolResultMessage | undefined): { receipt: string; answer: string } | undefined {
  if (!result || result.isError) return undefined;
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    const head = /look filed at (evidence\/[\w./-]+\.json):\)\n/.exec(block.text);
    if (head) return { receipt: head[1]!, answer: block.text.slice(head.index + head[0].length) };
  }
  return undefined;
}

/** The scripted lead: each item's node reads once with the state's arguments and the node's ask, and submits what the eyes said;
 *  the account takes the first line of each minute. A read that errs is asked again, three attempts in all. */
export function scriptedLead(classes: Record<string, string>): Fakes['model'] {
  return (messages: readonly Message[]): AssistantMessage => {
    const prompt = textOf(messages.find((message) => message.role === 'user')!);
    const landing = stateOf(prompt, (value) => Array.isArray(value.lines) && Array.isArray(value.windows)) as { lines: Array<{ mission_time: string; speaker: string; text: string; item: string; receipt: string }> } | undefined;
    if (landing) return accountOf(landing.lines);
    const state = stateOf(prompt, (value) => typeof value.path === 'string' && typeof value.item === 'string') as Record<string, string | number>;
    const kind = 'from_s' in state ? 'film' : 'page' in state ? 'page' : 'photo';
    const reads = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'read');
    const look = lookOf(reads.at(-1));
    if (!look && reads.length < 3) {
      const args = Object.fromEntries(['path', 'from_s', 'to_s', 'page'].filter((key) => state[key] !== undefined).map((key) => [key, state[key]!]));
      return call('read', { ...args, ask: kind === 'photo' ? ASKS.photo(classes) : ASKS[kind] });
    }
    const receipt = look?.receipt ?? 'none';
    if (kind === 'film') return call('submit', { item: state.item!, from_s: state.from_s!, to_s: state.to_s!, seen: look?.answer.trim() ?? 'not read', receipt });
    if (kind === 'page') return call('submit', { item: state.item!, page: state.page!, receipt });
    return call('submit', { item: state.item!, class: (look?.answer ?? '').split('\n')[0]!.trim(), receipt });
  };
}

/** The account a script writes: one entry a minute, the minute's first line, citing its page. */
function accountOf(lines: Array<{ mission_time: string; speaker: string; text: string; item: string; receipt: string }>): AssistantMessage {
  const minutes = new Map<string, (typeof lines)[number]>();
  for (const line of lines) if (!minutes.has(line.mission_time.slice(0, 6))) minutes.set(line.mission_time.slice(0, 6), line);
  const entries = [...minutes.values()].map((line) => ({ mission_time: line.mission_time, text: `(scripted) ${line.speaker}: ${line.text}`, cites: [{ item: line.item, receipt: line.receipt }] }));
  return call('submit', { entries: entries.length ? entries : [{ mission_time: '000:00:00', text: '(scripted) nothing was read in the span', cites: [{ item: 'none', receipt: 'none' }] }] });
}

/** The first mission time on each page, for the scripted eyes (`fakes-pages.json`). */
export type PageStarts = { item: string; page_starts: Record<string, string> };

/** The scripted eyes. A request names its source in each part's `fragment`, and a page by the line the package sends with its image
 *  (`... page N of M ...`); the eyes answer from what the data set and `pages` fix for it. A photo in `wrong` is answered with
 *  another class; a source in `fail` makes the request throw, as a provider's error does. */
export function scriptedEyes(dataset: Dataset, typed: readonly TypedLine[], pages: PageStarts, options: { wrong?: ReadonlySet<string>; fail?: ReadonlySet<string> } = {}) {
  const starts = Object.entries(pages.page_starts).map(([page, time]) => [Number(page), time] as const).sort((a, b) => a[0] - b[0]);
  const photos = new Map(dataset.items.filter((item): item is PhotoItem => item.kind === 'photo').map((item) => [fileOf(item), item]));
  const classes = Object.keys(dataset.classes);
  const answer = (parts: readonly Part[]): string => {
    const source = parts.find((part) => part.fragment)?.fragment ?? '';
    const page = parts.flatMap((part) => (part.type === 'text' ? [/\bpage (\d+) of \d+/.exec(part.text)?.[1]] : [])).find(Boolean);
    if (page) {
      const at = starts.findIndex(([number]) => number === Number(page));
      const [from, to] = at < 0 ? [undefined, undefined] : [starts[at]![1], starts[at + 1]?.[1]];
      const own = from ? typed.filter((line) => line.time >= from && (to === undefined || line.time < to)) : [];
      return own.length ? own.map((line) => JSON.stringify(line)).join('\n') : JSON.stringify({ time: '', speaker: '', text: `(scripted eyes: no typed lines are fixed for page ${page})` });
    }
    const photo = photos.get(source.split('/').at(-1)!);
    if (photo) {
      const said = options.wrong?.has(photo.id) ? classes.find((name) => name !== photo.class)! : photo.class;
      return `${said}\n(scripted eyes: the class of NASA's caption, not a model's reading.)`;
    }
    return '(scripted eyes: no model looked at these frames.)';
  };
  let next: string | { fail: string } = '';
  const base = fakeEyes({ model: 'scripted-eyes', price: { input: 0, output: 0 }, answers: [() => next] });
  return { ...base, see: (request: Parameters<typeof base.see>[0], signal: AbortSignal) => {
    const source = request.parts.find((part) => part.fragment)?.fragment ?? '';
    const page = request.parts.flatMap((part) => (part.type === 'text' ? [/\bpage (\d+) of \d+/.exec(part.text)?.[1]] : [])).find(Boolean);
    next = options.fail?.has(page ? `${source}#page=${page}` : source.split('/').at(-1)!) ? { fail: 'the scripted provider refused the request' } : answer(request.parts);
    return base.see(request, signal);
  } };
}

/** The fakes the reference entry runs the job on: the scripted lead, the job's tools, and no judge (the job asks none). */
export function fakesOf(classes: Record<string, string>): Fakes {
  return {
    model: scriptedLead(classes), tools, pages: {}, start: 'about:blank', responses: 20_000, tokensPerSecond: 400,
    judge: async () => { throw new Error('this job asks no judge'); },
  };
}
