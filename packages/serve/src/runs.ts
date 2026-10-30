// Runs: each one a child process (`pi-durable-disk run` on `<data>/runs/<id>` with serve's app), pinned to a revision in
// the agent store. An agentic run is read live through the door its process serves on loopback; a workflow run is
// working while its process lives. Once the process has exited the run is read from its store, read-only, and carried
// back to the agent store (`carryBack`), and it is finished. A run whose process went before the run ended is opened
// again on its directory, and resumes from its store.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { open as openFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { AgentHomeError, type Revision, type RevisionKind, type RunRow, type RunState } from "@parcha/pi-durable-agent";
import { registerLabel, timelineOf, timelineReducer, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { DEFAULT_HARNESS, FAUX_HARNESS_ENV, steersMidTurn } from "./harness.js";
import { type AgentEntry, type Agents, storeBusy, storeError, whenFree } from "./agents.js";
import { readJson, RUN_CANCELLED, RUN_META, writeWhole } from "./files.js";
import { type BoxView, UNSANDBOXED_RUN_LINE } from "./box/config.js";
import { type BoxHost, type Quarantine, settleBox, sweepBoxes } from "./box/sweep.js";
import { FAUX_WEB_ENV } from "./fetch-page.js";
import { ASK_TOOL, FAUX_BROWSER_ENV } from "./tools.js";
import { ApiError } from "./errors.js";
import { CAP_ENV, SPEND_CAP_REACHED } from "./cap.js";
import { EFFORT_ENV, FAUX_ENV } from "./model.js";
import { durationMs } from "./print.js";
import { ChangeClock, type Page, RowLog } from "./rows.js";
import { isObject, type Json } from "./validate.js";

export type Status = "queued" | "working" | "input_required" | "completed" | "failed" | "cancelled";
export type State = "working" | "waiting" | "idle";
export const STATUSES: readonly Status[] = ["queued", "working", "input_required", "completed", "failed", "cancelled"];
type Ended = Exclude<RunState, "running">;
const TERMINAL = new Set<Status>(["completed", "failed", "cancelled"]);
const RELEASED = new Set(["sleeping", "paused", "done", "failed"]);
const LEASE_MS = 90_000;
/** How long an agentic run's process may finish its turn after SIGTERM, unless the server says otherwise. */
const DRAIN = "30s";
/** The run process's stderr, beside run.json: a file, so the process outlives a server that stops without stopping it. */
const PROCESS_LOG = "process.log";
/** How long a request waits for a run's door: its process coming up, or a settle in progress. */
const READY_TIMEOUT_MS = 45_000;
const QUIET = /:run:(start|end)$/;
const RETRY_CODES = ["OPENING", "PARKING", "RELEASED"];
/** How often one server opens a run again whose process went before the run ended, before it fails the run. */
const MAX_RELAUNCHES = 3;
/** How often a run's end that the agent store refused is written again. */
const SETTLE_RETRY_MS = 30_000;
/** How a run ended in the store, as its status: the store's `stopped` is v2's `cancelled`. */
const STATUS_OF: Record<Ended, Status> = { completed: "completed", failed: "failed", escalated: "failed", stopped: "cancelled" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// A run's process that exited and was never reaped (a zombie, under a PID 1 that does not reap) is not alive.
const alive = processAlive;
/** Waits between carry backs that found the store busy: each attempt itself waits 5 s for the store's lock. */
const CARRY_BACK_RETRIES_MS = [500, 1_000, 2_000, 4_000, 8_000];
/** How long a run's process may live on after it released the run before its store is read anyway: the process holds the
 *  store's exclusive lock until it exits. */
const EXIT_AFTER_RELEASE_MS = 30_000;
/** How many 500 ms ticks in a row a live run's record is unreadable before the server says so. */
const UNREADABLE_TICKS = 10;
const warn = (runId: string, text: string) => void process.stderr.write(`agentrun-serve: run ${runId}: ${text}\n`);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isLoopback = (host: string) => host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);
const holderPid = (record: Json | null) => (isObject(record?.holder) && Number.isSafeInteger(record.holder.pid) ? (record.holder.pid as number) : undefined);
type WorkflowEnding = { status: "complete" | "escalated" | "refused" | "stopped"; code?: string; message?: string };
/** How a workflow run's workflow ended, as its app wrote it in the run's final status: absent until it ended. */
function workflowEnding(record: Json | null): WorkflowEnding | undefined {
  const detail = isObject(record?.detail) ? record.detail : undefined;
  if (!RELEASED.has(String(record?.status)) || !["complete", "escalated", "refused", "stopped"].includes(String(detail?.workflow))) return undefined;
  return { status: detail!.workflow as WorkflowEnding["status"], ...(typeof detail!.code === "string" ? { code: detail!.code } : {}), ...(typeof detail!.message === "string" ? { message: detail!.message } : {}) };
}

type RunMeta = {
  /** The box as this run saw it at its start (capabilities.box then): its mode, cgroup and egress. */
  box?: BoxView;
  title: string;
  created_at: string;
  /** The run's input: an agentic run's first message is its `content`, a workflow run's input is the whole of it. */
  input?: Json;
  effort?: string;
  max_cost_usd?: number;
  error?: { code: string; message: string };
  /** A workflow run's output, once it completed. */
  output?: unknown;
  /** Where the run stood when its turn was stopped: the person's last message, by its timeline row's id (its store
   *  entry's), or the root conversation's place 0 before any. It stays stopped until a message newer than that is shown. */
  stopped_at?: string;
  /** A run stopped by an older server: how many messages the person had sent then. Read only when `stopped_at` is not. */
  stopped_after?: number;
};
type RunError = { code: string; message: string; retryable: boolean };

/** An ended run's error from its row and serve.json: an escalated workflow says so (`escalated`, with its summary), a
 *  failed run keeps its own. */
const errorOfRow = (row: RunRow, meta: Partial<RunMeta> | null): RunError =>
  row.state === "escalated"
    ? { code: "escalated", message: row.summary ?? meta?.error?.message ?? "The workflow escalated.", retryable: false }
    : { code: meta?.error?.code ?? "run_failed", message: meta?.error?.message ?? row.summary ?? "The run failed.", retryable: false };

/** One run as this server holds it. */
export type Run = {
  id: string;
  agentId: string;
  kind: RevisionKind;
  revision: string;
  /** The harness its revision names, read at its first message. */
  harness?: string;
  /** The revision's number among its agent's. */
  version: number;
  dir: string;
  meta: RunMeta;
  log: RowLog;
  /** The run's rows as they come in (before the log names them), with each `ask_person` answer's waiting row. */
  rows: TimelineEvent[];
  /** The whole text of the run's newest assistant message: a row's text is cut at 2000 characters, an answer is not. */
  answerText?: string;
  child?: ChildProcess;
  /** The pid of a run process an earlier server started that still serves the run: supervised by its run.json. */
  orphan?: number;
  /** Adopted with a saved stop: its first snapshot is checked once, and a turn still working is aborted. */
  finishStop?: boolean;
  /** A completed run opening again for a follow-up: every follow-up meanwhile waits for this one, never a second. */
  reopening?: Promise<void>;
  feed?: AbortController;
  /** An agentic run's turn is running; a workflow run's process serves. */
  working: boolean;
  /** Messages this server sent the run that its rows do not show yet. */
  submitted: number;
  /** The user_message rows the run has shown, by id: one shown for the first time is a submitted message arriving. */
  users: Set<string>;
  /** The rows the live path has shown as live, by id, over every connection to the run's door. */
  live: Set<string>;
  cancel: boolean;
  /** Set when the run has answered or failed and is being let go; the outcome it gets. */
  finishing?: Status;
  endedAt?: string;
  outcome?: Status;
  error?: RunError;
  /** The cost the store recorded when it carried the run back. */
  costUsd?: number;
  relaunches: number;
  settled: boolean;
  settling?: Promise<void>;
  /** The newest write of its serve.json: one at a time, in order. */
  saving?: Promise<void>;
  /** Settles of this run not yet done: while any is, nothing starts its process again. */
  settles: number;
  updatedAt: string;
};

const ASKED = "Asked you: ";
registerLabel(ASK_TOOL, (args) => `${ASKED}${typeof args.question === "string" ? args.question : ""}`);

/** The waiting row after each answered `ask_person` call, which the timeline module does not know. The question comes
 *  from the call's row, whose label this module registers. */
export function withAsks(rows: readonly TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const questions = new Map<string, string>();
  for (const row of rows) {
    out.push(row);
    if (row.kind === "tool_use" && row.tool_name === ASK_TOOL && row.tool_use_id && row.summary?.startsWith(ASKED)) questions.set(row.tool_use_id, row.summary.slice(ASKED.length));
    if (row.kind === "tool_result" && row.tool_name === ASK_TOOL && row.tool_status === "success") {
      const question = questions.get(row.tool_use_id ?? "") || "the agent asked you a question";
      out.push({ ...row, id: `${row.id}:waiting`, kind: "waiting", summary: `Waiting for you: ${clip(question, 480)}`, text: clip(question, 2000), tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null });
    }
  }
  return out;
}

/** Notes the whole text of the newest assistant message in `entries` (pi's stored entries). */
function noteAnswer(run: Run, entries: readonly unknown[]): void {
  for (const value of entries) {
    if (!isObject(value) || value.kind !== "pi.assistant" || !Array.isArray(value.model) || !isObject(value.model[0])) continue;
    const content = value.model[0].content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => isObject(b) && b.type === "text").map((b) => String((b as Json).text ?? "")).join("\n").trim() : "";
    if (text) run.answerText = text;
  }
}

