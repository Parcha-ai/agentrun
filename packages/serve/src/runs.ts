// Runs: each one a child process (`pi-durable-disk run` on `<data>/runs/<id>` with serve's app), pinned to a revision in
// the agent store. An agentic run is read live through the door its process serves on loopback; a workflow run is
// working while its process lives. Once the process has exited the run is read from its store, read-only, and carried
// back to the agent store (`carryBack`), and it is finished. A run whose process went before the run ended is opened
// again on its directory, and resumes from its store.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open as openFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { AgentHomeError, type Revision, type RevisionKind, type RunRow, type RunState, type StoredMetrics } from "@parcha/pi-durable-agent";
import { registerLabel, registerTurnEnding, type RunMetrics, runMetricsWithDecisions, timelineOf, timelineReducer, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { HARNESS_LOG_EVENT, harnessModelKeys, thinkingFor } from "./adapters.js";
import { DEFAULT_HARNESS, harnessOfBody, steersMidTurn } from "./harness.js";
import type { RunNotice, WEBHOOK_EVENTS } from "./webhooks.js";
import { hostMemory, memoryFull, neverFits, runMibOf, runsMemoryMib } from "./host.js";
import { type AgentEntry, type Agents, storeBusy, storeError, whenFree } from "./agents.js";
import { LAUNCH_LOST, readJson, RUN_CANCELLED, RUN_DOOR_TOKEN, RUN_LAUNCHING, RUN_META, runDoorToken, writeWhole } from "./files.js";
import { type DaytonaApi, KEPT_AUTOSTOP_MINUTES, keepWhenIdle, wakeBoxes } from "./daytona-api.js";
import { type Learning, LEARNING_LABEL, type LearningMode, type LearningReason, type LearningState, shortOf } from "./learning.js";
import { labelled, LearningRuns, type Reflect, reflecting, reflects, type TurnOrigin, withLearning } from "./learning-run.js";
import { type BoxHost, type Quarantine, settleBox, sweepBoxes } from "./box/sweep.js";
import { rowPaths } from "./workspace-paths.js";
import { ASK_TOOL, toolingOf, workflowTools } from "./tools.js";
import { withDecisions } from "./decision-rows.js";
import { DECISION_KEY_FD_ENV, decisionKeysFor, providersNamed } from "./decisions.js";
import { ApiError, unsupported } from "./errors.js";
import { DOCUMENTS_ENV } from "./pdf-pages.js";
import { CAP_ENV, CAP_REFUSAL_PREFIX, SPEND_CAP_REACHED } from "./cap.js";
import { EFFORT_ENV, GATEWAY_KEY_ENV, hostModel, KEY_MODEL_ENV, llmTiers, modelKeys, nodeTiers, PROVIDER_KEYS, thinkingOf, type Tier, withoutFaux, workflowNodes } from "./model.js";
import { llmAnswers, pausedIn, readNodeLog, RUN_PAUSED } from "./pause.js";
import { durationMs } from "./print.js";
import { handsParallel, type Plane, planeFor, recheckPlane, TOOL_PLANE_ENV, type Tooling, type ToolSettingsMap } from "./tool-plane.js";
import { ChangeClock, type Page, RowLog } from "./rows.js";
import { TOOL_KEYS } from "./tool-keys.js";
import { isObject, type Json } from "./validate.js";
import { firstMessage } from "./run-manifest.js";
import { ADAPTER_API, MESSAGE, MESSAGE_END, TURN_END } from "./turn-end.js";
import { DECISION_KEYS, handover, SECRET_NAMES, SECRETS_FD_ENV, SECRETS_LEN_ENV, type StoredKeys, withoutSecrets, withSecrets } from "./secrets.js";
import { keyRefusal, runKeyOf } from "./key-refusal.js";
import { BOX_KEYS } from "./boxes.js";
import { type Place, remotePlace, storedPlace } from "./place.js";
import { destroyRunBoxes, ensureRemoteBox, PullIncomplete, pullRemoteBox, sweepRunBoxes } from "./run-box.js";
import type { BoxProvider } from "@parcha/pi-transport";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Emitted } from "./webhooks.js";

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
/** The reducer's live "Run started" and "Run finished" rows: a turn's edges, which no store entry makes on any harness,
 *  so a run's settled timeline never has them. Never served, live or settled, so no row a reader saw goes at the end. */
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
/** How long serve's calls on a run's box (its destroy, the start's sweep) may take. */
const BOX_CALL_MS = 60_000;
const boxContext = (ms = BOX_CALL_MS) => withAbortSignal(AbortSignal.timeout(ms), BACKGROUND_CONTEXT);
/** How long a remote box's making and seed, or one pull of its work/, may take: a sandbox's start, then the copy. */
const REMOTE_SYNC_MS = 15 * 60_000;
/** How long a read of a run's files waits for the pull its turn's end began. */
const PULL_WAIT_MS = 120_000;

/** A run's end that waits for its remote box's last pull: its settle is tried again until the pull lands. */
class PullPending extends Error {}

/** Run directory `dir`'s own door token, made now (mode 0600, never through a link) when it has none. */
function ensureRunDoorToken(dir: string): string {
  const held = runDoorToken(dir);
  if (held) return held;
  const token = `ar_door_${randomBytes(24).toString("base64url")}`;
  try {
    writeFileSync(join(dir, RUN_DOOR_TOKEN), `${token}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Made meanwhile: that one is the run's.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const made = runDoorToken(dir);
    if (!made) throw new Error(`the run's door token at ${RUN_DOOR_TOKEN} is not one`);
    return made;
  }
  return token;
}
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
  /** Its tools' providers, resolved at its first launch and kept for its life (tool-plane.ts). */
  tool_plane?: Plane;
  /** Where it runs, as its start resolved it (place.ts): its process reads it. Absent for a run an older server started,
   *  which ran on the runner. */
  place?: Place;
  /** Where the run's learning stands (learning.ts); absent for a run that does not learn. */
  learning?: Learning;
  /** The run's end-of-run turn, saved before it is asked. */
  reflect?: Reflect;
  /** A run whose cost was unknown when it ended: the sum of its charges whose cost is known, and how many have none
   *  (costsofar/1), as its view said then, so a list row read from the store says it too. */
  cost_so_far?: SoFar;
};
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
  /** The harness its revision names (pi when it names none, or its revision is gone). */
  harness: string;
  /** The newest store entry the run has shown. */
  lastEntry?: number;
  /** What the live path's rows keep served (keepCommitted), for a learning row shown between its snapshots. */
  keep?: (id: string) => boolean;
  /** What its pinned revision's tools resolve from (tool-plane.ts), resolved again at each launch. */
  tooling?: Tooling;
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
  /** The whole text of each assistant message of its end-of-run turn, by store entry: what the turn answered, whose
   *  notes learning reads (learning-run.ts). */
  turnText?: Map<number, string>;
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
  /** Whether, in the run's entries, an answer that ended its request (stopReason "stop") comes after the person's newest
   *  message: the turn that took the message answered it, though perhaps with nothing it shows (noteAnswer). */
  answeredMessage?: boolean;
  /** The messages a claude-agent or codex run's door accepted and has not sent yet, by id (MESSAGE with no MESSAGE_END in
   *  its entries, noteAnswer): each still waits for its turn, also when this server started after it was accepted. */
  waiting?: Set<string>;
  /** Messages this server sent the run that its rows do not show yet. */
  submitted: number;
  /** The user_message rows the run has shown, by id: one shown for the first time is a submitted message arriving. */
  users: Set<string>;
  /** The rows the live path has shown as live, by id, over every connection to the run's door. */
  live: Set<string>;
  cancel: boolean;
  /** Set when the run has answered or failed and is being let go; the outcome it gets. */
  finishing?: Status;
  /** A stop on its way: from its mark to its abort's answer, or a server's abort of a saved stop's turn that outlived the
   *  server before it (finishStop). The abort withdraws every input queued behind that turn, so a message meanwhile waits
   *  for it (message). */
  stopping?: true;
  endedAt?: string;
  outcome?: Status;
  error?: RunError;
  /** The cost the store recorded when it carried the run back; null when it recorded none (unknown). */
  costUsd?: number | null;
  /** A workflow run's decisions' cost, from its receipts once its end is read: null when one is unknown. */
  decisionCost?: number | null;
  /** The same decisions, apart: the sum of the costs that are known, and how many are not. */
  decisionsPriced?: { known: number; unpriced: number };
  /** A workflow run's decision rows, from its released store: its timeline shows one row each (decision-rows.ts). Null
   *  when they cannot be read: its timeline's usage row then reads unknown. */
  decisions?: Record<string, unknown>[] | null;
  /** How many of a workflow run's llm calls' answers its node log held when its rows were last read: their cost is in its
   *  rows (each a REQUEST_COST entry, committed before its answer is logged), so its graph counts only the later ones. */
  llmRead?: number;
  /** What every conversation of its store says it used, as the settle that ends it read them. */
  metrics?: RunMetrics;
  relaunches: number;
  /** Its newest launch has not reported back: its mark (RUN_LAUNCHING) is on disk. */
  launching?: boolean;
  /** Its files being copied into its work/ before its first launch, until they are: nothing launches it meanwhile (a
   *  request that would waits for it), and nothing but a cancel settles it. */
  preparing?: Promise<void>;
  settled: boolean;
  settling?: Promise<void>;
  /** The newest write of its serve.json: one at a time, in order. */
  saving?: Promise<void>;
  /** Settles of this run not yet done: while any is, nothing starts its process again. */
  settles: number;
  updatedAt: string;
  /** Its own door token (RUN_DOOR_TOKEN), once read or made; absent for a run an older server started, whose door takes
   *  the server-wide one. */
  doorToken?: string;
  /** A remote box's making and seed, asked by the run's process through the relay: one at a time. */
  boxing?: Promise<{ id: string; made: boolean }>;
  /** Its remote box's newest pull: a read of its files waits for it. */
  pulling?: Promise<void>;
  /** It stood waiting for the person when last marked: a turn's end is the change into that. */
  waited?: boolean;
};

const ASKED = "Asked you: ";
registerLabel(ASK_TOOL, (args) => `${ASKED}${typeof args.question === "string" ? args.question : ""}`, undefined, { name: "Ask you a question" });
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

/** The row that says a run's booked spend passed its cap, and by how much, after its usage row: a request's cost is
 *  booked once it answers, and one carrying a native web search is held at an allowance, not a bound (cap.ts), so a run
 *  can pass its cap by its last request. The next request is then refused, and the run ends spend_cap_reached. */
