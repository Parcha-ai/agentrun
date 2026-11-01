// Runs: each one a child process (`pi-durable-disk run` on `<data>/runs/<id>` with serve's app), pinned to a revision in
// the agent store. An agentic run is read live through the door its process serves on loopback; a workflow run is
// working while its process lives. Once the process has exited the run is read from its store, read-only, and carried
// back to the agent store (`carryBack`), and it is finished. A run whose process went before the run ended is opened
// again on its directory, and resumes from its store.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, rmSync } from "node:fs";
import { open as openFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { processAlive } from "@parcha/agentrun-adapters/host";
import { AgentHomeError, type Revision, type RevisionKind, type RunRow, type RunState, type StoredMetrics } from "@parcha/pi-durable-agent";
import { registerLabel, registerTurnEnding, type RunMetrics, runMetricsOf, timelineOf, timelineReducer, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { HARNESS_LOG_EVENT, thinkingFor } from "./adapters.js";
import { DEFAULT_HARNESS, FAUX_HARNESS_ENV, steersMidTurn } from "./harness.js";
import { type AgentEntry, type Agents, storeBusy, storeError, whenFree } from "./agents.js";
import { LAUNCH_LOST, readJson, RUN_CANCELLED, RUN_LAUNCHING, RUN_META, writeWhole } from "./files.js";
import { layLearned, LEARNED_DIR, type Learning, LEARNING_LABEL, learningBlocker, type LearningMode, type LearningReason, type LearningState, learningView, pinSeed, type Proposal, PROPOSAL, readPin, type Seed, seedAt, seedOf, withAgentGrade } from "./learning.js";
import { type BoxHost, type Quarantine, settleBox, sweepBoxes } from "./box/sweep.js";
import { FAUX_WEB_ENV } from "./fetch-page.js";
import { ASK_TOOL, FAUX_BROWSER_ENV } from "./tools.js";
import { withDecisions } from "./decision-rows.js";
import { DECISION_KEY_FD_ENV, decisionKeysOf, FAUX_JEV_ENV, FAUX_OPENROUTER_ENV, FAUX_PARALLEL_ENV, PARALLEL_KEY_ENV } from "./decisions.js";
import { ApiError, unsupported } from "./errors.js";
import { DOCUMENTS_ENV } from "./pdf-pages.js";
import { FAUX_MONID_ENV } from "./monid.js";
import { CAP_ENV, SPEND_CAP_REACHED } from "./cap.js";
import { EFFORT_ENV, FAUX_ENV, thinkingOf, withoutFaux } from "./model.js";
import { pausedIn, readNodeLog, RUN_PAUSED } from "./pause.js";
import { durationMs } from "./print.js";
import { WEB_FETCH_TOOL } from "./web-fetch.js";
import { ChangeClock, type Page, RowLog } from "./rows.js";
import { isObject, type Json } from "./validate.js";
import { DECISION_KEYS, handover, hostSecrets, SECRET_NAMES, SECRETS_FD_ENV, SECRETS_LEN_ENV, withoutSecrets, withSecrets } from "./secrets.js";
import { BOX_KEYS } from "./boxes.js";
import { book, bookings } from "./usage.js";

export type Status = "queued" | "working" | "paused" | "input_required" | "completed" | "failed" | "cancelled";
export type State = "working" | "waiting" | "idle";
export const STATUSES: readonly Status[] = ["queued", "working", "paused", "input_required", "completed", "failed", "cancelled"];
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
/** How a run ended in the store, as its status: the store's `stopped` is v2's `cancelled`, and an escalated workflow
 *  completed its work and waits for a person (its `review`), which is not a failure. */
const STATUS_OF: Record<Ended, Status> = { completed: "completed", failed: "failed", escalated: "completed", stopped: "cancelled" };

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
  title: string;
  created_at: string;
  /** The run's input: an agentic run's first message is its `content`, a workflow run's input is the whole of it. */
  input?: Json;
  effort?: string;
  max_cost_usd?: number;
  error?: { code: string; message: string; details?: { reason: string } };
  /** A workflow run's output, once it completed. */
  output?: unknown;
  /** A workflow run that escalated: what a person is to look at. Its time is the run's saved end, read with it. */
  review?: SavedReview;
  /** Where the run stood when its turn was stopped: the person's last message, by its timeline row's id (its store
   *  entry's), or the root conversation's place 0 before any. It stays stopped until a message newer than that is shown. */
  stopped_at?: string;
  /** A run stopped by an older server: how many messages the person had sent then. Read only when `stopped_at` is not. */
  stopped_after?: number;
  /** What its newest process took its thinking level from (app.ts's thinkingOf), as its environment had them: `effort`,
   *  the run's effort, and `host`, the host's AGENT_THINKING. Absent for a process an older server started. */
  launch_thinking?: { effort?: string; host?: string };
  /** Where the run's learning stands (learning.ts); absent for a run that does not learn. */
  learning?: Learning;
  /** The run's end-of-run turn, saved before it is asked. */
  reflect?: Reflect;
};
/** A run's end-of-run turn: the job's outcome, the newest store entry before the turn and, once the run ended, the newest
 *  after it (its rows are those between), its deadline, whether its copy of the folder was laid, and how it ended. */
type Reflect = { outcome: Status; after: number; until?: number; deadline: string; laid?: true; ended?: true; timedOut?: true };
/** Who sent the end-of-run turn: the server, never a person, and no request field sets it. The one value it is sent
 *  with, at its one call (reflectTurn); the per-tool gate, once this server has one, takes it there. */
const REFLECT_ORIGIN = "reflect";
/** The run asked its end-of-run turn and has not ended since. */
const reflecting = (run: { meta: RunMeta }) => run.meta.reflect !== undefined && run.meta.reflect.until === undefined;
/** The run ended after its end-of-run turn did, and what the turn wrote is neither checked nor dropped yet. */
const awaitsPropose = (meta: Partial<RunMeta> | null): boolean => meta?.learning?.state === "reflecting" && meta.reflect?.ended === true && meta.reflect.until !== undefined;
/** The end-of-run turn's request id: the door and pi take one id once, so a turn asked again after a restart is not
 *  asked twice. */
const reflectId = (runId: string) => `learn-reflect-${runId}`;
/** How long a run's end-of-run turn may take before it is aborted and the run finishes without it. */
const REFLECT_TIMEOUT_MS = 5 * 60_000;
/** How often the run's door is asked whether its end-of-run turn has ended. */
const REFLECT_POLL_MS = 250;
/** A row's store entry, from its id (`<conversation>:<entry>[:...]`); NaN for a row no entry made (a live one, usage). */
const entryOf = (id: string) => Number(id.split(":")[1]);
/** Whether entry `id` (a number), or the row `id`, is the end-of-run turn's. Before the run has ended every later entry
 *  is, and so is a live row. */
function reflects(reflect: Reflect | undefined, id: string | number): boolean {
  if (!reflect) return false;
  const entry = typeof id === "number" ? id : entryOf(id);
  if (Number.isInteger(entry)) return entry > reflect.after && (reflect.until === undefined || entry <= reflect.until);
  return reflect.until === undefined && typeof id === "string" && id.includes(":live:");
}
/** `rows` with the end-of-run turn's labelled: never the run's answer (meaningful skips the label), its answer shown as
 *  a text row, and its message as the host's. */
function labelled(reflect: Reflect | undefined, rows: TimelineEvent[]): TimelineEvent[] {
  if (!reflect) return rows;
  return rows.map((row) => (!reflects(reflect, row.id) ? row : {
    ...row, agent_label: LEARNING_LABEL,
    ...(row.kind === "final_answer" ? { kind: "text_block" as const } : {}),
    ...(row.kind === "user_message" ? { summary: `Learning: ${(row.summary ?? "").replace(/^You: /, "")}` } : {}),
  }));
}
/** A run's learning as a list shows it: its state and reason. */
const shortLearning = (learning: Learning | null) => (learning ? { state: learning.state, reason: learning.reason } : null);
/** The run's learning row, once its learning was proposed, merged or dropped (`seed_failed` included): its state, reason
 *  and detail. One row, which says where the learning ended. */
function withLearning(rows: readonly TimelineEvent[], learning: Learning | undefined): TimelineEvent[] {
  if (!learning || learning.state === "seeded" || learning.state === "reflecting") return [...rows];
  const row = {
    id: LEARNING_LABEL, timestamp: learning.at, created_at: learning.at, kind: "learning" as const, summary: `Learning ${learning.state}${learning.reason ? ` (${learning.reason})` : ""}: ${learning.detail ?? ""}`.trim(), agent_label: LEARNING_LABEL,
    tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: learning.detail,
    learning: { state: learning.state, reason: learning.reason, detail: learning.detail },
  };
  return [...rows, row];
}
type RunError = { code: string; message: string; retryable: boolean; details?: { reason: string } };
/** Why an escalated workflow run waits for a person: the escalation's kind, the escalate node's label, its summary,
 *  and when the run ended (`at`, the run's `ended_at`). */
export type RunReview = { kind: string | null; node: string | null; reason: string; at: string };
/** A review as serve.json keeps it: `at` is not kept, as it is the run's saved end, which the store stamps. */
type SavedReview = Omit<RunReview, "at">;
/** `review` at the run's saved end `endedAt`, so review.at and ended_at are one time. */
const reviewAt = (review: SavedReview | null, endedAt: string): RunReview | null => (review ? { kind: review.kind, node: review.node, reason: review.reason, at: endedAt } : null);

/** A failed run's error from its row and serve.json: its own, else the row's summary. */
const errorOfRow = (row: RunRow, meta: Partial<RunMeta> | null): RunError =>
  ({ code: meta?.error?.code ?? "run_failed", message: meta?.error?.message ?? row.summary ?? "The run failed.", retryable: false, ...(meta?.error?.details ? { details: meta.error.details } : {}) });

/** An ended run's review from its row and serve.json: an escalated one's as its end saved it, else (an end saved before
 *  reviews were kept) the row's summary; null for every other run. */
const reviewOfRow = (row: Pick<RunRow, "state" | "summary">, meta: Partial<RunMeta> | null): SavedReview | null =>
  row.state !== "escalated" ? null : (meta?.review ?? { kind: null, node: null, reason: row.summary ?? "The workflow escalated." });

/** One run as this server holds it. */
export type Run = {
  id: string;
  agentId: string;
  kind: RevisionKind;
  revision: string;
  /** The harness its revision names, read at its first message. */
  harness?: string;
  /** Its agentic revision names the `write` tool: its end-of-run turn can add a note. */
  writes?: boolean;
  /** The newest store entry the run has shown. */
  lastEntry?: number;
  /** What the live path's rows keep served (keepCommitted), for a learning row shown between its snapshots. */
  keep?: (id: string) => boolean;
  /** Its agentic revision names web_fetch: its process is handed Parallel's key for it (web-fetch.ts). */
  webFetch?: true;
  /** Imported history (`agentrun-serve import`): the source it was run in, and its id there. It takes no message, and a
   *  stop or a cancel moves nothing. */
  imported?: { source: string; session: string };
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
  /** The cost the store recorded when it carried the run back; null when it recorded none (unknown). */
  costUsd?: number | null;
  /** A workflow run's decisions' cost, from its receipts once its end is read: null when one is unknown. */
  decisionCost?: number | null;
  /** A workflow run's decision rows, from its released store: its timeline shows one row each (decision-rows.ts). */
  decisions?: Record<string, unknown>[];
  /** How many of a workflow run's llm calls' answers its node log held when its rows were last read: their cost is in its
   *  rows (each a REQUEST_COST entry, committed before its answer is logged), so its graph counts only the later ones. */
  llmRead?: number;
  /** What every conversation of its store says it used, as the settle that ends it read them. */
  metrics?: RunMetrics;
  relaunches: number;
  /** Its newest launch has not reported back: its mark (RUN_LAUNCHING) is on disk. */
  launching?: boolean;
  settled: boolean;
  settling?: Promise<void>;
  /** The newest write of its serve.json: one at a time, in order. */
  saving?: Promise<void>;
  /** Settles of this run not yet done: while any is, nothing starts its process again. */
  settles: number;
  /** What its end-of-run turn wrote, being checked (proposeOnce), and its proposal, being graded (gradeOnce). */
  proposing?: Promise<void>;
  grading?: Promise<void>;
  updatedAt: string;
};

const ASKED = "Asked you: ";
registerLabel(ASK_TOOL, (args) => `${ASKED}${typeof args.question === "string" ? args.question : ""}`);
// ask_person ends its turn (tools.ts): the person's reply is their next message, never a steer.
registerTurnEnding(ASK_TOOL);

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

/** Notes the whole text of the newest assistant message in `entries` (pi's stored entries), and the newest entry. The
 *  end-of-run turn's are never the run's answer. */
function noteAnswer(run: Run, entries: readonly unknown[]): void {
  for (const value of entries) {
    if (isObject(value) && typeof value.id === "number") {
      run.lastEntry = Math.max(run.lastEntry ?? 0, value.id);
      if (reflects(run.meta.reflect, value.id)) continue;
    }
    if (!isObject(value) || value.kind !== "pi.assistant" || !Array.isArray(value.model) || !isObject(value.model[0])) continue;
    const content = value.model[0].content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => isObject(b) && b.type === "text").map((b) => String((b as Json).text ?? "")).join("\n").trim() : "";
    if (text) run.answerText = text;
  }
}