const meaningful = (rows: readonly TimelineEvent[]) => rows.findLast((r) => r.kind !== "usage" && r.kind !== "phase" && !QUIET.test(r.id));
const answerOf = (rows: readonly TimelineEvent[]) => {
  const last = meaningful(rows);
  return last?.kind === "final_answer" || last?.kind === "text_block" ? last : undefined;
};
const usageOf = (rows: readonly TimelineEvent[]) => rows.findLast((r) => r.kind === "usage");
/** The run's cost from its usage row: null when a response's cost is unknown, 0 before any request. */
const costOf = (rows: readonly TimelineEvent[]): number | null => {
  const usage = usageOf(rows);
  return usage ? (usage.usage?.usd ?? null) : 0;
};
/** A run's cost for its views: its usage row's, else what the store kept when it carried the run back (0 before any
 *  request). A usage row that says unknown, or says nothing, stays unknown: what the store kept dates from before a
 *  follow-up. */
export function costView(rows: readonly TimelineEvent[], stored: number | undefined): number | null {
  const usage = usageOf(rows);
  if (!usage) return stored ?? 0;
  return usage.usage?.usd ?? null;
}
/** The whole text of the run's newest answer, paid for: an assistant message's, else its newest answer row's. */
const lastAnswer = (run: Run) => run.answerText ?? run.rows.findLast((r) => r.kind === "final_answer" || r.kind === "text_block")?.text ?? null;
const usersOf = (rows: readonly TimelineEvent[]) => rows.filter((r) => r.kind === "user_message").length;
const lastUserMessage = (rows: readonly TimelineEvent[]) => rows.findLast((r) => r.kind === "user_message")?.id;
// A row's place in the store: its entry's id. The store mints conversation and entry ids from one counter, so entry ids
// order rows across conversations and the conversation is no part of the order.
const placeOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));
/** Whether the turn a stop ended is still where the run stands: no message shown is newer than the stop's. By order,
 *  never by a count or by the stopped message itself, which a compaction can take off the rows. */
export const stoppedAt = (meta: { stopped_at?: string; stopped_after?: number }, rows: readonly TimelineEvent[]): boolean => {
  if (meta.stopped_at === undefined) return meta.stopped_after !== undefined && meta.stopped_after === usersOf(rows);
  const at = placeOf(meta.stopped_at);
  return !rows.some((r) => r.kind === "user_message" && placeOf(r.id) > at);
};
const stopped = (run: Run) => stoppedAt(run.meta, run.rows);
/** What a stop keeps of where the run stands: the person's last message, by its id, or the place before any. */
export const stopMark = (rows: readonly TimelineEvent[]): { stopped_at: string } => ({ stopped_at: lastUserMessage(rows) ?? `${ROOT_CONVERSATION_ID}:0` });

/** The rows a snapshot that no longer holds them leaves served: those committed entries made. A row any connection
 *  showed live is not one (`live` holds them for the run), so a live row that ended while the door was away goes. */
export function keepCommitted(live: Set<string>, rows: readonly TimelineEvent[], isLive: (id: string) => boolean): (id: string) => boolean {
  for (const row of rows) if (isLive(row.id)) live.add(row.id);
  return (id) => !live.has(id) && !isLive(id);
}

/** A run's status and state, by the contract's table. */
export function statusOf(run: Run): { status: Status; state: State } {
  if (run.outcome) return { status: run.outcome, state: "idle" };
  if (run.finishing) return { status: run.finishing, state: "idle" };
  if (run.kind === "workflow") return { status: run.working ? "working" : "queued", state: "working" };
  const users = usersOf(run.rows);
  if (run.submitted > 0) return { status: users ? "working" : "queued", state: "working" };
  // No rows is a run not shown yet (adopted, before its first snapshot), whatever an old stop says. Rows with no
  // message of the person's are a compaction's (it shows its summary), which can summarize every message of a stop.
  if (!run.rows.length) return { status: "queued", state: "working" };
  if (stopped(run)) return { status: "input_required", state: "idle" };
  if (!users) return { status: "queued", state: "working" };
  if (run.working) return { status: "working", state: "working" };
  if (meaningful(run.rows)?.kind === "waiting") return { status: "input_required", state: "waiting" };
  return { status: "working", state: "idle" };
}

/** The waits between carry backs that found the store busy, and a hook called at each such refusal. */
export type CarryBackRetry = { delaysMs?: readonly number[]; onBusy?: (runId: string, attempt: number) => void };
/** `token` is the server's own: no run's process sees it. */
/** `maxRuns`: the most runs with a live process at once; `settleRetryMs`: how often a carry back the store refused is
 *  tried again; `readyTimeoutMs`: how long a request to a run waits for its door (a run's first message, sent by its
 *  start, always waits READY_TIMEOUT_MS); `log` takes a run's start and end (print.ts). */
export type RunsOptions = { agents: Agents; token: string; doorTokenFile: string; doorToken: string; faux?: string; fauxBrowser?: string; fauxWeb?: string; fauxHarness?: string; drainTimeout?: string; carryBackRetry?: CarryBackRetry; maxRuns?: number; boxView?: BoxView; box?: { host: BoxHost; quarantine: Quarantine }; settleRetryMs?: number; readyTimeoutMs?: number; log?: (event: string, fields: Record<string, string | number>) => void };

/** The server's own variables, which a run's process never gets: the API token, by name or by value. Model keys, the
 *  AGENT_MODEL variables and the rest of the environment pass; the door token goes by file. */
const SERVER_ONLY = new Set(["AGENTRUN_TOKEN", "AGENTRUN_API_KEY"]);
export const childEnv = (env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name, value]) => !SERVER_ONLY.has(name) && value !== token));

/** One line of the run process's log in words: pi-durable-disk writes JSON lines (`{at, event, message, ...}`). */
function inWords(line: string): string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isObject(value)) return line;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  return [text("event"), text("message") ?? text("error")].filter(Boolean).join(": ") || "the run's process left no message";
}

/** The last line of the run process's log, in words, for a failure's message. */
async function lastLogLine(run: Run): Promise<string> {
  const file = await openFile(join(run.dir, PROCESS_LOG)).catch(() => null);
  if (!file) return "";
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 4096);
    const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length);
    return clip(inWords(buffer.toString("utf8").trim().split("\n").at(-1) ?? ""), 300);
  } finally {
    await file.close();
  }
}

