// The acceptance app (`pi-durable-archil run --app test/acceptance/_app.ts`): one job per run, a pi conversation on
// pi-ai's faux model whose replies are a pure function of the transcript, so every incarnation on every host makes the
// same calls. Every model request first goes through the paid API's `model` route, keyed by conversation and turn: the
// rig counts repeated model turns there and can hold a turn in flight. The `paid_charge` tool performs the paid effect
// on the paid API's `charge` route, keyed by run and call id, and is not replay-safe: a call cut by a crash comes back
// interrupted on the next open and is never sent again.
//
// Jobs ($PDA_ACCEPT_JOB, JSON):
//   {"kind":"paid","charges":N}                         N paid charges in a row, then the answer "charged N"
//   {"kind":"agentic","cycles":K,"charges":N,"fileBytes":F}
//       K cycles of pi's coding tools on the run's workspace (write a file of F bytes, bash sha256sum, read it, edit it,
//       bash ls), with N paid charges spread between cycles, then the answer "done <steps> steps" (R2's shape)
// Environment: $PDA_ACCEPT_API the paid API's URL; $PDA_ACCEPT_OUT a directory outside the mount, where each run's
// events go to <run id>.jsonl; $PDA_HOLDER (set by the host driver) names the instance for the X-Writer header.
import { appendFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage, FauxResponseFactory, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Conversation, Cursor, EntryRecord, SettledSubmissionRecord, Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AppContext, AppOptions } from "../../src/app.ts";
import { ArchilCodingTools } from "../../src/env.ts";
import type { DurableRun } from "../../src/run.ts";
import { dispatch } from "../fixtures/paid-api.ts";

const ctx = BACKGROUND_CONTEXT;
export const PAID_TOOL = "paid_charge";
export const JOB_REQUEST_ID = "accept-job";

export type Job = { kind: "paid"; charges: number } | { kind: "agentic"; cycles: number; charges: number; fileBytes: number };

/** One step of a job: a tool call with a call id that is the same in every incarnation. */
export type Step = { id: string; name: string; arguments: ToolCall["arguments"] };

export function parseJob(text: string | undefined): Job {
  const job = JSON.parse(text ?? "null") as Job | null;
  if (job?.kind === "paid" && Number.isInteger(job.charges) && job.charges > 0) return job;
  if (job?.kind === "agentic" && Number.isInteger(job.cycles) && job.cycles > 0 && Number.isInteger(job.charges) && job.charges >= 0 && job.fileBytes > 0) return job;
  throw new Error(`not a job: ${text}`);
}

/** Deterministic file content of about `bytes` bytes, with one edit marker on its first line. */
export function fileText(cycle: number, bytes: number): string {
  const lines = [`edit-marker-${cycle}`];
  let size = lines[0]!.length + 1;
  let x = (cycle + 1) * 2654435761;
  for (let j = 0; size < bytes; j++) {
    let word = "";
    for (let k = 0; k < 60; k++) {
      x = (x * 1103515245 + 12345) >>> 0;
      word += String.fromCharCode(97 + (x % 26));
    }
    const line = `cycle ${cycle} line ${j} ${word}`;
    lines.push(line);
    size += line.length + 1;
  }
  return `${lines.join("\n")}\n`;
}

const plans = new Map<string, Step[]>();

/** Every step of `job`, in order. The model makes step k's call once the transcript holds k tool results. */
export function plan(job: Job): Step[] {
  const key = JSON.stringify(job);
  let steps = plans.get(key);
  if (!steps) plans.set(key, (steps = buildPlan(job)));
  return steps;
}

function buildPlan(job: Job): Step[] {
  if (job.kind === "paid") return Array.from({ length: job.charges }, (_, i) => ({ id: `charge-${i + 1}`, name: PAID_TOOL, arguments: { n: i + 1 } }));
  const steps: Step[] = [];
  const chargeAfter = new Map<number, number>();
  for (let n = 1; n <= job.charges; n++) chargeAfter.set(Math.max(1, Math.round((n * job.cycles) / (job.charges + 1))), n);
  for (let c = 1; c <= job.cycles; c++) {
    const f = `f${c}.txt`;
    steps.push({ id: `c${c}-write`, name: "write", arguments: { path: f, content: fileText(c, job.fileBytes) } });
    steps.push({ id: `c${c}-sum`, name: "bash", arguments: { command: `sha256sum ${f} >> sums.log && wc -l < sums.log` } });
    steps.push({ id: `c${c}-read`, name: "read", arguments: { path: f } });
    steps.push({ id: `c${c}-edit`, name: "edit", arguments: { path: f, edits: [{ oldText: `edit-marker-${c}\n`, newText: `edited-${c}\n` }] } });
    steps.push({ id: `c${c}-ls`, name: "bash", arguments: { command: "ls -1 | wc -l" } });
    const n = chargeAfter.get(c);
    if (n !== undefined) steps.push({ id: `charge-${n}`, name: PAID_TOOL, arguments: { n } });
  }
  return steps;
}

