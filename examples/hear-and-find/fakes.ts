// The run with no key: a scripted lead, scripted eyes, a scripted Jev and a scripted transcriber stand in for the models,
// and the film is a real one (the committed clip, or with --fetch-sources NASA's). The lead runs the programs of the
// transcribe and find skills exactly as the package ships them, with only the names they ask to set filled in, through the
// `code` tool. The scripted parts answer from clip/clip.json (what is said when, where the flag stands), never from a
// model, and every answer says it is scripted, as does the recording.
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { fakeEyes } from '@parcha/pi-vision/testing';
import type { Transcriber } from '@parcha/pi-vision';
import type { Fakes } from '../reference/index.ts';
import clip from './clip/clip.json' with { type: 'json' };
import { FIND, TRANSCRIBE } from './job.ts';
import { tools } from './tools.ts';

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));
const blocks = (text: string, lang: string) => [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((match) => match[1]!);

type State = { film: string; best: string; phrase: string; thing: string; box: string; words: string; budget_usd: number };
/** The first JSON object in a prompt that names a film and a phrase: the agent's state. */
function stateOf(prompt: string): State | undefined {
  for (let start = prompt.indexOf('{'); start >= 0; start = prompt.indexOf('{', start + 1)) {
    for (let end = prompt.lastIndexOf('}'); end > start; end = prompt.lastIndexOf('}', end - 1)) {
      try { const parsed = JSON.parse(prompt.slice(start, end + 1)); if (parsed && typeof parsed.film === 'string' && typeof parsed.phrase === 'string') return parsed; } catch { /* not this slice */ }
    }
  }
  return undefined;
}

/** A program of a skill, run in its own function so its names and its `return` stay its own. */
const own = (code: string) => `await (async () => {\n${code}\n})()`;
/** One line of a program, the first that starts with `start`, put in place of `line`; a program that has none is a skill
 *  that changed, which fails here, not in a run. */
function setLine(code: string, start: string, line: string): string {
  const at = code.split('\n').findIndex((each) => each.startsWith(start));
  if (at < 0) throw new Error(`a skill's program has no line starting ${start}`);
  return code.split('\n').map((each, i) => (i === at ? line : each)).join('\n');
}

/** The script the scripted lead runs: the skills' programs, in order, with the names the task sets. */
export function scriptFor(state: State): string {
  const [step1, step2, step4] = blocks(TRANSCRIBE, 'bash');
  const [step3] = blocks(TRANSCRIBE, 'js');
  const [heard, ...seen] = blocks(FIND, 'js');
  if (!step1 || !step2 || !step3 || !step4 || !heard || seen.length !== 5) throw new Error('the transcribe or find skill does not have the programs the scripted lead runs');
  const search = `.find/${state.box.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const steps = seen.map((code, i) => (i === 0
    ? setLine(code, 'const task = ', `const task = ${JSON.stringify({ video: state.film, best: state.best, thing: state.thing, box: state.box, words: state.words, chapters: null, scanFrames: 300, budgetUsd: state.budget_usd })};`)
    : code).replaceAll('.find/umbrella', search));
  return [
    `const film = ${JSON.stringify(state.film)};`,
    // The transcribe skill: steps 1 and 2 in one shell (step 1 prints the folder), step 3 in code, step 4 in a shell.
    `const folder = (await tools.bash({ command: ${JSON.stringify(`VIDEO=${state.film} CHUNK=600\n${step1}\n${step2}`)} })).trim().split("\\n").at(-1);`,
    `const transcribed = ${own(setLine(step3, 'const video = ', 'const video = film, H = folder;'))};`,
    `await tools.bash({ command: "H=" + folder + "\\n" + ${JSON.stringify(step4)} });`,
    // The find skill: every time the phrase is said, then the five steps for the thing.
    `const heard = ${own(setLine(heard, 'const task = ', `const task = ${JSON.stringify({ video: state.film, phrase: state.phrase })};`))};`,
    `const narrowed = ${own(steps[0]!)};`,
    `const scanned = ${own(steps[1]!)};`,
    `const halved = ${own(steps[2]!)};`,
    // Step 3 says when nothing was found; step 4 when the eyes named no second; otherwise step 5 answers.
    `const named = halved.found === false ? null : ${own(steps[3]!)};`,
    `const answer = named === null || named.at === null ? { found: false, spentUsd: named ? named.spentUsd : scanned.spentUsd } : ${own(steps[4]!)};`,
    'const hits = heard.hits;',
    // A model reads the rows around each hit and picks the one the question means; the scripted lead cannot read, so it
    // takes the last hit and says so.
    'const picked = hits.length - 1;',
    'return {',
    '  heard: { hits, picked, why: picked < 0 ? "(scripted) no hit" : "(scripted lead: it takes the last hit; a model picks by the rows around each) before it: " + hits[picked].before, receipts: transcribed.flatMap((done) => done.receipts) },',
    '  seen: { found: Boolean(answer && answer.found), at: answer && answer.found ? answer.t : null, cite: answer && answer.found ? answer.cite : null, noul: answer && answer.found ? answer.noul : null, confidence: answer && answer.found ? answer.confidence : null, spent_usd: answer ? answer.spentUsd ?? null : null },',
    '};',
  ].join('\n');
}

/** The scripted lead: one `code` call with the script, then the script's value submitted; a script that failed is run
 *  again, three attempts in all. */
export function scriptedLead(messages: readonly Message[]): AssistantMessage {
  const state = stateOf(textOf(messages.find((message) => message.role === 'user')!));
  if (!state) throw new Error('the scripted lead found no film and phrase in its prompt');
  const runs = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'code');
  const last = runs.at(-1);
  const value = last ? (() => { try { const parsed = JSON.parse(textOf(last as Message).split('\n').at(-1)!); return parsed.ok ? parsed.value : undefined; } catch { return undefined; } })() : undefined;
  if (value) return call('submit', value);
  if (runs.length < 3) return call('code', { code: scriptFor(state) });
  throw new Error(`the scripted script failed three times: ${last ? textOf(last as Message).slice(0, 400) : ''}`);
}

/** The second a fragment names (`film#t=S` or `film#t=S,E`), or NaN. */
const secondOf = (fragment: string) => Number(/#t=([\d.]+)/.exec(fragment)?.[1]);

/** The scripted eyes: asked at which second the thing is first seen in a window, they name the second clip.json gives;
 *  anything else is answered with what the window's fragment names. */
export function scriptedEyes() {
  return fakeEyes({
    model: 'scripted-eyes', price: { input: 0, output: 0 }, accepts: { video: true },
    answers: [(request) => {
      const fragment = request.parts.find((part) => part.fragment)?.fragment ?? '';
      const from = secondOf(fragment);
      const to = Number(/#t=[\d.]+,([\d.]+)/.exec(fragment)?.[1] ?? from);
      const seen = clip.seen.from_s;
      return seen >= from && seen < to ? `SECOND=${seen - from}\n(scripted eyes: no model looked at ${fragment}; clip.json says it is first seen at ${seen} s.)` : `(scripted eyes: no model looked at ${fragment}, and clip.json puts nothing there.)`;
    }],
  });
}

/** The scripted Jev: a frame at or after clip.json's second is the thing (0.95, and its box), one in the lookalike's span
 *  half is (0.6), any other is not; priced at 0. */
export function scriptedJev() {
  const requests: { source: string; questions: string[] }[] = [];
  const judge = async (params: { state: unknown; questions: Readonly<Record<string, unknown>>; model?: string }) => {
    const source = String((params.state as { images: { source: string }[] }).images[0]?.source ?? '');
    const t = secondOf(source);
    requests.push({ source, questions: Object.keys(params.questions) });
    const [x, y, w, h] = clip.seen.box.map((value) => value / 100);
    const there = t >= clip.seen.from_s;
    const half = t >= clip.seen.lookalike_s[0]! && t <= clip.seen.lookalike_s[1]!;
    const answers = Object.fromEntries(Object.entries(params.questions).map(([name, q]) => [name, (q as { type: string }).type === 'box'
      ? { type: 'box', box: there ? { left: x!, top: y!, right: x! + w!, bottom: y! + h! } : { left: 0, top: 0, right: 1, bottom: 1 }, confidence: there ? 0.9 : 0.2 }
      : { type: 'noul', noul: there ? 0.95 : half ? 0.6 : 0.05 }]));
    return { answers, model: params.model ?? 'scripted-jev', usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 };
  };
  return { judge, requests };
}

/** The scripted transcriber: whatever it is sent, it answers with clip.json's words, each a third of a second after the
 *  last, at the second clip.json gives its line; priced at 0. */
export const scriptedTranscriber: Transcriber = {
  provider: 'scripted', model: 'scripted-words', usdPerMinute: 0,
  async transcribe() {
    const words = clip.said.flatMap((line) => line.words.split(' ').map((text, i) => ({ text, start: line.start + 0.3 * i, end: line.start + 0.3 * i + 0.25 })));
    return { words, text: `(scripted words, from clip.json) ${clip.said.map((line) => line.words).join(' ')}` };
  },
};

/** The fakes the reference entry runs the job on: the scripted lead, the job's tools, no judge of its own, and the scripted
 *  eyes, Jev and transcriber. */
export const fakes: Fakes = {
  model: scriptedLead, tools, pages: {}, start: 'about:blank', responses: 2_000, tokensPerSecond: 400, lead: { input: ['text'] },
  judge: async () => { throw new Error('this job asks no judge'); },
  vision: () => ({ eyes: scriptedEyes(), jev: { judge: scriptedJev().judge }, transcriber: scriptedTranscriber }),
};
