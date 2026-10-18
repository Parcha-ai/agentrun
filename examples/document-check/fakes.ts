// The run with no key: a scripted lead and a scripted Jev stand in for the models, and the document is the real one
// (the filed pages, or the TEST COPY with `--input test-copy`). The lead runs the verify skill's two steps as written,
// through the `code` tool, then submits what step 2 returned. The scripted Jev never looks at a pixel: it answers from
// sample/sample.json, which says where each mark is on the filed pages, and says every mark is gone from the TEST COPY.
// Its model is named `scripted-jev`, so the recording says no model looked.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { JevPort } from '@parcha/pi-vision';
import type { Fakes } from '../reference/index.ts';
import sample from './sample/sample.json' with { type: 'json' };
import { tools } from './tools.ts';

const SKILL = readFileSync(join(dirname(fileURLToPath(import.meta.resolve('@parcha/pi-vision'))), '..', 'skills', 'verify', 'SKILL.md'), 'utf8');
const STEPS = [...SKILL.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]!);
const TASK = /^const task = \{[^\n]*\};$/m;

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));

/** The first JSON object in a prompt that names a document and a checklist: the agent's state. */
function stateOf(prompt: string): { document: string; checklist: string } | undefined {
  for (let start = prompt.indexOf('{'); start >= 0; start = prompt.indexOf('{', start + 1)) {
    for (let end = prompt.lastIndexOf('}'); end > start; end = prompt.lastIndexOf('}', end - 1)) {
      try { const parsed = JSON.parse(prompt.slice(start, end + 1)); if (parsed && typeof parsed.document === 'string' && typeof parsed.checklist === 'string') return parsed; } catch { /* not this slice */ }
    }
  }
  return undefined;
}

/** Step `n` of the verify skill (0 or 1) with its task line set to the state, as the skill says to run it. */
export function stepFor(n: number, state: { document: string; checklist: string }): string {
  return STEPS[n]!.replace(TASK, `const task = { document: ${JSON.stringify(state.document)}, checklist: ${JSON.stringify(state.checklist)} };`);
}

/** The scripted lead: step 1, then step 2, then the value step 2 returned submitted; a step that failed is run again,
 *  three attempts in all. */
export function scriptedLead(messages: readonly Message[]): AssistantMessage {
  const state = stateOf(textOf(messages.find((message) => message.role === 'user')!));
  if (!state) throw new Error('the scripted lead found no document in its prompt');
  const runs = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'code');
  const values = runs.map((run) => { try { const parsed = JSON.parse(textOf(run as Message).split('\n').at(-1)!); return parsed.ok ? parsed.value : undefined; } catch { return undefined; } });
  const done = values.filter((value) => value !== undefined).length;
  if (done >= 2) return call('submit', values.findLast((value) => value !== undefined));
  if (runs.length - done >= 3) throw new Error('a scripted step failed three times');
  return call('code', { code: stepFor(done, state) });
}

type Box = { top: number; bottom: number; left: number; right: number };
const { width, height } = sample.size;
const MARKS: Record<string, Record<string, number[]>> = sample.marks;
const KINDS: Record<number, string> = { 1: 'certification', 2: 'certification', 3: 'filed' };

/** Where a mark is on a page of the filed document, as Jev gives a box (fractions of the page), or undefined. */
function markAt(page: number, id: string): Box | undefined {
  const at = MARKS[String(page)]?.[id];
  return at && { left: at[0]! / width, top: at[1]! / height, right: at[2]! / width, bottom: at[3]! / height };
}
const pageOf = (source: string) => Number(/#page=(\d+)/.exec(source)?.[1] ?? 0);
const filed = (source: string) => source.startsWith(`${sample.files.filed}#`);

/** The scripted Jev: each page's kind from the sample's layout; each mark there with its box on the filed pages and gone
 *  from the TEST COPY, with the whole page as the box Jev always gives; two file numbers the same on the filed pages. */
export function scriptedJev(): JevPort {
  return {
    model: 'scripted-jev',
    judge: async ({ state, questions }) => {
      const sources = (state as { images: { source: string }[] }).images.map((image) => image.source);
      const [first] = sources;
      const answers = Object.fromEntries(Object.entries(questions as Record<string, { type: string }>).map(([name, question]) => {
        if (question.type === 'choice') return [name, { type: 'choice', choice: KINDS[pageOf(first!)] ?? 'other', confidence: 0.9 }];
        if (sources.length === 2) return [name, { type: 'noul', noul: sources.every(filed) ? 0.95 : 0.05 }];
        const box = filed(first!) ? markAt(pageOf(first!), name.replace(/_at$/, '')) : undefined;
        if (question.type === 'noul') return [name, { type: 'noul', noul: box ? 0.97 : 0.03 }];
        return [name, { type: 'box', box: box ?? { top: 0, bottom: 1, left: 0, right: 1 }, confidence: box ? 0.9 : 0.1 }];
      }));
      return { answers, model: 'scripted-jev', usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 };
    },
  };
}

/** The fakes the reference entry runs the job on: the scripted lead, the job's tool, and the scripted Jev for
 *  `vision.judge`; no eyes, since the job asks none. */
export const fakes: Fakes = {
  model: scriptedLead, tools, pages: {}, start: 'about:blank', responses: 2_000, tokensPerSecond: 400, lead: { input: ['text'] },
  judge: async () => { throw new Error('this job asks no judge node; vision.judge goes through the vision lane'); },
  vision: () => ({ jev: scriptedJev() }),
};