export class Runs {
  private readonly runs = new Map<string, Run>();
  private readonly adopting = new Map<string, Promise<Run>>();
  private readonly clock = new ChangeClock();
  private readonly cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@parcha/pi-durable-disk")));
  private readonly app = fileURLToPath(new URL("./app.js", import.meta.url));
  private closing = false;
  /** Set once `close` is done: the store is closed, so nothing settles after it. */
  private closed = false;
  /** Runs past the cap's check whose process is not started yet. */
  private starting = 0;
  /** The start sweep of the boxes runs left: once, before any run opens a box (sweepOnce). */
  private swept?: Promise<void>;
  constructor(private readonly options: RunsOptions) {}

  private get store() {
    return this.options.agents.store;
  }

  // ---- reading --------------------------------------------------------------------------------------------------------

  /** Run `id`, read from the agent store the first time this process sees it. */
  async get(id: string): Promise<Run | null> {
    const known = this.runs.get(id);
    if (known) return known;
    const row = await this.options.agents.request(() => this.store.readRun(id));
    return row ? this.adopt(row) : null;
  }

  /** One Run per run id, however many requests ask for it at once. */
  private adopt(row: RunRow): Promise<Run> {
    const known = this.runs.get(row.id);
    if (known) return Promise.resolve(known);
    let pending = this.adopting.get(row.id);
    if (!pending) {
      pending = this.load(row).finally(() => this.adopting.delete(row.id));
      this.adopting.set(row.id, pending);
    }
    return pending;
  }

  private async load(row: RunRow): Promise<Run> {
    const dir = join(this.options.agents.dir, "runs", row.id);
    const stored = (await readJson(join(dir, RUN_META))) as Partial<RunMeta> | null;
    const meta: RunMeta = {
      title: typeof stored?.title === "string" ? stored.title : "",
      created_at: typeof stored?.created_at === "string" ? stored.created_at : row.startedAt,
      ...(isObject(stored?.input) ? { input: stored.input } : {}),
      ...(typeof stored?.effort === "string" ? { effort: stored.effort } : {}),
      ...(typeof stored?.max_cost_usd === "number" ? { max_cost_usd: stored.max_cost_usd } : {}),
      ...(stored?.error ? { error: stored.error } : {}),
      ...(stored && "output" in stored ? { output: stored.output } : {}),
      ...(typeof stored?.stopped_at === "string" ? { stopped_at: stored.stopped_at } : {}),
      ...(typeof stored?.stopped_after === "number" ? { stopped_after: stored.stopped_after } : {}),
      ...(isObject(stored?.box) && typeof stored.box.mode === "string" ? { box: stored.box as BoxView } : {}),
    };
    const run = this.blank(row, dir, meta, (await this.options.agents.revisions(row.agent)).find((r) => r.id === row.revision)?.version ?? 0);
    this.runs.set(row.id, run);
    const record = await this.record(run);
    // Only a store no live instance holds is opened: released, or left by an instance whose lease lapsed.
    if (row.state !== "running" || !this.doorOf(record)) await this.storeWhenFree(run);
    if (row.state !== "running") {
      run.outcome = STATUS_OF[row.state];
      run.endedAt = row.endedAt;
      if (row.costUsd !== undefined) run.costUsd = row.costUsd;
      if (run.outcome === "failed") run.error = errorOfRow(row, meta);
      run.settled = true;
    } else if (record && this.doorOf(record)) {
      // A server that died between saving a stop and its abort reaching the run leaves the turn working.
      run.finishStop = run.meta.stopped_at !== undefined || run.meta.stopped_after !== undefined;
      this.adoptProcess(run, record);
    }
    this.refresh(run);
    return run;
  }

  private blank(row: Pick<RunRow, "id" | "agent" | "revision" | "kind">, dir: string, meta: RunMeta, version: number): Run {
    return {
      id: row.id, agentId: row.agent, kind: row.kind, revision: row.revision, version, dir, meta, log: new RowLog(this.clock), rows: [],
      working: false, submitted: 0, users: new Set(), live: new Set(), cancel: false, relaunches: 0, settled: false, settles: 0, updatedAt: meta.created_at,
    };
  }

  /** Writes the run's serve.json as it is when its turn comes. */
  private saveMeta(run: Run): Promise<void> {
    run.saving = (run.saving ?? Promise.resolve()).catch(() => undefined).then(() => writeWhole(join(run.dir, RUN_META), `${JSON.stringify(run.meta)}\n`));
    return run.saving;
  }

  private record(run: Run): Promise<Json | null> {
    return readJson(join(run.dir, "run.json"));
  }

  /** The door a live run serves, from its run.json: running, a fresh heartbeat, and a loopback address. */
  private doorOf(record: Json | null): string | undefined {
    if (record?.status !== "running" || !isObject(record.holder) || typeof record.holder.serve !== "string") return undefined;
    // A run's process is a process on this machine: one that is gone serves no door, however fresh its heartbeat.
    const pid = holderPid(record);
    if (pid !== undefined && !alive(pid)) return undefined;
    if (typeof record.heartbeatAt !== "string" || Date.now() - Date.parse(record.heartbeatAt) >= LEASE_MS) return undefined;
    const url = URL.parse(record.holder.serve);
    return url?.protocol === "http:" && isLoopback(url.hostname) ? url.origin : undefined;
  }

  private storeFile(run: Run): string {
    return join(run.dir, "store", "run.sqlite");
  }

  /** The run's rows from its store, opened read-only; only once its claim is released. An agentic run's rows are its
   *  root conversation's; a workflow run's are its model nodes'. */
  private async readStore(run: Run): Promise<void> {
    const file = this.storeFile(run);
    if (!(await stat(file).catch(() => null))) return;
    const { DatabaseSync } = await import("node:sqlite");
    const entries: Json[] = [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = run.kind === "workflow"
        ? db.prepare("SELECT record FROM entries ORDER BY id").iterate()
        : db.prepare("SELECT record FROM entries WHERE conversation_id = (SELECT MIN(conversation_id) FROM entries) ORDER BY id").iterate();
      for (const row of rows) entries.push(JSON.parse(String((row as { record: string }).record)) as Json);
    } finally {
      db.close();
    }
    run.working = false;
    noteAnswer(run, entries);
    this.take(run, timelineOf(entries as never, { settled: true }));
  }

  /** New rows in: into the log, then the run's status, then whatever the status asks for. */
  /** `keep`: rows that stay served though `rows` no longer holds them (the live path's committed rows). */
  private take(run: Run, rows: TimelineEvent[], keep?: (id: string) => boolean): void {
    run.rows = withAsks(rows);
    // Counted by id: a snapshot of a compacted conversation shows fewer user messages than before, which is not more
    // messages waiting, so a count of rows would leave the run working forever.
    const arrived = run.rows.filter((r) => r.kind === "user_message" && !run.users.has(r.id));
    for (const row of arrived) run.users.add(row.id);
    run.submitted = Math.max(0, run.submitted - arrived.length);
    if (run.log.sync(run.rows, keep)) run.updatedAt = new Date().toISOString();
    this.refresh(run);
  }

  /** A live process: the child this server started, or one an earlier server started that still serves the run. */
  private live(run: Run): boolean {
    return Boolean(run.child || run.orphan);
  }

  /** How an agentic run ends, from its rows: over its cap, a model error, or an answer. Undefined while it works, or
   *  when it stopped, waits or parked. A workflow run ends when its workflow does. */
  private decide(run: Run): { outcome: Status; error?: RunError; abort?: boolean } | undefined {
    if (run.kind === "workflow") return undefined;
    const cap = run.meta.max_cost_usd;
    const cost = costOf(run.rows);
    if (cap !== undefined && cost !== null && cost > cap) return { outcome: "failed", abort: true, error: { code: SPEND_CAP_REACHED, message: `The run cost $${cost.toFixed(4)}, over its cap of $${cap}.`, retryable: false } };
    if (run.working || run.submitted > 0) return undefined;
    const last = meaningful(run.rows);
    // The cap's refusal in the run's process (cap.ts); a provider error with this exact prefix would read as one too.
    if (last?.kind === "error" && last.text?.startsWith(`${SPEND_CAP_REACHED}: `)) return { outcome: "failed", error: { code: SPEND_CAP_REACHED, message: last.text.slice(SPEND_CAP_REACHED.length + 2), retryable: false } };
    if (last?.kind === "error") return { outcome: "failed", error: { code: "run_failed", message: last.text ?? last.summary ?? "The run failed.", retryable: false } };
    return !stopped(run) && answerOf(run.rows) ? { outcome: "completed" } : undefined;
  }

