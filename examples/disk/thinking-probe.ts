// How much the review agent thinks at each thinking level: the disk demo's review node, exactly as the take runs it (the
// harness's own process path, prepareChild then run, with the take's instructions, read_lines on the fixture's files and
// the Review submission), on one invoice, `--runs` times at each of `--levels`. It counts, per run, from the run's own
// recording: the model's messages, those with a thinking part that has text (and those whose thinking part is empty or a
// signature only), the thinking characters, the calls, the tokens, the cost pi-ai priced, whether the submission was
// accepted, and the cites it submitted. One line per run, then one JSON line per level.
//   node examples/disk/thinking-probe.ts --fake                    (the scripted lead: no key, no spend; the same counting)
//   node examples/disk/thinking-probe.ts [--invoice INV-005] [--levels medium,high,xhigh] [--runs 3]
// Live, the key is ANTHROPIC_API_KEY from the caller's credential wrapper. It is never printed: every line is checked for it
// before it is written, and the last line says how many held it (0). The spend is guarded over the whole probe: at most 40
// model calls and $1; a call past either is sent with its signal already aborted, so it never reaches the server.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { createModels, createProvider, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { run, type DemoOptions, type LiveParts } from '@parcha/agentrun-harness';
import { prepareChild } from '../../packages/harness/dist/demo.js';
import { fakes } from './fakes.ts';
import { job } from './job.ts';
import { KEY_ENV, LEAD, MAX_OUTPUT_TOKENS } from './model.ts';
import { charge, DiskReview } from './tools.ts';

const { values } = parseArgs({ options: { fake: { type: 'boolean' }, invoice: { type: 'string' }, levels: { type: 'string' }, runs: { type: 'string' }, 'max-calls': { type: 'string' }, 'max-usd': { type: 'string' }, keep: { type: 'boolean' } } });
const live = !values.fake;
const invoice = values.invoice ?? 'INV-005';
const levels = (values.levels ?? 'medium,high,xhigh').split(',').map((level) => level.trim()).filter(Boolean);
const runs = Number(values.runs ?? 3);
const MAX_CALLS = Number(values['max-calls'] ?? 40);
const MAX_USD = Number(values['max-usd'] ?? 1);
const key = live ? process.env[KEY_ENV] : undefined;
if (live && !key) throw new Error(`the live probe needs ${KEY_ENV} from the caller's credential wrapper (or --fake)`);
let keyHits = 0;
/** Every line goes out through here, checked for the key first: a line that holds it is withheld and counted. */
const say = (line: string) => {
  if (key && line.includes(key)) {
    keyHits += 1;
    console.log('[a line that held the key was withheld]');
    return;
  }
  console.log(line);
};

// The guard over the whole probe: the calls made and what they cost, as pi-ai priced each answer.
let calls = 0;
let spent = 0;
type Api = ReturnType<typeof anthropicMessagesApi>;
function guardedApi(inner: Api, force?: string): Api {
  const guard = <O extends { maxTokens?: number; signal?: AbortSignal }>(options: O | undefined): O => {
    const capped = { ...options, maxTokens: Math.min(options?.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS) } as O;
    if (calls >= MAX_CALLS || spent >= MAX_USD) return { ...capped, signal: AbortSignal.abort(new Error(`the probe's guard: ${calls} calls, $${spent.toFixed(4)} spent (caps ${MAX_CALLS} calls, $${MAX_USD})`)) };
    calls += 1;
    // A level the workflow cannot ask for (xhigh: a node's thinking goes up to high) is sent here, as pi-ai's own request option.
    return (force ? { ...capped, reasoning: force, effort: force } : capped) as O;
  };
  const priced = <S extends { result(): Promise<{ usage?: { cost?: { total?: number } } } | undefined> }>(stream: S): S => {
    stream.result().then((message) => (spent += message?.usage?.cost?.total ?? 0), () => {});
    return stream;
  };
  return {
    ...inner,
    stream: (model, context, options) => priced(inner.stream(model, context, guard(options))),
    streamSimple: (model, context, options) => priced(inner.streamSimple(model, context, guard(options))),
  };
}