export const finalAnswer = (job: Job): string => (job.kind === "paid" ? `charged ${job.charges}` : `done ${plan(job).length} steps`);

const isSystem = (m: Message) => (m.role as string) === "system";

/**
 * What identifies one model turn on any host: the conversation, how many non-system messages its request carries, and a
 * hash of the last one. pi may add a system entry on another host (a section that names the workspace path), so system
 * messages are left out.
 */
export function turnOf(messages: readonly Message[], sessionId: string | undefined) {
  const visible = messages.filter((m) => !isSystem(m));
  const last = visible.at(-1);
  const results = visible.filter((m): m is ToolResultMessage => m.role === "toolResult");
  const digest = createHash("sha256").update(JSON.stringify(last ?? null)).digest("hex").slice(0, 12);
  return {
    key: `${sessionId ?? "session"}:${visible.length}:${digest}`,
    turn: visible.length,
    tools: results.length,
    paid: results.filter((r) => r.toolName === PAID_TOOL).length,
    last: last?.role === "toolResult" ? { role: last.role, toolName: last.toolName, toolCallId: last.toolCallId } : { role: last?.role ?? null },
  };
}

/**
 * The scripted reply: step k's tool call once the transcript holds k tool results, then the final answer. `responseId`
 * is stored with the assistant entry, so a row in the store names the instance that received it.
 */
export function reply(job: Job, messages: readonly Message[], responseId?: string): AssistantMessage {
  const steps = plan(job);
  const done = messages.filter((m) => m.role === "toolResult").length;
  const step = steps[done];
  const tag = responseId === undefined ? {} : { responseId };
  if (!step) return fauxAssistantMessage(finalAnswer(job), tag);
  return fauxAssistantMessage(fauxToolCall(step.name, step.arguments, { id: step.id }), { stopReason: "toolUse", ...tag });
}

/** The `responseId` of an assistant row: `<writer>|<turn key>`. */
export const responseIdOf = (writer: string, turnKey: string) => `${writer}|${turnKey}`;

/** The run's job result as data: what a clean and a crashed run must agree on. */
export interface JobResult {
  status: SettledSubmissionRecord["status"];
  final: string | null;
  calls: { id: string; name: string }[];
  results: { id: string; name: string; isError: boolean; interrupted: boolean; text: string }[];
  kinds: Record<string, number>;
}

async function entries(conversation: Conversation): Promise<EntryRecord[]> {
  const all: EntryRecord[] = [];
  let cursor;
  for (;;) {
    const page = await conversation.entries({}, 500, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) return all;
    cursor = page.next;
  }
}

const textOf = (content: readonly { type: string; text?: string }[]) => content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");

export async function jobResult(conversation: Conversation, settled: SettledSubmissionRecord): Promise<JobResult> {
  // Entries come newest first; ids grow with the transcript. An entry's `model` holds its messages.
  const items = (await entries(conversation)).sort((a, b) => Number(a.id) - Number(b.id));
  const kinds: Record<string, number> = {};
  for (const e of items) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const messagesOf = <T>(kind: string) => items.filter((e) => e.kind === kind).flatMap((e) => (Array.isArray(e.model) ? e.model : [e.model]) as T[]);
  const assistants = messagesOf<AssistantMessage>("pi.assistant");
  const calls = assistants.flatMap((m) => m.content.filter((c): c is ToolCall => c.type === "toolCall").map((c) => ({ id: c.id, name: c.name })));
  const results = messagesOf<ToolResultMessage>("pi.tool-result")
    .map((r) => {
      const text = textOf(r.content);
      return { id: r.toolCallId, name: r.toolName, isError: r.isError, interrupted: r.isError && /interrupted/i.test(text), text: text.slice(0, 200) };
    });
  const lastAnswer = assistants.findLast((m) => m.content.every((c) => c.type !== "toolCall"));
  return { status: settled.status, final: lastAnswer ? textOf(lastAnswer.content) : null, calls, results, kinds };
}

