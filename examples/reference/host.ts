// What a host hands the open packages, as one value, and `localHost`: the defaults that need no key. pi-ai's faux
// model answers from a script, the workflow's `call` reaches a tool in this process, the browser is the package's fake
// backend, and evidence, status and the record are files under the run's directory. Every fake call, and each page
// operation the browser makes, is counted in `<run>/ledger.jsonl`, which outlives a killed process.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import type { ConversationId, Extension, ModelRef } from '@earendil-works/pi-durable';
import type { WorkflowDeps, WorkflowEvent } from '@parcha/agentrun-dsl';
import type { RecoveryEffectParams } from '@parcha/agentrun-dsl/recovery';
import type { BrowserConfig, Decisions as BrowserDecisions, BrowserProvider, EvidenceRecord, PriceTable, ReconcileReport, SessionChange, SessionRow } from '@parcha/pi-browser';
import type { DriverFactory, PageDriver } from '@parcha/pi-browser/durable';
import { FakeBackend, fakeDriver, type FixturePage } from '@parcha/pi-browser/testing';
import type { LookEvent, LookRecord, MissEvent } from '@parcha/pi-vision';
import type { ChildEnv } from '@parcha/pi-vision/node';
import type { Recorder } from './record.ts';

/** Where one run lives: the disk package's `AppContext`. */
export type RunPlace = { id: string; root: string; work: string; store: string };

/** The door a `call` goes through: under the recovery driver it also gets `effect`, the admitted effect's id and argsHash. */
export type RunEffect = (params: RecoveryEffectParams) => ReturnType<NonNullable<WorkflowDeps['runEffect']>>;
export type RunJudge = NonNullable<WorkflowDeps['runJudge']>;
export type BrowserPlane = {
  /** Called per use; holds the provider's credentials in its closure. */
  provider(target: { conversationId: ConversationId; plane: string; config: BrowserConfig }): BrowserProvider | Promise<BrowserProvider>;
  driver: DriverFactory<PageDriver>;
  prices?: Partial<PriceTable>;
  /** How long a session create whose answer was lost may still land before its release goes ahead; the browser's
   *  default (60 s) is for a provider across a network. */
  createDeadlineMs?: number;
};
/** The packages' own rows, tagged by who reported them. */
export type StatusEvent =
  | { source: 'browser'; change: SessionChange; row: SessionRow }
  | { source: 'browser'; reconciled: ReconcileReport }
  | { source: 'vision'; look: LookEvent }
  | { source: 'vision'; miss: MissEvent }
  | { source: 'workflow'; event: WorkflowEvent }
  | { source: 'evidence'; label: string; tool: string; path: string };
export type Delivery = { record: unknown };
/** What a recorder takes from the run: the process's generation once it has opened the run. */
export type Generation = { generation(n: number): void; attach?(input: { session: unknown; storage?: unknown; head?: number; context: unknown; gen: number }): Promise<void> };

export type Host = {
  /** Told which generation this process is, once it has opened the run. Absent: nothing is recorded. */
  record?: Generation;
  /** 1. pi-ai's models, and the one the lead runs. */
  models: { catalog: Models; lead: ModelRef };
  /** 2. The host's own pi extensions, the door a workflow's `call` goes through, and the browser plane. `answered`
   *  looks a call up by the admitted effect's `argsHash` (which names the call's step): what the door answered it,
   *  if it did. A resumed run asks before it decides a call a killed process left unknown; absent, or with no answer,
   *  the call stays unknown and is never sent again. */
  tools: { extensions: readonly Extension[]; runEffect: RunEffect; answered?(argsHash: string): Promise<{ args: unknown; value: unknown } | undefined>; browser: BrowserPlane };
  /** 3. Files a browser read or a look as a receipt; returns the path the model cites. */
  evidence: { file(label: string, record: EvidenceRecord | LookRecord): Promise<{ path: string } | null> };
  /** 4. Typed answers: the workflow's judge, and the browser's (absent, it files every page `ok`). */
  decisions: { runJudge: RunJudge; browser?: BrowserDecisions };
  /** 5. Rows out. A throw never fails the call that reported. */
  status(event: StatusEvent): void | Promise<void>;
  /** 6. What the run hands back. */
  deliver(result: Delivery): Promise<void>;
  /** 7. Secrets by closure only: strings scrubbed from browser output, and the whole environment of a program vision starts. */
  credentials: { redact?: () => readonly string[]; childEnv?: ChildEnv };
};