export function withOverCap(rows: TimelineEvent[], cap: number | undefined): TimelineEvent[] {
  const at = rows.findLastIndex((row) => row.kind === "usage");
  const usd = rows[at]?.usage?.usd;
  if (cap === undefined || typeof usd !== "number" || usd <= cap) return rows;
  const { usage: _, ...usage } = rows[at]!;
  const over: TimelineEvent = { ...usage, id: `${usage.id}:over_cap`, kind: "phase", summary: `Spent $${usd.toFixed(4)}, $${(usd - cap).toFixed(4)} over the run's cap of $${cap}`, text: null };
  return [...rows.slice(0, at + 1), over, ...rows.slice(at + 1)];
}

/** Notes the whole text of the newest assistant message in `entries` (pi's stored entries), and the newest entry. The
 *  end-of-run turn's are never the run's answer: each is noted by its entry in `turnText`, whole. */
function noteAnswer(run: Run, entries: readonly unknown[]): void {
  for (const value of entries) {
    const entry = isObject(value) && typeof value.id === "number" ? value.id : undefined;
    if (entry !== undefined) run.lastEntry = Math.max(run.lastEntry ?? 0, entry);
    // The end-of-run turn's entries are never the run's answer, nor a message it waits on: each assistant message's
    // whole text is noted in `turnText`, by entry.
    if (entry !== undefined && reflects(run.meta.reflect, entry)) {
      if (isObject(value) && value.kind === "pi.assistant" && Array.isArray(value.model) && isObject(value.model[0])) {
        const content = value.model[0].content;
        (run.turnText ??= new Map()).set(entry, typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => isObject(b) && b.type === "text").map((b) => String((b as Json).text ?? "")).join("\n").trim() : "");
      }
      continue;
    }
    if (!isObject(value) || typeof value.kind !== "string") continue;
    // A message a claude-agent or codex run accepted, and its end (harness-app.ts): one with no end still waits.
    if (value.kind === MESSAGE || value.kind === MESSAGE_END) {
      const id = isObject(value.data) && typeof value.data.id === "string" ? value.data.id : undefined;
      if (id !== undefined && value.kind === MESSAGE) (run.waiting ??= new Set()).add(id);
      else if (id !== undefined) run.waiting?.delete(id);
      continue;
    }
    // The person's message, as the timeline shows one (a user entry: pi's, or a host's own kind), or their sign-in: no
    // answer has followed it yet.
    const first = Array.isArray(value.model) && isObject(value.model[0]) ? value.model[0] : undefined;
    if (value.kind === "agent.handover" || (first?.role === "user" && (value.kind === "pi.user" || !value.kind.startsWith("pi.")))) run.answeredMessage = false;
    // A claude-agent or codex turn's end (harness-app.ts): its turn took the message and answered it, if it completed.
    if (value.kind === TURN_END) {
      if (isObject(value.data) && value.data.status === "completed") run.answeredMessage = true;
      continue;
    }
    if (value.kind !== "pi.assistant" || !first) continue;
    // An answer, as the timeline shows one (timeline.ts): a request that ended without an error or an abort and called no
    // tool, whatever else stopped it (its length, max output tokens, too). Never commentary that came with a call.
    if (first.stopReason === "error" || first.stopReason === "aborted") continue;
    if (Array.isArray(first.content) && first.content.some((block) => isObject(block) && block.type === "toolCall")) continue;
    // pi's own stop answer ends its turn (one commit with the run's end). The bridge's entries (api "agentrun-adapter")
    // never say so: a request without content is written alike whether it is a cost, a cut, an interruption or an answer.
    if (first.stopReason === "stop" && first.api !== ADAPTER_API) run.answeredMessage = true;
    // The answer's text: an answer's, never commentary that came with a call.
    const content = first.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => isObject(b) && b.type === "text").map((b) => String((b as Json).text ?? "")).join("\n").trim() : "";
    if (text) run.answerText = text;
  }
}

/** Read only on a run's `rows`, which hold no QUIET row (take). */
const shows = (r: TimelineEvent) => r.kind !== "usage" && r.kind !== "phase";
const meaningful = (rows: readonly TimelineEvent[]) => rows.findLast((r) => shows(r) && r.agent_label !== LEARNING_LABEL);
/** What a run waits on, as `pending` says it (one field for every kind; a tool call waiting on approval is another):
 *  the question a waiting run asked, read from its last meaningful row (withAsks' waiting row), the same row its
 *  status reads, never from a scan of its timeline. */
type Pending = { kind: "question"; question: string; asked_at: string } | null;
const pendingOf = (rows: readonly TimelineEvent[]): Pending => {
  const last = meaningful(rows);
  return last?.kind === "waiting" ? { kind: "question", question: last.text ?? last.summary ?? "", asked_at: last.timestamp } : null;
};
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
/** What a run's paid tools charged, from the same rows its cost is read from: each charge's line carries it (`usage` on a
 *  `phase` row); null when one is unknown. A call still marked, in flight or cut, is no charge here. */
export const toolCostOf = (rows: readonly TimelineEvent[]): number | null =>
  rows.reduce<number | null>((sum, row) => (row.kind !== "phase" || !row.usage ? sum : sum === null || row.usage.usd === null ? null : sum + row.usage.usd), 0);
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
/** What a run whose cost is unknown has cost so far (costsofar/1): the sum of its charges whose cost is known, and how many
 *  have none, from its usage row, plus a workflow's decisions (`decisions`: their known sum and how many are not known;
 *  null when they could not be read, which says nothing). Undefined while the cost is known, when the row says neither
 *  (an older run's), or when a workflow's decisions are unreadable. No ceiling is claimed. */
export type SoFar = { so_far_usd: number; unpriced: number };
export function soFarOf(rows: readonly TimelineEvent[], decisions?: { known: number; unpriced: number } | null): SoFar | undefined {
  if (decisions === null) return undefined;
  const usage = usageOf(rows)?.usage;
  const models = !usage ? { known: 0, unpriced: 0 } : usage.usd !== null ? { known: usage.usd, unpriced: 0 } : usage.so_far_usd !== undefined && usage.unpriced !== undefined ? { known: usage.so_far_usd, unpriced: usage.unpriced } : undefined;
  if (!models) return undefined;
  const unpriced = models.unpriced + (decisions?.unpriced ?? 0);
  return unpriced > 0 ? { so_far_usd: Math.round((models.known + (decisions?.known ?? 0)) * 1e6) / 1e6, unpriced } : undefined;
}
/** What a run's meta kept of its cost so far at its end, when it is well formed. */
const soFarOfMeta = (meta: Partial<RunMeta> | null | undefined): SoFar | undefined => {
  const kept = meta?.cost_so_far;
  return kept && typeof kept.so_far_usd === "number" && Number.isFinite(kept.so_far_usd) && Number.isInteger(kept.unpriced) && kept.unpriced > 0 ? { so_far_usd: kept.so_far_usd, unpriced: kept.unpriced } : undefined;
};
/** The whole text of the run's newest answer, paid for: an assistant message's, else its newest answer row's. */
const lastAnswer = (run: Run) => run.answerText ?? run.rows.findLast((r) => r.kind === "final_answer" && r.agent_label !== LEARNING_LABEL)?.text ?? null;
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

/** A wait's mark: the stop it stands at, while that stop holds, else its newest row (the question it waits on). */
const waitMark = (run: Run): string => (stopped(run) && run.meta.stopped_at) || meaningful(run.rows)?.id || "";

/** Waits for `work`, or until `deadline` (ms since the epoch), whichever comes first. */
async function untilDeadline(work: Promise<unknown> | undefined, deadline: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))))]);
  clearTimeout(timer);
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
/** How a run is asked to start: its input and title, its effort and cap, and what puts its files in its work/. */
export type StartOptions = { input: Json; title: string; place: Place; effort?: string; maxCostUsd?: number; inputs?: (work: string) => Promise<unknown> };

/** `token` is the server's own: no run's process sees it. */
/** `maxRuns`: the most runs with a live process at once; `settleRetryMs`: how often a carry back the store refused is
 *  tried again; `readyTimeoutMs`: how long a request to a run waits for its door (a run's first message, sent by its
 *  start, always waits READY_TIMEOUT_MS); `log` takes a run's start and end (print.ts). */
export type RunsOptions = { agents: Agents; token: string; /** The server's saved tool keys, read by name for its runs alone (secrets.ts). */ storedKeys?: StoredKeys; documents?: string; doorTokenFile: string; doorToken: string; /** The test switches a run's process gets (server.ts fauxEnvOf): empty outside tests. */ fauxEnv?: NodeJS.ProcessEnv; runBoxes?: BoxProvider; /** The server's Daytona provider, with its key: remote boxes are made, seeded, pulled and destroyed with it, here alone (box-relay.ts). */ remoteBoxes?: BoxProvider; /** Daytona's API and the same key, for what the provider does not do: a kept box's idle stop, and its wake at a start (daytona-api.ts). */ remoteApi?: DaytonaApi; toolSettings?: () => ToolSettingsMap; drainTimeout?: string; carryBackRetry?: CarryBackRetry; maxRuns?: number; box?: { host: BoxHost; quarantine: Quarantine }; settleRetryMs?: number; readyTimeoutMs?: number; reflectTimeoutMs?: number; gradeTimeoutMs?: number; /** The grader's model (`--grade-model`), before AGENTRUN_SERVE_GRADE_MODEL and the strong tier (grade.ts gradeModelOf). */ gradeModel?: string; /** How much of what a run learned its instructions hold, in bytes (`--learning-budget`, learning.ts learnedOf). */ learningBudget?: number; log?: (event: string, fields: Record<string, string | number>) => void; notify?: RunNotify; learning?: LearningMode };
/** Told of a run's moment each time it is seen (webhooks.ts' emit, which queues each one once): a wait it reached, and an
 *  end once the agent store has it. `marker` names the moment (the person's turn it waits at, the end's time), the same
 *  when another server sees it again. It says what came of it: `unsaved`, not in the outbox on disk yet. */
export type RunNotify = (event: (typeof WEBHOOK_EVENTS)[number], run: RunNotice & { status: Status }, marker: string) => Emitted;

/** The server's own secrets, which a run's process never gets: the API token, by name or by value, the seal key
 *  the tool keys are kept under (tool-keys.ts), and the boxes' keys (boxes.ts), which only the server's box providers use. */