const shows = (r: TimelineEvent) => r.kind !== "usage" && r.kind !== "phase" && !QUIET.test(r.id);
const meaningful = (rows: readonly TimelineEvent[]) => rows.findLast((r) => shows(r) && r.agent_label !== LEARNING_LABEL);
const answerOf = (rows: readonly TimelineEvent[]) => {
  const last = meaningful(rows);
  return last?.kind === "final_answer" || last?.kind === "text_block" ? last : undefined;
};
const usageOf = (rows: readonly TimelineEvent[]) => rows.findLast((r) => r.kind === "usage");
/** The run's cost from its usage row: null when a response's cost is unknown, 0 before any request. */
export const costOf = (rows: readonly TimelineEvent[]): number | null => {
  const usage = usageOf(rows);
  return usage ? (usage.usage?.usd ?? null) : 0;
};
/** A run's cost for its views: its usage row's, else what the store kept when it carried the run back (0 before any
 *  request). A usage row that says unknown, or says nothing, stays unknown: what the store kept dates from before a
 *  follow-up. */
export function costView(rows: readonly TimelineEvent[], stored: number | null | undefined, decisions?: number | null): number | null {
  const usage = usageOf(rows);
  // A workflow run's decisions, once its end is read: their cost joins its model nodes', and one unknown makes it unknown.
  if (decisions !== undefined) {
    const models = usage ? (usage.usage?.usd ?? null) : 0;
    return models === null || decisions === null ? null : models + decisions;
  }
  if (!usage) return stored === undefined ? 0 : stored;
  return usage.usage?.usd ?? null;
}
/** The whole text of the run's newest answer, paid for: an assistant message's, else its newest answer row's. */
const lastAnswer = (run: Run) => run.answerText ?? run.rows.findLast((r) => (r.kind === "final_answer" || r.kind === "text_block") && r.agent_label !== LEARNING_LABEL)?.text ?? null;
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
  // A paused workflow run finishes what it has in flight and starts nothing new until it is resumed (pause.ts). A held run
  // read without its directory (a view built for a count) has no mark to read.
  if (run.kind === "workflow") return run.dir && pausedIn(run.dir) ? { status: "paused", state: "idle" } : { status: run.working ? "working" : "queued", state: "working" };
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
export type RunsOptions = { agents: Agents; token: string; documents?: string; doorTokenFile: string; doorToken: string; faux?: string; fauxBrowser?: string; fauxWeb?: string; fauxJev?: string; fauxParallel?: string; fauxOpenrouter?: string; fauxMonid?: string; fauxHarness?: string; drainTimeout?: string; carryBackRetry?: CarryBackRetry; maxRuns?: number; box?: { host: BoxHost; quarantine: Quarantine }; settleRetryMs?: number; readyTimeoutMs?: number; reflectTimeoutMs?: number; learning?: LearningMode; log?: (event: string, fields: Record<string, string | number>) => void };

/** The server's own secrets, which a run's process never gets: the API token, by name or by value, the seal key
 *  the tool keys are kept under (tool-keys.ts), and the boxes' keys (boxes.ts), which only the server's box providers use. */
const SERVER_ONLY = new Set(["AGENTRUN_TOKEN", "AGENTRUN_API_KEY", "AGENTRUN_SEAL_KEY", ...BOX_KEYS]);
/** The secrets a run's process is handed over its pipe (secrets.ts): every one but the server's own and the decision
 *  keys, which go on their own descriptor. */
export const RUN_SECRETS = SECRET_NAMES.filter((name) => !SERVER_ONLY.has(name) && !DECISION_KEYS.includes(name));
/** The module a run's process preloads (`--import`) to read its pipe before anything else; app.ts gets the same instance. */
const SECRETS_MODULE = new URL("./secrets.js", import.meta.url).href;
/** A run's process's environment: no secret in it (they go over its pipe), nor the token by value; the AGENT_MODEL
 *  variables and the rest pass, and the door token goes by file. A test hook's name passes never (withoutFaux): the run
 *  gets one only from startServe's options. */
export const childEnv = (env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(withoutSecrets(withoutFaux(env))).filter(([, value]) => value !== token));

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

