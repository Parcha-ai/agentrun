// The run with no key: a scripted lead and scripted eyes stand in for the models, and the film is a real one (the committed
// clip, or with --fetch-sources NASA's). The lead writes the script a model would (probe, cut windows, look, group, a second for each keyframe)
// and runs it through the `code` tool; the eyes answer each window with a line that says no model looked, and a topic from a
// fixed table. Every answer says it is scripted, and so does the recording.
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { fakeEyes } from '@parcha/pi-vision/testing';
import type { Fakes } from '../reference/index.ts';
import { ASK } from './job.ts';
import { tools } from './tools.ts';

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));

/** The first JSON object in a prompt that names a film: the agent's state. */
function stateOf(prompt: string): { film: string; from_s: number; to_s: number; window_s: number } | undefined {
  for (let start = prompt.indexOf('{'); start >= 0; start = prompt.indexOf('{', start + 1)) {
    for (let end = prompt.lastIndexOf('}'); end > start; end = prompt.lastIndexOf('}', end - 1)) {
      try { const parsed = JSON.parse(prompt.slice(start, end + 1)); if (parsed && typeof parsed.film === 'string' && typeof parsed.window_s === 'number') return parsed; } catch { /* not this slice */ }
    }
  }
  return undefined;
}

/** The script the scripted lead runs: what the task asks, step by step, as plain code. */
export function scriptFor(state: { film: string; from_s: number; to_s: number; window_s: number }): string {
  return [
    `const film = ${JSON.stringify(state.film)}; const W = ${state.window_s}; const ASK = ${JSON.stringify(ASK)};`,
    'const ext = film.slice(film.lastIndexOf("."));',
    'const sh = async (command) => { const ran = await tools.bash({ command }); if (ran.exitCode !== 0) throw new Error(command + ": " + ran.output); return ran.output; };',
    'const duration = parseFloat(await sh("ffprobe -v error -show_entries format=duration -of csv=p=0 " + film));',
    `const from = ${state.from_s}; const to = ${state.to_s} > 0 ? Math.min(${state.to_s}, duration) : duration;`,
    'await sh("mkdir -p .look/windows .look/answers");',
    'const windows = [];',
    'for (let s = from; s < to - 0.5; s += W) {',
    '  const e = Math.min(to, s + W); const path = ".look/windows/" + s + ext;',
    '  const kept = ".look/answers/" + s + ".json";',
    '  const before = await tools.bash({ command: "cat " + kept });',
    '  if (before.exitCode === 0) { windows.push(JSON.parse(before.output)); continue; }',
    '  await sh("ffmpeg -v error -y -ss " + s + " -t " + (e - s) + " -i " + film + " -map_metadata -1 -c copy -fflags +bitexact " + path);',
    '  try {',
    '    const seen = await vision.see({ ask: ASK, paths: [path], fragments: [film + "#t=" + s + "," + e] });',
    '    const topic = ((/TOPIC:\\s*(.+)\\s*$/m.exec(seen.text) || [])[1] || "Untitled").trim();',
    '    const window = { s, e, text: seen.text, topic, receipts: seen.receipts };',
    '    await sh("cat > " + kept + " <<\'JSON\'\\n" + JSON.stringify(window) + "\\nJSON");',
    '    windows.push(window);',
    '  } catch (error) { windows.push({ s, e, error: String(error.message || error) }); }',
    '}',
    'const chapters = [];',
    'for (const w of windows.filter((w) => !w.error)) {',
    '  const last = chapters[chapters.length - 1];',
    '  if (last && last.topic === w.topic) { last.end_s = w.e; last.receipts.push(...w.receipts); }',
    '  else chapters.push({ topic: w.topic, start_s: w.s, end_s: w.e, receipts: [...w.receipts], first: w.text });',
    '}',
    'for (const c of chapters) c.at_s = Math.round(c.start_s + Math.min(W, c.end_s - c.start_s) / 2);',
    'return {',
    '  summary: "(scripted) " + chapters.length + " chapters: " + chapters.map((c) => c.topic).join("; ") + ".",',
    '  chapters: chapters.map((c) => ({ title: c.topic, start_s: c.start_s, end_s: c.end_s, note: c.first.split("\\n")[0], at_s: c.at_s, receipts: c.receipts })),',
    '};',
  ].join('\n');
}

/** The scripted lead: one `code` call with the script, then the script's value submitted; a script that failed is run again,
 *  three attempts in all. */
export function scriptedLead(messages: readonly Message[]): AssistantMessage {
  const state = stateOf(textOf(messages.find((message) => message.role === 'user')!));
  if (!state) throw new Error('the scripted lead found no film in its prompt');
  const runs = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'code');
  const last = runs.at(-1);
  const value = last ? (() => { try { const parsed = JSON.parse(textOf(last as Message)); return parsed.ok ? parsed.value : undefined; } catch { return undefined; } })() : undefined;
  if (value) return call('submit', value);
  if (runs.length < 3) return call('code', { code: scriptFor(state) });
  throw new Error('the scripted script failed three times');
}

/** The topics the scripted eyes give the clip's windows, by start second; another window is named by its minute. */
const TOPICS: Record<number, string> = { 0: 'The launch', 8: 'The launch', 16: 'Climbing away' };

/** The scripted eyes: a window is answered with what its fragment names and a topic, and never with a model's reading. */
export function scriptedEyes() {
  return fakeEyes({
    model: 'scripted-eyes', price: { input: 0, output: 0 }, accepts: { video: true },
    answers: [(request) => {
      const fragment = request.parts.find((part) => part.fragment)?.fragment ?? '';
      const [, from = '0', to = '?'] = /#t=([\d.]+),?([\d.]*)/.exec(fragment) ?? [];
      const start = Number(from);
      const text = `(scripted eyes: no model looked at ${fragment}, seconds ${from} to ${to}.)\nTOPIC: ${TOPICS[start] ?? `Minute ${Math.floor(start / 60) + 1}`}`;
      // A test's knob: each answer takes this long, so a kill can land between two windows.
      const delayMs = Number(process.env.DEMO_EYES_DELAY_MS ?? 0);
      return delayMs ? { text, delayMs } : text;
    }],
  });
}

/** The fakes the reference entry runs the job on: the scripted lead, the job's tools, no judge, and the scripted eyes. */
export const fakes: Fakes = {
  model: scriptedLead, tools, pages: {}, start: 'about:blank', responses: 2_000, tokensPerSecond: 400, lead: { input: ['text'] },
  judge: async () => { throw new Error('this job asks no judge'); },
  vision: () => ({ eyes: scriptedEyes() }),
};