const SERVER_ONLY = new Set(["AGENTRUN_TOKEN", "AGENTRUN_API_KEY", "AGENTRUN_SEAL_KEY", ...BOX_KEYS]);
/** The secrets a run's process is handed over its pipe (secrets.ts): every one but the server's own and the decision
 *  keys, which go on their own descriptor. */
export const RUN_SECRETS = SECRET_NAMES.filter((name) => !SERVER_ONLY.has(name) && !DECISION_KEYS.includes(name));
type KeyRow = { kind: string; fields: readonly string[]; unlocks: readonly string[] };
/** The fields a run gets only when its revision names what they unlock: a `tool` key's. Any other kind's (a model key's)
 *  is the model's to need, as every model key is. */
const scopedOf = (rows: readonly KeyRow[]): readonly string[] => rows.filter((row) => row.kind === "tool").flatMap((row) => row.fields);
/** The model keys: every key of pi-ai's providers (model.ts' PROVIDER_KEYS) and the gateway's. A run gets those its model
 *  needs and no other (secretsFor). A workflow's decision keys, OpenRouter's among them, go on its decision descriptor
 *  (decisions.ts), whatever its model. */
const MODEL_KEYS: readonly string[] = [...new Set([...Object.values(PROVIDER_KEYS).flat(), GATEWAY_KEY_ENV])];
/** What a run whose revision was not read is handed: no tool key, and no model key. */
const NO_TOOL_KEYS = RUN_SECRETS.filter((name) => !scopedOf(TOOL_KEYS).includes(name) && !MODEL_KEYS.includes(name));

/** What of a revision decides the secrets its runs are handed, none of it a key, read once per revision (a revision
 *  never changes): its harness, the model it names, the tools it binds (named as its process binds them, app.ts: an
 *  agentic revision's `tools`, a workflow's on its model nodes and its `call` nodes), a workflow's tiers (those its model
 *  nodes and `llm` calls run on), and its decision providers (decisions.ts' decisionKeysFor: a workflow's decision
 *  nodes', providersNamed, Jev for a node that names none; an agentic revision's, none). Names only: no instruction and
 *  no skill. */
export type RunNeeds = { harness: string; model?: string; tools: readonly string[]; tiers?: readonly Tier[]; decisionProviders: readonly string[] };

/** `revision`'s RunNeeds. */
export async function needsOf(revision: Revision): Promise<RunNeeds> {
  const workflow = revision.kind === "workflow" ? revision.body.workflow : undefined;
  const nodes = workflow ? workflowNodes(workflow, (await import("@parcha/agentrun-dsl")).inspectWorkflow(workflow)) : undefined;
  const bound = nodes && workflowTools(nodes);
  return {
    harness: revision.body.harness ?? DEFAULT_HARNESS,
    ...(revision.kind === "agentic" && revision.body.model ? { model: revision.body.model } : {}),
    tools: bound ? [...bound.nodes, ...bound.calls] : [...(revision.body.tools ?? [])],
    ...(nodes ? { tiers: llmTiers(nodes, nodeTiers(nodes)) } : {}),
    decisionProviders: nodes ? providersNamed(nodes) : [],
  };
}

/** The secrets a run of `needs` is handed over its pipe, by the keys `env` holds now: RUN_SECRETS but each field of a
 *  `tool` row of `rows` (TOOL_KEYS) that unlocks none of the tools the run binds; and but each model key its model does
 *  not need, from the host's model settings and the keys in `env`: a pi run's, its models' providers' keys or the
 *  gateway's (model.ts' modelKeys: its own model, or the host's of each tier it runs); codex's and claude-agent's, the
 *  one key their route sends for the revision's model (adapters.ts' harnessModelKeys). Read at each launch, so a key
 *  saved with no restart counts at the next. */
export function keysFor(needs: RunNeeds, env: NodeJS.ProcessEnv, rows: readonly KeyRow[] = TOOL_KEYS): string[] {
  const named = new Set(needs.tools);
  const unlocked = new Set<string>(rows.filter((row) => row.unlocks.some((name) => named.has(name))).flatMap((row) => row.fields));
  const scoped = scopedOf(rows);
  const model = new Set(needs.harness !== DEFAULT_HARNESS ? harnessModelKeys(needs.harness, env, needs.model) : needs.tiers ? modelKeys(env, undefined, needs.tiers) : modelKeys(env, needs.model));
  return RUN_SECRETS.filter((name) => (!scoped.includes(name) || unlocked.has(name)) && (!MODEL_KEYS.includes(name) || model.has(name)));
}

/** The secrets a run of `revision` is handed with the keys `env` holds (needsOf, then keysFor). */
export async function secretsFor(revision: Revision, rows: readonly KeyRow[] = TOOL_KEYS, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  return keysFor(await needsOf(revision), env, rows);
}
/** The decision providers a run of `revision` needs keys for (needsOf). Its web tools' need, Parallel's where one
 *  resolves to Parallel, is its tool plane's (tool-plane.ts' handsParallel), read at each launch. */