/** The line of the run process's log a failure's message is made of: its last, past any harness's own lines (a proxy's
 *  refusal just before a crash says nothing of why the process went). */
export function failureLine(log: string): string {
  const lines = log.trim().split("\n");
  return ownLine(lines) ?? lines.at(-1) ?? "";
}

/** The last of `lines` that is not a harness's own line, if any. */
function ownLine(lines: readonly string[]): string | undefined {
  return lines.findLast((line) => {
    if (line.trim() === "") return false;
    try {
      return (JSON.parse(line) as { event?: unknown } | null)?.event !== HARNESS_LOG_EVENT;
    } catch {
      return true;
    }
  });
}

/** How far back from its end a failure's message is looked for in the run's log, in steps of LOG_STEP. */
const LOG_STEP = 4096;
const LOG_REACH = 1 << 20;

/** The last line of the run process's log, in words, for a failure's message. */
export async function lastLogLine(run: Pick<Run, "dir">): Promise<string> {
  const file = await openFile(join(run.dir, PROCESS_LOG)).catch(() => null);
  if (!file) return "";
  try {
    // Backward until a whole line is the process's own: harness lines after it may run past any one read, and a read
    // that starts inside a line has only its tail, which is no line at all. Each step looks only at the lines it
    // completes; what was read is joined once, and failureLine, the one rule, picks the line from it.
    const { size } = await file.stat();
    const chunks: Buffer[] = [];
    let start = size;
    // The oldest line read so far, torn at the read's start unless that is the file's start.
    let head = Buffer.alloc(0);
    while (start > 0 && size - start < LOG_REACH) {
      const from = Math.max(0, start - LOG_STEP);
      const { buffer } = await file.read(Buffer.alloc(start - from), 0, start - from, from);
      start = from;
      chunks.unshift(buffer);
      const newline = buffer.indexOf(0x0a);
      const completed = start === 0 ? Buffer.concat([buffer, head]) : newline < 0 ? Buffer.alloc(0) : Buffer.concat([buffer.subarray(newline + 1), head]);
      head = start === 0 ? Buffer.alloc(0) : newline < 0 ? Buffer.concat([buffer, head]) : buffer.subarray(0, newline);
      if (ownLine(completed.toString("utf8").split("\n")) !== undefined) break;
    }
    return clip(inWords(failureLine(Buffer.concat(chunks).subarray(head.length).toString("utf8"))), 300);
  } finally {
    await file.close();
  }
}

export class Runs {
  private readonly runs = new Map<string, Run>();
  /** Each workflow revision's workflow, by revision id, as a graph read it: a revision never changes. */
  private readonly workflows = new Map<string, unknown>();
  /** Each workflow run's last graph read whole: what a poll that met a busy store answers, marked stale. */
  private readonly graphs = new Map<string, object>();
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
  /** Why this host keeps no learning folder, said once. */
  private learningOff?: string;
  /** Aborted as the server closes: a grade's screen and grader stop, and leave the run's learning `proposed`. */
  private readonly stopping = new AbortController();
  /** The learning of each ended run this server does not hold, which never moves again (learningOfRow): read by the
   *  start's pass over every ended run, or once by a count. */
  private readonly endedLearning = new Map<string, { state: LearningState; reason: LearningReason | null } | null>();
  constructor(private readonly options: RunsOptions) {}

  private get store() {
    return this.options.agents.store;
  }

  // ---- reading --------------------------------------------------------------------------------------------------------