/** The take's live part (model.ts), with the probe's guard in place of the per-process bound. */
function probeLive({ env }: { env: NodeJS.ProcessEnv }): LiveParts {
  if (!env[KEY_ENV]) throw new Error(`no ${KEY_ENV}`);
  const anthropic = anthropicProvider() as Provider;
  const entry = anthropic.getModels().find((model) => model.id === LEAD.modelId);
  if (!entry) throw new Error(`anthropic has no model ${LEAD.modelId} in this build of pi-ai`);
  const catalog = createModels();
  catalog.setProvider(createProvider({ id: anthropic.id, name: anthropic.name, baseUrl: anthropic.baseUrl, auth: anthropic.auth, models: [{ ...entry, maxTokens: MAX_OUTPUT_TOKENS }], api: guardedApi(anthropicMessagesApi(), env.PROBE_FORCE_LEVEL) } as never) as never);
  return { host: { models: { catalog, lead: { provider: LEAD.provider, modelId: LEAD.modelId } }, tools: { extensions: [DiskReview] } as never }, tools: { charge }, models: { lead: `${LEAD.provider}/${LEAD.modelId}` } };
}

// The review node as the take runs it (job.ts), alone: its instructions, tools, submission and schemas; the input is one invoice's path.
const steps = (job.workflow.root as unknown as { steps: [{ body: { steps: [Record<string, unknown>] } }] }).steps;
const review = steps[0].body.steps[0];
const reviewOnly = (thinking: string) => ({
  v: 2,
  name: 'disk-review-probe',
  schemas: { Input: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } }, Cite: job.workflow.schemas.Cite, Review: job.workflow.schemas.Review },
  input: { schemaId: 'Input' },
  output: { schemaId: 'Review', path: 'review' },
  root: { ...review, state: { path: '{path}' }, thinking },
});
/** The levels a workflow node may ask for; any other (xhigh) is asked for as `high` by the node and sent as itself through pi-ai's request option. */
const NODE_LEVELS = new Set(['low', 'medium', 'high']);
const spec = JSON.parse(readFileSync(new URL('./demo.json', import.meta.url), 'utf8'));
const path = `invoices/${invoice}.txt`;

type Count = { levelsSent: Record<string, number>; messages: number; withThinking: number; emptyThinking: number; thinkingChars: number; input: number; output: number; cacheRead: number; cacheWrite: number; usd: number };
/** What the run's recording says the model did: every assistant message in its spool. */
function countOf(record: string): Count {
  const count: Count = { levelsSent: {}, messages: 0, withThinking: 0, emptyThinking: 0, thinkingChars: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  const spool = join(record, '.spool');
  if (!existsSync(spool)) return count;
  for (const file of readdirSync(spool).filter((name) => name.endsWith('.jsonl'))) {
    for (const text of readFileSync(join(spool, file), 'utf8').split('\n').filter(Boolean)) {
      const line = JSON.parse(text) as { kind?: string; data?: { model?: Array<{ providerThinkingLevel?: string; content?: Array<{ type?: string; thinking?: string }>; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } }> } };
      if (line.kind !== 'pi.assistant') continue;
      for (const message of line.data?.model ?? []) {
        count.messages += 1;
        const sent = message.providerThinkingLevel ?? 'none';
        count.levelsSent[sent] = (count.levelsSent[sent] ?? 0) + 1;
        const thinking = (message.content ?? []).filter((block) => block.type === 'thinking');
        const chars = thinking.reduce((n, block) => n + String(block.thinking ?? '').trim().length, 0);
        if (chars > 0) count.withThinking += 1;
        else if (thinking.length > 0) count.emptyThinking += 1;
        count.thinkingChars += chars;
        const usage = message.usage ?? {};
        count.input += usage.input ?? 0;
        count.output += usage.output ?? 0;
        count.cacheRead += usage.cacheRead ?? 0;
        count.cacheWrite += usage.cacheWrite ?? 0;
        count.usd += usage.cost?.total ?? 0;
      }
    }
  }
  return count;
}