  /** Records the run's status as a change when it moves, and lets go of a live run that answered, failed or is over its cap. */
  private refresh(run: Run): void {
    this.mark(run);
    if (!this.live(run) || run.finishing || run.outcome) return;
    const end = this.decide(run);
    if (!end) return;
    if (end.error) run.error = end.error;
    this.finish(run, end.outcome, end.abort);
  }

  /** Let go of a live run with `outcome`: SIGTERM, after aborting its turn when it is still working. */
  private finish(run: Run, outcome: Status, abortFirst = false): void {
    run.finishing = outcome;
    run.endedAt = new Date().toISOString();
    this.mark(run);
    void (abortFirst ? this.abortTurn(run) : Promise.resolve()).then(() => this.terminate(run));
  }

  /** SIGTERM to the run's process: it drains, releases the run and exits. */
  private terminate(run: Run): void {
    if (run.child) run.child.kill("SIGTERM");
    else if (run.orphan && alive(run.orphan)) process.kill(run.orphan, "SIGTERM");
  }

  /** Supervise a run process an earlier server started: follow its door, and settle the run once its run.json says it
   *  let go (released, or its lease lapsed) or the process is gone. */
  private adoptProcess(run: Run, record: Json): void {
    const pid = holderPid(record);
    if (!pid) return;
    run.orphan = pid;
    this.connect(run);
    let releasedAt: number | undefined;
    let unreadable = 0;
    const timer = setInterval(() => {
      void this.record(run).then((now) => {
        if (now !== null) unreadable = 0;
        if (run.orphan !== pid || (this.doorOf(now) && alive(pid))) return;
        // A record that cannot be read while the process lives is read again at every tick: settling on no record could
        // leave the run unsettled and unwatched. The server says so once the record has been unreadable for a while.
        if (now === null && alive(pid)) {
          if (++unreadable === UNREADABLE_TICKS) warn(run.id, `its run.json has been unreadable for ${UNREADABLE_TICKS / 2} s; still watching its process ${pid}`);
          return;
        }
        if (RELEASED.has(String(now?.status)) && alive(pid)) {
          releasedAt ??= Date.now();
          if (Date.now() - releasedAt < EXIT_AFTER_RELEASE_MS) return;
          warn(run.id, `its process ${pid} released the run ${EXIT_AFTER_RELEASE_MS / 1000} s ago and has not exited; reading its store anyway`);
        }
        clearInterval(timer);
        run.orphan = undefined;
        void this.settle(run, null, !alive(pid) && !RELEASED.has(String(now?.status)));
      });
    }, 500);
    timer.unref();
  }

  /** At start: every run the store says is running is read, supervised when its process lives, carried back when it
   *  already ended, and opened again when its process went before it ended. */
  /** Every run's box let go that nothing owns, and every run cgroup no record names: once, before any run of this server
   *  starts, opens again or relaunches, so a box or cgroup being made is never swept away. */
  private sweepOnce(): Promise<void> {
    const box = this.options.box;
    if (!box) return Promise.resolve();
    this.swept ??= (async () => {
      const rows = await this.options.agents.request(() => this.store.listRuns());
      const settled = await sweepBoxes(box.host, box.quarantine, rows.map((row) => ({ id: row.id, dir: join(this.options.agents.dir, "runs", row.id) })));
      for (const [id, how] of Object.entries(settled)) if (how === "quarantined") warn(id, "its box could not be emptied; it is quarantined, and tried again at each start");
    })();
    return this.swept;
  }

  /** The run's box let go (archive, or its process gone after an archive): reaped by the box's own count. */
  private async teardown(run: Run): Promise<void> {
    const box = this.options.box;
    if (!box || this.live(run)) return;
    if ((await settleBox(box.host, box.quarantine, run.id, run.dir)) === "quarantined") warn(run.id, "its box could not be emptied; it is quarantined, and tried again at each start");
  }

  /** After an archive (a run's, or an agent's, which archives its runs): the box of every run now archived is let go,
   *  now when its process is gone, else when it exits. */
  async archived(): Promise<void> {
    if (!this.options.box) return;
    for (const row of await this.options.agents.request(() => this.store.listRuns())) {
      if (!row.archivedAt) continue;
      const run = await this.get(row.id);
      if (run) await this.teardown(run);
    }
  }

  async recover(): Promise<void> {
    await this.sweepOnce();
    for (const row of await this.options.agents.request(() => this.store.listRuns())) {
      if (row.state !== "running") continue;
      const run = await this.adopt(row).catch((error: Error) => (warn(row.id, `not recovered: ${error.message}; the next start tries again`), null));
      if (run && !this.live(run) && !run.outcome) await this.settle(run, null, false);
    }
  }

  /** The run's status, state and whether its rows are all in, as one more change of its log when any of them moves. */
  private mark(run: Run): void {
    const { status, state } = statusOf(run);
    if (run.log.setState(`${status}/${state}/${run.settled}`)) run.updatedAt = new Date().toISOString();
  }

  // ---- the door -------------------------------------------------------------------------------------------------------

  private headers(json = false): Record<string, string> {
    return { authorization: `Bearer ${this.options.doorToken}`, ...(json ? { "content-type": "application/json" } : {}) };
  }

  /** Follow the door's events into an agentic run's rows, again after each drop while the process lives. A workflow
   *  run is only watched: the door's events are a root conversation's, and a workflow run has none. */
  private connect(run: Run): void {
    if (run.feed) return;
    const abort = new AbortController();
    run.feed = abort;
    void (async () => {
      while (!abort.signal.aborted) {
        const door = this.doorOf(await this.record(run));
        if (door && run.kind === "workflow") {
          if (!run.working && !run.outcome) {
            run.working = true;
            this.refresh(run);
          }
        } else if (door) await this.follow(run, door, abort.signal).catch(() => undefined);
        if (abort.signal.aborted || (!this.live(run) && !this.doorOf(await this.record(run)))) break;
        await sleep(run.kind === "workflow" ? 500 : 200);
      }
      if (run.feed === abort) run.feed = undefined;
    })();
  }

