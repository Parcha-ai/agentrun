// The run with no key: a scripted lead and scripted eyes, Jev and transcriber stand in for the models; the files are real.
// The lead cannot read a question, so it runs one script whatever is asked: it looks at the first picture, page or frame
// it can make of the first file, and writes a report of that one look, citing it at the file's own fragment by its key.
// Every answer says it is scripted, and so does the recording.
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { fakeEyes } from '@parcha/pi-vision/testing';
import type { Transcriber } from '@parcha/pi-vision';
import type { Fakes } from '@parcha/agentrun-harness';

const call = (name: string, args: ToolCall['arguments']) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'));

/** The first JSON object in a prompt that names a question and files: the agent's state. */
function stateOf(prompt: string): { question: string; files: string[] } | undefined {
  for (let start = prompt.indexOf('{'); start >= 0; start = prompt.indexOf('{', start + 1)) {
    for (let end = prompt.lastIndexOf('}'); end > start; end = prompt.lastIndexOf('}', end - 1)) {
      try { const parsed = JSON.parse(prompt.slice(start, end + 1)); if (parsed && typeof parsed.question === 'string' && Array.isArray(parsed.files)) return parsed; } catch { /* not this slice */ }
    }
  }
  return undefined;
}

/** The script the scripted lead runs: one look at the first file, and a report of it. */
export function scriptFor(state: { question: string; files: string[] }): string {
  return [
    `const files = ${JSON.stringify(state.files)};`,
    'const q = (text) => `\'${String(text).replaceAll("\'", "\'\\\\\'\'")}\'`;',
    'if (!files.length) throw new Error("no files to look at");',
    'const file = files[0];',
    'const pdf = /\\.pdf$/i.test(file);',
    'const image = /\\.(png|jpe?g|webp|gif)$/i.test(file);',
    'await tools.bash({ command: "mkdir -p .vision report/frames" });',
    // A picture of the file: its first page, the still itself, or its frame at second 1.
    'const fragment = pdf ? "#page=1" : image ? "" : "#t=1";',
    'if (pdf) await tools.bash({ command: `pdftoppm -cropbox -f 1 -l 1 -r 50 -png ${q(file)} .vision/p && mv .vision/p-1.png report/frames/one.png 2>/dev/null || mv .vision/p-01.png report/frames/one.png` });',
    'else if (image) await tools.bash({ command: `ffmpeg -v error -y -i ${q(file)} -frames:v 1 report/frames/one.png` });',
    'else await tools.bash({ command: `ffmpeg -v error -y -ss 1 -i ${q(file)} -frames:v 1 report/frames/one.png` });',
    'const seen = await vision.see({ ask: "What does this show?", paths: ["report/frames/one.png"], fragments: [file + fragment] });',
    'const receipt = JSON.parse(await tools.bash({ command: `cat ${q("../" + seen.receipts[0])}` }));',
    'const key = receipt.facts.key;',
    'const label = pdf ? "page 1" : image ? "the image" : "1 s";',
    'const html = `<!doctype html><meta charset="utf-8"><title>Report</title><style>body{font:16px system-ui;margin:1rem;max-width:48rem}img{max-width:100%}</style>'
      + '<section id="answer"><h1>Answer</h1><p>(scripted: no model read the question) One look at ${file}, ${label}.</p></section>'
      + '<article class="finding"><p>${seen.text.split("\\n")[0].replace(/[<>&]/g, "")}</p><img src="frames/one.png" alt="the look"><p><a class="cite" href="../${file}${fragment}" data-look="${key}">${label}</a></p></article>'
      + '<section id="not-checked"><p>Everything else.</p></section>`;',
    'await tools.bash({ command: `cat > report/index.html <<\'HTML\'\\n${html}\\nHTML` });',
    'return { answer: "(scripted) One look at " + file + ", in report/index.html.", report: "report/index.html" };',
  ].join('\n');
}

/** The scripted lead: one `code` call with the script, then the script's value submitted; a script that failed is run
 *  again, three attempts in all. */
export function scriptedLead(messages: readonly Message[]): AssistantMessage {
  const state = stateOf(textOf(messages.find((message) => message.role === 'user')!));
  if (!state) throw new Error('the scripted lead found no question and files in its prompt');
  const runs = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.toolName === 'code');
  const last = runs.at(-1);
  const value = last ? (() => { try { const parsed = JSON.parse(textOf(last as Message).split('\n').at(-1)!); return parsed.ok ? parsed.value : undefined; } catch { return undefined; } })() : undefined;
  if (value) return call('submit', value);
  if (runs.length < 3) return call('code', { code: scriptFor(state) });
  throw new Error(`the scripted script failed three times: ${last ? textOf(last as Message).slice(0, 400) : ''}`);
}

/** The scripted Jev: every question answered the same way, priced at 0. */
const scriptedJudge = async (params: { questions: Readonly<Record<string, unknown>>; model?: string }) => ({
  answers: Object.fromEntries(Object.entries(params.questions).map(([name, q]) => [name, (q as { type: string }).type === 'box' ? { type: 'box', box: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 }, confidence: 0.5 } : { type: 'noul', noul: 0.5 }])),
  model: params.model ?? 'scripted-jev', usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0,
});

/** The scripted transcriber: one line that says it is scripted, priced at 0. */
const scriptedTranscriber: Transcriber = {
  provider: 'scripted', model: 'scripted-words', usdPerMinute: 0,
  async transcribe() { return { words: ['(scripted', 'words:', 'no', 'model', 'listened)'].map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 })), text: '(scripted words: no model listened)' }; },
};

/** The fakes the reference entry runs the agent on. */
export const fakes: Fakes = {
  model: scriptedLead, tools: {}, pages: {}, start: 'about:blank', responses: 2_000, tokensPerSecond: 400, lead: { input: ['text'] },
  judge: scriptedJudge as unknown as Fakes['judge'],
  vision: () => ({
    eyes: fakeEyes({ model: 'scripted-eyes', price: { input: 0, output: 0 }, accepts: { video: true }, answers: [(request) => `(scripted eyes: no model looked at ${request.parts.find((part) => part.fragment)?.fragment ?? 'it'}.)`] }),
    transcriber: scriptedTranscriber,
  }),
};