export async function decisionProvidersFor(revision: Revision): Promise<readonly string[]> {
  return (await needsOf(revision)).decisionProviders;
}
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
  /** What decides the secrets each revision's runs are handed (needsOf), by revision id: read once, from the revision the
   *  run is pinned to, never from a request. The keys themselves are read at each launch (keysFor). */
  private readonly needs = new Map<string, RunNeeds>();
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
  /** The memory the starts counted in `starting` reserve, in MiB. */
  private startingMib = 0;
  /** This host's memory, out of which each live run reserves what its harness takes (host.ts), beside `maxRuns`. */
  private readonly memory = hostMemory();
  /** The start sweep of the boxes runs left: once, before any run opens a box (sweepOnce). */
  private swept?: Promise<void>;
  /** The runs' learning (learning-run.ts): a step this file calls as a run starts, ends, settles, opens again and is
   *  recovered, handed what it moves of a run. */
  readonly learning: LearningRuns;
  constructor(private readonly options: RunsOptions) {
    this.learning = new LearningRuns(options, {
      held: (id) => this.runs.get(id),
      get: (id) => this.get(id),
      live: (run) => this.live(run),
      toLiveDoor: (run, path, body, turnOrigin) => this.toLiveDoor(run, path, body, turnOrigin),
      toDoor: (run, path, body) => this.toDoor(run, path, body),
      abortTurn: (run) => this.abortTurn(run),
      terminate: (run) => this.terminate(run),
      mark: (run) => this.mark(run),
      show: (run) => this.show(run),
      save: (run) => this.saveMeta(run),
      costOf,
      fauxEnv: () => this.fauxEnv(),
    });
  }

  /** A test's seam (startServe's `beforeAbort`): awaited by a stop between its mark and its abort, so a test can hold a
   *  stop in flight there. */
  beforeAbort?: (runId: string) => Promise<void> | void;

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
      ...(isObject(stored?.tool_plane) ? { tool_plane: stored.tool_plane as Plane } : {}),
      ...(stored?.place ? { place: storedPlace(stored.place) } : {}),
      ...(isObject(stored?.learning) ? { learning: stored.learning as Learning } : {}),
      ...(isObject(stored?.reflect) ? { reflect: stored.reflect as Reflect } : {}),
    };
    // A seed copy a server went down during is taken back before anything holds the run: its relaunch, a settle, a
    // follow-up (learning-run.ts onLoad).
    if (stored) await this.learning.onLoad(row, dir, meta, () => writeWhole(join(dir, RUN_META), `${JSON.stringify(meta)}\n`));
    const known = await this.options.agents.revision(row.agent, row.revision);
    const run = this.blank(row, dir, meta, known?.version ?? 0, harnessOfBody(known?.revision.body ?? {}), known ? await toolingOf(known.revision) : undefined, known?.revision);
    this.runs.set(row.id, run);
    run.launching = existsSync(join(dir, RUN_LAUNCHING));
    const record = await this.record(run);
    // An ended run is ended before its rows are read, so they never make it a wait: a last row that asks is no notice.
    if (row.state !== "running") run.outcome = STATUS_OF[row.state];
    // Only a store no live instance holds is opened: released, or left by an instance whose lease lapsed.
    if (row.state !== "running" || !this.doorOf(record)) await this.storeWhenFree(run);
    if (row.state !== "running") {
      run.endedAt = row.endedAt;
      // An ended run the store kept no cost for has an unknown cost, never $0.
      run.costUsd = row.costUsd ?? null;
      // A workflow run's decisions' cost too: an unknown one keeps the run's unknown after a restart. Unread, it is unknown.
      if (run.kind === "workflow") await this.readDecisionCost(run).catch(() => void (run.decisionCost = null));
      if (row.importedFrom) run.imported = row.importedFrom;
      if (run.outcome === "failed") run.error = errorOfRow(row, meta);
      run.settled = true;
    } else {
      const adopted = record && this.doorOf(record) ? record : null;
      if (adopted) {
        // A server that died between saving a stop and its abort reaching the run leaves the turn working.
        run.finishStop = run.meta.stopped_at !== undefined || run.meta.stopped_after !== undefined;
        this.adoptProcess(run, adopted);
      }
      // One a server left in its end-of-run turn finishes with its job's outcome, and its turn, when its process lives,
      // is asked again (learning-run.ts).
      this.learning.onAdopt(run, adopted !== null);
    }
    this.refresh(run);
    return run;
  }

  private blank(row: Pick<RunRow, "id" | "agent" | "revision" | "kind">, dir: string, meta: RunMeta, version: number, harness: string, tooling?: Tooling, revision?: Revision): Run {
    return {
      id: row.id, agentId: row.agent, kind: row.kind, revision: row.revision, version, dir, meta, log: new RowLog(this.clock), rows: [], harness,
      working: false, submitted: 0, users: new Set(), live: new Set(), cancel: false, relaunches: 0, settled: false, settles: 0, updatedAt: meta.created_at,
      ...(tooling ? { tooling } : {}),
    };
  }

  /** Writes the run's serve.json as it is when its turn comes; then tells learning what it now holds (the ledger's line
   *  once the run's learning ended). */
  private saveMeta(run: Run): Promise<void> {
    run.saving = (run.saving ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const { learning } = run.meta;
      await writeWhole(join(run.dir, RUN_META), `${JSON.stringify(run.meta)}\n`);
      await this.learning.onSaved(run, learning);
    });
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
    if (run.kind === "workflow") {
      const { durableDecisions } = await import("@parcha/agentrun-pi/durable");
      // Decisions it cannot read add no rows, and leave the served usage row's total unknown, as the run's cost read
      // does (readDecisionCost): never its model nodes' total alone.
      try { run.decisions = durableDecisions(file); } catch { run.decisions = null; }
      run.llmRead = llmAnswers(await readNodeLog(run.dir)).length;
    }
    // Its decision requests count with its model requests: each receipt's tokens, or unmetered without them.
    if (atEnd) run.metrics = runMetricsWithDecisions(read.map((r) => r.entry) as never, run.kind === "workflow" ? (run.decisions ?? []) : []);
    run.working = false;
    noteAnswer(run, entries);
    this.take(run, timelineOf(entries as never, { settled: true, path: rowPaths(run.dir) }));
  }

  /** New rows in: into the log, then the run's status, then whatever the status asks for. */
  /** `keep`: rows that stay served though `rows` no longer holds them (the live path's committed rows). */
  private take(run: Run, rows: TimelineEvent[], keep?: (id: string) => boolean): void {
    run.rows = withOverCap(labelled(run.meta.reflect, withAsks(rows.filter((r) => !QUIET.test(r.id)))), run.meta.max_cost_usd);
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
    // The decisions' rows are the served view's only: the run's own rows, which its cost is read from, stay its model nodes'.
    const rows = run.decisions === undefined ? run.rows : withDecisions(run.rows, run.decisions);
    if (run.log.sync(withLearning(rows, run.meta.learning, this.learning.shown()), run.keep)) run.updatedAt = new Date().toISOString();
  }

  /** A live process: the child this server started, or one an earlier server started that still serves the run. */
  private live(run: Run): boolean {
    return Boolean(run.child || run.orphan);
  }

  /** How an agentic run ends, from its rows: over its cap, a model error, or an answer. Undefined while it works, or
   *  when it stopped, waits or parked. A workflow run ends when its workflow does. */
  private decide(run: Run): { outcome: Status; error?: RunError; abort?: boolean } | undefined {
    if (run.kind === "workflow") return undefined;
    // A cancel ends the run cancelled, by its settle (whatever the turn it cut wrote, a cost over the cap too): nothing
    // ends it otherwise meanwhile, so its first terminal status is its last. The cancel has aborted the turn already.
    if (run.cancel) return undefined;
    const cap = run.meta.max_cost_usd;
    const cost = costOf(run.rows);
    if (cap !== undefined && cost !== null && cost > cap) return { outcome: "failed", abort: true, error: { code: SPEND_CAP_REACHED, message: `The run cost $${cost.toFixed(4)}, $${(cost - cap).toFixed(4)} over its cap of $${cap}.`, retryable: false } };
    if (run.working || run.submitted > 0) return undefined;
    // A message accepted and not sent yet waits for its turn: a server started after it counts none submitted, and a turn's
    // end before it is no end of the run (harness-app.ts writes a turn's end, then sends the next message).
    if (run.waiting?.size) return undefined;
    const last = meaningful(run.rows);
    // The cap's refusal in the run's process (cap.ts); a provider error with this exact prefix would read as one too.
    // Its code is `spend_cap_reached: `, or with a note after it (`spend_cap_reached (out of budget): `, cap.ts); the message is
    // the words after it.
    const capped = last?.kind === "error" ? CAP_REFUSAL_PREFIX.exec(last.text ?? "") : null;
    if (capped) return { outcome: "failed", error: { code: SPEND_CAP_REACHED, message: last!.text!.slice(capped[0].length), retryable: false } };
    if (last?.kind === "error") return { outcome: "failed", error: { code: "run_failed", message: this.plainKey(run, last.text ?? undefined) ?? last.text ?? last.summary ?? "The run failed.", retryable: false } };
    if (stopped(run)) return undefined;
    // Its newest row is the answer; or the person's message, which an answer that ended its request follows in the entries
    // (the Claude CLI's /compact: a summary request, no text): its turn took it and is over, and the earlier answer stands.
    // From the entries' own order, never from when the door said idle.
    if (answerOf(run.rows) || (last?.kind === "user_message" && run.answeredMessage === true)) return { outcome: "completed" };
    return undefined;
  }

  /** A run's model error in a person's words when its provider refused the run's key (key-refusal.ts): the key its
   *  harness's route sends, by this server's settings and keys, and no secret's value. */
  private plainKey(run: Run, text: string | undefined): string | undefined {
    if (!text) return undefined;
    const env = withSecrets(process.env, "all", this.options.storedKeys);
    const secrets = SECRET_NAMES.map((name) => env[name]).filter((value): value is string => typeof value === "string");
    return keyRefusal(text, runKeyOf(env, run.harness ?? run.tooling?.harness, run.tooling?.model), secrets);
  }

  /** Records the run's status as a change when it moves, and lets go of a live run that answered, failed or is over its cap. */
  private refresh(run: Run): void {
    this.mark(run);
    if (!this.live(run) || run.finishing || run.outcome) return;
    const end = this.decide(run);
    if (!end) return;
    if (end.error) run.error = end.error;
    // A run that learns is not let go yet: its end-of-run turn is asked first, unless learning skips it (learning-run.ts).
    if (this.learning.beforeFinish(run, end)) return;
    this.finish(run, end.outcome, end.abort);
  }

  /** The test hooks startServe's options name, as a run's process and this server's own calls get them. */
  private fauxEnv(): NodeJS.ProcessEnv {
    return { ...this.options.fauxEnv };
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
    const { box, runBoxes, remoteBoxes } = this.options;
    if (!box && !runBoxes && !remoteBoxes) return Promise.resolve();
    this.swept ??= (async () => {
      const rows = await this.options.agents.request(() => this.store.listRuns());
      // The boxes of sandbox runs, by their label: one whose run has ended, or is archived, is destroyed. A failure only
      // warns: the next start sweeps again, and a box's lifetime bounds it.
      const ended = new Set(rows.filter((row) => row.state !== "running" || row.archivedAt).map((row) => row.id));
      if (runBoxes) {
        await sweepRunBoxes(runBoxes, (id) => ended.has(id), boxContext()).catch((error: Error) => warn("-", `its start's sweep of run boxes failed (${error.message}); the next start sweeps again`));
      }
      // A remote box of an ended run is pulled first, so what it changed after its run's last pull is kept, and goes only
      // once that pull landed: one that fails keeps the box for the next start, its lifetime bounding it.
      if (remoteBoxes) {
        const dirOf = (id: string) => join(this.options.agents.dir, "runs", id);
        const pulledFirst = (id: string, boxId: string) =>
          pullRemoteBox(remoteBoxes, { id, dir: dirOf(id) }, boxContext(REMOTE_SYNC_MS)).then(
            () => true,
            async (error: Error) => {
              warn(id, `its box is kept: its pull failed (${error.message}); the next start tries again`);
              await this.keepBox(id, boxId);
              return false;
            },
          );
        // A box kept at a run's end that Daytona stopped once idle is woken first, so this sweep pulls it like the rest.
        const api = this.options.remoteApi;
        if (api) await wakeBoxes(api, (id) => ended.has(id)).catch((error: Error) => warn("-", `the stopped boxes of ended runs were not woken (${error.message}); the next start tries again`));
        await sweepRunBoxes(remoteBoxes, (id) => ended.has(id), boxContext(REMOTE_SYNC_MS), pulledFirst).catch((error: Error) => warn("-", `its start's sweep of remote run boxes failed (${error.message}); the next start sweeps again`));
      }
      if (!box) return;
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

  /** A sandbox run's box (run-box.ts), destroyed by its label: at every settle, a cancel included, and at archive. A
   *  remote box's work/ is pulled first, and its box goes only once that pull brought it back whole (or there is no box).
   *  A copy that stopped for good (an archive the extractor cannot read, a limit it cannot pass) keeps the box, said in
   *  the log, its lifetime bounding it, and the run ends. Any other failure at a run's end (`ending`) throws
   *  PullPending, and the end is tried again; at an archive it only warns, the box kept for the run's end or the next
   *  start's sweep. A destroy that fails only warns: the next start's sweep tries again, and the box's lifetime bounds it. */
  private async dropBox(run: Run, ending = false): Promise<void> {
    const place = run.meta.place;
    if (place?.mode !== "sandbox") return;
    const remote = remotePlace(place);
    const boxes = remote ? this.options.remoteBoxes : this.options.runBoxes;
    if (!boxes) return;
    if (remote) {
      try {
        await this.pullBox(run, true);
      } catch (error) {
        if (error instanceof PullIncomplete && error.lasting) {
          await this.keepBox(run.id, error.box);
          return warn(run.id, `its box is kept, not destroyed: ${error.message}; what came back is in its files, and the box stops after ${KEPT_AUTOSTOP_MINUTES} idle minutes, its files kept for the next start's pull`);
        }
        const why = `its box's last pull failed (${(error as Error).message})`;
        if (ending) throw new PullPending(why);
        return warn(run.id, `${why}; its box is kept for its end`);
      }
    }
    try {
      await destroyRunBoxes(boxes, run.id, boxContext());
    } catch (error) {
      warn(run.id, `its box was not destroyed (${(error as Error).message}); the next start sweeps it`);
    }
  }

  /** A remote box kept because its copy back is not whole: said in the log, and set to stop once idle, so it costs its
   *  disk alone until the next start's pull (which wakes it) or its lifetime. */
  private async keepBox(runId: string, boxId: string): Promise<void> {
    this.options.log?.("box_kept", { run: runId, box: boxId, reason: "pull_incomplete" });
    const api = this.options.remoteApi;
    if (api) await keepWhenIdle(api, boxId).catch((error: Error) => warn(runId, `its kept box was not kept from deletion or set to stop when idle (${error.message})`));
  }

  /** What wakes run `runId`'s remote box when Daytona stopped or paused it (a class that pauses when idle, while the run
   *  waited for a person): how many it woke. */
  private wakeOf(runId: string): (() => Promise<number>) | undefined {
    const api = this.options.remoteApi;
    return api && (() => wakeBoxes(api, (id) => id === runId));
  }

  /** Pulls run `run`'s remote box into its work/, after any pull already running: at a turn's end in the background (a
   *  failure warns, and the next pull brings it), or awaited (`strict`: a failure throws). */
  private pullBox(run: Run, strict = false): Promise<void> {
    const boxes = this.options.remoteBoxes;
    const place = run.meta.place;
    if (!boxes || !place || !remotePlace(place)) return Promise.resolve();
    // After any pull already running, and after the box's making and seed when one is under way.
    const pull = Promise.all([run.pulling, run.boxing?.catch(() => undefined)]).then(async () => {
      const pulled = await pullRemoteBox(boxes, run, boxContext(REMOTE_SYNC_MS), this.wakeOf(run.id));
      if (pulled) this.options.log?.("box_pulled", { run: run.id, changed: pulled.changed, files: pulled.files, bytes: pulled.bytes, removed: pulled.removed });
    });
    const settled = pull.catch((error: Error) => {
      if (!strict) warn(run.id, `its box's work/ was not pulled at its turn's end (${error.message}); the next pull brings it`);
    });
    run.pulling = settled;
    void settled.finally(() => {
      if (run.pulling === settled) run.pulling = undefined;
    });
    return strict ? pull : settled;
  }

  /** Waits for the pull run `id`'s turn's end began, if any, up to PULL_WAIT_MS: its files then show what its box wrote. */
  async pulled(id: string): Promise<void> {
    const pulling = this.runs.get(id)?.pulling;
    if (!pulling) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([pulling, new Promise<void>((resolve) => (timer = setTimeout(resolve, PULL_WAIT_MS)))]);
    clearTimeout(timer);
  }

  /** Whether run `id` is one this server holds in a remote box and has not ended: the relay serves no other. */
  servesBox(id: string): boolean {
    const run = this.runs.get(id);
    return Boolean(this.options.remoteBoxes && run && !run.outcome && run.meta.place && remotePlace(run.meta.place));
  }

  /** Run `id`'s remote box, found or made and seeded: what its process asks the relay for at its first tool call. */
  ensureBox(id: string): Promise<{ id: string; made: boolean }> {
    const run = this.runs.get(id);
    const boxes = this.options.remoteBoxes;
    if (!run || !boxes || !this.servesBox(id)) return Promise.reject(new Error(`no run ${id} of this server is in a remote box`));
    // After any pull of this run's box, so a seed never meets a pull.
    run.boxing ??= (run.pulling ?? Promise.resolve())
      .then(() => ensureRemoteBox(boxes, run, boxContext(REMOTE_SYNC_MS), this.wakeOf(run.id)))
      .finally(() => void (run.boxing = undefined));
    return run.boxing;
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
    if (!this.options.box && !this.options.runBoxes && !this.options.remoteBoxes) return;
    for (const row of await this.options.agents.request(() => this.store.listRuns())) {
      if (!row.archivedAt) continue;
      // A run's box needs only the runs this server holds: one it has not read has ended, or was swept at its start.
      const run = this.options.box ? await this.get(row.id) : this.runs.get(row.id);
      if (!run) continue;
      // A run's box goes at its archive, its process live or not (an ended run's went at its end): an archived run takes
      // no message, and a call it still makes gets a fresh box, which its end or the next start's sweep destroys.
      if (!run.outcome) await this.dropBox(run);
      await this.teardown(run);
    }
  }

  async recover(): Promise<void> {
    // The learning a server left between steps, picked up once every running run is read (learning-run.ts).
    const recoverLearning = this.learning.recover();
    await this.sweepOnce();
    const rows = await this.options.agents.request(() => this.store.listRuns());
    for (const row of rows) {
      if (row.state !== "running" || row.importedFrom) continue;
      const run = await this.adopt(row).catch((error: Error) => (warn(row.id, `not recovered: ${error.message}; the next start tries again`), null));
      if (run && !this.live(run) && !run.outcome) await this.settle(run, null, false);
    }
    await recoverLearning(rows);
  }

  /** The run's status, state and whether its rows are all in, as one more change of its log when any of them moves. A wait
   *  is told each time it is seen: webhooks.ts queues each wait once, whichever server sees it first. */
  private mark(run: Run): void {
    const { status, state } = statusOf(run);
    // A turn's end, or a run first read waiting (a start that finds it so, whose last turn's pull may not have landed):
    // what its remote box changed is pulled into work/ now, and a read of the files waits for it.
    const waiting = status === "input_required";
    if (waiting && run.waited !== true) this.pullBox(run);
    run.waited = waiting;
    if (run.log.setState(`${status}/${state}/${run.settled}`)) run.updatedAt = new Date().toISOString();
    // What it waits on: an ask_person question (waiting), else a stopped turn, for the person's next message.
    if (status === "input_required") this.notice(run, "run.needs_input", waitMark(run), { kind: state === "waiting" ? "question" : "stopped" });
  }

  /** Tells webhooks.ts (`notify`) of a moment of the run under `marker`: a wait it reached (mark), or an end the agent store
   *  has (settle, persistLater, reopen). What it already queued it queues no more. */
  private notice(run: Run, event: "run.needs_input" | "run.ended", marker: string | undefined, pending?: { kind: "question" | "stopped" }): Emitted | undefined {
    if (!this.options.notify || !marker) return undefined;
    try {
      return this.options.notify(event, { run_id: run.id, agent_id: run.agentId, status: statusOf(run).status, title: run.meta.title, ...(pending ? { pending } : {}) }, marker);
    } catch (error) {
      warn(run.id, `its notice was not queued: ${(error as Error).message}`);
      return undefined;
    }
  }

  // ---- the door -------------------------------------------------------------------------------------------------------

  /** A call to run `run`'s door: with its own door token, or, for a process an older server started, the server-wide one. */
  private headers(run: Run, json = false): Record<string, string> {
    run.doorToken ??= runDoorToken(run.dir);
    return { authorization: `Bearer ${run.doorToken ?? this.options.doorToken}`, ...(json ? { "content-type": "application/json" } : {}) };
  }

  /** Run `id`'s own door token, the one its calls to the box relay carry; none for a run it does not hold or that has none. */
  relayToken(id: string): string | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    run.doorToken ??= runDoorToken(run.dir);
    return run.doorToken;
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
    // A file a call names by its absolute path in the run's workspace (a harness's CLI sends one) reads by its name there.
    const reducer = timelineReducer({ path: rowPaths(run.dir) });
    const up = await fetch(new URL("/events", door), { signal, headers: { ...this.headers(run), accept: "text/event-stream" } });
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
        // A stopped turn is over while the run's process lives on: a request it cut is a charge with no price (costsofar/1),
        // as the settled read counts it, never one in flight.
        if (!run.working && stopped(run)) reducer.idle();
        // A snapshot rebuilds from the conversation's current view: after a compaction it holds fewer of the rows
        // already shown, which stay; only live rows go when they end.
        const rows = reducer.rows();
        this.take(run, rows, keepCommitted(run.live, rows, reducer.isLive));
        if (event === "snapshot" && run.finishStop) {
          run.finishStop = false;
          if (run.working && stopped(run) && run.submitted === 0) {
            // The run reads stopped already, so a message sent now would go in behind the turn this abort ends, and be
            // withdrawn with it: it waits for the abort, as for a stop in flight.
            run.stopping = true;
            void this.abortTurn(run).catch(() => undefined).finally(() => (run.stopping = undefined));
          }
        }
      }
    }
  }

  /** The door of a run that is not finished, starting or waking its process when it is not live. */
  private async ensureLive(run: Run, timeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    // A run brought up by a request (a message before the start's recovery reached it) waits for the sweep as well.
    await this.sweepOnce();
    await this.pinNeeds(run);
    // And for its files, which its start copies before it launches it: within the time left.
    const copying = run.preparing;
    if (copying) {
      await untilDeadline(copying, deadline);
      if (run.preparing === copying) throw new ApiError("unavailable", "the run's files are still being copied into its workspace", { retry_after_ms: 1000 }, { "retry-after": "1" });
    }
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
          await untilDeadline(run.settling, deadline);
          if (Date.now() > deadline) throw new ApiError("unavailable", "the run did not come up in time", { retry_after_ms: 1000 }, { "retry-after": "1" });
          continue;
        }
        if (launched) throw new ApiError("internal", `the run's process exited before it served: ${await lastLogLine(run)}`);
        const pid = holderPid(record);
        const fresh = record?.status === "running" && typeof record.heartbeatAt === "string" && Date.now() - Date.parse(record.heartbeatAt) < LEASE_MS && (pid === undefined || alive(pid));
        // A run already going is never refused a place, but one whose harness this host's memory never holds (after a
        // restart on a smaller one) is not started: said, never tried.
        const never = fresh ? undefined : neverFits(run.harness, this.memory);
        if (never) throw new ApiError("agent_not_runnable", never, { details: { unbound: [], missing: {}, harness: run.harness } });
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
    if (door) await fetch(new URL("/abort", door), { method: "POST", headers: this.headers(run, true), body: "{}", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }

  /** One request to the door of a run whose process lives, never waking it (toDoor wakes no run that is finishing): again
   *  while it opens or parks. `turnOrigin`: who sent a turn this request sends (learning-run.ts's REFLECT_ORIGIN), for
   *  the per-tool gate to take once this server has one; nothing reads it until then. */
  private async toLiveDoor(run: Run, path: string, body?: Json, turnOrigin?: TurnOrigin): Promise<Json | null> {
    for (const deadline = Date.now() + 30_000; ; await sleep(200)) {
      if (!this.live(run) || run.cancel) throw new Error("the run's process is gone");
      const door = this.doorOf(await this.record(run));
      const res = door ? await fetch(new URL(path, door), { method: body ? "POST" : "GET", headers: this.headers(run, body !== undefined), body: body && JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).catch(() => null) : null;
      const data = res ? ((await res.json().catch(() => null)) as Json | null) : null;
      if (res && res.status < 400) return data;
      if (res && !(res.status === 503 && RETRY_CODES.includes(String(data?.error)))) throw new Error(`the run's door answered ${res.status}`);
      if (Date.now() > deadline) throw new Error("the run's door did not answer");
    }
  }

  private async toDoor(run: Run, path: string, body?: Json, readyMs?: number): Promise<{ status: number; body: Json | null }> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const door = await this.ensureLive(run, readyMs);
      const res = await fetch(new URL(path, door), {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers(run, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const data = res ? ((await res.json().catch(() => null)) as Json | null) : null;
      if (res && !(res.status === 503 && RETRY_CODES.includes(String(data?.error)))) return { status: res.status, body: data };
      if (Date.now() > deadline) throw new ApiError("unavailable", "the run's door did not answer", { retry_after_ms: 1000 }, { "retry-after": "1" });
      await sleep(200);
    }
  }

  /** Reads what decides the secrets runs of `run`'s revision are handed (needsOf), once per revision: from `given` (a
   *  start's, read from the store), else from the agent store, waiting out a busy one as a run's end does. */
  private async pinNeeds(run: Pick<Run, "id" | "revision">, given?: Revision): Promise<void> {
    if (this.needs.has(run.revision)) return;
    const revision = given ?? (await whenFree(() => this.store.readRevision(run.revision), this.busyDelays(), this.onBusy(run.id, "the agent store")));
    this.needs.set(run.revision, await needsOf(revision));
  }

  private launch(run: Run): void {
    if (run.child || this.closing || run.cancel || run.outcome || run.finishing || run.preparing) return;
    // Its secrets go over fd 3, written whole and closed as it starts; it reads them first (secrets.ts). Each launch path
    // reads its revision's needs first (pinNeeds); one that did not hands no tool key. Which keys, from the keys this
    // server holds now (its launcher's and the saved ones, never its environment, which under the launcher holds none),
    // in this same turn as the handover, so a key saved with no restart counts at the next launch, and none can change
    // in between.
    const served = withSecrets(process.env, "all", this.options.storedKeys);
    const needs = this.needs.get(run.revision);
    const handed = needs ? keysFor(needs, served) : NO_TOOL_KEYS;
    const secrets = handover(handed, this.options.storedKeys);
    // What it was handed, for the check of what its end-of-run turn writes (learning-run.ts).
    this.learning.onLaunch(run, handed);
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
    // A run on the host's default (its revision names no model) gets the model the server picks for its harness, never
    // the key that gave it: behind a gateway its process holds the gateway's key alone (keysFor) and could not tell. It is
    // the run's last choice (model.ts hostModel: the tier's variable, then AGENT_MODEL where the harness runs it, then a
    // key the run holds, then this), so a host's setting the harness can run still wins; and one it cannot (AGENT_MODEL
    // on Anthropic's model, for codex) no longer leaves the run with none. pi and codex choose through the gateway
    // (chooseModel); claude-agent never does, and holds the key its route sends, which gives its default.
    delete env[KEY_MODEL_ENV];
    const harness = run.tooling?.harness ?? DEFAULT_HARNESS;
    const keyModel = run.tooling && !run.tooling.model && harness !== "claude-agent" ? hostModel(served, "default", harness) : undefined;
    if (keyModel) env[KEY_MODEL_ENV] = keyModel;
    // Its tools' providers (tool-plane.ts): resolved at its first launch from its pinned revision and this server's
    // settings, and kept in its serve.json, so a later change of the settings never changes a run's tools; at a later
    // launch only checked again (a Parallel key gone makes Parallel unavailable, never another provider). A new run's are
    // in the serve.json its start writes (start); resolving here is for a run made before that. A description with no secret
    // in it, read by the run's process, never by a request. A key saved through the settings API counts as the launcher's
    // does (secrets.ts), so a saved Parallel key makes Parallel available, and a deleted one unavailable at the next launch.
    const plane = run.meta.tool_plane ? recheckPlane(run.meta.tool_plane, served) : run.tooling ? planeFor(served, run.tooling, this.options.toolSettings?.() ?? {}, { capped: run.meta.max_cost_usd !== undefined }) : {};
    if (!run.meta.tool_plane && Object.keys(plane).length) {
      run.meta.tool_plane = plane;
      void this.saveMeta(run).catch(() => undefined);
    }
    delete env[TOOL_PLANE_ENV];
    if (Object.keys(plane).length) env[TOOL_PLANE_ENV] = JSON.stringify(plane);
    // The decision keys are never in a run's environment, which its tools and its model's provider read (childEnv leaves
    // out every secret): a run's process gets those it needs once on an inherited pipe, by name: its decision
    // providers' (decisionProvidersFor), and Parallel's where one of its web tools resolves to Parallel (its plane,
    // handsParallel). A web tool reaches Parallel only where its own capability resolves there. A run that needs none
    // gets no pipe at all, and one whose revision was not read gets none.
    delete env[DECISION_KEY_FD_ENV];
    // Chosen from the secrets this server holds: out of its environment once its launcher hands them over (secrets.ts).
    const providers = needs?.decisionProviders;
    const decisionKeys = providers ? decisionKeysFor(served, { providers, parallelWeb: handsParallel(plane) }) : {};
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
    // Its own door token, which its door takes and its calls to the box relay carry: no other run's process holds it.
    run.doorToken = ensureRunDoorToken(run.dir);
    const doorTokenFile = join(run.dir, RUN_DOOR_TOKEN);
    const child = spawn(process.execPath, [
      // secrets.ts first, as a preload: the pipe is read and closed before pi-durable-disk's CLI loads or starts anything.
      "--no-warnings=ExperimentalWarning", "--import", SECRETS_MODULE, this.cli, "run", "--dir", run.dir, "--app", this.app,
      "--serve", "0", "--serve-host", "127.0.0.1", "--serve-token-file", doorTokenFile, "--drain-timeout", drain, // key-gate: loopback-rule the door of a run listens on loopback only, for this server
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
    // As it was first sent: the run never took it, so its work/inputs/ is as its start left it.
    void firstMessage(first, join(run.dir, "work")).then((content) => this.submit(run, content, "followUp", `first-${run.id}`, READY_TIMEOUT_MS)).catch((error: Error) => warn(run.id, `its first message did not land again: ${error.message}`));
  }

  /** After the run's process exited, or was found gone: its rows from its released store, then, when it is over, its
   *  carry back. One at a time per run, and none once the run has its outcome. */
  private settle(run: Run, code: number | null, exited: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    run.settles++;
    run.settling = (run.settling ?? Promise.resolve())
      .then(() => (run.outcome ? undefined : this.settleOnce(run, code, exited)))
      .catch((error: Error) => {
        if (!(storeBusy(error) || error instanceof PullPending) || this.closing) return warn(run.id, `not settled: ${error.message}; the next start tries again`);
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
    // A run whose files are still being copied has had no process yet: its start launches it, and only a cancel ends it
    // first (a recovery that lists it meanwhile must not fail it for its launch mark).
    if (run.preparing && !run.cancel) return;
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
      // Opened again without a place, as a run already going, unless its harness never fits this host (a restart on a
      // smaller one): that run fails with why.
      const never = neverFits(run.harness, this.memory);
      if (!never && run.relaunches < MAX_RELAUNCHES) {
        await this.pinNeeds(run);
        return this.relaunch(run);
      }
      run.error = { code: "run_failed", message: never ?? `The run's process went ${MAX_RELAUNCHES + 1} times before the run ended: ${await lastLogLine(run)}`, retryable: false };
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
    if (paid.length) run.decisionsPriced = { known: paid.reduce<number>((a, b) => a + (typeof b === "number" ? b : 0), 0), unpriced: paid.filter((cost) => typeof cost !== "number").length };
  }

  /** Ends the run in the agent store, once: how it ended, its cost, a line for the list and its metrics. A store held by
   *  another writer is tried again with backoff; past the last try the run stays unsettled, and the next start carries it back. */
  private async carryBack(run: Run, outcome: Status, state?: Ended, summary?: string): Promise<void> {
    // Its process is gone: its box goes with its end, whatever the end (a follow-up after it gets a fresh box; work/ stays).
    // A remote box's last pull lands first: the end is not recorded until its files are in work/.
    await this.dropBox(run, true);
    // Its end-of-run turn closed, and what the turn wrote set aside before the run reads ended (learning-run.ts).
    await this.learning.beforeSettle(run, outcome);
    const answer = answerOf(run.rows);
    const cost = run.decisionCost === undefined ? costOf(run.rows) : costView(run.rows, undefined, run.decisionCost);
    // An unknown cost keeps what it cost so far beside it, for the list row read from the store.
    const soFar = cost === null && !run.imported ? soFarOf(run.rows, run.decisionCost === undefined ? undefined : (run.decisionsPriced ?? null)) : undefined;
    if (soFar) run.meta.cost_so_far = soFar;
    else delete run.meta.cost_so_far;
    const line = summary ?? (outcome === "completed" ? (run.answerText ?? answer?.text ?? answer?.summary) : outcome === "cancelled" ? "cancelled" : run.error?.message);
    if (run.error) run.meta.error = { code: run.error.code, message: run.error.message, ...(run.error.details ? { details: run.error.details } : {}) };
    // Its end's time, chosen once and given to the store: the row, a retry of the write and its run.ended all name this one
    // time. A server that settles the run after a kill chooses its own: nothing was sent before the store had an end.
    const endedAt = (run.endedAt ??= new Date().toISOString());
    const ending = { state: state ?? (outcome === "cancelled" ? "stopped" : outcome === "completed" ? "completed" : "failed"), ...(cost === null ? {} : { costUsd: cost }), ...(line ? { summary: line } : {}), endedAt } as const;
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
      // run as it was in the store. Its run.ended waits for the store (persistLater), so a receiver that reads the run
      // back on its notice reads it ended there too.
      warn(run.id, `its end could not be written to the agent store (${(error as Error).message}); trying again every ${(this.options.settleRetryMs ?? SETTLE_RETRY_MS) / 1000} s`);
      // An unknown cost stays unknown: never stored as 0.
      if (cost !== null) run.costUsd = cost;
      run.outcome = outcome;
      run.finishing = undefined;
      run.settled = true;
      run.updatedAt = new Date().toISOString();
      this.refresh(run);
      this.persistLater(run, persist);
      return;
    }
    const row = await this.options.agents.request(() => this.store.readRun(run.id)).catch(() => undefined);
    // The store's time is the one it was given, unless an earlier end of the run's own landed first (a refused write that
    // went through after all): the row's then. A read that fails keeps the chosen time, never a new one.
    if (row?.endedAt) run.endedAt = row.endedAt;
    if (row?.costUsd !== undefined) run.costUsd = row.costUsd;
    this.options.log?.("run_ended", { run: run.id, agent: run.agentId, status: outcome, cost_usd: row?.costUsd ?? cost ?? "unknown" });
    run.outcome = outcome;
    run.finishing = undefined;
    run.settled = true;
    run.updatedAt = new Date().toISOString();
    this.refresh(run);
    this.notice(run, "run.ended", run.endedAt);
    // Only once the run has ended as it would without learning: a slow or failing check never holds the job.
    void this.learning.afterSettle(run);
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
        // In the store at last: its run.ended goes now.
        this.notice(run, "run.ended", run.endedAt);
        await this.learning.afterSettle(run);
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
  /** A place for one more live run of `harness`, taken for this start (counted in `starting` and `startingMib` from
   *  here, so two starts at once cannot both take the last place), or 429 rate_limited; the function returned gives it
   *  back once the run holds it as a live run, or did not start. A place is one under the cap on the count and the
   *  memory a run of its harness reserves (host.ts): both must be free. A run that has ended (failed, completed,
   *  cancelled) still holds its place until its process exits; a start that needs that place waits for it, up to that
   *  process's drain and kill, never refused for a place already being given back. A harness whose one run is more than
   *  the whole memory for runs is refused at once, never a 429 (capabilities say so too). From the read of what is held
   *  to the reservation nothing awaits, so two starts at once never both take the last of it. */
  private async takePlace(harness: string): Promise<() => void> {
    const { memory, options: { maxRuns: max } } = this;
    const need = runMibOf(harness);
    const never = neverFits(harness, memory);
    if (never) throw new ApiError("agent_not_runnable", never, { details: { unbound: [], missing: {}, harness } });
    for (const deadline = Date.now() + this.killAfterMs() + 1_000; ; await sleep(50)) {
      const holding = [...this.runs.values()].filter((run) => this.live(run));
      const counted = max === undefined || holding.length + this.starting < max;
      const held = holding.reduce((sum, run) => sum + runMibOf(run.harness), this.startingMib);
      // With nothing held, a run that fits at all starts: pi's one place on a host smaller than a pi run (host.ts).
      const fits = held === 0 || held + need <= runsMemoryMib(memory);
      if (counted && fits) break;
      const leaving = holding.some((run) => run.outcome || run.finishing || run.cancel);
      if (!leaving || Date.now() > deadline) {
        if (!counted) throw new ApiError("rate_limited", `This server runs at most ${max} runs at once (max_concurrent_runs); start this one when another ends.`, { retry_after_ms: 5_000, details: { max_concurrent_runs: max } }, { "retry-after": "5" });
        throw new ApiError("rate_limited", memoryFull(harness, memory, held), { retry_after_ms: 5_000, details: { max_concurrent_runs: max ?? null, harness, needs_mb: need, free_mb: Math.max(0, runsMemoryMib(memory) - held) } }, { "retry-after": "5" });
      }
    }
    this.starting++;
    this.startingMib += need;
    return () => {
      this.starting--;
      this.startingMib -= need;
    };
  }

  /** `inputs` copies the run's files into its work/ (uploads.ts), after the store made it and before its process starts. */
  async create(entry: AgentEntry, revision: Revision, version: number, options: StartOptions): Promise<Run> {
    await this.sweepOnce();
    const release = await this.takePlace(harnessOfBody(revision.body));
    try {
      // Read again: the place may have been waited for, and the agent archived meanwhile.
      const now = await this.options.agents.get(entry.agent.id);
      if (now?.agent.archivedAt) throw new ApiError("agent_not_runnable", `The agent ${entry.agent.id} is archived: unarchive it to run it.`, { details: { archived_at: now.agent.archivedAt } });
      return await this.start(entry, revision, version, options);
    } finally {
      release();
    }
  }

  /** Writes the serve.json of a run being set up. When it fails, the store has the run as running and no process will
   *  run it: it ends failed here, never left for a later start to open with half its files. */
  private async setUp(runId: string, dir: string, meta: RunMeta): Promise<void> {
    try {
      await writeWhole(join(dir, RUN_META), `${JSON.stringify(meta)}\n`);
    } catch (error) {
      const summary = `The run could not be set up: ${(error as Error).message}`;
      await this.options.agents.request(() => this.store.carryBack(runId, { state: "failed", summary })).catch((undo: Error) => warn(runId, `not ended after its setup failed: ${undo.message}`));
      throw error;
    }
  }

  private async start(entry: AgentEntry, revision: Revision, version: number, options: StartOptions): Promise<Run> {
    // Its tools' providers, resolved before the run exists (tool-plane.ts) and kept in the serve.json its start writes first,
    // so a launch after a crash reads them back, never the settings of that moment, and keeping them is no write of its own.
    const tooling = await toolingOf(revision);
    const plane = tooling ? planeFor(withSecrets(process.env, "all", this.options.storedKeys), tooling, this.options.toolSettings?.() ?? {}, { capped: options.maxCostUsd !== undefined }) : {};
    // A run that learns: its seed read before it is made (learning-run.ts).
    const pin = await this.learning.onStart(entry.agent.id, revision);
    const started = await this.options.agents.request(() => this.store.startRun({ agent: entry.agent.id, revision: revision.id })).catch((error) => storeError(error, "revision"));
    const at = new Date().toISOString();
    const meta: RunMeta = {
      title: clip(options.title.trim().replace(/\s+/g, " "), 80),
      created_at: at,
      input: options.input,
      place: options.place,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.maxCostUsd !== undefined ? { max_cost_usd: options.maxCostUsd } : {}),
      ...(Object.keys(plane).length ? { tool_plane: plane } : {}),
    };
    // The run's input is saved first, as the store has it running: a server that goes down from here on leaves a run the
    // next one relaunches with its first message.
    await this.setUp(started.runId, started.dir, meta);
    if (pin) {
      // Then its seed copied and pinned, and its learning saved once the copy is whole or gone. A server that goes down
      // during the copy leaves none saved, and the next one takes the copy back (learning-run.ts onLoad).
      meta.learning = await pin(started, at);
      await this.setUp(started.runId, started.dir, meta);
    }
    const run = this.blank({ id: started.runId, agent: entry.agent.id, revision: revision.id, kind: revision.kind }, started.dir, meta, version, harnessOfBody(revision.body), tooling, revision);
    // Before the run is known here, so nothing launches it first.
    await this.pinNeeds(run, revision);
    this.runs.set(run.id, run);
    // A seed that failed is a learning row from the start, and its learning's end is in the ledger.
    this.show(run);
    void this.learning.onSaved(run, meta.learning);
    this.options.log?.("run_started", { run: run.id, agent: run.agentId, kind: run.kind });
    if (revision.kind === "agentic") run.submitted = 1;
    this.refresh(run);
    if (options.inputs) {
      // Listed from here, so a request may reach it while it copies: `preparing` holds it until its files are in.
      const prepared = this.prepare(run, started.workspace, options.inputs).finally(() => void (run.preparing = undefined));
      // Never rejected: a request waiting on it reads how the start ended from the run; the start's own error is the create's.
      run.preparing = prepared.then(() => undefined, () => undefined);
      if (!(await prepared)) return run;
    }
    this.launch(run);
    if (revision.kind === "workflow") return run;
    // The first message names the files given to the run (run-manifest.ts), on every harness.
    void firstMessage(options.input.content as string, started.workspace).then((content) => this.submit(run, content, "followUp", `first-${run.id}`, READY_TIMEOUT_MS)).catch((error: Error) => {
      run.submitted = 0;
      // The run ended before its first message reached it (a process that crashed at its start): how it ended stands.
      if (run.outcome || run.finishing || run.cancel) return;
      run.error = { code: "run_failed", message: error.message, retryable: false };
      if (this.live(run)) this.finish(run, "failed");
      else if (!run.cancel) void this.settle(run, 1, true);
    });
    return run;
  }

  /** Copies the run's files into its work/ under the launch mark: a server that goes down while it copies leaves the
   *  mark, and the next start fails the run rather than run it on part of its files. Copied whole, the mark goes, and the
   *  launch makes its own. False when the copy failed, and the run ended so (or was cancelled meanwhile). */
  private async prepare(run: Run, work: string, inputs: (work: string) => Promise<unknown>): Promise<boolean> {
    try {
      // The mark itself may fail (a full disk): the run ends as when the copy does.
      this.markLaunching(run);
      await inputs(work);
    } catch (error) {
      run.submitted = 0;
      // Cancelled while it copied: it ends so.
      if (!(run.outcome || run.cancel)) {
        run.error = { code: "run_failed", message: `The run's files could not be copied into its workspace: ${(error as Error).message}`, retryable: false };
        await this.carryBack(run, "failed");
      }
      // The mark goes only once the store has the run's end: a server that goes down before then finds it, and fails the
      // run rather than launch it on part of its files.
      const row = await this.options.agents.request(() => this.store.readRun(run.id)).catch(() => undefined);
      if (row && row.state !== "running") this.reportedBack(run);
      return false;
    }
    this.reportedBack(run);
    return true;
  }

  private async submit(run: Run, content: string, whenBusy: "steer" | "followUp", requestId: string, readyMs?: number): Promise<void> {
    const answer = await this.toDoor(run, "/submit", { requestId, content, whenBusy }, readyMs);
    if (answer.status >= 400) throw new ApiError(answer.status === 409 ? "not_continuable" : "internal", String(answer.body?.message ?? answer.body?.error ?? "the run refused the message"));
  }

  /** Whether the run's harness takes a message mid-turn. */
  private steers(run: Run): boolean {
    return run.kind !== "agentic" || steersMidTurn(run.harness);
  }

  /** One message to an agentic run, its mode chosen by the run's state (the contract's table). */
  async message(run: Run, content: string): Promise<{ mode: "steer" | "answer" | "follow_up"; messageId: string }> {
    if (run.imported) throw this.importedRefusal(run);
    // Every wait first, then a last look for a stop in flight, again after any wait a stop came during: from that look
    // to the count below nothing awaits, so no stop can begin in between.
    do {
      // A stop in flight is answered first. Sent between its mark and its abort, a message would read the run stopped, go
      // to the turn the abort is cutting, and be dropped with it, its row never coming.
      if (run.stopping) await this.waitWhile(() => run.stopping === true, 50, "The run is being stopped");
      // A run that reads finished before its end is written (its process still closing, or its carry back waiting on the
      // store) is answered once the end is in: then it is completed and opens again, or it is failed or cancelled.
      if (run.finishing && !run.outcome) await this.waitWhile(() => Boolean(run.finishing && !run.outcome), 100, "The run's end is still being written");
      // A run another message is opening again is answered once that opening is done: reopen() clears the run's end
      // before it lays the run's notes again (learning-run.ts onReopen), and a message read meanwhile would launch the run
      // before they are back.
      if (run.reopening) await run.reopening.catch(() => undefined);
      if (run.kind === "agentic" && statusOf(run).status === "completed") await (run.reopening ??= this.reopen(run).finally(() => (run.reopening = undefined)));
    } while (run.stopping);
    const steers = this.steers(run);
    const { status, state } = statusOf(run);
    if (TERMINAL.has(status)) throw this.finished(run);
    // A harness that cannot take a message mid-turn (any but pi, harness.ts) queues it for the turn's end: a new turn of
    // the same run, which the contract calls follow_up, never a steer it does not do.
    const working = status === "queued" || (status === "working" && state === "working");
    const mode = working ? (steers ? "steer" : "follow_up") : status === "input_required" && state === "waiting" ? "answer" : "follow_up";
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

  /** Waits, up to a request's deadline, while `holds` (checked every `everyMs`): else 503 `unavailable`, saying `why`. */
  private async waitWhile(holds: () => boolean, everyMs: number, why: string): Promise<void> {
    for (const deadline = Date.now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS); holds(); await sleep(everyMs)) {
      if (Date.now() > deadline) throw new ApiError("unavailable", `${why}; try again.`, { retry_after_ms: 1000 }, { "retry-after": "1" });
    }
  }

  /** A completed agentic run that gets a follow-up opens again: the same run on its own store and session, under its
   *  cap, taking a place under the server's. Launched here, with no wait after the place is taken, so no start takes
   *  it meanwhile. An archived run, or a run of an archived agent, stays closed. */
  private async reopen(run: Run): Promise<void> {
    await this.sweepOnce();
    await this.pinNeeds(run);
    const row = this.store.readRun(run.id);
    if (row?.archivedAt) throw new ApiError("not_continuable", "This run is archived: unarchive it to continue it.");
    // Its end could not be written yet (persistLater tries again): it opens once the store has it.
    if (row?.state === "running") throw new ApiError("unavailable", "The run's end is still being written to the agent store; try again.", { retry_after_ms: 1000 }, { "retry-after": "1" });
    const release = await this.takePlace(run.harness);
    try {
      // Read again: the place may have been waited for, and the run (or its agent) archived meanwhile.
      const now = this.store.readRun(run.id);
      if (now?.archivedAt) throw new ApiError("not_continuable", "This run is archived: unarchive it to continue it.");
      if (now?.state === "running") throw new ApiError("unavailable", "The run's end is still being written to the agent store; try again.", { retry_after_ms: 1000 }, { "retry-after": "1" });
      // Its end's run.ended in the outbox on disk before the run opens again, or not opened: once the row runs, no start finds
      // the end to queue it.
      if (now?.endedAt && this.notice(run, "run.ended", now.endedAt) === "unsaved") throw new ApiError("unavailable", "The run's end is still being announced to its webhook; try again.", { retry_after_ms: 1000 }, { "retry-after": "1" });
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
      // A run that learns finds its agent's notes in its work again (learning-run.ts).
      await this.learning.onReopen(run);
      this.refresh(run);
      this.launch(run);
    } finally {
      // Launched, it holds its place as a live run.
      release();
    }
    // An end-of-run turn its process went in is aborted before the follow-up is sent (learning-run.ts).
    await this.learning.afterReopen(run);
  }

  /** Waits, up to a request's deadline, until a live run's rows show every message sent to it, and any rows at all: its
   *  record has caught up with its process. Its end, a cancel or its process going ends the wait. */
  private async caughtUp(run: Run): Promise<void> {
    for (const deadline = Date.now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS); run.submitted > 0 || !run.rows.length; await run.log.changed(100)) {
      if (!this.live(run) || run.finishing || run.outcome || run.cancel || Date.now() > deadline) return;
    }
  }

  /** Abort the turn that is running; the run stays open, `input_required` and idle. A workflow run has no turn to stop. */
  async stop(run: Run): Promise<boolean> {
    // The contract's stop has no refusal: an imported run answers as any ended one, stopped false, and nothing moves.
    if (run.imported) return false;
    // A message sent to the run shows in its rows only once its door's events bring it: until then the run reads queued
    // (state working), or holds a message not shown, however far its process is into the turn. The stop waits for its
    // rows first, so the mark it saves (the person's last message) covers the message the turn answers; then it stops
    // the turn as it stops any working run.
    if (run.kind !== "workflow") await this.caughtUp(run);
    const { status, state } = statusOf(run);
    if (run.kind === "workflow" || !this.live(run) || !(status === "working" && state === "working") || run.submitted > 0) return false;
    run.stopping = true;
    try {
      return await this.stopTurn(run);
    } finally {
      run.stopping = undefined;
    }
  }

  /** stop()'s mark and abort, once it took the stop. */
  private async stopTurn(run: Run): Promise<boolean> {
    // Set before the abort: the turn's end can arrive before the door answers, and must not read as an answer.
    const before = { stopped_at: run.meta.stopped_at, stopped_after: run.meta.stopped_after };
    delete run.meta.stopped_at;
    delete run.meta.stopped_after;
    Object.assign(run.meta, stopMark(run.rows));
    await this.saveMeta(run).catch((error: Error) => warn(run.id, `its stop is not saved, so a restart will not keep it: ${error.message}`));
    await this.beforeAbort?.(run.id);
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
    // Finishing is already ending with its outcome (an answer, a failure, the cap): a cancel now would turn a run that
    // answered into a cancelled one, since the settle reads the cancel first.
    if (run.outcome || run.finishing) return false;
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

  /** What close() will wait on: the runs whose processes are left to finish their turn (those this server started, and
   *  those it adopted), and the longest it can wait on them: a kill bound for the started ones, and one more for the
   *  adopted ones, which it stops after them. */
  stopping(): { runs: number; boundMs: number } {
    const all = [...this.runs.values()];
    const started = all.filter((run) => run.child).length;
    const adopted = all.filter((run) => !run.child && run.orphan && alive(run.orphan)).length;
    return { runs: started + adopted, boundMs: (started ? this.killAfterMs() : 0) + (adopted ? this.killAfterMs() : 0) };
  }

  async close(): Promise<void> {
    this.closing = true;
    this.learning.close();
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
    await this.learning.idle();
    for (const run of this.runs.values()) run.feed?.abort();
    this.closed = true;
  }

  // ---- views ------------------------------------------------------------------------------------------------------------

  /** A run's cost from its rows, else what the store recorded when it carried the run back. */
  cost(run: Run) {
    // An imported run's cost is its source's, for the whole session: its requests may not each have a price.
    const usd = run.imported ? (run.costUsd ?? null) : costView(run.rows, run.costUsd, run.decisionCost);
    // Unknown: what it cost so far and how many charges have no price (costsofar/1), from its rows, else what it said at
    // its end (a run carried back with no rows read since).
    const soFar = usd === null && !run.imported ? (soFarOf(run.rows, run.decisionCost === undefined ? undefined : (run.decisionsPriced ?? null)) ?? (run.rows.length ? undefined : soFarOfMeta(run.meta))) : undefined;
    return { usd, basis: "estimate", charge_state: null, cap_usd: run.meta.max_cost_usd ?? null, ...(soFar ?? {}) };
  }

  /** `Run`, as the contract shows it. `known`: its stored row as the caller already has it, so nothing is read; a run
   *  just written has none worth reading (`{ stored: null }`: it is neither archived nor ended), and its start's answer
   *  must not read the store once the run exists, since a busy store would then refuse a run that runs. */
  async view(run: Run, known?: { stored: RunRow | null }) {
    const stored = known ? (known.stored ?? undefined) : await this.options.agents.request(() => this.store.readRun(run.id));
    // After the read: the run may have moved on while it waited, and every field below is of this one moment.
    const { status, state } = statusOf(run);
    const row = TERMINAL.has(status) ? stored : undefined;
    const answer = answerOf(run.rows);
    // A run that ended on the person's message, which its turn answered with nothing it shows (decide()), answered with its
    // newest answer: the whole text (answerText, read from the entries again on a later server), never the line the store
    // keeps, which is cut.
    const finalAnswer = run.kind === "workflow" ? null : answer ? (run.answerText ?? answer.text ?? answer.summary ?? null) : status === "completed" ? (lastAnswer(run) ?? row?.summary ?? null) : (row?.summary ?? null);
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
      place: run.meta.place ?? { mode: "runner" },
      ...(run.meta.effort ? { effort: run.meta.effort } : {}),
      created_at: run.meta.created_at,
      updated_at: run.updatedAt,
      ended_at: endedAt,
      result: status === "completed" ? { output: run.kind === "workflow" ? (run.meta.output ?? null) : null, final_answer: finalAnswer } : kept ? { output: null, final_answer: kept } : null,
      error: status === "failed" ? (run.error ?? { code: "run_failed", message: "The run failed.", retryable: false }) : null,
      review: endedAt === null ? null : reviewAt(run.meta.review ?? (row ? reviewOfRow(row, run.meta) : null), endedAt),
      pending: status === "input_required" && state === "waiting" ? pendingOf(run.rows) : null,
      cost: this.cost(run),
      archived_at: stored?.archivedAt ?? null,
      imported_from: run.imported ?? null,
      // The notes it read once it settled: while it runs, or runs again for a follow-up, they are still being read.
      learning: this.learning.view(run.meta.learning, TERMINAL.has(status) && run.settled),
      poll_after_ms: TERMINAL.has(status) && run.settled ? 0 : 1000,
    };
  }

  async summary(run: Run) {
    const { run_id, agent_id, agent_version, revision, kind, sha, status, state, title, effort, created_at, ended_at, error, review, pending, cost, archived_at, imported_from, learning } = await this.view(run);
    return { run_id, agent_id, agent_version, revision, kind, sha, status, state, title, ...(effort ? { effort } : {}), created_at, ended_at, error, review, pending, cost, archived_at, imported_from, learning: learning && shortOf(learning) };
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
      ...(typeof meta?.effort === "string" ? { effort: meta.effort } : {}),
      created_at: typeof meta?.created_at === "string" ? meta.created_at : row.startedAt, ended_at: row.endedAt ?? null,
      error: STATUS_OF[row.state as Ended] === "failed" ? errorOfRow(row, meta) : null,
      review: reviewAt(reviewOfRow(row, meta), row.endedAt ?? new Date(0).toISOString()),
      cost: { usd: row.costUsd ?? null, basis: "estimate", charge_state: null, cap_usd: typeof meta?.max_cost_usd === "number" ? meta.max_cost_usd : null, ...(row.costUsd == null ? (soFarOfMeta(meta) ?? {}) : {}) },
      archived_at: row.archivedAt ?? null,
      // A run read from its row alone has ended: it waits on nothing.
      pending: null,
      imported_from: row.importedFrom ?? null,
      // Its row says it ended: what serve.json holds of its learning is as it settled.
      learning: this.learning.short(isObject(meta?.learning) ? (meta.learning as Learning) : null, true),
    };
  }

  /** A key was saved on this server or deleted from it: each held run's learning row shown again, cut of the keys as
   *  they are now (learning-run.ts shown), as its view and its lists already are from the next read on. */
  keysChanged(): void {
    this.learning.keysChanged();
    for (const run of this.runs.values()) if (run.meta.learning) this.show(run);
  }

  /** A held run's learning, in short (learning-run.ts heldLearning). */
  heldLearning(runId: string): { state: LearningState; reason: LearningReason | null } | null | undefined {
    return this.learning.heldLearning(runId);
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
