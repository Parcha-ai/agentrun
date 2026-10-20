// The moves demo on fakes: a scripted lead for the three agent nodes and for the threads it forks, the two hand-overs' fakes, and stand-in
// sandboxes that run local processes. The lead's answer is a pure function of the transcript, so it is the same across a handoff. Every answer
// carries a thinking block, as the live model's do. This is the test fixture, not what a gallery shows.
import { dirname, join } from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Fakes } from '@parcha/agentrun-harness';
import { fakeModalBoxes, ledgerPath } from './boxes.ts';
import { movesExtensions } from './tools.ts';

type Block = { type?: string; text?: string };
const textOf = (message: unknown): string => {
  const m = message as { content?: unknown; output?: unknown };
  const blocks = m?.output ?? m?.content;
  return typeof blocks === 'string' ? blocks : Array.isArray(blocks) ? (blocks as Block[]).map((b) => b.text ?? '').join('') : '';
};
const think = (what: string) => fauxThinking(what);
const call = (name: string, args: Record<string, string | number>, id: string) => fauxAssistantMessage([think(`I will use ${name}.`), fauxToolCall(name, args, { id })], { stopReason: 'toolUse' });
const say = (text: string) => fauxAssistantMessage([think('I have what I need.'), fauxText(text)]);

/** The brief the prepare node writes, and the loss a thread's job reports: small, and a real number out. */
export const BRIEF = 'Train a tiny regression on the GPU for a few seconds.\nEach thread chooses the learning rate and the width.\nThe score is the final loss: lower is better.\n';
export const jobFor = (n: number) => {
  const lr = 0.002 * n;
  const width = 8 * n;
  const loss = Math.abs(lr - 0.008) * 50 + 1 / width + n * 0.001; // thread 4 wins: lr 0.008
  return { settings: { lr, width }, loss: Number(loss.toFixed(5)) };
};

/** The tool results after the last user message, in order. */
function sinceLastUser(messages: readonly Message[]): { user: string; first: string; results: string[] } {
  const at = messages.findLastIndex((m) => m.role === 'user');
  const firstUser = messages.find((m) => m.role === 'user');
  return {
    user: at < 0 ? '' : textOf(messages[at]),
    first: firstUser ? textOf(firstUser) : '',
    results: messages.slice(at + 1).filter((m) => (m.role as string) === 'toolResult').map(textOf),
  };
}

export function lead(all: readonly Message[]) {
  const messages = all.filter((m) => (m.role as string) !== 'system');
  const { user, first, results } = sinceLastUser(messages);
  const thread = /^Thread (\d+) of (\d+)\./.exec(user);
  if (thread) {
    const n = Number(thread[1]);
    const { settings, loss } = jobFor(n);
    const job = `console.log("final_loss=" + ${loss});\n`;
    if (results.length === 0) return call('gpu_bash', { command: 'command -v nvidia-smi >/dev/null && nvidia-smi -L || echo "GPU 0: none (offline stand-in)"' }, `t${n}-gpu`);
    if (results.length === 1) return call('gpu_write', { path: 'job.mjs', content: job }, `t${n}-write`);
    if (results.length === 2) return call('gpu_bash', { command: 'node job.mjs' }, `t${n}-run`);
    const gpu = /GPU \d+: ([^(\n]+?)\s*(?:\(|\n|$)/.exec(results[0]!)?.[1] ?? 'unknown';
    const metric = /final_loss=([0-9.]+)/.exec(results[2]!)?.[1] ?? 'nan';
    return say(`METRIC=${metric} SETTINGS=${JSON.stringify(settings)} GPU=${gpu}`);
  }
  if (first.includes('"task"')) {
    if (results.length === 0) return call('write', { path: 'brief.md', content: BRIEF }, 'prepare-write');
    return call('submit', { file: 'brief.md' }, 'prepare-submit');
  }
  if (first.includes('"brief"')) {
    if (results.length === 0) return call('read', { path: 'brief.md' }, 'threads-read');
    if (results.length === 1) return call('fork_threads', { job: 'Train a tiny regression and report its final loss.' }, 'threads-fork');
    if (results.length === 2) {
      const losses = [...results[1]!.matchAll(/thread (\d+): METRIC=([0-9.]+)/g)].map((m) => ({ n: Number(m[1]), loss: Number(m[2]) }));
      const best = losses.sort((a, b) => a.loss - b.loss)[0]!;
      return call('pick', { thread: best.n, why: `thread ${best.n} has the lowest loss, ${best.loss}` }, 'threads-pick');
    }
    const picked = /recorded thread (\d+)/.exec(results[2]!)?.[1] ?? '0';
    return call('submit', { thread: Number(picked) }, 'threads-submit');
  }
  if (first.includes('"picked"')) {
    if (results.length === 0) return call('read', { path: 'result.json' }, 'answer-read');
    const result = JSON.parse(results[0]!.slice(results[0]!.indexOf('{'))) as { picked: number; metric: number; settings: string; gpu: string | null };
    // Thinking is on: the thinking of the earlier nodes' turns is not this node's context, but this node's own earlier turn is.
    const kept = messages.some((m) => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Block[]).some((b) => b.type === 'thinking'));
    return call('submit', { answer: `Thread ${result.picked} won with a final loss of ${result.metric} (settings ${result.settings}) on ${result.gpu ?? 'an unnamed GPU'}.${kept ? '' : ' THINKING LOST'}` }, 'answer-submit');
  }
  return say('I do not know this node.');
}

/** The fakes: the lead above, the extensions with stand-in sandboxes, and the hand-overs (effect tools that do nothing outside the run). */
export function movesFakes(): Fakes {
  // The stand-in sandboxes live beside the run's workspace (never inside it, so never in the recording), with a ledger of what each was asked to be and when it ended.
  const { session, thread } = movesExtensions({ provider: async (workspace) => { const at = join(dirname(workspace), 'boxes'); return fakeModalBoxes(at, ledgerPath(at)); }, labels: { run: 'moves' } });
  const handOver = (args: Record<string, unknown>) => ({ to: String(args.to) });
  return {
    model: lead,
    lead: { input: ['text'] },
    extensions: [session, thread],
    tools: { hand_over: handOver, hand_back: handOver },
    judge: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.9 }])), usage: { input_tokens: 0, output_tokens: 0 }, cost_usd: 0 }),
    pages: {},
    start: 'about:blank',
  };
}
export const fakes = movesFakes();