/** The job's rows as a store holds them, each model and paid row with the instance that wrote it. */
export interface StoreRows {
  conversations: number;
  kinds: Record<string, number>;
  /** Assistant rows in order: the tool calls each carries, and the writer and turn key from its `responseId`. */
  assistants: { calls: string[]; writer: string | null; turn: string | null }[];
  /** Tool-result rows in order; a paid one carries its receipt (the counter's seq) and writer. */
  results: { id: string; name: string; isError: boolean; interrupted: boolean; receipt: number | null; writer: string | null }[];
}

/** Read the job's rows straight from a store (another client's, after its release), oldest first. */
export async function storeRows(storage: Storage): Promise<StoreRows> {
  const all: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1000, cursor, ctx);
    all.push(...page.items);
    if (page.next === undefined) break;
    cursor = page.next;
  }
  all.sort((a, b) => Number(a.id) - Number(b.id));
  const conversations = (await storage.scanConversations({}, 1000, undefined, ctx)).items.length;
  const kinds: Record<string, number> = {};
  for (const e of all) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const messages = <T>(e: EntryRecord) => (Array.isArray(e.model) ? e.model : [e.model]) as T[];
  const assistants = all
    .filter((e) => e.kind === "pi.assistant")
    .flatMap((e) => messages<AssistantMessage>(e))
    .map((m) => {
      const [writer, turn] = m.responseId?.includes("|") ? m.responseId.split("|") : [null, null];
      return { calls: m.content.filter((c): c is ToolCall => c.type === "toolCall").map((c) => c.id), writer: writer ?? null, turn: turn ?? null };
    });
  const results = all
    .filter((e) => e.kind === "pi.tool-result")
    .flatMap((e) => messages<ToolResultMessage>(e))
    .map((r) => {
      const details = (r.details ?? {}) as { receipt?: unknown; writer?: unknown };
      return {
        id: r.toolCallId,
        name: r.toolName,
        isError: r.isError,
        interrupted: r.isError && /interrupted/i.test(textOf(r.content)),
        receipt: typeof details.receipt === "number" ? details.receipt : null,
        writer: typeof details.writer === "string" ? details.writer : null,
      };
    });
  return { conversations, kinds, assistants, results };
}

/** What the counter recorded of one request, as far as `lateRows` needs it. */
export type CounterRequest = { route: string; key: string; seq: number; writer: string | null; answeredAt: number | null };

/**
 * Rows a lost instance wrote from an answer it got after its loss: a model row whose turn the counter had not answered to
 * that instance before the loss, or a paid result whose receipt is not a charge answered to it before the loss. Its
 * rows from before the loss are the run's history and stay. `lost` tells the lost instance's writers apart.
 */