  private async follow(run: Run, door: string, signal: AbortSignal): Promise<void> {
    const reducer = timelineReducer();
    const up = await fetch(new URL("/events", door), { signal, headers: { ...this.headers(), accept: "text/event-stream" } });
    if (!up.ok || !up.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of up.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) >= 0; ) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        let value: unknown;
        try {
          value = JSON.parse(data.join("\n"));
        } catch {
          continue;
        }
        if (event === "end") return;
        const events = event === "snapshot" ? [value as Json] : event === "events" && Array.isArray(value) ? (value as Json[]) : [];
        if (event === "snapshot") run.working = Boolean((value as Json).run);
        for (const e of events) if (e.type === "run_start" || e.type === "run_end") run.working = e.type === "run_start";
        noteAnswer(run, events.flatMap((e) => (Array.isArray(e.entries) ? e.entries : e.entry !== undefined ? [e.entry] : [])));
        reducer.apply(events as never);
        // A snapshot rebuilds from the conversation's current view: after a compaction it holds fewer of the rows
        // already shown, which stay; only live rows go when they end.
        const rows = reducer.rows();
        this.take(run, rows, keepCommitted(run.live, rows, reducer.isLive));
        if (event === "snapshot" && run.finishStop) {
          run.finishStop = false;
          if (run.working && stopped(run) && run.submitted === 0) void this.abortTurn(run);
        }
      }
    }
  }

  /** The door of a run that is not finished, starting or waking its process when it is not live. */
  private async ensureLive(run: Run, timeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (let launched = false; ; await sleep(100)) {
      const record = await this.record(run);
      // Checked after the read: a settle may end the run while it is read, and nothing starts a run that ended.
      if (run.outcome || run.finishing || run.cancel) throw this.finished(run);
      const door = this.doorOf(record);
      if (door) return door;
      if (!this.live(run)) {
        // A process that just went is being settled: its run may be over, so nothing starts it again before that.
        if (run.settles > 0) {
          // Within the time left: a settle waiting on a busy store must not hold this caller past its deadline.
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([run.settling, new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))))]);
          clearTimeout(timer);
          if (Date.now() > deadline) throw new ApiError("unavailable", "the run did not come up in time", { retry_after_ms: 1000 }, { "retry-after": "1" });
          continue;
        }
        if (launched) throw new ApiError("internal", `the run's process exited before it served: ${await lastLogLine(run)}`);
        const pid = holderPid(record);
        const fresh = record?.status === "running" && typeof record.heartbeatAt === "string" && Date.now() - Date.parse(record.heartbeatAt) < LEASE_MS && (pid === undefined || alive(pid));
        if (!fresh) {
          const refused = this.boxRefusal(run);
          if (refused) throw new ApiError("not_continuable", refused.message);
          this.launch(run);
          launched = true;
        }
      }
      if (Date.now() > deadline) throw new ApiError("unavailable", "the run did not come up in time", { retry_after_ms: 1000 }, { "retry-after": "1" });
    }
  }

  private finished(run: Run): ApiError {
    const status = run.cancel ? "cancelled" : statusOf(run).status;
    const why = status === "completed" ? "This run is finished." : `This run ${status === "failed" ? "failed" : "was cancelled"}.`;
    // A run its box ended says so in its own words (box_downgrade, box_unavailable): they name what to do.
    const boxed = status === "failed" && run.error?.code.startsWith("box_") ? run.error.message : undefined;
    return new ApiError("not_continuable", boxed ?? `${why} Start a new run of the agent.`, {
      next_action: { type: "request", method: "POST", path: `/agents/${run.agentId}/runs`, caller_supplies: ["input", "Idempotency-Key"] },
    });
  }

  /** Abort an agentic run's turn running now through the door, when there is one; never wakes the run. A workflow run
   *  has no turn: the door's abort would give it a root conversation. */
  private async abortTurn(run: Run): Promise<void> {
    if (run.kind === "workflow") return;
    const door = this.doorOf(await this.record(run));
    if (door) await fetch(new URL("/abort", door), { method: "POST", headers: this.headers(true), body: "{}", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }

  private async toDoor(run: Run, path: string, body?: Json, readyMs?: number): Promise<{ status: number; body: Json | null }> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const door = await this.ensureLive(run, readyMs);
      const res = await fetch(new URL(path, door), {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const data = res ? ((await res.json().catch(() => null)) as Json | null) : null;
      if (res && !(res.status === 503 && RETRY_CODES.includes(String(data?.error)))) return { status: res.status, body: data };
      if (Date.now() > deadline) throw new ApiError("unavailable", "the run's door did not answer", { retry_after_ms: 1000 }, { "retry-after": "1" });
      await sleep(200);
    }
  }

  private launch(run: Run): void {
    if (run.child || this.closing || run.cancel || run.outcome || run.finishing) return;
    const env: NodeJS.ProcessEnv = {
      ...childEnv(process.env, this.options.token),
      ...(this.options.faux ? { [FAUX_ENV]: this.options.faux, ...(this.options.fauxBrowser ? { [FAUX_BROWSER_ENV]: this.options.fauxBrowser } : {}), ...(this.options.fauxWeb ? { [FAUX_WEB_ENV]: this.options.fauxWeb } : {}) } : {}),
      ...(this.options.fauxHarness ? { [FAUX_HARNESS_ENV]: this.options.fauxHarness } : {}),
      ...(run.meta.effort ? { [EFFORT_ENV]: run.meta.effort } : {}),
    };
    delete env[CAP_ENV];
    if (run.meta.max_cost_usd !== undefined) env[CAP_ENV] = String(run.meta.max_cost_usd);
    // The box this open runs in, recorded before its process starts: every launch's own (a relaunch after the operator
    // changed AGENTRUN_BOX records the new mode), so the record always tells the truth about the latest open.
    if (this.options.boxView) {
      run.meta.box = this.options.boxView;
      const meta = join(run.dir, RUN_META);
      writeFileSync(`${meta}.tmp`, `${JSON.stringify(run.meta)}\n`, { mode: 0o600 });
      renameSync(`${meta}.tmp`, meta);
    }
    const log = openSync(join(run.dir, PROCESS_LOG), "a", 0o600);
    // Loud, in the run's own log too: its harness's tools run with no box.
    if (this.options.boxView?.mode === "unsandboxed") writeSync(log, `${UNSANDBOXED_RUN_LINE}\n`);
    // A workflow run resumes from its journal when it opens again, so SIGTERM lets it go at once, undrained.
    const drain = run.kind === "workflow" ? "0s" : (this.options.drainTimeout ?? DRAIN);
    const child = spawn(process.execPath, [
      "--no-warnings=ExperimentalWarning", this.cli, "run", "--dir", run.dir, "--app", this.app,
      "--serve", "0", "--serve-host", "127.0.0.1", "--serve-token-file", this.options.doorTokenFile, "--drain-timeout", drain,
    ], { stdio: ["ignore", "ignore", log], env });
    closeSync(log);
    run.child = child;
    child.once("exit", (code) => {
      if (run.child === child) run.child = undefined;
      void this.settle(run, code, true);
    });
    child.once("error", () => void (run.child === child && (run.child = undefined)));
    this.connect(run);
  }

  /** Opens the run again on its directory after its process went before the run ended: it resumes from its store. An
   *  agentic run whose first message never landed gets it again, under the same request id. */
  /** Why the run may not open again in this server's box, given the box its last open ran in. It never loses its box
   *  mid-run: boxed, then unsandboxed, ends it (box_downgrade). With no box here after it had one (box_unavailable) it is
   *  held: never opened, its messages and follow-ups refused, until a server with a box opens it. A run that had no box
   *  may open in one, and one boxed kind may follow another. */
  private boxRefusal(run: Run): { code: "box_downgrade" | "box_unavailable"; message: string } | undefined {
    const now = this.options.boxView;
    const before = run.meta.box?.mode;
    if (!now || !before) return undefined;
    const boxed = (mode: string) => mode === "bwrap" || mode === "seatbelt" || mode === "provider";
    if (boxed(before) && now.mode === "unsandboxed") return { code: "box_downgrade", message: "box_downgrade: this run started in a box; start a new run to run it unsandboxed" };
    if (before !== "unavailable" && now.mode === "unavailable") return { code: "box_unavailable", message: `box_unavailable: this run ran with ${before === "unsandboxed" ? "no box, by the operator's setting" : `a ${before} box`}, and this server has no box (${now.error}); it is held, and opens again on a server whose box is back` };
    return undefined;
  }

  private relaunch(run: Run): void {
    run.relaunches++;
    warn(run.id, `its process went before the run ended; opening it again (${run.relaunches} of ${MAX_RELAUNCHES})`);
    this.launch(run);
    const first = run.meta.input?.content;
    if (run.kind !== "agentic" || usersOf(run.rows) > 0 || typeof first !== "string") return;
    run.submitted = 1;
    this.refresh(run);
    void this.submit(run, first, "followUp", `first-${run.id}`, READY_TIMEOUT_MS).catch((error: Error) => warn(run.id, `its first message did not land again: ${error.message}`));
  }

  /** After the run's process exited, or was found gone: its rows from its released store, then, when it is over, its
   *  carry back. One at a time per run, and none once the run has its outcome. */
  private settle(run: Run, code: number | null, exited: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    run.settles++;
    run.settling = (run.settling ?? Promise.resolve())
      .then(() => (run.outcome ? undefined : this.settleOnce(run, code, exited)))
      .catch((error: Error) => {
        if (!storeBusy(error) || this.closing) return warn(run.id, `not settled: ${error.message}; the next start tries again`);
        // A store still held past the run end's retries: settled again later, not left until the next start.
        const every = this.options.settleRetryMs ?? SETTLE_RETRY_MS;
        warn(run.id, `not settled: ${error.message}; trying again in ${every / 1000} s`);
        setTimeout(() => void this.settle(run, code, exited), every).unref();
      })
      .finally(() => void run.settles--);
    return run.settling;
  }

  /** `exited`: the process this server supervised exited. Exiting on an error before it released fails the run; going
   *  any other way before the run ended (killed, or found gone at a start) opens it again. */
  private async settleOnce(run: Run, code: number | null, exited: boolean): Promise<void> {
    run.feed?.abort();
    run.feed = undefined;
    run.working = false;
    const record = await this.record(run);
    const released = RELEASED.has(String(record?.status));
    const pid = holderPid(record);
    // A process that is gone serves no door, whatever its last heartbeat says.
    const gone = !this.live(run) && !(pid !== undefined && pid !== process.pid && alive(pid) && this.doorOf(record));
    if (released || gone) await this.storeWhenFree(run);
    let ended: { outcome: Status; state?: Ended; summary?: string } | undefined;
    // A workflow run carries back how its workflow ended, through workflowCarry; cancelled before that, it stopped.
    if (run.cancel) ended = run.kind === "workflow" ? await this.workflowEnd(run, workflowEnding(record) ?? { status: "stopped" }) : { outcome: "cancelled" };
    else if (run.finishing) ended = { outcome: run.finishing };
    else if (exited && !released && code !== null && code !== 0) {
      run.error = { code: "run_failed", message: `The run's process exited (${code}) without releasing the run: ${await lastLogLine(run)}`, retryable: false };
      ended = { outcome: "failed" };
    } else if (!gone && this.doorOf(record)) ended = undefined;
    else if (run.kind === "workflow") ended = await this.workflowEnd(run, workflowEnding(record));
    else {
      const end = this.decide(run);
      if (end?.error) run.error = end.error;
      ended = end && { outcome: end.outcome };
    }
    if (!ended) {
      // Work left and no process: opened again. A run that waits for the person waits without one, until a message.
      const stalled = run.kind === "workflow" || statusOf(run).status !== "input_required";
      if (!gone || !stalled || this.closing) return this.refresh(run);
      const refused = this.boxRefusal(run);
      // No box here for a run that had one: held, unopened, until a server with a box opens it. Nothing runs without one.
      if (refused?.code === "box_unavailable") {
        warn(run.id, `held: ${refused.message}`);
        return this.refresh(run);
      }
      if (refused) run.error = { code: refused.code, message: refused.message, retryable: false };
      else if (run.relaunches < MAX_RELAUNCHES) return this.relaunch(run);
      else run.error = { code: "run_failed", message: `The run's process went ${MAX_RELAUNCHES + 1} times before the run ended: ${await lastLogLine(run)}`, retryable: false };
      ended = { outcome: "failed" };
    }
    await this.carryBack(run, ended.outcome, ended.state, ended.summary);
    if ((await this.options.agents.request(() => this.store.readRun(run.id)).catch(() => undefined))?.archivedAt) await this.teardown(run);
  }

  /** A workflow run's carry back, `workflowCarry` of @parcha/pi-durable-agent/workflow on its released store, and its
   *  output when it completed; undefined while its workflow has not ended. */
  private async workflowEnd(run: Run, ending: WorkflowEnding | undefined): Promise<{ outcome: Status; state: Ended; summary: string } | undefined> {
    if (!ending) return undefined;
    const { readWorkflowRun, workflowCarry } = await import("@parcha/pi-durable-agent/workflow");
    // A run's end waits for a busy store as long as its carry back does, not a request's 2 s.
    const revision = (await whenFree(() => this.store.readRevision(run.revision), this.busyDelays(), this.onBusy(run.id, "the agent store"))) as Extract<Revision, { kind: "workflow" }>;
    const at = { runId: run.id, storePath: this.storeFile(run), revision };
    const { state, summary } = await workflowCarry(at, ending);
    if (state === "completed") run.meta.output = (await readWorkflowRun(at)).output ?? null;
    else if (state === "escalated") run.error = { code: "escalated", message: summary, retryable: false };
    else if (state === "failed") run.error = { code: "run_failed", message: `The workflow failed: ${summary}.`, retryable: false };
    return { outcome: STATUS_OF[state], state, summary };
  }

  /** Ends the run in the agent store, once: how it ended, its cost and a line for the list. A store held by another
   *  writer is tried again with backoff; past the last try the run stays unsettled, and the next start carries it back. */
  private async carryBack(run: Run, outcome: Status, state?: Ended, summary?: string): Promise<void> {
    const answer = answerOf(run.rows);
    const cost = costOf(run.rows);
    const line = summary ?? (outcome === "completed" ? (run.answerText ?? answer?.text ?? answer?.summary) : outcome === "cancelled" ? "cancelled" : run.error?.message);
    if (run.error) run.meta.error = { code: run.error.code, message: run.error.message };
    const ending = { state: state ?? (outcome === "cancelled" ? "stopped" : outcome === "completed" ? "completed" : "failed"), ...(cost === null ? {} : { costUsd: cost }), ...(line ? { summary: line } : {}) } as const;
    const persist = async () => {
      await this.saveMeta(run);
      await whenFree(() => {
        try {
          this.store.carryBack(run.id, ending);
        } catch (error) {
          if (!(error instanceof AgentHomeError && error.code === "exists")) throw error;
        }
      }, this.busyDelays(), this.onBusy(run.id, "the agent store"));
    };
    try {
      await persist();
    } catch (error) {
      // A store that refuses the write (a full disk, a store fenced by it) must not leave the run unended: it ends here
      // now, with its cost from its rows, and the write is tried again until it lands. A restart before then reads the
      // run as it was in the store.
      warn(run.id, `its end could not be written to the agent store (${(error as Error).message}); trying again every ${(this.options.settleRetryMs ?? SETTLE_RETRY_MS) / 1000} s`);
      // An unknown cost stays unknown: never stored as 0.
      if (cost !== null) run.costUsd = cost;
      run.endedAt ??= new Date().toISOString();
      run.outcome = outcome;
      run.finishing = undefined;
      run.settled = true;
      run.updatedAt = new Date().toISOString();
      this.refresh(run);
      this.persistLater(run, persist);
      return;
    }
    const row = await this.options.agents.request(() => this.store.readRun(run.id)).catch(() => undefined);
    run.endedAt = row?.endedAt ?? run.endedAt ?? new Date().toISOString();
    if (row?.costUsd !== undefined) run.costUsd = row.costUsd;
    this.options.log?.("run_ended", { run: run.id, agent: run.agentId, status: outcome, cost_usd: row?.costUsd ?? cost ?? "unknown" });
    run.outcome = outcome;
    run.finishing = undefined;
    run.settled = true;
    run.updatedAt = new Date().toISOString();
    this.refresh(run);
  }

  /** Tries `persist` again every settleRetryMs while the server lives, until it lands. */
  private persistLater(run: Run, persist: () => Promise<void>): void {
    const timer = setTimeout(() => {
      if (this.closing) return;
      persist().then(async () => {
        const row = await this.options.agents.request(() => this.store.readRun(run.id)).catch(() => undefined);
        if (row?.endedAt) run.endedAt = row.endedAt;
        if (row?.costUsd !== undefined) run.costUsd = row.costUsd;
      }, () => this.persistLater(run, persist));
    }, this.options.settleRetryMs ?? SETTLE_RETRY_MS);
    timer.unref();
  }

  /** How long a run's end waits for a busy store, step by step. */
  private busyDelays(): readonly number[] {
    return this.options.carryBackRetry?.delaysMs ?? CARRY_BACK_RETRIES_MS;
  }

  /** Hears that `what` was busy for run `runId`, and says so when another try follows. */
  private onBusy(runId: string, what: string) {
    return (attempt: number, delay: number | undefined) => {
      this.options.carryBackRetry?.onBusy?.(runId, attempt);
      if (delay !== undefined) warn(runId, `${what} is busy; trying again in ${delay} ms (${attempt + 1} of ${this.busyDelays().length})`);
    };
  }

  /** The run's store, read again while another connection holds it, within the same retries. */
  private storeWhenFree(run: Run): Promise<void> {
    return whenFree(() => this.readStore(run), this.busyDelays(), this.onBusy(run.id, "its store"));
  }

  // ---- acting ---------------------------------------------------------------------------------------------------------

  /** Start a run of `revision` (number `version`) of `entry`'s agent: `startRun` in the store, then its process, then an
   *  agentic run's first message, `input.content`. */
  /** A place for one more live run, taken for this start (counted in `starting` from here, so two starts at once cannot
   *  both take the last place), or 429 rate_limited. A run that has ended (failed, completed, cancelled) still holds its
   *  place until its process exits; a start that needs that place waits for it, up to that process's drain and kill,
   *  never refused for a place already being given back. */
  private async takePlace(): Promise<void> {
    const max = this.options.maxRuns;
    for (const deadline = Date.now() + this.killAfterMs() + 1_000; max !== undefined; await sleep(50)) {
      const holding = [...this.runs.values()].filter((run) => this.live(run));
      if (holding.length + this.starting < max) break;
      const leaving = holding.some((run) => run.outcome || run.finishing || run.cancel);
      if (!leaving || Date.now() > deadline) {
        throw new ApiError("rate_limited", `This server runs at most ${max} runs at once (max_concurrent_runs); start this one when another ends.`, { retry_after_ms: 5_000, details: { max_concurrent_runs: max } }, { "retry-after": "5" });
      }
    }
    this.starting++;
  }

  async create(entry: AgentEntry, revision: Revision, version: number, options: { input: Json; title: string; effort?: string; maxCostUsd?: number }): Promise<Run> {
    await this.sweepOnce();
    await this.takePlace();
    try {
      // Read again: the place may have been waited for, and the agent archived meanwhile.
      const now = await this.options.agents.get(entry.agent.id);
      if (now?.agent.archivedAt) throw new ApiError("agent_not_runnable", `The agent ${entry.agent.id} is archived: unarchive it to run it.`, { details: { archived_at: now.agent.archivedAt } });
      return await this.start(entry, revision, version, options);
    } finally {
      this.starting--;
    }
  }

  private async start(entry: AgentEntry, revision: Revision, version: number, options: { input: Json; title: string; effort?: string; maxCostUsd?: number }): Promise<Run> {
    const started = await this.options.agents.request(() => this.store.startRun({ agent: entry.agent.id, revision: revision.id })).catch((error) => storeError(error, "revision"));
    const meta: RunMeta = {
      title: clip(options.title.trim().replace(/\s+/g, " "), 80),
      created_at: new Date().toISOString(),
      input: options.input,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.maxCostUsd !== undefined ? { max_cost_usd: options.maxCostUsd } : {}),
      ...(this.options.boxView ? { box: this.options.boxView } : {}),
    };
    await writeWhole(join(started.dir, RUN_META), `${JSON.stringify(meta)}\n`);
    const run = this.blank({ id: started.runId, agent: entry.agent.id, revision: revision.id, kind: revision.kind }, started.dir, meta, version);
    this.runs.set(run.id, run);
    this.options.log?.("run_started", { run: run.id, agent: run.agentId, kind: run.kind });
    if (revision.kind === "agentic") run.submitted = 1;
    this.refresh(run);
    this.launch(run);
    if (revision.kind === "workflow") return run;
    void this.submit(run, options.input.content as string, "followUp", `first-${run.id}`, READY_TIMEOUT_MS).catch((error: Error) => {
      run.submitted = 0;
      // The run ended before its first message reached it (a process that crashed at its start): how it ended stands.
      if (run.outcome || run.finishing || run.cancel) return;
      run.error = { code: "run_failed", message: error.message, retryable: false };
      if (this.live(run)) this.finish(run, "failed");
      else if (!run.cancel) void this.settle(run, 1, true);
    });
    return run;
  }

  private async submit(run: Run, content: string, whenBusy: "steer" | "followUp", requestId: string, readyMs?: number): Promise<void> {
    const answer = await this.toDoor(run, "/submit", { requestId, content, whenBusy }, readyMs);
    if (answer.status >= 400) throw new ApiError(answer.status === 409 ? "not_continuable" : "internal", String(answer.body?.message ?? answer.body?.error ?? "the run refused the message"));
  }

  /** Whether the run's harness takes a message mid-turn. */
  private async steers(run: Run): Promise<boolean> {
    if (run.kind !== "agentic") return true;
    run.harness ??= ((await this.options.agents.revision(run.agentId, run.revision))?.revision.body as { harness?: string } | undefined)?.harness ?? DEFAULT_HARNESS;
    return steersMidTurn(run.harness);
  }

  /** One message to an agentic run, its mode chosen by the run's state (the contract's table). */
  async message(run: Run, content: string): Promise<{ mode: "steer" | "answer" | "follow_up"; messageId: string }> {
    // A run that reads finished before its end is written (its process still closing, or its carry back waiting on the
    // store) is answered once the end is in: then it is completed and opens again, or it is failed or cancelled.
    if (run.finishing && !run.outcome) await this.endWritten(run);
    if (run.kind === "agentic" && statusOf(run).status === "completed") await (run.reopening ??= this.reopen(run).finally(() => (run.reopening = undefined)));
    const { status, state } = statusOf(run);
    if (TERMINAL.has(status)) throw this.finished(run);
    // A harness that cannot take a message mid-turn (any but pi, harness.ts) queues it for the turn's end: a new turn of
    // the same run, which the contract calls follow_up, never a steer it does not do.
    const working = status === "queued" || (status === "working" && state === "working");
    const mode = working ? ((await this.steers(run)) ? "steer" : "follow_up") : status === "input_required" && state === "waiting" ? "answer" : "follow_up";
    const messageId = `m${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    run.submitted++;
    this.refresh(run);
    try {
      await this.submit(run, content, mode === "steer" ? "steer" : "followUp", messageId);
    } catch (error) {
      run.submitted = Math.max(0, run.submitted - 1);
      this.refresh(run);
      throw error;
    }
    return { mode, messageId };
  }

  /** Waits, up to a request's deadline, for the end of a run that is finishing to be written. */
  private async endWritten(run: Run): Promise<void> {
    for (const deadline = Date.now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS); run.finishing && !run.outcome; await sleep(100)) {
      if (Date.now() > deadline) throw new ApiError("unavailable", "The run's end is still being written; try again.", { retry_after_ms: 1000 }, { "retry-after": "1" });
    }
  }

  /** A completed agentic run that gets a follow-up opens again: the same run on its own store and session, under its
   *  cap, taking a place under the server's. Launched here, with no wait after the place is taken, so no start takes
   *  it meanwhile. An archived run, or a run of an archived agent, stays closed. */
  private async reopen(run: Run): Promise<void> {
    await this.sweepOnce();
    const row = this.store.readRun(run.id);
    if (row?.archivedAt) throw new ApiError("not_continuable", "This run is archived: unarchive it to continue it.");
    // Its end could not be written yet (persistLater tries again): it opens once the store has it.
    if (row?.state === "running") throw new ApiError("unavailable", "The run's end is still being written to the agent store; try again.", { retry_after_ms: 1000 }, { "retry-after": "1" });
    // Before it opens again: a run that started in a box never continues without one.
    const refused = this.boxRefusal(run);
    if (refused) throw new ApiError("not_continuable", refused.message);
    await this.takePlace();
    try {
      // Read again: the place may have been waited for, and the run (or its agent) archived meanwhile.
      const now = this.store.readRun(run.id);
      if (now?.archivedAt) throw new ApiError("not_continuable", "This run is archived: unarchive it to continue it.");
      if (now?.state === "running") throw new ApiError("unavailable", "The run's end is still being written to the agent store; try again.", { retry_after_ms: 1000 }, { "retry-after": "1" });
      try {
        this.store.reopenRun(run.id);
      } catch (error) {
        storeError(error, "run");
      }
      run.outcome = undefined;
      run.settled = false;
      run.endedAt = undefined;
      run.error = undefined;
      delete run.meta.error;
      run.relaunches = 0;
      this.refresh(run);
      this.launch(run);
    } finally {
      // Launched, it holds its place as a live run.
      this.starting--;
    }
  }

  /** Abort the turn that is running; the run stays open, `input_required` and idle. A workflow run has no turn to stop. */
  async stop(run: Run): Promise<boolean> {
    const { status, state } = statusOf(run);
    if (run.kind === "workflow" || !this.live(run) || !(status === "working" && state === "working") || run.submitted > 0) return false;
    // Set before the abort: the turn's end can arrive before the door answers, and must not read as an answer.
    const before = { stopped_at: run.meta.stopped_at, stopped_after: run.meta.stopped_after };
    delete run.meta.stopped_at;
    delete run.meta.stopped_after;
    Object.assign(run.meta, stopMark(run.rows));
    await this.saveMeta(run).catch((error: Error) => warn(run.id, `its stop is not saved, so a restart will not keep it: ${error.message}`));
    const answer = await this.toDoor(run, "/abort", {}).catch(() => null);
    if (!answer || answer.status >= 400) {
      if (before.stopped_at === undefined) delete run.meta.stopped_at;
      else run.meta.stopped_at = before.stopped_at;
      if (before.stopped_after !== undefined) run.meta.stopped_after = before.stopped_after;
      await this.saveMeta(run).catch(() => undefined);
      this.refresh(run);
      return false;
    }
    this.refresh(run);
    return true;
  }

  /** Record the cancel and signal the run; it is `cancelled` once its process has exited and it is carried back. */
  async cancel(run: Run): Promise<boolean> {
    if (run.outcome) return false;
    run.cancel = true;
    // First, so no request leaves after the cancel landed, whether or not the process can be reached yet.
    await writeWhole(join(run.dir, RUN_CANCELLED), "").catch((error: Error) => warn(run.id, `its cancel mark is not written: ${error.message}`));
    if (this.live(run)) {
      // The turn is aborted first, so the drain that SIGTERM starts does not wait for it.
      await this.abortTurn(run);
      this.terminate(run);
    } else await this.settle(run, null, false);
    return true;
  }

  /** How long a run's process gets after SIGTERM before SIGKILL: its drain and a second to exit. */
  private killAfterMs(): number {
    return (durationMs(this.options.drainTimeout ?? DRAIN) ?? 30_000) + 1_000;
  }

  async close(): Promise<void> {
    this.closing = true;
    const live = [...this.runs.values()].filter((run) => run.child);
    for (const run of live) {
      run.child!.kill("SIGTERM");
      setTimeout(() => run.child?.exitCode === null && run.child.kill("SIGKILL"), this.killAfterMs()).unref();
    }
    await Promise.all(live.map((run) => new Promise((resolve) => (run.child ? run.child.once("exit", resolve) : resolve(undefined)))));
    // An adopted process is stopped the same way, and watched by its pid.
    const adopted = [...this.runs.values()].filter((run) => run.orphan && alive(run.orphan));
    for (const run of adopted) this.terminate(run);
    for (const deadline = Date.now() + this.killAfterMs(); adopted.some((run) => run.orphan && alive(run.orphan)) && Date.now() < deadline; ) await sleep(100);
    await sleep(0);
    await Promise.all([...this.runs.values()].map((run) => run.settling));
    for (const run of this.runs.values()) run.feed?.abort();
    this.closed = true;
  }

  // ---- views ------------------------------------------------------------------------------------------------------------

  /** A run's cost from its rows, else what the store recorded when it carried the run back. */
  cost(run: Run) {
    return { usd: costView(run.rows, run.costUsd), basis: "estimate", charge_state: null, cap_usd: run.meta.max_cost_usd ?? null };
  }

  /** `Run`, as the contract shows it. */
  async view(run: Run) {
    const stored = await this.options.agents.request(() => this.store.readRun(run.id));
    // After the read: the run may have moved on while it waited, and every field below is of this one moment.
    const { status, state } = statusOf(run);
    const row = TERMINAL.has(status) ? stored : undefined;
    const answer = answerOf(run.rows);
    const finalAnswer = run.kind === "workflow" ? null : answer ? (run.answerText ?? answer.text ?? answer.summary ?? null) : (row?.summary ?? null);
    // A run its cap stopped keeps the answer it paid for.
    const kept = status === "failed" && run.error?.code === SPEND_CAP_REACHED ? lastAnswer(run) : null;
    return {
      run_id: run.id,
      agent_id: run.agentId,
      agent_version: run.version,
      revision: run.revision,
      kind: run.kind,
      sha: null,
      status,
      state,
      title: run.meta.title,
      ...(run.meta.effort ? { effort: run.meta.effort } : {}),
      created_at: run.meta.created_at,
      updated_at: run.updatedAt,
      ended_at: TERMINAL.has(status) ? (row?.endedAt ?? run.endedAt ?? run.updatedAt) : null,
      result: status === "completed" ? { output: run.kind === "workflow" ? (run.meta.output ?? null) : null, final_answer: finalAnswer } : kept ? { output: null, final_answer: kept } : null,
      error: status === "failed" ? (run.error ?? { code: "run_failed", message: "The run failed.", retryable: false }) : null,
      cost: this.cost(run),
      archived_at: stored?.archivedAt ?? null,
      poll_after_ms: TERMINAL.has(status) && run.settled ? 0 : 1000,
    };
  }

  async summary(run: Run) {
    const { run_id, agent_id, agent_version, revision, kind, sha, status, state, title, created_at, ended_at, error, cost, archived_at } = await this.view(run);
    return { run_id, agent_id, agent_version, revision, kind, sha, status, state, title, created_at, ended_at, error, cost, archived_at };
  }

  /** A run's status for a list: an ended run's from its row, a running one's from the run itself. */
  async statusOfRow(row: RunRow): Promise<Status> {
    if (row.state !== "running") return STATUS_OF[row.state];
    const run = await this.get(row.id);
    return run ? statusOf(run).status : "queued";
  }

  /** A run's summary for a list. An ended run this server holds no Run for is read from its row and its serve.json alone,
   *  not its store; `versions` numbers its agent's revisions. */
  async summaryOfRow(row: RunRow, versions: Map<string, number>): Promise<Awaited<ReturnType<Runs["summary"]>>> {
    const known = this.runs.get(row.id) ?? (row.state === "running" ? await this.get(row.id) : null);
    if (known) return this.summary(known);
    const meta = (await readJson(join(this.options.agents.dir, "runs", row.id, RUN_META))) as Partial<RunMeta> | null;
    return {
      run_id: row.id, agent_id: row.agent, agent_version: versions.get(row.revision) ?? 0, revision: row.revision, kind: row.kind, sha: null,
      status: STATUS_OF[row.state as Ended], state: "idle" as State, title: typeof meta?.title === "string" ? meta.title : "",
      created_at: typeof meta?.created_at === "string" ? meta.created_at : row.startedAt, ended_at: row.endedAt ?? null,
      error: STATUS_OF[row.state as Ended] === "failed" ? errorOfRow(row, meta) : null,
      cost: { usd: row.costUsd ?? null, basis: "estimate", charge_state: null, cap_usd: typeof meta?.max_cost_usd === "number" ? meta.max_cost_usd : null },
      archived_at: row.archivedAt ?? null,
    };
  }

  /** The timeline from change `after`, held up to `waitMs` for a change when there is none. */
  async page(run: Run, after: number, waitMs: number, limit: number): Promise<Page & { status: Status; state: State; final: boolean }> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const page = run.log.page(after, limit);
      const { status, state } = statusOf(run);
      const final = TERMINAL.has(status) && run.settled;
      if (!page.unchanged || final || Date.now() >= deadline) return { ...page, status, state, final };
      await run.log.changed(deadline - Date.now());
    }
  }
}