/** What a job scripts for the no-key host. */
export type Fakes = {
  /** The lead's next turn from the transcript so far, so a process that resumes a request answers it the same. */
  model(messages: readonly Message[]): AssistantMessage;
  tools: Record<string, (args: Record<string, unknown>) => unknown>;
  judge: RunJudge;
  /** Whether a page the browser read is content. Absent, the browser judges none. */
  page?: BrowserDecisions['classifyPage'];
  /** What the faux lead takes; default text and images. */
  lead?: { input: ('text' | 'image')[] };
  /** The fake browser's pages, and the one a new session opens on. */
  pages: Record<string, FixturePage>;
  start: string;
};

/** One fake call, with the process incarnation that made it (a pid can be reused; this id is drawn at each start). A
 *  model call also names its conversation: the `sessionId` pi-durable keeps for it and hands the provider, the same in
 *  every process of the run. */
export type LedgerRow = { kind: 'model' | 'tool' | 'judge' | 'browser'; name: string; pid: number; incarnation?: string; conversation?: string };

const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const quiet = <T,>(report: (event: T) => void) => (event: T) => { try { report(event); } catch { /* a status row never fails a call */ } };

export type LocalHost = { host: Host; backend?: FakeBackend; ledger(): LedgerRow[]; evidence(): string[] };