  /** Run `id` when this process holds it, never read from disk. */
  held(id: string): Run | undefined {
    return this.runs.get(id);
  }

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
      ...(isObject(stored?.review) ? { review: stored.review as SavedReview } : {}),
      ...(typeof stored?.stopped_at === "string" ? { stopped_at: stored.stopped_at } : {}),
      ...(typeof stored?.stopped_after === "number" ? { stopped_after: stored.stopped_after } : {}),
      ...(isObject(stored?.launch_thinking) ? { launch_thinking: stored.launch_thinking as RunMeta["launch_thinking"] } : {}),
      ...(isObject(stored?.learning) ? { learning: stored.learning as Learning } : {}),
      ...(isObject(stored?.reflect) ? { reflect: stored.reflect as Reflect } : {}),
    };
    const known = await this.options.agents.revision(row.agent, row.revision);
    const run = this.blank(row, dir, meta, known?.version ?? 0, known?.revision);
    this.runs.set(row.id, run);
    run.launching = existsSync(join(dir, RUN_LAUNCHING));
    const record = await this.record(run);
    // Only a store no live instance holds is opened: released, or left by an instance whose lease lapsed.
    if (row.state !== "running" || !this.doorOf(record)) await this.storeWhenFree(run);
    if (row.state !== "running") {
      run.outcome = STATUS_OF[row.state];
      run.endedAt = row.endedAt;
      // An ended run the store kept no cost for has an unknown cost, never $0.
      run.costUsd = row.costUsd ?? null;
      // A workflow run's decisions' cost too: an unknown one keeps the run's unknown after a restart. Unread, it is unknown.
      if (run.kind === "workflow") await this.readDecisionCost(run).catch(() => void (run.decisionCost = null));
      if (row.importedFrom) run.imported = row.importedFrom;
      if (run.outcome === "failed") run.error = errorOfRow(row, meta);
      run.settled = true;
    } else {
      // A server that went while the run reflected: the run is finishing with its job's outcome, and nothing opens it again.
      const reflect = reflecting(run) ? meta.reflect : undefined;
      if (reflect) {
        run.finishing = reflect.outcome;
        if (meta.error) run.error = { ...meta.error, retryable: false };
      }
      if (record && this.doorOf(record)) {
        // A server that died between saving a stop and its abort reaching the run leaves the turn working.
        run.finishStop = run.meta.stopped_at !== undefined || run.meta.stopped_after !== undefined;
        this.adoptProcess(run, record);
        // Its process lives: the turn is asked again under the same request id, which it takes once, and waited for.
        if (reflect) void this.reflectTurn(run);
      }
    }
    this.refresh(run);
    return run;
  }

  private blank(row: Pick<RunRow, "id" | "agent" | "revision" | "kind">, dir: string, meta: RunMeta, version: number, revision?: Revision): Run {
    return {
      id: row.id, agentId: row.agent, kind: row.kind, revision: row.revision, version, dir, meta, log: new RowLog(this.clock), rows: [],
      working: false, submitted: 0, users: new Set(), live: new Set(), cancel: false, relaunches: 0, settled: false, settles: 0, updatedAt: meta.created_at,
      ...(revision?.kind === "agentic" && revision.body.tools.includes(WEB_FETCH_TOOL) ? { webFetch: true as const } : {}),
      ...(revision?.kind === "agentic" ? { harness: revision.body.harness ?? DEFAULT_HARNESS, writes: revision.body.tools.includes("write") } : {}),
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
   *  root conversation's; a workflow run's are its model nodes'. `atEnd`: a settle's read, which reads every
   *  conversation (a workflow's nodes, a harness's session) once and counts the run's metrics from all of them. */
  private async readStore(run: Run, atEnd = false): Promise<void> {
    const file = this.storeFile(run);
    if (!(await stat(file).catch(() => null))) return;
    const { DatabaseSync } = await import("node:sqlite");
    const read: Array<{ conversation: number; entry: Json }> = [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = run.kind === "workflow" || atEnd
        ? db.prepare("SELECT conversation_id, record FROM entries ORDER BY id").iterate()
        : db.prepare("SELECT conversation_id, record FROM entries WHERE conversation_id = (SELECT MIN(conversation_id) FROM entries) ORDER BY id").iterate();
      for (const row of rows as Iterable<{ conversation_id: number; record: string }>) read.push({ conversation: Number(row.conversation_id), entry: JSON.parse(String(row.record)) as Json });
    } finally {
      db.close();
    }
    const root = read.reduce((min, r) => Math.min(min, r.conversation), Infinity);
    const entries = read.flatMap((r) => (run.kind === "workflow" || r.conversation === root ? [r.entry] : []));
    if (atEnd) run.metrics = runMetricsOf(read.map((r) => r.entry) as never);
    if (run.kind === "workflow") {
      const { durableDecisions } = await import("@parcha/agentrun-pi/durable");
      // Decisions it cannot read add no rows: the run's cost read says unknown (readDecisionCost).
      try { run.decisions = durableDecisions(file); } catch { run.decisions = undefined; }
      run.llmRead = (await readNodeLog(run.dir)).filter((line) => line.t === "effect.end" && line.tool === "llm" && line.status === "done").length;
    }
    run.working = false;
    noteAnswer(run, entries);
    this.take(run, timelineOf(entries as never, { settled: true }));
  }

  /** New rows in: into the log, then the run's status, then whatever the status asks for. */
  /** `keep`: rows that stay served though `rows` no longer holds them (the live path's committed rows). */
  private take(run: Run, rows: TimelineEvent[], keep?: (id: string) => boolean): void {
    run.rows = labelled(run.meta.reflect, withAsks(rows));
    // Counted by id: a snapshot of a compacted conversation shows fewer user messages than before, which is not more
    // messages waiting, so a count of rows would leave the run working forever.
    const arrived = run.rows.filter((r) => r.kind === "user_message" && !run.users.has(r.id));
    for (const row of arrived) run.users.add(row.id);
    run.submitted = Math.max(0, run.submitted - arrived.length);
    run.keep = keep;
    this.show(run);
    this.refresh(run);
  }

  /** The run's rows into its log, as served: a workflow run's decisions and the run's learning row are the served view's
   *  only, never the run's own rows, which its cost and its answer are read from. */
  private show(run: Run): void {
    const rows = run.decisions?.length ? withDecisions(run.rows, run.decisions) : run.rows;
    if (run.log.sync(withLearning(rows, run.meta.learning), run.keep)) run.updatedAt = new Date().toISOString();
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
    // A run that learns is not let go yet: its harness is asked one end-of-run turn first, unless learning is skipped.
    const skip = this.reflectSkip(run, end);
    if (skip === undefined) return this.reflect(run, end.outcome);
    if (skip) this.dropLearning(run, ...skip);
    this.finish(run, end.outcome, end.abort);
  }

  // ---- learning -------------------------------------------------------------------------------------------------------

  /** Moves the run's learning on, and shows its row. Saved by the caller, or with the run's end. */
  private setLearning(run: Run, state: LearningState, reason: LearningReason | null = null, detail: string | null = null, more: Omit<Partial<Learning>, "state" | "reason" | "detail" | "at"> = {}): void {
    run.meta.learning = { state, reason, detail, at: new Date().toISOString(), ...more };
    run.updatedAt = run.meta.learning.at;
    this.show(run);
  }

  private dropLearning(run: Run, reason: LearningReason, detail: string): void {
    this.setLearning(run, "dropped", reason, detail);
    void this.saveMeta(run).catch((error: Error) => warn(run.id, `its learning's drop is not saved: ${error.message}`));
  }

  /** Why a run that just ended asks no end-of-run turn: a drop's reason and detail; null when it does not learn, or asked
   *  one already (one per run, ever); undefined when it asks one. The cap keeps no reserve: a run its cap stopped has no
   *  room left, and one whose spend is unknown cannot be kept within its cap. */
  private reflectSkip(run: Run, end: { outcome: Status; error?: RunError; abort?: boolean }): [LearningReason, string] | null | undefined {
    if (run.meta.learning?.state !== "seeded" || run.meta.reflect) return null;
    if (run.cancel) return ["cancelled", "The run was cancelled before it could reflect."];
    if (end.abort || end.error?.code === SPEND_CAP_REACHED) return ["no_budget", "The run's cap leaves no room for the end-of-run turn."];
    if (run.meta.max_cost_usd !== undefined && costOf(run.rows) === null) return ["unknown_cost", "What the run spent is unknown, so its cap cannot be kept through an end-of-run turn."];
    if (!run.writes) return ["no_write_tool", "The agent has no write tool to add a note with."];
    return undefined;
  }

  /** The run answered or failed: it is finishing with that outcome, and its harness is asked one end-of-run turn first.
   *  The turn is saved before it is asked, so a restart asks it again under the same id, never twice. */
  private reflect(run: Run, outcome: Status): void {
    run.finishing = outcome;
    run.endedAt = new Date().toISOString();
    const after = run.lastEntry ?? Math.max(0, ...run.rows.map((row) => entryOf(row.id)).filter(Number.isInteger));
    run.meta.reflect = { outcome, after, deadline: new Date(Date.now() + (this.options.reflectTimeoutMs ?? REFLECT_TIMEOUT_MS)).toISOString() };
    // The job's error, kept for a restart: the turn's is never the run's.
    if (run.error) run.meta.error = { code: run.error.code, message: run.error.message, ...(run.error.details ? { details: run.error.details } : {}) };
    this.setLearning(run, "reflecting", null, "The agent is asked what it learned.");
    this.mark(run);
    void this.reflectTurn(run);
  }

  /** Lays the run's copy of its agent's folder again from its seed (once: a restart that asks again keeps what the turn
   *  wrote), asks the end-of-run turn through the run's door and waits for its end, its deadline (the turn is aborted)
   *  or the process to go; then lets the run go. */
  private async reflectTurn(run: Run): Promise<void> {
    const reflect = run.meta.reflect!;
    const dir = join(run.dir, "work", LEARNED_DIR);
    let end: "ended" | "timeout" | "gone" = "gone";
    try {
      const pin = await readPin(run.dir);
      if (!pin) throw new Error("the run has no learning pin");
      const seed = await seedAt(this.options.agents.dir, run.agentId, pin.seed);
      // What the job's own turns left in the copy is not the end-of-run turn's to propose.
      if (!reflect.laid) {
        await layLearned(dir, seed);
        reflect.laid = true;
      }
      await this.saveMeta(run);
      const { reflectPrompt } = await import("@parcha/agentrun-learn");
      // The one call that sends the end-of-run turn, with its origin.
      await this.toReflect(run, "/submit", { requestId: reflectId(run.id), content: reflectPrompt({ dir, active: Object.keys(seed.notes).length }), whenBusy: "followUp" }, REFLECT_ORIGIN);
      end = await this.reflectEnd(run, Date.parse(reflect.deadline));
    } catch (error) {
      if (!this.live(run) || run.cancel) return;
      warn(run.id, `its end-of-run turn was not asked: ${(error as Error).message}`);
      this.dropLearning(run, "reflect_failed", "The end-of-run turn could not be asked.");
      return this.terminate(run);
    }
    if (end === "gone") return;
    if (end === "ended") reflect.ended = true;
    else {
      reflect.timedOut = true;
      await this.abortTurn(run);
    }
    await this.saveMeta(run).catch((error: Error) => warn(run.id, `its end-of-run turn's end is not saved: ${error.message}`));
    this.terminate(run);
  }

  /** One request to a finishing run's door (toDoor wakes no run that is finishing): again while it opens or parks.
   *  `turnOrigin`: who sent a turn this request sends (REFLECT_ORIGIN), for the per-tool gate to take once this server
   *  has one; nothing reads it until then. */
  private async toReflect(run: Run, path: string, body?: Json, turnOrigin?: typeof REFLECT_ORIGIN): Promise<Json | null> {
    for (const deadline = Date.now() + 30_000; ; await sleep(200)) {
      if (!this.live(run) || run.cancel) throw new Error("the run's process is gone");
      const door = this.doorOf(await this.record(run));
      const res = door ? await fetch(new URL(path, door), { method: body ? "POST" : "GET", headers: this.headers(body !== undefined), body: body && JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(() => null) : null;
      const data = res ? ((await res.json().catch(() => null)) as Json | null) : null;
      if (res && res.status < 400) return data;
      if (res && !(res.status === 503 && RETRY_CODES.includes(String(data?.error)))) throw new Error(`the run's door answered ${res.status}`);
      if (Date.now() > deadline) throw new Error("the run's door did not answer");
    }
  }

  /** How the end-of-run turn ends: `ended` once the run's door says it is idle (the turn was taken before the submit was
   *  answered, so idle is after it), `timeout` at `deadline`, `gone` when the process went or the run was cancelled. */
  private async reflectEnd(run: Run, deadline: number): Promise<"ended" | "timeout" | "gone"> {
    for (;;) {
      const status = await this.toReflect(run, "/status").catch(() => null);
      if (!this.live(run) || run.cancel) return "gone";
      if (isObject(status?.busy) && status.busy.kind === "idle") return "ended";
      if (Date.now() >= deadline) return "timeout";
      await sleep(REFLECT_POLL_MS);
    }
  }

  /** At the run's end: the end-of-run turn's rows closed, and its learning settled from how the turn went. A run that
   *  never left `seeded` went before it could reflect. */
  private closeLearning(run: Run, outcome: Status): void {
    const { learning, reflect } = run.meta;
    if (learning?.state === "seeded") return this.setLearning(run, "dropped", ...((run.cancel || outcome === "cancelled" ? ["cancelled", "The run was cancelled before it could reflect."] : ["crashed", "The run's process went before it could reflect."]) as [LearningReason, string]));
    if (!reflect || reflect.until !== undefined) return;
    reflect.until = run.lastEntry ?? reflect.after;
    if (learning?.state !== "reflecting") return;
    const last = run.rows.findLast((row) => row.agent_label === LEARNING_LABEL && shows(row));
    if (run.cancel) this.setLearning(run, "dropped", "cancelled", "The run was cancelled during its end-of-run turn.");
    else if (reflect.timedOut) this.setLearning(run, "dropped", "reflect_timeout", "The end-of-run turn did not end in time.");
    else if (last?.kind === "error" && last.text?.startsWith(`${SPEND_CAP_REACHED}: `)) this.setLearning(run, "dropped", "no_budget", "The run's cap refused the end-of-run turn's request.");
    else if (last?.kind === "error") this.setLearning(run, "dropped", "reflect_failed", "The end-of-run turn ended on an error.");
    else if (!reflect.ended) this.setLearning(run, "dropped", "crashed", "The run's process went during its end-of-run turn.");
    else this.setLearning(run, "reflecting", null, "The end-of-run turn ended; what it wrote waits to be checked.");
  }

  /** What the run's end-of-run turn wrote, checked and kept as its proposal or dropped (propose.ts), once at a time, after
   *  the run has ended. Never rejects: `proposed` or `dropped`, `propose_failed` for a fault. A server that goes
   *  meanwhile leaves it `reflecting` in serve.json, and the next start checks it again. */
  private proposeOnce(run: Run): Promise<void> {
    if (!awaitsPropose(run.meta)) return Promise.resolve();
    return (run.proposing ??= this.propose(run).finally(() => (run.proposing = undefined)));
  }

  private async propose(run: Run): Promise<void> {
    try {
      const pin = await readPin(run.dir);
      if (!pin) throw new Error("the run has no learning pin");
      const { proposeRun } = await import("./propose.js");
      // The secrets this server holds, wherever its launcher put them, and its own tokens.
      const proposed = await proposeRun({ data: this.options.agents.dir, agentId: run.agentId, runDir: run.dir, seed: pin.seed, refuse: [...hostSecrets(process.env), this.options.token, this.options.doorToken] });
      if (proposed.state === "proposed") this.setLearning(run, "proposed", null, `The run proposes ${proposed.notes === 1 ? "one new note" : `${proposed.notes} new notes`}, which passed the checks and are being graded.`);
      else if (proposed.reason === "empty") this.setLearning(run, "dropped", "empty", "The end-of-run turn added no note.");
      else this.setLearning(run, "dropped", "checker", `The checks refused what the run wrote: ${[...new Set(proposed.problems.map((problem) => problem.rule))].join(", ")}.`, { problems: proposed.problems });
    } catch (error) {
      warn(run.id, `what its end-of-run turn wrote could not be checked: ${(error as Error).message}`);
      this.setLearning(run, "dropped", "propose_failed", "What the end-of-run turn wrote could not be checked.");
    }
    await this.saveMeta(run).catch((error: Error) => warn(run.id, `its learning is not saved: ${error.message}`));
    void this.gradeOnce(run);
  }

  /** The run's proposal merged into main or dropped (grade.ts), one grade at a time per agent, after the checks and
   *  never in a run's way. The verdict and what the grade spent are kept in serve.json and booked on /usage before the
   *  merge, so a restart neither asks the grader again nor books it twice. A server that closes mid-grade leaves the
   *  learning `proposed`, and its next start grades it. */
  private gradeOnce(run: Run): Promise<void> {
    if (run.meta.learning?.state !== "proposed") return Promise.resolve();
    return (run.grading ??= withAgentGrade(this.options.agents.dir, run.agentId, () => this.grade(run)).finally(() => (run.grading = undefined)));
  }

  private async grade(run: Run): Promise<void> {
    const before = run.meta.learning;
    if (before?.state !== "proposed" || this.closing) return;
    const data = this.options.agents.dir;
    let kept: Omit<Partial<Learning>, "state" | "reason" | "detail" | "at"> = before.verdict ? { verdict: before.verdict, cost_usd: before.cost_usd, tokens: before.tokens } : {};
    // A grade whose cost was kept was booked then, or by the restart pass.
    let booked = before.cost_usd !== undefined;
    const save = async () => {
      await this.saveMeta(run);
      if (booked || !run.meta.learning?.cost_usd) return;
      booked = true;
      const { at, cost_usd, tokens } = run.meta.learning;
      await book(data, { run: run.id, agent: run.agentId, at, usd: cost_usd.grade, tokens: tokens?.grade ?? null }).catch((error: Error) => warn(run.id, `its grade's cost is not booked: ${error.message}`));
    };
    const end = (state: LearningState, reason: LearningReason | null, detail: string, more: typeof kept = {}) => {
      this.setLearning(run, state, reason, detail, { ...kept, ...more });
      return save().catch((error: Error) => warn(run.id, `its learning is not saved: ${error.message}`));
    };
    try {
      const proposal = JSON.parse(await readFile(join(run.dir, PROPOSAL), "utf8")) as Proposal;
      const known = await this.options.agents.revision(run.agentId, run.revision);
      if (known?.revision.kind !== "agentic") throw new Error("the run's revision is not agentic");
      const { judgeProposal, mergeProposal, readForGrade } = await import("./grade.js");
      const main = kept.verdict ? undefined : await readForGrade(data, run.agentId, run.id, proposal);
      // Main took a note of the same name, or superseded one it supersedes, since the run started: refused before the
      // grader is asked.
      if (main && "problems" in main) return await end("dropped", "checker", `Main no longer takes what the run proposed: ${[...new Set(main.problems.map((problem) => problem.rule))].join(", ")}.`, { problems: main.problems });
      if (main && !("merged" in main)) {
        const { instructions, harness, model, thinking } = known.revision.body;
        const judged = await judgeProposal({ runId: run.id, agent: { instructions, harness, model, thinking }, main, proposed: proposal.notes, env: this.hostEnv(), signal: this.stopping.signal });
        kept = { cost_usd: { grade: judged.cost.usd }, tokens: { grade: judged.cost.tokens } };
        if ("file" in judged) return await end("dropped", judged.reason, judged.reason === "screen" ? "The injection screen refused a new note." : "The injection screen could not judge a new note.");
        if ("error" in judged) {
          warn(run.id, `its grader gave no verdict: ${judged.error.message}`);
          return await end("dropped", "grade_failed", "The grader gave no verdict.");
        }
        kept.verdict = judged.verdict;
        if (!judged.verdict.merge) return await end("dropped", "grader", "The grader's verdict was to keep none of the new notes.");
        // Kept and booked before the merge: a restart merges on this verdict, and never asks or books the grader again.
        this.setLearning(run, "proposed", null, before.detail, kept);
        await save();
      }
      const merge = await mergeProposal(data, run.agentId, run.id, proposal, kept.verdict?.reason || "The grader kept every new note.");
      if ("problems" in merge) return await end("dropped", "checker", `Main no longer takes what the run proposed: ${[...new Set(merge.problems.map((problem) => problem.rule))].join(", ")}.`, { problems: merge.problems });
      if (merge.checkout) warn(run.id, `its merge is on main, but the folder's files were not brought in line: ${merge.checkout.message}`);
      await end("merged", null, "What the run learned is merged into main.", { merged: merge.merged });
    } catch (error) {
      // A server closing: nothing was decided, and the next start grades the run.
      if (this.closing) return;
      warn(run.id, `what it proposed could not be graded: ${(error as Error).message}`);
      await end("dropped", "grade_failed", "What the run proposed could not be graded or merged.");
    }
  }

  /** This server's environment for a call of its own (a grade's screen and grader): its secrets readable, never a
   *  child's, and the test hooks a run's process gets. */
  private hostEnv(): NodeJS.ProcessEnv {
    return withSecrets({ ...withoutFaux(process.env), ...this.fauxEnv() });
  }

  /** The test hooks startServe's options name, as a run's process and this server's own calls get them. */
  private fauxEnv(): NodeJS.ProcessEnv {
    const { faux, fauxBrowser, fauxWeb, fauxJev, fauxParallel, fauxOpenrouter, fauxMonid, fauxHarness } = this.options;
    return {
      ...(faux ? { [FAUX_ENV]: faux, ...(fauxBrowser ? { [FAUX_BROWSER_ENV]: fauxBrowser } : {}), ...(fauxWeb ? { [FAUX_WEB_ENV]: fauxWeb } : {}), ...(fauxJev ? { [FAUX_JEV_ENV]: fauxJev } : {}), ...(fauxParallel ? { [FAUX_PARALLEL_ENV]: fauxParallel } : {}), ...(fauxOpenrouter ? { [FAUX_OPENROUTER_ENV]: fauxOpenrouter } : {}) } : {}),
      ...(fauxHarness ? { [FAUX_HARNESS_ENV]: fauxHarness } : {}),
      ...(faux && fauxMonid ? { [FAUX_MONID_ENV]: fauxMonid } : {}),
    };
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
    this.reportedBack(run);
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
    })().catch((error: unknown) => {
      // A sweep that failed is not kept: the next start, open or relaunch sweeps again, so one transient error never
      // holds every run back until the server restarts. Nothing of this server's runs has started a box before it.
      this.swept = undefined;
      throw error;
    });
    return this.swept;
  }

  /** The run's box let go (archive, or its process gone after an archive): reaped by the box's own count. */
  private async teardown(run: Run): Promise<void> {
    const box = this.options.box;
    if (!box || this.live(run)) return;
    // Never in the way of the run's own end or an archive already saved: a box that could not be let go (its cgroup not
    // removed, its record not marked) is said, and its unmarked record is tried again by the next start's sweep.
    try {
      if ((await settleBox(box.host, box.quarantine, run.id, run.dir)) === "quarantined") warn(run.id, "its box could not be emptied; it is quarantined, and tried again at each start");
    } catch (error) {
      warn(run.id, `its box was not let go (${(error as Error).message}); the next start tries again`);
    }
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
    const rows = await this.options.agents.request(() => this.store.listRuns());
    for (const row of rows) {
      if (row.state !== "running" || row.importedFrom) continue;
      const run = await this.adopt(row).catch((error: Error) => (warn(row.id, `not recovered: ${error.message}; the next start tries again`), null));
      if (run && !this.live(run) && !run.outcome) await this.settle(run, null, false);
    }
    // Then each ended run whose learning a server left between steps: what its end-of-run turn wrote not checked yet, or
    // its proposal not graded or merged. It is checked or graded now, once. A grade whose cost was kept and not booked
    // is booked.
    const booked = new Set((await bookings(this.options.agents.dir).catch(() => [])).map((entry) => entry.run));
    for (const row of rows) {
      if (this.closing) return;
      if (row.state === "running" || row.importedFrom || row.kind !== "agentic") continue;
      const meta = (await readJson(join(this.options.agents.dir, "runs", row.id, RUN_META))) as Partial<RunMeta> | null;
      const learning = meta?.learning;
      this.endedLearning.set(row.id, shortLearning(isObject(learning) ? learning : null));
      if (learning?.cost_usd && !booked.has(row.id)) await book(this.options.agents.dir, { run: row.id, agent: row.agent, at: learning.at, usd: learning.cost_usd.grade, tokens: learning.tokens?.grade ?? null }).catch((error: Error) => warn(row.id, `its grade's cost is not booked: ${error.message}`));
      if (!awaitsPropose(meta) && learning?.state !== "proposed") continue;
      const run = await this.get(row.id).catch((error: Error) => (warn(row.id, `not read: ${error.message}; the next start tries again`), null));
      if (run && awaitsPropose(run.meta)) await this.proposeOnce(run);
      else if (run) void this.gradeOnce(run);
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
        if (door) this.reportedBack(run);
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
    // A run brought up by a request (a message before the start's recovery reached it) waits for the sweep as well.
    await this.sweepOnce();
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
        if (!fresh) this.launch(run), (launched = true);
      }
      if (Date.now() > deadline) throw new ApiError("unavailable", "the run did not come up in time", { retry_after_ms: 1000 }, { "retry-after": "1" });
    }
  }

  /** The refusal of a message to an imported run: it was run elsewhere, and is kept as history. */
  private importedRefusal(run: Run): ApiError {
    const source = run.imported?.source;
    return new ApiError("not_continuable", `This run was imported from ${source}: it is history, not run here, so it takes no message. Start a new run of the agent.`, {
      details: { reason: "imported", imported_from: source },
      next_action: { type: "request", method: "POST", path: `/agents/${run.agentId}/runs`, caller_supplies: ["input", "Idempotency-Key"] },
    });
  }

  private finished(run: Run): ApiError {
    const status = run.cancel ? "cancelled" : statusOf(run).status;
    const why = status === "completed" ? "This run is finished." : `This run ${status === "failed" ? "failed" : "was cancelled"}.`;
    return new ApiError("not_continuable", `${why} Start a new run of the agent.`, {
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
    // Its secrets go over fd 3, written whole and closed as it starts; it reads them first (secrets.ts).
    const secrets = handover(RUN_SECRETS);
    const env: NodeJS.ProcessEnv = {
      ...childEnv(process.env, this.options.token),
      [SECRETS_FD_ENV]: "3",
      [SECRETS_LEN_ENV]: String(secrets.length),
      ...this.fauxEnv(),
      ...(run.meta.effort ? { [EFFORT_ENV]: run.meta.effort } : {}),
      ...(this.options.documents ? { [DOCUMENTS_ENV]: this.options.documents } : {}),
    };
    // Kept for its metrics: the host's level may change before the run ends.
    run.meta.launch_thinking = { ...(env[EFFORT_ENV] ? { effort: env[EFFORT_ENV] } : {}), ...(env.AGENT_THINKING ? { host: env.AGENT_THINKING } : {}) };
    void this.saveMeta(run).catch((error: Error) => warn(run.id, `what its process thinks at is not saved: ${error.message}`));
    delete env[CAP_ENV];
    if (run.meta.max_cost_usd !== undefined) env[CAP_ENV] = String(run.meta.max_cost_usd);
    // The decision keys are never in a run's environment, which its tools and its model's provider read (childEnv leaves
    // out every secret): a workflow run's process gets them once on an inherited pipe, by name, for its decision
    // providers and web_fetch alone (decisions.ts), and an agentic run's process Parallel's alone when it names
    // web_fetch.
    delete env[DECISION_KEY_FD_ENV];
    // Chosen from the secrets this server holds: out of its environment once its launcher hands them over (secrets.ts).
    const offered = decisionKeysOf(withSecrets(process.env));
    const decisionKeys = run.kind === "workflow" ? offered : run.webFetch && offered[PARALLEL_KEY_ENV] ? { [PARALLEL_KEY_ENV]: offered[PARALLEL_KEY_ENV] } : {};
    const handsKey = Object.keys(decisionKeys).length > 0;
    this.markLaunching(run);
    const log = openSync(join(run.dir, PROCESS_LOG), "a", 0o600);
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "ignore", log, "pipe"];
    // The first descriptor after the others: macOS aborts the parent of a spawn with a pipe at 16 or above.
    const keyFd = stdio.length;
    if (handsKey) {
      stdio.push("pipe");
      env[DECISION_KEY_FD_ENV] = String(keyFd);
    }
    // A workflow run resumes from its journal when it opens again, so SIGTERM lets it go at once, undrained.
    const drain = run.kind === "workflow" ? "0s" : (this.options.drainTimeout ?? DRAIN);
    const child = spawn(process.execPath, [
      // secrets.ts first, as a preload: the pipe is read and closed before pi-durable-disk's CLI loads or starts anything.
      "--no-warnings=ExperimentalWarning", "--import", SECRETS_MODULE, this.cli, "run", "--dir", run.dir, "--app", this.app,
      "--serve", "0", "--serve-host", "127.0.0.1", "--serve-token-file", this.options.doorTokenFile, "--drain-timeout", drain,
    ], { stdio, env });
    closeSync(log);
    const pipe = child.stdio[3] as import("node:stream").Writable | null;
    pipe?.on("error", () => {});
    pipe?.end(secrets);
    if (handsKey) {
      const keyPipe = (child.stdio as unknown as readonly (Writable | null | undefined)[])[keyFd];
      // A process that dies before it reads the key closes the pipe: that is its exit to settle, not an error here.
      keyPipe?.on("error", () => undefined);
      keyPipe?.end(JSON.stringify(decisionKeys));
    }
    run.child = child;
    child.once("exit", (code) => {
      if (run.child === child) run.child = undefined;
      this.reportedBack(run);
      void this.settle(run, code, true);
    });
    child.once("error", () => {
      if (run.child === child) run.child = undefined;
      this.reportedBack(run);
    });
    this.connect(run);
  }

  /** Writes the run's launch mark before its process is spawned: a spawn that takes the server down leaves it, and the
   *  next start fails the run rather than launch it again and go down with it. The file exists once the call returns,
   *  which a server's death does not undo; no fsync, which would hold the event loop on the disk at every launch. */
  private markLaunching(run: Run): void {
    closeSync(openSync(join(run.dir, RUN_LAUNCHING), "w", 0o600));
    run.launching = true;
  }

  /** The run's newest launch came through with the server up: its process serves, or exited while it was watched. Its
   *  callers are event handlers, so a mark that cannot be removed is logged, never thrown: a throw there stops the
   *  server and every run on it. The mark left behind fails the run at the next start, which never launches it again. */
  private reportedBack(run: Run): void {
    if (!run.launching) return;
    run.launching = false;
    try {
      rmSync(join(run.dir, RUN_LAUNCHING), { force: true });
    } catch (error) {
      this.options.log?.("launch_mark_kept", { run: run.id, code: (error as NodeJS.ErrnoException).code ?? "unknown" });
    }
  }

  /** Opens the run again on its directory after its process went before the run ended: it resumes from its store. An
   *  agentic run whose first message never landed gets it again, under the same request id. */
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
    // Its metrics are this settle's read, or none: never an earlier end's.
    run.metrics = undefined;
    if (released || gone) await this.storeWhenFree(run, true);
    // Its process gone: an archived run's box is let go now, whatever comes next (an outcome, a wait for the person, a
    // relaunch), since nothing else would until the next start or archive. This is every archived end that can let a box
    // go: a settle with the process not gone means another live holder of the run, whose box is its own. That holder is
    // one this server neither started nor adopted (adoptProcess watches only the holder it adopts), so its later exit
    // settles nothing here: its box stays held, fail-closed, until the next start's sweep or another archive lets it go.
    if (gone && (await this.options.agents.request(() => this.store.readRun(run.id)).catch(() => undefined))?.archivedAt) await this.teardown(run);
    let ended: { outcome: Status; state?: Ended; summary?: string } | undefined;
    // A workflow run carries back how its workflow ended, through workflowCarry; cancelled before that, it stopped.
    // A cancel during the end-of-run turn ends the run's learning, never its job: the run keeps the outcome it had.
    if (run.cancel && !reflecting(run)) ended = run.kind === "workflow" ? await this.workflowEnd(run, workflowEnding(record) ?? { status: "stopped" }) : { outcome: "cancelled" };
    else if (run.finishing) ended = { outcome: run.finishing };
    else if (run.launching && gone) {
      run.error = { code: "run_failed", message: "The server went down while it started the run's process, which never came up; it is not started again, since starting it may be what took the server down.", retryable: false, details: { reason: LAUNCH_LOST } };
      ended = { outcome: "failed" };
    } else if (exited && !released && code !== null && code !== 0) {
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
      if (run.relaunches < MAX_RELAUNCHES) return this.relaunch(run);
      run.error = { code: "run_failed", message: `The run's process went ${MAX_RELAUNCHES + 1} times before the run ended: ${await lastLogLine(run)}`, retryable: false };
      ended = { outcome: "failed" };
    }
    await this.carryBack(run, ended.outcome, ended.state, ended.summary);
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
    else if (state === "escalated") {
      const { escalation, escalatedAt } = await readWorkflowRun(at);
      run.meta.review = { kind: escalation?.kind ?? null, node: escalation?.label ?? escalatedAt?.label ?? null, reason: escalation?.summary ?? summary };
    }
    else if (state === "failed") run.error = { code: "run_failed", message: `The workflow failed: ${summary}.`, retryable: false };
    await this.readDecisionCost(run);
    return { outcome: STATUS_OF[state], state, summary };
  }

  /** A workflow run's decisions' cost, from their receipts in its released store: a receipt whose cost is unknown leaves
   *  the run's unknown, never $0. Read at its end and again when a restarted server adopts it as ended. */
  private async readDecisionCost(run: Run): Promise<void> {
    const { durableDecisions } = await import("@parcha/agentrun-pi/durable");
    // Not its `llm` calls: each completes on the run's marked models, so its cost is a REQUEST_COST entry its usage row
    // already sums (request-start.ts).
    const paid = durableDecisions(this.storeFile(run)).map((row) => row.cost_usd);
    if (paid.length) run.decisionCost = paid.every((cost) => typeof cost === "number") ? (paid as number[]).reduce((a, b) => a + b, 0) : null;
  }

  /** Ends the run in the agent store, once: how it ended, its cost, a line for the list and its metrics. A store held by
   *  another writer is tried again with backoff; past the last try the run stays unsettled, and the next start carries it back. */
  private async carryBack(run: Run, outcome: Status, state?: Ended, summary?: string): Promise<void> {
    this.closeLearning(run, outcome);
    const answer = answerOf(run.rows);
    const cost = run.decisionCost === undefined ? costOf(run.rows) : costView(run.rows, undefined, run.decisionCost);
    const line = summary ?? (outcome === "completed" ? (run.answerText ?? answer?.text ?? answer?.summary) : outcome === "cancelled" ? "cancelled" : run.error?.message);
    if (run.error) run.meta.error = { code: run.error.code, message: run.error.message, ...(run.error.details ? { details: run.error.details } : {}) };
    const ending = { state: state ?? (outcome === "cancelled" ? "stopped" : outcome === "completed" ? "completed" : "failed"), ...(cost === null ? {} : { costUsd: cost }), ...(line ? { summary: line } : {}) } as const;
    const counted = run.metrics;
    const end = (metrics?: StoredMetrics) => {
      try {
        this.store.carryBack(run.id, metrics ? { ...ending, metrics } : ending);
      } catch (error) {
        if (!(error instanceof AgentHomeError && error.code === "exists")) throw error;
      }
    };
    const persist = async () => {
      await this.saveMeta(run);
      await whenFree(() => {
        const metrics = counted && this.storedMetrics(run, counted);
        try {
          end(metrics);
        } catch (error) {
          // Metrics the store refuses (a name past its limit) never hold up the run's end: it ends without them.
          if (!(metrics && error instanceof AgentHomeError && error.code === "invalid")) throw error;
          warn(run.id, `its metrics are not kept: ${error.message}`);
          end();
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
    // Only once the run has ended as it would without learning: a slow or failing check never holds the job.
    void this.proposeOnce(run);
  }

  /** The run's metrics as the store keeps them: what its entries say it used, the effort its newest process ran at (unknown
   *  for one an older server started), and on a harness other than pi the model its revision names (its entries name the
   *  harness). A busy store throws, for the write's retries; a revision that cannot be read otherwise adds nothing. */
  private storedMetrics(run: Run, counted: RunMetrics): StoredMetrics {
    let revision: Revision;
    try {
      revision = this.store.readRevision(run.revision);
    } catch (error) {
      if (storeBusy(error)) throw error;
      return counted;
    }
    const body = revision.kind === "agentic" ? revision.body : undefined;
    const harness = body?.harness ?? DEFAULT_HARNESS;
    // As its process chose it (app.ts): the run's effort, else its revision's thinking, else the host's, else medium.
    const launched = run.meta.launch_thinking;
    const level = launched && thinkingFor(harness, thinkingOf({ [EFFORT_ENV]: launched.effort, AGENT_THINKING: launched.host }, body?.thinking));
    return { ...counted, ...(level ? { effort: level } : {}), ...(harness !== DEFAULT_HARNESS && body?.model ? { model: body.model } : {}) };
  }

  /** Tries `persist` again every settleRetryMs while the server lives, until it lands. */
  private persistLater(run: Run, persist: () => Promise<void>): void {
    const timer = setTimeout(() => {
      if (this.closing) return;
      persist().then(async () => {
        const row = await this.options.agents.request(() => this.store.readRun(run.id)).catch(() => undefined);
        if (row?.endedAt) run.endedAt = row.endedAt;
        if (row?.costUsd !== undefined) run.costUsd = row.costUsd;
        await this.proposeOnce(run);
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
  private storeWhenFree(run: Run, atEnd = false): Promise<void> {
    return whenFree(() => this.readStore(run, atEnd), this.busyDelays(), this.onBusy(run.id, "its store"));
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

  /** What a run of `agentId` starts from: its learning folder's main (learning.ts), the folder made first when it is
   *  absent; else why it starts with nothing learned. A learning fault never refuses a run: a host without the git
   *  learning needs is said once, and a folder that cannot be made or read once per run. */
  private async seedFor(agentId: string): Promise<{ seed: Seed } | { failed: string }> {
    const blocked = await learningBlocker(process.env);
    if (blocked) {
      if (this.learningOff !== blocked) process.stderr.write(`agentrun-serve: runs start with nothing learned: ${blocked}\n`);
      this.learningOff = blocked;
      return { failed: "This host has no git that learning can use, so the run started with nothing learned." };
    }
    return seedOf(this.options.agents.dir, agentId).then((seed) => ({ seed }), (error: Error) => {
      process.stderr.write(`agentrun-serve: the agent ${agentId}'s learning folder could not be read, so its run starts with nothing learned: ${error.message}\n`);
      return { failed: "The agent's learning folder could not be read, so the run started with nothing learned." };
    });
  }

  private async start(entry: AgentEntry, revision: Revision, version: number, options: { input: Json; title: string; effort?: string; maxCostUsd?: number }): Promise<Run> {
    // A run learns when the server's switch (`--learning`) is on and its agent's definition says `learning: true`. Its
    // seed is read before the run is made, so the folder is read once whatever the run's setup does.
    const learns = this.options.learning !== "off" && revision.kind === "agentic" && revision.body.learning === true;
    const seeded = learns ? await this.seedFor(entry.agent.id) : undefined;
    const started = await this.options.agents.request(() => this.store.startRun({ agent: entry.agent.id, revision: revision.id })).catch((error) => storeError(error, "revision"));
    const at = new Date().toISOString();
    let failed = seeded && "failed" in seeded ? seeded.failed : undefined;
    if (seeded && "seed" in seeded) {
      try {
        await pinSeed(started.dir, started.workspace, seeded.seed);
        for (const path of seeded.seed.skipped) warn(started.runId, `its learning folder's ${path} was not read`);
      } catch (error) {
        warn(started.runId, `starts with nothing learned: ${(error as Error).message}`);
        failed = "What the agent learned could not be copied into the run, so it started with nothing learned.";
      }
    }
    const meta: RunMeta = {
      title: clip(options.title.trim().replace(/\s+/g, " "), 80),
      created_at: at,
      input: options.input,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.maxCostUsd !== undefined ? { max_cost_usd: options.maxCostUsd } : {}),
      ...(seeded ? { learning: failed === undefined ? { state: "seeded", reason: null, detail: null, at } : { state: "dropped", reason: "seed_failed", detail: failed, at } } : {}),
    };
    try {
      await writeWhole(join(started.dir, RUN_META), `${JSON.stringify(meta)}\n`);
    } catch (error) {
      // The store has the run as running, and no process will run it: it ends failed here, never left for a later
      // start to open with half its files.
      const summary = `The run could not be set up: ${(error as Error).message}`;
      await this.options.agents.request(() => this.store.carryBack(started.runId, { state: "failed", summary })).catch((undo: Error) => warn(started.runId, `not ended after its setup failed: ${undo.message}`));
      throw error;
    }
    const run = this.blank({ id: started.runId, agent: entry.agent.id, revision: revision.id, kind: revision.kind }, started.dir, meta, version, revision);
    this.runs.set(run.id, run);
    // A seed that failed is a learning row from the start.
    this.show(run);
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
    if (run.imported) throw this.importedRefusal(run);
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
    // An end-of-run turn its process went in would resume with the run: it is aborted before the follow-up is sent. One
    // that cannot be aborted runs out ahead of it, and its rows are never the follow-up's answer, which comes after them.
    if (run.meta.reflect && run.meta.learning?.reason === "crashed") await this.toDoor(run, "/abort", {}).catch(() => undefined);
  }

  /** Abort the turn that is running; the run stays open, `input_required` and idle. A workflow run has no turn to stop. */
  async stop(run: Run): Promise<boolean> {
    // The contract's stop has no refusal: an imported run answers as any ended one, stopped false, and nothing moves.
    if (run.imported) return false;
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
    // As stop: already terminal, and no cancel mark is written.
    if (run.imported) return false;
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

  /** Pause a workflow run (`paused` true) or resume it: the mark in its directory, which its process reads before each
   *  node starts. A run that has ended is not continuable. */
  async pause(run: Run, paused: boolean): Promise<{ run_id: string; paused: boolean; status: Status }> {
    if (run.kind !== "workflow") throw unsupported("runs.pause", "Only a workflow run pauses here: an agentic run's turn is stopped with POST /runs/{id}/stop.");
    if (TERMINAL.has(statusOf(run).status) || run.cancel) throw this.finished(run);
    const mark = join(run.dir, RUN_PAUSED);
    if (paused) await writeWhole(mark, `${new Date().toISOString()}\n`);
    else await rm(mark, { force: true });
    this.mark(run);
    return { run_id: run.id, paused, status: statusOf(run).status };
  }

  /** A workflow run's graph as it stands (graph-view.ts), live while it runs. */
  async graph(run: Run) {
    if (run.kind !== "workflow") throw new ApiError("not_found", `the run ${run.id} is an agentic run; only a workflow run has a graph`);
    // A revision never changes: read once, waiting out a busy store as a run's end does, never failing a poll on it.
    let workflow = this.workflows.get(run.revision);
    if (workflow === undefined) {
      const revision = (await whenFree(() => this.store.readRevision(run.revision), this.busyDelays(), this.onBusy(run.id, "the agent store"))) as Extract<Revision, { kind: "workflow" }>;
      this.workflows.set(run.revision, (workflow = revision.body.workflow));
    }
    // The run's status as this server holds it, with no read of the agent store, which the run's process may be writing.
    const { status } = statusOf(run);
    const ended = TERMINAL.has(status);
    const { runGraph } = await import("./graph-view.js");
    const given = {
      run: { id: run.id, agent: run.agentId, revision: run.revision, status, paused: status === "paused", startedAt: run.meta.created_at, endedAt: ended ? (run.endedAt ?? run.updatedAt) : null },
      ended, workflow, storeFile: this.storeFile(run), root: run.dir, input: run.meta.input ?? {}, modelCost: costOf(run.rows), llmRead: run.llmRead ?? 0,
    };
    // A poll never answers home_busy: a store still held answers the live view, or the last whole one, marked stale.
    try {
      const view = await runGraph(given);
      this.graphs.set(run.id, view);
      return { ...view, stale: false };
    } catch (error) {
      if (!storeBusy(error)) throw error;
      warn(run.id, "its store is busy; the graph answers its live view, stale");
      const held = this.graphs.get(run.id);
      if (held) return { ...held, run: given.run, stale: true };
      return { ...(await runGraph({ ...given, liveOnly: true })), stale: true };
    }
  }

  /** How long a run's process gets after SIGTERM before SIGKILL: its drain and a second to exit. */
  private killAfterMs(): number {
    return (durationMs(this.options.drainTimeout ?? DRAIN) ?? 30_000) + 1_000;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.stopping.abort();
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
    await Promise.all([...this.runs.values()].map((run) => run.proposing));
    await Promise.all([...this.runs.values()].map((run) => run.grading));
    for (const run of this.runs.values()) run.feed?.abort();
    this.closed = true;
  }

  // ---- views ------------------------------------------------------------------------------------------------------------

  /** A run's cost from its rows, else what the store recorded when it carried the run back. */
  cost(run: Run) {
    // An imported run's cost is its source's, for the whole session: its requests may not each have a price.
    return { usd: run.imported ? (run.costUsd ?? null) : costView(run.rows, run.costUsd, run.decisionCost), basis: "estimate", charge_state: null, cap_usd: run.meta.max_cost_usd ?? null };
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
    const endedAt = TERMINAL.has(status) ? (row?.endedAt ?? run.endedAt ?? run.updatedAt) : null;
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
      ended_at: endedAt,
      result: status === "completed" ? { output: run.kind === "workflow" ? (run.meta.output ?? null) : null, final_answer: finalAnswer } : kept ? { output: null, final_answer: kept } : null,
      error: status === "failed" ? (run.error ?? { code: "run_failed", message: "The run failed.", retryable: false }) : null,
      review: endedAt === null ? null : reviewAt(run.meta.review ?? (row ? reviewOfRow(row, run.meta) : null), endedAt),
      cost: this.cost(run),
      archived_at: stored?.archivedAt ?? null,
      imported_from: run.imported ?? null,
      learning: run.meta.learning ? learningView(run.meta.learning) : null,
      poll_after_ms: TERMINAL.has(status) && run.settled ? 0 : 1000,
    };
  }

  async summary(run: Run) {
    const { run_id, agent_id, agent_version, revision, kind, sha, status, state, title, created_at, ended_at, error, review, cost, archived_at, imported_from, learning } = await this.view(run);
    return { run_id, agent_id, agent_version, revision, kind, sha, status, state, title, created_at, ended_at, error, review, cost, archived_at, imported_from, learning: shortLearning(learning) };
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
      review: reviewAt(reviewOfRow(row, meta), row.endedAt ?? new Date(0).toISOString()),
      cost: { usd: row.costUsd ?? null, basis: "estimate", charge_state: null, cap_usd: typeof meta?.max_cost_usd === "number" ? meta.max_cost_usd : null },
      archived_at: row.archivedAt ?? null,
      imported_from: row.importedFrom ?? null,
      learning: shortLearning(isObject(meta?.learning) ? (meta.learning as Learning) : null),
    };
  }

  /** A run's learning, in short, for a count: a held run's, else an ended run's as the start's pass read it, else its
   *  serve.json's, kept once its learning ended (merged or dropped never moves again). */
  async learningOfRow(row: RunRow): Promise<{ state: LearningState; reason: LearningReason | null } | null> {
    const held = this.runs.get(row.id);
    if (held) return shortLearning(held.meta.learning ?? null);
    const known = this.endedLearning.get(row.id);
    if (known !== undefined) return known;
    const meta = (await readJson(join(this.options.agents.dir, "runs", row.id, RUN_META))) as Partial<RunMeta> | null;
    const learning = shortLearning(isObject(meta?.learning) ? (meta.learning as Learning) : null);
    if (learning?.state === "merged" || learning?.state === "dropped") this.endedLearning.set(row.id, learning);
    return learning;
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
