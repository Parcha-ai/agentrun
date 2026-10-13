// What a host hands the open packages, as one value, and `localHost`: the defaults that need no key. pi-ai's faux
// model answers from a script, the workflow's `call` reaches a tool in this process, the browser is the package's fake
// backend, and evidence, status and the record are files under the run's directory. Every fake call is counted in
// `<run>/ledger.jsonl`, which outlives a killed process.
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import type { ConversationId, Extension, ModelRef } from '@earendil-works/pi-durable';
import type { WorkflowDeps, WorkflowEvent } from '@parcha/agentrun-dsl';
import type { BrowserConfig, Decisions as BrowserDecisions, BrowserProvider, EvidenceRecord, PriceTable, ReconcileReport, SessionChange, SessionRow } from '@parcha/pi-browser';
import type { DriverFactory, PageDriver } from '@parcha/pi-browser/durable';
import { FakeBackend, fakeDriver, type FixturePage } from '@parcha/pi-browser/testing';
import type { LookEvent, LookRecord, MissEvent } from '@parcha/pi-vision';
import type { ChildEnv } from '@parcha/pi-vision/node';

/** Where one run lives: the disk package's `AppContext`. */
export type RunPlace = { id: string; root: string; work: string; store: string };

export type RunEffect = NonNullable<WorkflowDeps['runEffect']>;
export type RunJudge = NonNullable<WorkflowDeps['runJudge']>;
export type BrowserPlane = {
  /** Called per use; holds the provider's credentials in its closure. */
  provider(target: { conversationId: ConversationId; plane: string; config: BrowserConfig }): BrowserProvider | Promise<BrowserProvider>;
  driver: DriverFactory<PageDriver>;
  prices?: Partial<PriceTable>;
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

export type Host = {
  /** 1. pi-ai's models, and the one the lead runs. */
  models: { catalog: Models; lead: ModelRef };
  /** 2. The host's own pi extensions, the door a workflow's `call` goes through, and the browser plane. */
  tools: { extensions: readonly Extension[]; runEffect: RunEffect; browser: BrowserPlane };
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

/** One fake call. A model call also names its conversation: the `sessionId` pi-durable keeps for it and hands the
 *  provider, the same in every process of the run. */
export type LedgerRow = { kind: 'model' | 'tool' | 'judge'; name: string; pid: number; conversation?: string };

const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const quiet = <T,>(report: (event: T) => void) => (event: T) => { try { report(event); } catch { /* a status row never fails a call */ } };

export type LocalHost = { host: Host; backend?: FakeBackend; ledger(): LedgerRow[]; evidence(): string[] };

export function localHost(place: RunPlace, fakes: Fakes, options: { browser?: BrowserPlane } = {}): LocalHost {
  const ledgerFile = join(place.root, 'ledger.jsonl');
  const eventsFile = join(place.root, 'events.jsonl');
  // Both logs exist from the start: a run that called nothing leaves an empty ledger, and a missing one was lost.
  for (const log of [ledgerFile, eventsFile]) appendFileSync(log, '');
  const count = (kind: LedgerRow['kind'], name: string, conversation?: string) =>
    appendFileSync(ledgerFile, json({ kind, name, pid: process.pid, ...(conversation ? { conversation } : {}) }));
  const status = quiet((event: StatusEvent) => appendFileSync(eventsFile, json(event)));

  const faux = fakes.lead ? fauxProvider({ models: [{ id: 'faux-1', input: fakes.lead.input }] }) : fauxProvider();
  faux.setResponses(Array.from({ length: 64 }, () => (context, stream) => {
    count('model', `turn ${context.messages.filter((message) => message.role === 'toolResult').length}`, stream?.sessionId);
    return fakes.model(context.messages);
  }));
  const catalog = createModels();
  catalog.setProvider(faux.provider);

  const classifyPage = fakes.page;
  const backend = options.browser ? undefined : new FakeBackend({ start: fakes.start, pages: fakes.pages });
  const browser: BrowserPlane = options.browser ?? { provider: () => backend!.provider, driver: fakeDriver(backend!) as DriverFactory<PageDriver> };

  const host: Host = {
    models: { catalog, lead: { provider: faux.provider.id, modelId: faux.getModel().id } },
    tools: {
      extensions: [],
      runEffect: async ({ node, input }) => {
        const tool = node.tool === undefined ? undefined : fakes.tools[node.tool];
        if (!tool) throw new Error(`no tool ${node.tool} in this host`);
        count('tool', node.tool!);
        return tool(input);
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
        return { path };
      },
    },
    decisions: {
      runJudge: async (request) => { count('judge', request.label); return fakes.judge(request); },
      ...(classifyPage ? { browser: { classifyPage: async (page) => { count('judge', `page ${page.url}`); return classifyPage(page); } } } : {}),
    },
    status,
    async deliver(result) {
      await mkdir(join(place.root, 'out'), { recursive: true });
      await writeFile(join(place.root, 'out', 'record.json'), JSON.stringify({ ...result, evidence: evidence() }, null, 2));
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