const scratch = mkdtempSync(join(tmpdir(), 'disk-thinking-probe-'));
const byLevel: Record<string, { counts: Count[]; accepted: number; cites: unknown[] }> = {};
try {
  for (const level of levels) {
    byLevel[level] = { counts: [], accepted: 0, cites: [] };
    for (let n = 1; n <= runs; n++) {
      if (calls >= MAX_CALLS || spent >= MAX_USD) {
        say(`${level} #${n}: not run, the guard stops the probe (${calls} calls, $${spent.toFixed(4)})`);
        continue;
      }
      const root = join(scratch, `${level}-${n}`);
      mkdirSync(root, { recursive: true });
      const nodeLevel = NODE_LEVELS.has(level) ? level : 'high';
      const options = { self: import.meta.url, spec, job: { workflow: reviewOnly(nodeLevel), input: { path }, files: job.files }, fakes, live: probeLive } as unknown as DemoOptions;
      const env: NodeJS.ProcessEnv = { RECORD_DIR: join(root, 'record'), ...(live ? { LIVE: '1', [KEY_ENV]: key, ...(nodeLevel !== level ? { PROBE_FORCE_LEVEL: level } : {}) } : {}) };
      const callsBefore = calls;
      let outcome: { status: string; output?: { cites?: Array<{ path: string; from: number; to: number }> } } | undefined;
      let failure: string | undefined;
      const prepared = await prepareChild(options, env, { id: 'probe', root, work: join(root, 'work'), store: join(root, 'store') });
      try {
        await prepared.open();
        outcome = (await run(prepared.place, prepared.host, prepared.job, prepared.runOptions)) as never;
        await prepared.recorder?.detach();
      } catch (error) {
        failure = String((error as Error).message).slice(0, 200);
      } finally {
        await prepared.done();
      }
      const count = countOf(join(root, 'record'));
      const accepted = outcome?.status === 'complete' && Array.isArray(outcome.output?.cites);
      const cites = outcome?.output?.cites?.map((cite) => `${cite.path}:${cite.from}-${cite.to}`) ?? null;
      byLevel[level]!.counts.push(count);
      if (accepted) byLevel[level]!.accepted += 1;
      byLevel[level]!.cites.push(cites);
      say(`${level} #${n}: ${calls - callsBefore} calls; level sent ${JSON.stringify(count.levelsSent)}; ${count.withThinking}/${count.messages} messages with thinking text (${count.thinkingChars} chars; ${count.emptyThinking} empty or signature only); tokens in ${count.input}, cache read ${count.cacheRead}, cache write ${count.cacheWrite}, out ${count.output}; $${count.usd.toFixed(4)}; submission ${accepted ? 'accepted' : `not accepted (${outcome?.status ?? failure ?? 'no outcome'})`}; cites ${cites ? cites.join(' ') : 'none'}`);
    }
    const c = byLevel[level]!.counts;
    const sum = (k: Exclude<keyof Count, 'levelsSent'>) => c.reduce((n, x) => n + x[k], 0);
    const sent: Record<string, number> = {};
    for (const x of c) for (const [name, n] of Object.entries(x.levelsSent)) sent[name] = (sent[name] ?? 0) + n;
    say(JSON.stringify({ level, runs: c.length, levelSent: sent, messagesWithThinking: `${sum('withThinking')}/${sum('messages')}`, emptyThinking: sum('emptyThinking'), thinkingChars: sum('thinkingChars'), meanUsd: c.length ? Math.round((sum('usd') / c.length) * 10000) / 10000 : null, accepted: `${byLevel[level]!.accepted}/${c.length}`, cites: byLevel[level]!.cites }));
  }
} finally {
  if (!values.keep) rmSync(scratch, { recursive: true, force: true });
}
say(JSON.stringify({ probe: live ? 'live' : 'fake', model: `${LEAD.provider}/${LEAD.modelId}`, invoice, calls, spentUsd: Math.round(spent * 10000) / 10000, guard: { maxCalls: MAX_CALLS, maxUsd: MAX_USD } }));
console.log(JSON.stringify({ keyInOutput: keyHits }));