export function localHost(place: RunPlace, fakes: Fakes, options: { browser?: BrowserPlane; recorder?: Recorder } = {}): LocalHost {
  const recorder = options.recorder;
  const ledgerFile = join(place.root, 'ledger.jsonl');
  const answerOf = (argsHash: string) => join(place.root, 'answers', `${argsHash}.json`);
  const eventsFile = join(place.root, 'events.jsonl');
  // Both logs exist from the start: a run that called nothing leaves an empty ledger, and a missing one was lost.
  for (const log of [ledgerFile, eventsFile]) appendFileSync(log, '');
  const incarnation = randomUUID();
  const count = (kind: LedgerRow['kind'], name: string, conversation?: string) =>
    appendFileSync(ledgerFile, json({ kind, name, pid: process.pid, incarnation, ...(conversation ? { conversation } : {}) }));
  const status = quiet((event: StatusEvent) => { appendFileSync(eventsFile, json(event)); if (recorder) record(recorder, event); });

  const faux = fakes.lead ? fauxProvider({ models: [{ id: 'faux-1', input: fakes.lead.input }] }) : fauxProvider();
  faux.setResponses(Array.from({ length: 64 }, () => (context, stream) => {
    count('model', `turn ${context.messages.filter((message) => message.role === 'toolResult').length}`, stream?.sessionId);
    return fakes.model(context.messages);
  }));
  const catalog = createModels();
  catalog.setProvider(faux.provider);

  const classifyPage = fakes.page;
  const backend = options.browser ? undefined : new FakeBackend({ start: fakes.start, pages: fakes.pages });
  // The fake answers in this process: a create it lost is known lost within seconds.
  const plane: BrowserPlane = options.browser ?? { provider: () => backend!.provider, driver: fakeDriver(backend!), createDeadlineMs: 3_000 };
  // A page's `run` and read are counted once each returns: the operations a browser receipt rests on.
  const ops: Record<string, string> = { run: 'page.run', page: 'page.read' };
  const browser: BrowserPlane = { ...plane, driver: async (...args) => {
    const page = await plane.driver(...args);
    return new Proxy(page, { get(target, name) {
      const member = Reflect.get(target, name, target);
      const op = typeof name === 'string' ? ops[name] : undefined;
      if (typeof member !== 'function') return member;
      return op ? async (...inputs: unknown[]) => { const out = await member.apply(target, inputs); count('browser', op); return out; } : member.bind(target);
    } });
  } };

  const host: Host = {
    ...(recorder ? { record: recorder } : {}),
    models: { catalog, lead: { provider: faux.provider.id, modelId: faux.getModel().id } },
    tools: {
      extensions: [],
      runEffect: async ({ node, input, effect }) => {
        if (!effect) throw new Error('this door runs under the recovery driver, which names the admitted effect');
        const tool = node.tool === undefined ? undefined : fakes.tools[node.tool];
        if (!tool) throw new Error(`no tool ${node.tool} in this host`);
        count('tool', node.tool!);
        const value = await tool(input);
        // Kept under the admitted effect's argsHash before the driver commits the result, so a process killed between
        // the two is answered from here and the call is not sent again.
        const at = answerOf(effect.argsHash);
        await mkdir(join(place.root, 'answers'), { recursive: true });
        await writeFile(`${at}.partial`, JSON.stringify({ args: input ?? {}, value }));
        await rename(`${at}.partial`, at);
        return value;
      },
      answered: async (argsHash) => {
        try { return JSON.parse(await readFile(answerOf(argsHash), 'utf8')) as { args: unknown; value: unknown }; } catch { return undefined; }
      },
      // The fake costs nothing; list prices would bill its session by the second and make every run's usage differ.
      browser: { prices: { sessionUsdPerHour: 0, sessionMinimumS: 0, fetchUsd: 0, fetchProxiedUsd: 0, searchUsd: 0 }, ...browser },
    },
    evidence: {
      // Named by the record's hash: a read replayed after a crash files the same path again, never a second one.
      async file(label, record) {
        const body = typeof record.body === 'string' ? record.body : Buffer.from(record.body).toString('base64');
        const text = JSON.stringify({ ...record, body }, null, 2);
        const path = join('evidence', label, `${record.tool}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.json`);
        await mkdir(join(place.root, 'evidence', label), { recursive: true });
        await writeFile(join(place.root, path), text);
        status({ source: 'evidence', label, tool: record.tool, path });
        recorder?.live(record.tool.startsWith('vision') || record.tool === 'look' ? 'vision' : 'browser', 'EvidenceRecord', { label, tool: record.tool, path }, { blobs: [recorder.blob(text, 'json')] });
        return { path };
      },
    },
    decisions: {
      runJudge: async (request) => { count('judge', request.label); return fakes.judge(request); },
      ...(classifyPage ? { browser: { classifyPage: async (page) => { count('browser', 'page.judge'); return classifyPage(page); } } } : {}),
    },
    status,
    async deliver(result) {
      await mkdir(join(place.root, 'out'), { recursive: true });
      const written = JSON.stringify({ ...result, evidence: evidence() }, null, 2);
      await writeFile(join(place.root, 'out', 'record.json'), written);
      recorder?.host('result', { path: 'out/record.json' }, { blobs: [recorder.blob(written, 'json')] });
    },
    // No program the job starts sees this process's environment beyond where programs live.
    credentials: { childEnv: { PATH: process.env.PATH } },
  };
  /** Every file filed, by any process of the run. */
  function evidence(): string[] {
    try { return readdirSync(join(place.root, 'evidence'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(place.root, join(entry.parentPath, entry.name))).sort(); } catch { return []; }
  }
  const ledger = () => {
    try { return readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerRow); } catch { return []; }
  };
  return { host, ...(backend ? { backend } : {}), ledger, evidence };
}

/** A status row as the recording's live line: the package's own record name, and the position and conversation it carries. */
function record(recorder: Recorder, event: StatusEvent): void {
  if (event.source === 'workflow') return recorder.live('workflow', event.event.type, event.event, event.event.executionPath === undefined ? {} : { path: event.event.executionPath });
  if (event.source === 'vision') return recorder.live('vision', 'look' in event ? 'LookEvent' : 'MissEvent', 'look' in event ? event.look : event.miss);
  if (event.source === 'browser') {
    if ('reconciled' in event) return recorder.live('browser', 'reconciled', event.reconciled);
    const conv = Number((event.row as { conversationId?: unknown }).conversationId);
    return recorder.live('browser', event.change, event.row, Number.isFinite(conv) ? { conv } : {});
  }
}