export function lateRows(rows: StoreRows, requests: readonly CounterRequest[], lossAt: number, lost: (writer: string | null) => boolean): string[] {
  const answeredBefore = (match: (r: CounterRequest) => boolean) => requests.some((r) => match(r) && lost(r.writer) && r.answeredAt !== null && r.answeredAt < lossAt);
  const late: string[] = [];
  for (const a of rows.assistants) {
    if (lost(a.writer) && !answeredBefore((r) => r.route === "model" && r.key === a.turn)) late.push(`assistant row for turn ${a.turn} [${a.calls.join(",")}]`);
  }
  for (const r of rows.results) {
    if (r.name === PAID_TOOL && lost(r.writer) && !answeredBefore((c) => c.route === "charge" && c.seq === r.receipt)) late.push(`result row ${r.id} receipt ${r.receipt}`);
  }
  return late;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export interface Ports {
  api: string;
  writer: string;
  note(event: string, extra?: Record<string, unknown>): void;
}

/** The harness options for `job`, without `env` (the run builds it on its claim). */
export function jobHarness(job: Job, runId: string, ports: Ports) {
  // A context window no job reaches: compaction would add summary requests the script does not answer.
  const faux = fauxProvider({ models: [{ id: "faux-accept", contextWindow: 100_000_000, maxTokens: 64_000 }] });
  const scripted: FauxResponseFactory = async (context, options) => {
    const turn = turnOf(context.messages, options?.sessionId);
    await dispatch(ports.api, "model", turn.key, { run: runId, ...turn }, { writer: ports.writer });
    return reply(job, context.messages, responseIdOf(ports.writer, turn.key));
  };
  faux.setResponses(Array.from({ length: 20_000 }, () => scripted));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const paidCharge = defineTool({
    name: PAID_TOOL,
    description: "Charge the customer once. A paid effect: never rerun after a crash.",
    parameters: Type.Object({ n: Type.Number() }),
    async execute(args, api) {
      const key = `${runId}:${api.callId}`;
      const answer = await dispatch(ports.api, "charge", key, { run: runId, n: args.n }, { writer: ports.writer });
      return { content: [{ type: "text" as const, text: `charged ${args.n}: receipt ${answer.seq}` }], details: { n: args.n, key, receipt: answer.seq, writer: ports.writer } };
    },
  });
  const registry = createRegistry();
  registry.install(ArchilCodingTools);
  registry.install(defineExtension({ name: "accept-paid", tools: [paidCharge] }));
  return { models, registry, agent: { model: { provider: model.provider, modelId: model.id } } };
}

/**
 * Run the job to its end on an open run: submit it (idempotent by request id, so a resumed run finds its submission),
 * wait, record the result and the store's size, then barrier, mark the run done and release it.
 */
export async function runJob(run: DurableRun, job: Job, agent: ReturnType<typeof jobHarness>["agent"], ports: Ports): Promise<JobResult> {
  const conversation = await run.harness.root(ctx, { agent });
  const submission = await conversation.submit({ type: "input", content: `acceptance job ${job.kind}`, requestId: JOB_REQUEST_ID }, ctx);
  ports.note("submitted", { submission: submission.id });
  const settled = await submission.wait(ctx);
  const result = await jobResult(conversation, settled);
  const pages = await run.store.database.get<{ page_count: number }>("PRAGMA page_count");
  const pageSize = await run.store.database.get<{ page_size: number }>("PRAGMA page_size");
  const store = {
    db: fileSize(join(run.claim.store, "run.sqlite")),
    wal: fileSize(join(run.claim.store, "run.sqlite-wal")),
    logical: Number(pages?.page_count ?? 0) * Number(pageSize?.page_size ?? 0),
  };
  ports.note("settled", { result, store });
  const b0 = performance.now();
  await run.claim.barrier();
  const barrierMs = performance.now() - b0;
  const d0 = performance.now();
  await run.setStatus("done", { job: job.kind, status: result.status });
  const doneMs = performance.now() - d0;
  const r0 = performance.now();
  await run.release();
  const releaseMs = performance.now() - r0;
  ports.note("done", { barrierMs: Math.round(barrierMs * 10) / 10, doneMs: Math.round(doneMs * 10) / 10, releaseMs: Math.round(releaseMs * 10) / 10, sealedSeq: run.record.sealedSeq });
  return result;
}

/** The `--app` factory. */
export default async function app(where: AppContext): Promise<AppOptions> {
  const job = parseJob(process.env.PDA_ACCEPT_JOB);
  const api = process.env.PDA_ACCEPT_API;
  const outDir = process.env.PDA_ACCEPT_OUT;
  if (!api || !outDir) throw new Error("PDA_ACCEPT_API and PDA_ACCEPT_OUT are required");
  const holder = JSON.parse(process.env.PDA_HOLDER ?? "{}") as { unit?: string; host?: string };
  const writer = `${holder.unit ?? holder.host ?? "instance"}:${process.pid}`;
  const out = join(outDir, `${where.ref.id}.jsonl`);
  let generation = 0;
  const ports: Ports = {
    api,
    writer,
    note: (event, extra = {}) => appendFileSync(out, `${JSON.stringify({ event, t: Date.now(), writer, unit: holder.unit ?? null, host: holder.host ?? null, generation, ...extra })}\n`),
  };
  ports.note("loaded", { job });
  const { models, registry, agent } = jobHarness(job, where.ref.id, ports);
  return {
    models,
    registry,
    async onOpen(run) {
      generation = run.generation;
      ports.note("opened", { pid: process.pid, work: run.claim.work });
      await runJob(run, job, agent, ports);
      process.exit(0);
    },
  };
}
