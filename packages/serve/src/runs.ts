// Runs: each one a child process (`pi-durable-disk run` on `<data>/runs/<id>` with serve's app), pinned to a revision in
// the agent store. An agentic run is read live through the door its process serves on loopback; a workflow run is
// working while its process lives. Once the process has exited the run is read from its store, read-only, and carried
// back to the agent store (`carryBack`), and it is finished. A run whose process went before the run ended is opened
// again on its directory, and resumes from its store.
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open as openFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { processAlive } from "@parcha/agentrun-kernel/host";
import { doorKey, doorTook } from "@parcha/pi-durable-disk";
import { RUN_STATUS_TABLE } from "@parcha/pi-durable-disk/internals";
import { AgentHomeError, type Revision, runDirIn, type RevisionKind, type RunOrigin, type RunRow, type RunState, type StoredMetrics } from "@parcha/pi-durable-agent";
import { chargedTool, isMessageRow, MESSAGE_ORIGIN, type MessageOrigin, registerLabel, registerTurnEnding, REQUEST_STARTED, type RunMetrics, runMetricsWithDecisions, timelineOf, timelineReducer, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { HARNESS_LOG_EVENT, harnessModelKeys, thinkingFor } from "./adapters.js";
import { DEFAULT_HARNESS, harnessOfBody, steersMidTurn } from "./harness.js";
import type { RUN_EVENTS, RunNotice } from "./webhooks.js";
import type { RunTrigger } from "./triggers.js";
import { hostMemory, memoryFull, neverFits, runMibOf, runsMemoryMib } from "./host.js";
import { type AgentEntry, type Agents, storeBusy, storeError, whenFree } from "./agents.js";
import { INSTALLING_CLAUDE } from "./claude-sdk.js";
import { DATA_ENV, dataOfRun, FOLLOW_UP_OPEN_ENV, LAUNCH_LOST, readJson, RUN_CANCELLED, RUN_DOOR_TOKEN, RUN_LAUNCHING, RUN_META, runDoorToken, SETUP_LOST, writeDurableSync, writeWhole } from "./files.js";
import { MCP_PIN, mcpCredentialsOf, type McpPin, mcpPinOf, type McpServerSource } from "./mcp-gateway.js";
import { META_REASON, metaToolOf } from "./mcp-meta.js";
import { type DaytonaApi, KEPT_AUTOSTOP_MINUTES, keepWhenIdle, wakeBoxes } from "./daytona-api.js";
import { type Learning, LEARNING_LABEL, type LearningMode, type LearningReason, type LearningState, shortOf } from "./learning.js";
import { labelled, LearningRuns, type Reflect, reflecting, reflects, type TurnOrigin, withLearning } from "./learning-run.js";
import { type BoxHost, type Quarantine, settleBox, sweepBoxes } from "./box/sweep.js";
import { rowPaths } from "./workspace-paths.js";
import { ASK_TOOL, toolingOf, workflowTools } from "./tools.js";
import { withDecisions } from "./decision-rows.js";
import { DECISION_KEY_FD_ENV, decisionKeysFor, providersNamed } from "./decisions.js";
import { ApiError, invalid, unsupported } from "./errors.js";
import { DOCUMENTS_ENV } from "./pdf-pages.js";
import { CAP_ENV, CAP_REFUSAL_PREFIX, CAP_REFUSED_FIELD, CAP_TOLERANCE, FIT_TOLERANCE, money, type RefusalFigures, roomRefusal, SPEND_CAP_REACHED, spentIn } from "./cap.js";
import { DEFAULT_MODEL_ENV, EFFORT_ENV, GATEWAY_KEY_ENV, hostModel, llmTiers, modelKeys, nodeTiers, PROVIDER_KEYS, thinkingOf, type Tier, withoutFaux, workflowNodes } from "./model.js";
import { llmAnswers, pausedIn, readNodeLog, RUN_PAUSED } from "./pause.js";
import { durationMs } from "./print.js";
import { handsParallel, keptFromBefore, keptVendor, type Plane, planeFor, recheckPlane, relaunchPlane, TOOL_PLANE_ENV, type Tooling, type ToolSettingsMap } from "./tool-plane.js";
import { APPROVAL_ENTRY, APPROVAL_ROW, NO_APPROVER_ENV, type PendingApproval, permissionOf, previewOf, RESUME_PREFIX, TURN_ORIGIN_FILE } from "./tool-gate.js";
import { ChangeClock, type Page, RowLog } from "./rows.js";
import { TOOL_KEYS } from "./tool-keys.js";
import { isObject, type Json } from "./validate.js";
import { firstMessage } from "./run-manifest.js";
import { REFLECT_REQUEST, Turns } from "./turns.js";
import { DECISION_KEYS, handover, handoverSignIn, hostSecrets, mcpHandover, mcpSecretValues, secret, SECRET_NAMES, SECRETS_FD_ENV, SECRETS_LEN_ENV, type StoredKeys, withoutSecrets, withSecrets } from "./secrets.js";
import type { HandedSignIn, SignIns } from "./sign-ins.js";
import { MIN_SECRET } from "./learn/secrets.js";
import { keyRefusal, redacted, redactedAnswer, redactedLive, redactedOutput, runKeyOf, withoutLoopback } from "./key-refusal.js";
import { GRAPH_CACHE_BYTES, PartCache, type PartKind, servedPart } from "./graph-served.js";
import { CONTENT_FILTER_WORDS, contentFiltered, MODERATED } from "./content-filter.js";
import { BOX_KEYS, VM_PROVIDER } from "./boxes.js";
import { type Place, remotePlace, storedPlace } from "./place.js";
import { destroyRunBoxes, ensureRemoteBox, PullIncomplete, pullRemoteBox, RUN_LABEL, sweepRunBoxes } from "./run-box.js";
import { BACKGROUND_DIR, endBackground } from "./background.js";
import { removeEgressDir, RUN_BOX_ALLOW_ENV } from "./box-egress.js";
import { BehindReadError, checkpointRunDb, MonotonicReads, readRunDb } from "./run-db.js";
import { holderLives, holderOfClaim, holderOfProcess, holderState, killHolder, LAUNCH_HOLDER, RUN_LAUNCH_ENV, type RunHolder, signal } from "./run-holder.js";
import { firstDoorLine, untilOpened, verifyDoor } from "./door-line.js";

/** `holder` with this launch's door nonce, which the row keeps so a next server can prove the door too. */
const withNonce = (holder: RunHolder | undefined, nonce: string): RunHolder | undefined => holder && { ...holder, nonce };
import { type DiskAdapter, localDisk } from "./disk.js";
import { RUN_BOX_VOLUME_ENV } from "./box-egress-vm.js";
import type { BoxProvider } from "@parcha/pi-transport";
import type { RemoteLimits } from "./run-box.js";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Emitted } from "./webhooks.js";

export type Status = "queued" | "working" | "paused" | "input_required" | "completed" | "failed" | "cancelled";
export type State = "working" | "waiting" | "idle";
export const STATUSES: readonly Status[] = ["queued", "working", "paused", "input_required", "completed", "failed", "cancelled"];
type Ended = Exclude<RunState, "running">;
const TERMINAL = new Set<Status>(["completed", "failed", "cancelled"]);

const RELEASED = new Set(["sleeping", "paused", "done", "failed"]);
/** How long an agentic run's process may finish its turn after SIGTERM, unless the server says otherwise. */
const DRAIN = "30s";
/** The run process's stderr, in its folder: a file, so the process outlives a server that stops without stopping it. */
const PROCESS_LOG = "process.log";
/** How long a request waits for a run's door: its process coming up, or a settle in progress. */
const READY_TIMEOUT_MS = 45_000;
/** The reducer's live "Run started" and "Run finished" rows: a turn's edges, which no store entry makes on any harness,
 *  so a run's settled timeline never has them. Never served, live or settled, so no row a reader saw goes at the end. */
const QUIET = /:run:(start|end)$/;
const RETRY_CODES = ["OPENING", "PARKING", "RELEASED"];
/** How often one server opens a run again whose process went before the run ended, before it fails the run. */
const MAX_RELAUNCHES = 3;
/** How soon a launch whose claim was refused tries again, at its first tries: a store another writer holds is let go of
 *  within moments, and a run waits on its launch. Past these, every settle retry. */
const CLAIM_RETRY_MS = [50, 100, 200, 400, 800, 1_600];
/** The epoch of the claim a run's process holds, which the server gave it at its launch. */
export const RUN_EPOCH_ENV = "AGENTRUN_RUN_EPOCH";
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
/** A settle that cannot tell who holds the run (its row, or the process listing, cannot be read): tried again, never taken
 *  for a holder that is gone. */
class HolderUnknown extends Error {}

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
  /** Each raise of its cap (PATCH /runs/{id}): from what, to what, when, and the pause it answers (pauseOf), if any. */
  cap_raised?: { from: number; to: number; at: string; pause?: string }[];
  /** The one follow-up that sends a run paused at its cap on once its cap is raised (resumeRaised): for which pause, by
   *  what id, whether it went, how many tries failed and why, and which process was being let go when it was asked for
   *  (its pid and start ticks): it goes once that process is gone, here or after a restart. */
  cap_continue?: { pause: string; message_id: string; sent: boolean; tries: number; error?: string; paused?: string };
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
  /** A person's answer to each tool call that waited for approval (tool-gate.ts), by its id: the first one wins, and
   *  the run's process reads it here. A cancel marks one still waiting canceled. */
  approvals?: Record<string, ApprovalAnswer>;
  /** A cancel that waits for the run's gate to cut the approved calls it overrode (Runs.cancel): their ids, kept so an
   *  operator (and a test) reads that it did, never how long it took. Absent on a cancel that waits on nothing. */
  cancel_waits_for?: string[];
  /** The trigger that started it, and its firing's key (triggers.ts); absent for a run a caller started. */
  trigger?: RunTrigger;
};
/** A tool call that waited for a person's approval, as the run's store has it (tool-gate.ts): `resolved` once the run's
 *  process acted on the answer. */
type Approval = { id: string; tool: string; call_id: string; args_json: string; requested_at: string; price?: number | "not metered"; resolved?: true };
/** `args_shown`: the call's arguments as the server shows them (shownArgs), which the gate's resume message names. */
/** `by`: "message", a deny a person's message gave while the call waited (Runs.message). */
/** `superseded`: the answer a stop or a cancel overrode before the run's process acted on it, kept as it was given. */
type ApprovalAnswer = { decision: "allow" | "deny" | "canceled" | "withdrawn"; note?: string; answered_at: string; args_shown?: string; by?: "message"; superseded?: { decision: string; answered_at: string; note?: string; by?: "message" } };
/** A call withdrawn with its run (a cancel, or a stop while it waited): never run, and an answer after is 409. */
const withdrawn = (answer: ApprovalAnswer | undefined) => answer?.decision === "canceled" || answer?.decision === "withdrawn";
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
/** A run's answer or output as a view served it: `out`, redacted from `input` over the held values whose digest is `keys`. */
type Served = { keys: string; input: unknown; out: unknown };

/** GET /runs/{id}/graph's view (graph-view.ts, loaded when a graph is first read). */


/** A value's sha256, of its JSON. */
const digestOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");

export type Run = {
  id: string;
  /** The values of the secrets each launch handed its process: what its errors never show, a key rotated since included. */
  handed?: Set<string>;
  /** What a view last served of its answer and its workflow output (runs.ts servedOnce), with what it was made from. */
  served?: { answer?: Served; output?: Served };
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
  /** The person's messages the run took, and how each one's turn ended (turns.ts): its end is read from them. */
  turns: Turns;
  /** Its tool calls that waited for a person's approval, read from its store's entries, by id. */
  approvals?: Map<string, Approval>;
  /** The whole text of each assistant message of its end-of-run turn, by store entry: what the turn answered, whose
   *  notes learning reads (learning-run.ts). */
  turnText?: Map<number, string>;
  child?: ChildProcess;
  /** The pid of a run process an earlier server started that still serves the run: supervised by the holder its row names. */
  orphan?: number;
  /** That process as its row names it (its pid, its start, this boot): what a signal to it is checked against. */
  orphanHolder?: RunHolder;
  /** A stop of that process kept pending while its identity cannot be checked (terminate): tried again every second. */
  stopPending?: NodeJS.Timeout;
  /** That pending stop has been said in the log: once for as long as it waits. */
  stopWaits?: boolean;
  /** Adopted with a saved stop: its first snapshot is checked once, and a turn still working is aborted. */
  finishStop?: boolean;
  /** A completed run opening again for a follow-up: every follow-up meanwhile waits for this one, never a second. */
  reopening?: Promise<void>;
  /** A follow-up to a run whose turn had ended is on its way: a launch it makes opens the run for it (FOLLOW_UP_OPEN_ENV). */
  followUpOpen?: true;
  feed?: AbortController;
  /** An agentic run's turn is running; a workflow run's process serves. */
  working: boolean;
  /** Messages this server sent the run that its rows do not show yet. */
  submitted: number;
  /** The write of its end-of-run turn's origin (toLiveDoor), which a person's turn waits for before it removes it. */
  originWrite?: Promise<unknown>;
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
  /** The saved sign-in its next launch hands its browser (pinSignIn), never kept on disk by the run. */
  signIn?: HandedSignIn;
  /** Whether its process, as last settled, let the run go (and its browser's sessions with it), or went without. */
  letGo?: boolean;
  /** A workflow run's decision rows, from its released store: its timeline shows one row each (decision-rows.ts). Null
   *  when they cannot be read: its timeline's usage row then reads unknown. */
  decisions?: Record<string, unknown>[] | null;
  /** How many of a workflow run's llm calls' answers its node log held when its rows were last read: their cost is in its
   *  rows (each a REQUEST_COST entry, committed before its answer is logged), so its graph counts only the later ones. */
  llmRead?: number;
  /** What every conversation of its store says it used, as the settle that ends it read them. */
  metrics?: RunMetrics;
  relaunches: number;
  /** Its start's launch is next: the one a deny is told as under ask (relaunchPlane's `first`). */
  firstLaunch?: true;
  /** Its newest launch has not reported back: its mark (RUN_LAUNCHING) is on disk. */
  launching?: boolean;
  /** The store has it running and its serve.json holds no input: its server went down before it set the run up (whose
   *  first write is the input), so it never launched. A serve.json written since (its failure, a stop) never adds one. */
  notSetUp?: boolean;
  /** Its files being copied into its work/ before its first launch, until they are: nothing launches it meanwhile (a
   *  request that would waits for it), and nothing but a cancel settles it. */
  preparing?: Promise<void>;
  /** Its harness being installed before its first launch (claude-agent's Claude Code, on first use: claude-sdk.ts): true
   *  once it is, false when the install failed and the run ended so. Nothing launches it meanwhile, and a request that
   *  would waits for it. */
  installing?: Promise<boolean>;
  /** It shows the install's row (INSTALLING_CLAUDE) while it waits for an install that runs. */
  installRow?: string;
  /** It waits for its harness's install before a launch (harnessReady): takePlace counts it as holding a place until
   *  that launch, so nothing takes its place meanwhile. A cancel or an end lets the place go. */
  waitsInstall?: boolean;
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
  /** Its launch waits on its claim, tried again later (launch): it keeps its place in the server's limits (takePlace). */
  claimWait?: boolean;
  /** Why that claim waits, in words, for a request's 503 (notUp). */
  claimWaitWhy?: string;
  /** Why its newest process was stopped unopened (the ready time passed, its door's last answer): the reason its run
   *  fails with when that was its last launch, since the process's own log does not say it. */
  notOpened?: string;
  /** The door the process this server started said it serves (its stdout line): this server's own record of it, so a
   *  row the agent store cannot take yet never keeps the door from it. */
  door?: string;
  /** The holder its row is still to name (nameHolder), while a store another writer holds keeps the write waiting. */
  naming?: { epoch: number; holder: RunHolder; tries: number };
  /** How many launches in a row its claim was refused: the next try comes sooner while it is few. */
  claimTries?: number;
  /** The last of its database's reads and take-back checkpoint (runs.ts runDb): the next waits for it. */
  dbQueue?: Promise<void>;
  /** It stood waiting for the person when last marked: a turn's end is the change into that. */
  waited?: boolean;
  /** The pause at its cap (its mark) whose process was let go: once per pause. */
  parked?: string;
  /** A raise of its cap being taken (raiseCap): the next one waits for it, so two at once resume it once. */
  raising?: Promise<unknown>;
  /** Its raise's follow-up is being sent (resumeRaised), or waits to be tried again (its time): never two at once. */
  resuming?: "sending" | number;
  /** Its newest refusal for room's figures, from that refusal's own start mark (cap.ts RefusalFigures). */
  capRefusal?: RefusalFigures;
  /** That refusal's own start mark (its entry): the pause a raise answers is keyed to it (pauseOf). */
  capMark?: number;
  /** What it has spent paused at that refusal (its row), its process gone: the store's spend (spentNow), read once. */
  capSpent?: { mark: string; usd: number | null; at?: number };
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
  if (cap === undefined || typeof usd !== "number" || usd <= cap + FIT_TOLERANCE) return rows;
  const { usage: _, ...usage } = rows[at]!;
  const over: TimelineEvent = { ...usage, id: `${usage.id}:over_cap`, kind: "phase", summary: `Spent $${usd.toFixed(4)}, $${(usd - cap).toFixed(4)} over the run's cap of $${cap}`, text: null };
  return [...rows.slice(0, at + 1), over, ...rows.slice(at + 1)];
}

/** Notes the messages the run's turns took and how each turn ended, from `entries` (its root's), `submissions` (pi's
 *  input submissions) and a reconnect's `snapshot` of them (the door's `inputs`, the run's whole state of them), and the
 *  newest entry (learning-run.ts reads it). The end-of-run learning turn's entries are no turn of the run's: none of
 *  them, its TURN_END and its settlement included, opens, closes or answers one of the run's messages. */
function noteTurns(run: Run, entries: readonly unknown[], submissions: readonly unknown[] = [], snapshot?: readonly unknown[]): void {
  for (const value of entries) {
    if (!isObject(value) || typeof value.id !== "number") continue;
    run.lastEntry = Math.max(run.lastEntry ?? 0, value.id);
    // A refusal for room's own start mark: what the cap counted as taken, and the least the request needed.
    const data = value.kind === REQUEST_STARTED && isObject(value.data) && value.data[CAP_REFUSED_FIELD] === true ? value.data : undefined;
    if (data) run.capMark = value.id;
    if (data) run.capRefusal = typeof data.spentUsd === "number" && typeof data.needsUsd === "number" ? { spentUsd: data.spentUsd, needsUsd: data.needsUsd } : undefined;
    // The end-of-run turn's assistant messages, whole, by entry: what the turn answered, whose notes learning reads
    // (learning-run.ts). The ledger skips them; this is their only reader here.
    if (value.kind === "pi.assistant" && reflects(run.meta.reflect, value.id) && Array.isArray(value.model) && isObject(value.model[0])) {
      const content = value.model[0].content;
      (run.turnText ??= new Map()).set(value.id, typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => isObject(b) && b.type === "text").map((b) => String((b as Json).text ?? "")).join("\n").trim() : "");
    }
  }
  const reflect = (id: number) => reflects(run.meta.reflect, id);
  run.turns.note(entries, submissions, reflect);
  if (snapshot) run.turns.snapshot(snapshot, reflect);
}

/** Read only on a run's `rows`, which hold no QUIET row (take). */
const shows = (r: TimelineEvent) => r.kind !== "usage" && r.kind !== "phase";
const meaningful = (rows: readonly TimelineEvent[]) => rows.findLast((r) => shows(r) && r.agent_label !== LEARNING_LABEL);
/** What a run waits on, as `pending` says it (one field for every kind; a tool call waiting on approval is another):
 *  the question a waiting run asked, read from its last meaningful row (withAsks' waiting row), the same row its
 *  status reads, never from a scan of its timeline. */
type Pending = { kind: "question"; question: string; asked_at: string } | PendingApproval | { kind: "budget"; cap_usd: number; spent_usd?: number; needs_usd?: number; suggested_cap_usd?: number; said: string; at: string } | null;
const pendingOf = (rows: readonly TimelineEvent[]): Pending => {
  const last = meaningful(rows);
  return last?.kind === "waiting" ? { kind: "question", question: last.text ?? last.summary ?? "", asked_at: last.timestamp } : null;
};
/** Notes the tool calls that wait for approval in `entries` (the run's stored entries), and those whose answer its process
 *  acted on. */
function noteApprovals(run: Run, entries: readonly unknown[]): void {
  for (const value of entries) {
    if (!isObject(value) || value.kind !== APPROVAL_ENTRY || !isObject(value.data) || typeof value.data.id !== "string") continue;
    const data = value.data;
    run.approvals ??= new Map();
    const known = run.approvals.get(data.id as string);
    if (data.phase === "requested" && !known) run.approvals.set(data.id as string, { id: data.id as string, tool: String(data.tool), call_id: String(data.call_id), args_json: "args" in data ? (JSON.stringify(data.args ?? {}) ?? "{}") : String(data.args_preview ?? ""), requested_at: String(data.requested_at), ...(typeof data.price === "number" || data.price === "not metered" ? { price: data.price } : {}) });
    else if (data.phase === "resolved" && known) known.resolved = true;
  }
}
/** The tool call that waits for a person's answer: requested in the run's store, not resolved there, not answered. */
const waitingApproval = (run: Pick<Run, "approvals" | "meta">): Approval | undefined => [...(run.approvals?.values() ?? [])].find((a) => !a.resolved && !run.meta.approvals?.[a.id]);
/** What is shown of a call's arguments: the whole of them redacted with the run's redactor, then cut (previewOf), so
 *  no cut leaves the head of a held key. */
const shownArgs = (approval: Pick<Approval, "args_json">, redact: (text: string) => string): string => previewOf(redact(approval.args_json));
/** `entries` with the gate's resume messages (RESUME_PREFIX) redacted whole with `redact`, before the timeline cuts
 *  them: the message carries a call's arguments and its result, which may hold a held key. The marker that names a
 *  resume the server's (its origin, on pi) is redacted alike, so its text is still the message's, which it matches. */
function redactGateMessages<T>(entries: readonly T[], redact: (text: string) => string): T[] {
  return entries.map((entry) => {
    const data = isObject(entry) && entry.kind === MESSAGE_ORIGIN && isObject(entry.data) ? entry.data : undefined;
    if (data && typeof data.text === "string" && data.text.startsWith(RESUME_PREFIX)) return { ...(entry as Json), data: { ...data, text: redact(data.text) } } as T;
    const first = isObject(entry) && Array.isArray(entry.model) ? entry.model[0] : undefined;
    if (!isObject(first) || first.role !== "user") return entry;
    const content = first.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((block) => (isObject(block) && block.type === "text" ? String(block.text ?? "") : "")).join("") : "";
    if (!text.startsWith(RESUME_PREFIX)) return entry;
    const redacted = typeof content === "string" ? redact(content) : (content as Json[]).map((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? { ...block, text: redact(block.text) } : block));
    return { ...(entry as Json), model: [{ ...first, content: redacted }, ...((entry as Json).model as Json[]).slice(1)] } as T;
  });
}
/** The run's pending approval (`pending`, kind approval): the call that waits; else undefined. */
const approvalOf = (run: Run, redact: (text: string) => string): PendingApproval | undefined => {
  const waiting = waitingApproval(run);
  return waiting ? { kind: "approval", id: waiting.id, tool: waiting.tool, call_id: waiting.call_id, args_preview: shownArgs(waiting, redact), requested_at: waiting.requested_at, ...(waiting.price !== undefined ? { price: waiting.price } : {}) } : undefined;
};
/** One answered (allow or deny) whose answer the run's process has not acted on yet. */
const actingOn = (run: Pick<Run, "approvals" | "meta">) => [...(run.approvals?.values() ?? [])].some((a) => !a.resolved && run.meta.approvals?.[a.id] && !withdrawn(run.meta.approvals[a.id]));
/** The row after each tool call that waited for approval, beside its result's row. Its arguments are redacted whole
 *  (`redact`, the Timeline's own: no held key), before any cut. */
function withApprovals(rows: readonly TimelineEvent[], run: Pick<Run, "approvals" | "meta">, redact: (text: string) => string): TimelineEvent[] {
  if (!run.approvals?.size) return [...rows];
  const byCall = new Map([...run.approvals.values()].map((approval) => [approval.call_id, approval]));
  const waiting = waitingApproval(run);
  return rows.flatMap((row) => {
    // The gate's resume, the server's row: it says what came of the answer, never the head the model reads.
    const resumed = row.kind === "phase" && row.text?.startsWith(RESUME_PREFIX) ? resumedBy(row.text, byCall) : undefined;
    if (resumed) return [{ ...row, summary: resumeSays(resumed, run.meta.approvals?.[resumed.id], row.text!) }];
    const own = (row.kind === "tool_use" || row.kind === "tool_result") && row.tool_use_id ? byCall.get(row.tool_use_id) : undefined;
    // The call's own rows: what it answered at the park is not what it did, so they say what came of the approval.
    const called = own ? { ...row, summary: parkedCallSays(own, run, waiting), tool_status: null } : row;
    if (row.kind === "tool_use") return [called];
    const approval = own;
    if (!approval) return [row];
    const args = shownArgs(approval, redact);
    const said = run.meta.approvals?.[approval.id]?.decision;
    const byMessage = run.meta.approvals?.[approval.id]?.by === "message";
    const head = approval === waiting ? "Waiting for your approval" : byMessage ? "Declined by your message" : said === "withdrawn" ? "Withdrawn when the run was stopped" : said === "canceled" ? "Withdrawn when the run was cancelled" : "Asked your approval";
    const summary = `${head}: ${approval.tool} ${clip(args, 400)}`;
    // A message that would have declined the call, which a stop or a cancel overrode: its words were never sent, and
    // the row says so (the record keeps them whole).
    const dropped = run.meta.approvals?.[approval.id]?.superseded;
    const text = dropped?.by === "message" && dropped.note !== undefined ? `${args}\n\nNot sent: the run was ${said === "canceled" ? "cancelled" : "stopped"}. Your message: ${redact(dropped.note)}` : args;
    return [called, { ...row, id: `${row.id}:approval`, kind: APPROVAL_ROW, summary, text, tool_name: approval.tool, tool_status: null, tool_input_preview: clip(args, 500), tool_result_preview: null, tool_result_size_bytes: null }];
  });
}
/** What a call that waited for approval came to, as its own rows (its call's and its result's) say it: the park answered
 *  it with the gate's waiting text, so they never say it ran while it had not (no tool verb, no outcome, no status). */
function parkedCallSays(approval: Approval, run: Pick<Run, "meta">, waiting: Approval | undefined): string {
  const given = run.meta.approvals?.[approval.id];
  if (approval === waiting || !given) return approval.resolved ? "Not run" : "Not run yet: it waits for your approval";
  const ended = given.decision === "canceled" ? "cancelled" : "stopped";
  if (given.decision === "withdrawn" || given.decision === "canceled")
    return given.superseded?.decision === "allow" ? `Allowed, then the run was ${ended}: no result of it reached the model` : `Not run: the run was ${ended} while it waited`;
  if (given.decision === "deny") return given.by === "message" ? "Not run: your message declined it" : "Not run: you declined it";
  return approval.resolved ? "Allowed: its result is in the message that resumed the run" : "Allowed: it runs now";
}
/** The call a resume (resumeText, its text as the row has it) answers: its head names the call's tool and id. */
const resumedBy = (text: string, byCall: ReadonlyMap<string, Approval>): Approval | undefined =>
  [...byCall.values()].find((approval) => text.startsWith(`${RESUME_PREFIX}This answers your ${approval.tool} call ${approval.call_id} `));
/** A resume's row as the approval's outcome: what ran, or what was refused. Only the tool's name and fixed words. */
function resumeSays(approval: Approval, given: { decision: string; by?: string } | undefined, text: string): string {
  if (given?.decision === "deny") return `AgentRun: ${approval.tool} was refused: ${given.by === "message" ? "your message declined it" : "you declined it"}`;
  return `AgentRun: ${approval.tool} ran once you allowed it${text.includes(" They allowed it, and it ran and failed.") ? ", and failed" : ""}`;
}
/** A dollar figure to a millionth, as the timeline's cost.usd is. */
const micro = (usd: number): number => Math.round(usd * 1e6) / 1e6;
/** How many tries a raised run's follow-up gets, and the waits between them, before the run fails with why. */
const CONTINUE_TRIES = 3;
const CONTINUE_RETRY_MS = [1_000, 3_000];
/** How many of the refused request's least a run paused at its cap is offered on top of what was taken (suggestedCap). */
export const SUGGESTED_RAISE_FACTOR = 10;
/** The raise a run paused at its cap is offered: what the cap counted as taken plus SUGGESTED_RAISE_FACTOR times the
 *  refused request's least, rounded up to a whole dollar, and always above the cap (the next dollar above it, if not),
 *  so a PATCH with it is a raise. */
export const suggestedCap = (cap: number, spentUsd: number, needsUsd: number): number => {
  // A hair under, so a sum a float puts just past a whole dollar (3.0000000000000004) stays that dollar.
  const up = Math.ceil(spentUsd + SUGGESTED_RAISE_FACTOR * needsUsd - 1e-9);
  // Above the cap as a raise must be (by more than CAP_TOLERANCE, takeRaise), so a PATCH with it is always taken.
  return up > cap + CAP_TOLERANCE ? up : Math.floor(cap + CAP_TOLERANCE) + 1;
};
/** A run paused at its cap waits on a raise: its cap, what the cap counted as taken and the least the refused request
 *  needs (its refusal's mark; none from a store written before it kept them), the raise it is offered (suggestedCap),
 *  the refusal's words, and when it came (its error row's time). The figures are as the cap counts them, never rounded.
 *  What was taken is the store's spend once its process is gone (`spentNow`), when that is lower: the refusal counted
 *  requests still answering at what it held for them, and they have settled. */
const budgetPending = (run: Run, spentNow?: number): Pending | undefined => {
  const said = pausedAt(run);
  const cap = run.meta.max_cost_usd;
  if (said === undefined || cap === undefined) return undefined;
  const r = run.capRefusal;
  const spent = r && spentNow !== undefined ? Math.min(r.spentUsd, spentNow) : r?.spentUsd;
  // Shown as cost.usd is (to a millionth of a dollar), the suggestion from the figures as the cap counts them.
  const figures = r && spent !== undefined ? { spent_usd: micro(spent), needs_usd: micro(r.needsUsd), suggested_cap_usd: suggestedCap(cap, spent, r.needsUsd) } : {};
  return { kind: "budget", cap_usd: cap, ...figures, said, at: meaningful(run.rows)?.timestamp ?? run.updatedAt };
};
/** The row a run shows while Claude Code installs for it (claude-sdk.ts), since `at`. */
const installRow = (at: string): TimelineEvent => ({ id: "harness:installing", timestamp: at, created_at: at, kind: "phase", summary: INSTALLING_CLAUDE, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: null });

/** The waiting row of a run paused at its cap, after the refusal's error row: "Waiting for you to raise the cap", and no
 *  more: the refusal's words are the pause's (pending.said), which a client shows once, as its banner. */
const BUDGET_WAITING = "Waiting for you to raise the cap";
function withPaused(rows: readonly TimelineEvent[]): TimelineEvent[] {
  const at = rows.findLastIndex((row) => row.kind === "error");
  if (at < 0) return [...rows];
  // The refusal's own marker (`paused`, servedError) stays on the refusal's row: the waiting row is no refusal.
  const { paused: _marker, ...error } = rows[at]!;
  const paused: TimelineEvent = { ...error, id: `${error.id}:paused`, kind: "waiting", summary: BUDGET_WAITING, text: BUDGET_WAITING, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null };
  return [...rows.slice(0, at + 1), paused, ...rows.slice(at + 1)];
}
/** An import's answer, the one row reading of an answer left: its records hold no turn's end (it ran elsewhere), so its
 *  last meaningful row is its answer when that row is one, a final answer's or a text row's. */
const importAnswerOf = (rows: readonly TimelineEvent[]) => {
  const last = meaningful(rows);
  return last?.kind === "final_answer" || last?.kind === "text_block" ? last : undefined;
};
const usageOf = (rows: readonly TimelineEvent[]) => rows.findLast((r) => r.kind === "usage");
/** The run's cost from its usage row: null when a response's cost is unknown, 0 before any request. */
export const costOf = (rows: readonly TimelineEvent[]): number | null => {
  const usage = usageOf(rows);
  return usage ? (usage.usage?.usd ?? null) : 0;
};
/** Whether `row` carries a paid tool's charge counted here: `tool`'s alone when given, every other tool's with `others`
 *  (chargedTool: a charge's own `phase` row, or a browser call's row its charges fold into). */
const chargeOf = (row: TimelineEvent, tool: string | undefined, others: boolean): boolean => {
  const charged = chargedTool(row);
  return charged !== undefined && (tool === undefined || (others ? charged !== tool : charged === tool));
};
/** What a run's paid tools charged (`tool`'s alone, when given; every other tool's with `others`), from the same rows its
 *  cost is read from: each charge's line carries it (`usage` on a `phase` row), and a browser call's row what its charges
 *  came to; null when one is unknown. A call still marked, in flight or cut, is no charge here. */
export const toolCostOf = (rows: readonly TimelineEvent[], tool?: string, others = false): number | null =>
  rows.reduce<number | null>((sum, row) => (!chargeOf(row, tool, others) ? sum : sum === null || row.usage!.usd === null ? null : sum + row.usage!.usd), 0);
/** What a run's paid tools are known to have charged (`tool`'s alone, when given; every other tool's with `others`): each
 *  charge's line that names its cost, a charge of unknown cost adding nothing (a browser call's row, what is known of it). */
export const knownToolCostOf = (rows: readonly TimelineEvent[], tool?: string, others = false): number =>
  rows.reduce((sum, row) => (!chargeOf(row, tool, others) ? sum : sum + (row.usage!.usd ?? row.usage!.so_far_usd ?? 0)), 0);
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
/** The whole text of the run's newest answer with text, paid for: an assistant message's, else its newest answer row's. */
const lastAnswer = (run: Run) => run.turns.newestText ?? run.rows.findLast((r) => r.kind === "final_answer" && r.agent_label !== LEARNING_LABEL)?.text ?? null;
/** A row's store entry, from its id (`<conversation>:<entry>[:...]`). */
const entryOfRow = (id: string) => Number(id.split(":")[1]);
/** The answer of a run that completed: the whole text of the entry its turn's end names, "" when that turn showed no text,
 *  never an earlier turn's. Without such an end (a run still working, a workflow, a store an older server wrote): the
 *  newest answer it gave, whole (lastAnswer); an import's, its last row's when that row is its answer. */
function answerOfRun(run: Run): string | null {
  const end = run.turns.end();
  if (end?.status === "answered") {
    if (end.answer === null) return "";
    // The entry's row when its text was not read here: a final answer's, or a text row's (a stop at the length limit).
    return run.turns.text(end.answer) ?? run.rows.findLast((r) => (r.kind === "final_answer" || r.kind === "text_block") && entryOfRow(r.id) === end.answer)?.text ?? "";
  }
  const imported = run.imported ? importAnswerOf(run.rows) : undefined;
  return lastAnswer(run) ?? imported?.text ?? imported?.summary ?? null;
}
// A run's messages are its message rows (isMessageRow): a person's, and those the server wrote, the message its turn took.
const usersOf = (rows: readonly TimelineEvent[]) => rows.filter(isMessageRow).length;
const lastUserMessage = (rows: readonly TimelineEvent[]) => rows.findLast(isMessageRow)?.id;
// A row's place in the store: its entry's id. The store mints conversation and entry ids from one counter, so entry ids
// order rows across conversations and the conversation is no part of the order.
const placeOf = (id: string) => Number(id.slice(id.lastIndexOf(":") + 1));
/** Whether the turn a stop ended is still where the run stands: no message shown is newer than the stop's. By order,
 *  never by a count or by the stopped message itself, which a compaction can take off the rows. */
export const stoppedAt = (meta: { stopped_at?: string; stopped_after?: number }, rows: readonly TimelineEvent[]): boolean => {
  if (meta.stopped_at === undefined) return meta.stopped_after !== undefined && meta.stopped_after === usersOf(rows);
  const at = placeOf(meta.stopped_at);
  return !rows.some((r) => isMessageRow(r) && placeOf(r.id) > at);
};
const stopped = (run: Run) => stoppedAt(run.meta, run.rows);
/** The words of the cap's refusal for room an agentic run stands paused at: its newest message's turn ended on it (cap.ts
 *  roomRefusal: what is left of its cap cannot buy the next request's least, which a higher cap would send), and nothing
 *  came since. The run then waits for its cap to be raised (input_required, `pending.kind` budget), never failed; a
 *  refusal no cap fixes (an unknown spend, no price) still fails it (decide). Undefined for any other run. */
const refusedAt = (run: Run): string | undefined => {
  if (run.kind !== "agentic" || run.cancel || run.submitted > 0 || run.turns.open > 0 || stopped(run)) return undefined;
  const end = run.turns.end();
  return end?.status === "failed" ? roomRefusal(end.error) : undefined;
};
/** The pause a run stands at, by its refusal's own start mark (its entry), so no row shown after it moves it; a store
 *  with no such mark keys it to the refusal's row. Undefined when it stands at no refusal for room. */
const pauseOf = (run: Run): string | undefined => {
  if (refusedAt(run) === undefined) return undefined;
  if (run.capMark !== undefined) return `mark:${run.capMark}`;
  const row = meaningful(run.rows)?.id;
  return row === undefined ? undefined : `row:${row}`;
};
/** Its cap was raised since the refusal it stands at (a raise names that pause): it waits for its follow-up then, not
 *  for a raise (input_required, idle). */
const raisedSince = (run: Run): boolean => {
  const pause = pauseOf(run);
  return pause !== undefined && run.meta.cap_raised?.some((raise) => raise.pause === pause) === true;
};
/** The follow-up a raise of the pause it stands at asked for and that has not gone yet: one per pause. */
const continuationOf = (run: Run): NonNullable<RunMeta["cap_continue"]> | undefined => {
  // A run that has ended, or is ending (its follow-up's tries spent: failRaised, a cancel), sends none any more.
  if (run.outcome || run.finishing || run.cancel) return undefined;
  const pause = pauseOf(run);
  const next = run.meta.cap_continue;
  return pause !== undefined && next?.pause === pause && !next.sent ? next : undefined;
};
/** A process by its pid and start ticks (Linux /proc; the pid alone elsewhere): a pid used again is another process. */
function processIdentity(pid: number | undefined): string | undefined {
  if (pid === undefined) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return `${pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
  } catch {
    return String(pid);
  }
}
const pausedAt = (run: Run): string | undefined => (raisedSince(run) ? undefined : refusedAt(run));
/** Raised at the pause it stands at, and that raise's follow-up still to go (continuationOf): the run goes on without a
 *  person, once the follow-up opens its next process (resumeRaised). */
const raisedToGo = (run: Run): boolean => raisedSince(run) && continuationOf(run) !== undefined;
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
  // A tool call parked for approval (tool-gate.ts) waits for the person; once answered, its process acts on it.
  if (run.kind === "agentic" && run.submitted === 0 && !run.working) {
    if (waitingApproval(run)) return { status: "input_required", state: "waiting" };
    if (actingOn(run)) return { status: "working", state: "working" };
  }
  // Every message's turn is over and the newest one's ended interrupted, with no stop of the person's saying so (the
  // harness ended it on its own): the run waits for the person, as after a stop, never working for good.
  if (run.kind === "agentic" && run.submitted === 0 && run.turns.end()?.status === "interrupted") return { status: "input_required", state: "idle" };
  // Paused at its cap: it waits for the cap to be raised. Raised, it is queued while the raise's follow-up is still to go
  // (raisedToGo: from the moment the raise is taken, through its paused process's let-go and the follow-up's tries), since
  // nothing waits on a person; for a message only if that follow-up will not go.
  if (refusedAt(run) !== undefined) return pausedAt(run) !== undefined ? { status: "input_required", state: "waiting" } : raisedToGo(run) ? { status: "queued", state: "working" } : { status: "input_required", state: "idle" };
  if (run.working) return { status: "working", state: "working" };
  if (meaningful(run.rows)?.kind === "waiting") return { status: "input_required", state: "waiting" };
  return { status: "working", state: "idle" };
}

/** The trigger a serve.json says started its run, as read back: `{id, firing_key}`, or null. */
function triggerOf(meta: Partial<RunMeta> | null): RunTrigger | null {
  const trigger = meta?.trigger as unknown;
  return isObject(trigger) && typeof trigger.id === "string" && typeof trigger.firing_key === "string" ? { id: trigger.id, firing_key: trigger.firing_key } : null;
}

/** The waits between carry backs that found the store busy, and a hook called at each such refusal. */
export type CarryBackRetry = { delaysMs?: readonly number[]; onBusy?: (runId: string, attempt: number) => void };
/** How a run is asked to start: its input and title, its effort and cap, and what puts its files in its work/. `origin`:
 *  the store's key for what asked (an Idempotency-Key's, a trigger's firing): a key that already started a run gets that
 *  run. `trigger`: the trigger and firing that started it. */
export type StartOptions = { input: Json; title: string; place: Place; effort?: string; maxCostUsd?: number; trigger?: RunTrigger; inputs?: (work: string) => Promise<unknown>; origin?: RunOrigin };

/** `token` is the server's own: no run's process sees it. */
/** `maxRuns`: the most runs with a live process at once; `settleRetryMs`: how often a carry back the store refused is
 *  tried again; `readyTimeoutMs`: how long a request to a run waits for its door (a run's first message, sent by its
 *  start, always waits READY_TIMEOUT_MS); `log` takes a run's start and end (print.ts). */
export type RunsOptions = { /** claude-agent's install of Claude Code (claude-sdk.ts ClaudeInstall): a run on claude-agent waits for it before it launches. Absent, none is waited for. */ claudeInstall?: { readonly installed: boolean; needed(): Promise<boolean>; ensure(): Promise<void> }; /** What a run's Docker box reaches, as the server resolved it (run-box.ts boxNetworkOf): the list, or none. Absent, none. */ dockerAllow?: readonly string[] | "none"; /** On a Mac, the server's proxy container's volume a run's Docker box mounts (box-egress-vm.ts). */ dockerVolume?: string; agents: Agents; token: string; /** The server's saved tool keys, read by name for its runs alone (secrets.ts). */ storedKeys?: StoredKeys; /** The server's saved MCP servers (mcp-servers.ts): a run's pin and its credentials come from them at each launch. */ mcpServers?: McpServerSource; documents?: string; doorTokenFile: string; doorToken: string; /** The test switches a run's process gets (server.ts fauxEnvOf): empty outside tests. */ fauxEnv?: NodeJS.ProcessEnv; runBoxes?: BoxProvider; /** The server's Daytona provider, with its key: remote boxes are made, seeded, pulled and destroyed with it, here alone (box-relay.ts). */ remoteBoxes?: BoxProvider; /** Daytona's API and the same key, for what the provider does not do: a kept box's idle stop, and its wake at a start (daytona-api.ts). */ remoteApi?: DaytonaApi; /** The server's VM box provider, with its client: a VM run's box is made, seeded, pulled and ended with it, here alone, as a Daytona one is (box-relay-vm.ts); it has no network. */ vmBoxes?: BoxProvider; /** A VM box's limits (run-box.ts RemoteLimits), from the box settings. */ vmLimits?: RemoteLimits; /** The relay's VM half, which lets go of a run's programs at its end. */ vmRelay?: { drop(runId: string): void }; /** The hosts a remote box may reach (run-box.ts boxAllowOf); `none`, or absent, for none. */ boxAllow?: readonly string[] | "none"; /** Called once, with the provider's refusal's code and words, when it cannot keep that list here: from then on each remote box is made with no network. */ onNoBoxList?: (code: string, message: string) => void; toolSettings?: () => ToolSettingsMap; /** Whether anyone can answer a tool call's approval here (accounts on); false, the run's gate refuses each ask (tool-gate.ts). */ approvers?: boolean; drainTimeout?: string; carryBackRetry?: CarryBackRetry; maxRuns?: number; box?: { host: BoxHost; quarantine: Quarantine }; settleRetryMs?: number; readyTimeoutMs?: number; reflectTimeoutMs?: number; gradeTimeoutMs?: number; /** The grader's model (`--grade-model`), before AGENTRUN_SERVE_GRADE_MODEL and the strong tier (grade.ts gradeModelOf). */ gradeModel?: string; /** How much of what a run learned its instructions hold, in bytes (`--learning-budget`, learning.ts learnedOf). */ learningBudget?: number; log?: (event: string, fields: Record<string, string | number>) => void; notify?: RunNotify; learning?: LearningMode; /** Each agent's saved sign-ins (sign-ins.ts): absent, no run gets one. */ signIns?: SignIns; /** The secrets this server makes and keeps sealed while it runs (each webhook trigger's), read at each check, so a rotation is seen at once: what a run's learning refuses and cuts, as it does the saved keys. */ ownSecrets?: () => readonly string[] };
/** Told of a run's moment each time it is seen (webhooks.ts' emit, which queues each one once): a wait it reached, and an
 *  end once the agent store has it. `marker` names the moment (the person's turn it waits at, the end's time), the same
 *  when another server sees it again. It says what came of it: `unsaved`, not in the outbox on disk yet. */
export type RunNotify = (event: (typeof RUN_EVENTS)[number], run: RunNotice & { status: Status }, marker: string) => Emitted;

/** Why a message that may not answer a person's question is not sent. */
export const WAITS_ON_A_PERSON = "The run is waiting on a person.";

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

/** Seams for tests, each unset in a server: `personsTurn` holds a person's turn just after its origin went. */
export const runsTestHooks: { personsTurn?: (runDir: string) => Promise<void> | void } = {};

export class Runs {
  private readonly runs = new Map<string, Run>();
  /** The last entry each run's database reads have seen (run-db.ts): a read behind it is never shown. */
  private readonly reads = new MonotonicReads();
  /** The disk the runs' folders are on (disk.ts): on this machine, the data directory's own. */
  private get disk(): DiskAdapter {
    return (this.#disk ??= localDisk(this.options.agents.dir, this.store));
  }
  #disk: DiskAdapter | undefined;
  /** Each workflow revision's workflow, by revision id, as a graph read it: a revision never changes. */
  private readonly workflows = new Map<string, unknown>();
  /** What decides the secrets each revision's runs are handed (needsOf), by revision id: read once, from the revision the
   *  run is pinned to, never from a request. The keys themselves are read at each launch (keysFor). */
  private readonly needs = new Map<string, RunNeeds>();
  /** Every run's graph as served, part by part (servedGraph): one LRU by bytes across runs (graph-served.ts PartCache). */
  private readonly graphCache = new PartCache(GRAPH_CACHE_BYTES);
  private readonly adopting = new Map<string, Promise<Run>>();
  /** The hosts this server's next remote box asks for: the setting's, until the provider cannot keep a list here, then none. */
  private remoteAllow: readonly string[] | "none" | undefined;
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
  /** When this server took the data root (one server a root): a run started since is its own, never one to recover. */
  private readonly bootedAt = new Date().toISOString();
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
  /** A test's seam (startServe's `beforeReopenLaunch`): awaited by a reopen after the run reads open again and before its
   *  launch, so a test can hold a reopen there. */
  beforeReopenLaunch?: (runId: string) => Promise<void> | void;
  /** A test's seam (startServe's `onRunLoad`): told each run read in from its store, its timeline with it. */
  onRunLoad?: (runId: string) => void;
  /** A test's seam (startServe's `beforeSubmit`): awaited by a message before it goes to the run's door. */
  beforeSubmit?: (runId: string, content: string) => Promise<void> | void;
  /** A test's seam (startServe's `beforeMetaSave`): awaited before a run's serve.json is written; one that throws fails
   *  the write, as a full disk would. */
  beforeMetaSave?: (runId: string, meta: Readonly<RunMeta>) => Promise<void> | void;
  /** A test's seam (startServe's `messageOrigin`): the origin a message sent through the messages route carries. */
  messageOrigin?: (runId: string, content: string) => MessageOrigin | undefined;

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
    this.onRunLoad?.(row.id);
    const dir = runDirIn(this.options.agents.dir, row.agent, row.id);
    const stored = (await readJson(join(dir, RUN_META))) as Partial<RunMeta> | null;
    const trigger = triggerOf(stored);
    const meta: RunMeta = {
      title: typeof stored?.title === "string" ? stored.title : "",
      created_at: typeof stored?.created_at === "string" ? stored.created_at : row.startedAt,
      ...(isObject(stored?.input) ? { input: stored.input } : {}),
      ...(typeof stored?.effort === "string" ? { effort: stored.effort } : {}),
      ...(typeof stored?.max_cost_usd === "number" ? { max_cost_usd: stored.max_cost_usd } : {}),
      // Each raise of its cap, and the follow-up a stopped server never sent, which the next sends (resumeRaised).
      ...(Array.isArray(stored?.cap_raised) ? { cap_raised: stored.cap_raised as NonNullable<RunMeta["cap_raised"]> } : {}),
      ...(isObject(stored?.cap_continue) ? { cap_continue: stored.cap_continue as unknown as NonNullable<RunMeta["cap_continue"]> } : {}),
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
      ...(isObject(stored?.approvals) ? { approvals: stored.approvals as Record<string, ApprovalAnswer> } : {}),
      ...(trigger ? { trigger } : {}),
    };
    // A turn's origin a server before this one set is not known to be the turn running now: it goes.
    await rm(join(dir, TURN_ORIGIN_FILE), { force: true }).catch(() => undefined);
    // A seed copy a server went down during is taken back before anything holds the run: its relaunch, a settle, a
    // follow-up (learning-run.ts onLoad).
    if (stored) await this.learning.onLoad(row, dir, meta, () => writeWhole(join(dir, RUN_META), `${JSON.stringify(meta)}\n`));
    const known = await this.options.agents.revision(row.agent, row.revision);
    const run = this.blank(row, dir, meta, known?.version ?? 0, harnessOfBody(known?.revision.body ?? {}), known ? await toolingOf(known.revision) : undefined, known?.revision);
    this.runs.set(row.id, run);
    run.launching = existsSync(join(dir, RUN_LAUNCHING));
    run.notSetUp = row.state === "running" && !isObject(stored?.input);
    // The process its row names, when it lives on: an earlier server's, serving the run or still opening it.
    const adopted = this.holder(run);
    const lives = adopted !== undefined && adopted.pid !== process.pid && holderLives(adopted);
    // An ended run is ended before its rows are read, so they never make it a wait: a last row that asks is no notice.
    if (row.state !== "running") run.outcome = STATUS_OF[row.state];
    // Only a store no live process holds is opened: released, or left by a process that is gone.
    if (row.state !== "running" || !lives) await this.storeWhenFree(run);
    if (row.state !== "running") {
      // An ended run's one read is done: no guard is kept for it.
      this.reads.forget(row.id);
      run.endedAt = row.endedAt;
      // An ended run the store kept no cost for has an unknown cost, never $0.
      run.costUsd = row.costUsd ?? null;
      // A workflow run's decisions' cost too: an unknown one keeps the run's unknown after a restart. Unread, it is unknown.
      if (run.kind === "workflow") await this.readDecisionCost(run).catch(() => void (run.decisionCost = null));
      if (row.importedFrom) run.imported = row.importedFrom;
      if (run.outcome === "failed") run.error = errorOfRow(row, meta);
      run.settled = true;
    } else {
      // A cancel a server took and could not carry back before it went: its mark is written first (cancel()), so it is
      // the run's end, as it was from its 202 on, whatever the turn it cut reads.
      if (run.kind === "agentic" && existsSync(join(dir, RUN_CANCELLED))) {
        run.cancel = true;
        run.finishing = "cancelled";
      }
      if (lives) {
        // A server that died between saving a stop and its abort reaching the run leaves the turn working.
        run.finishStop = run.meta.stopped_at !== undefined || run.meta.stopped_after !== undefined;
        this.adoptProcess(run, adopted);
        // Its cancel's SIGTERM may never have gone: it is let go now, its turn aborted first.
        if (run.cancel) void this.abortTurn(run).then(() => this.terminate(run));
      }
      // One a server left in its end-of-run turn finishes with its job's outcome, and its turn, when its process lives,
      // is asked again (learning-run.ts).
      this.learning.onAdopt(run, lives);
    }
    this.refresh(run);
    return run;
  }

  private blank(row: Pick<RunRow, "id" | "agent" | "revision" | "kind">, dir: string, meta: RunMeta, version: number, harness: string, tooling?: Tooling, revision?: Revision): Run {
    return {
      id: row.id, agentId: row.agent, kind: row.kind, revision: row.revision, version, dir, meta, log: new RowLog(this.clock), rows: [], harness,
      working: false, submitted: 0, users: new Set(), live: new Set(), cancel: false, relaunches: 0, settled: false, settles: 0, updatedAt: meta.created_at, turns: new Turns(),
      ...(tooling ? { tooling } : {}),
    };
  }

  /** Writes the run's serve.json as it is when its turn comes; then tells learning what it now holds (the ledger's line
   *  once the run's learning ended). */
  /** Writes the run's serve.json, after any write already under way: `meta`, a copy its caller publishes to run.meta
   *  only once this resolves (a raise, takeRaise), else run.meta, each as it stands when the write starts. */
  private saveMeta(run: Run, meta?: () => RunMeta): Promise<void> {
    run.saving = (run.saving ?? Promise.resolve()).catch(() => undefined).then(async () => {
      // A copy is built as its write starts, from run.meta as it stands then.
      const written = meta ? meta() : run.meta;
      const { learning } = written;
      await this.beforeMetaSave?.(run.id, written);
      await writeWhole(join(run.dir, RUN_META), `${JSON.stringify(written)}\n`);
      await this.learning.onSaved(run, learning);
    });
    return run.saving;
  }

  /** The process that holds the run, as its row's claim names it (run-holder.ts); undefined for none, or the server. */
  private holder(run: Run): RunHolder | undefined {
    return this.holderView(run).holder;
  }

  /** Who holds the run, as its row says and the processes show: `unknown` when the row or the process listing cannot be
   *  read, which a caller never takes for a holder that is gone. */
  private holderView(run: Run): { holder?: RunHolder; unknown: boolean } {
    try {
      const holder = holderOfClaim(run.id, this.store.runClaim(run.id));
      return holder === undefined ? { unknown: false } : holderState(holder) === "unknown" ? { holder, unknown: true } : { holder, unknown: false };
    } catch {
      return { unknown: true };
    }
  }

  /** The door a live run serves, from its row's holder: a process that lives (its pid, of the same start, on this boot)
   *  and a loopback address it named. */
  private doorOf(run: Run): string | undefined {
    let door = run.child && run.door !== undefined ? run.door : undefined;
    if (door === undefined) {
      const holder = this.holder(run);
      if (holder?.door === undefined || !holderLives(holder)) return undefined;
      door = holder.door;
    }
    const url = URL.parse(door);
    return url?.protocol === "http:" && isLoopback(url.hostname) ? url.origin : undefined;
  }

  /** The record the run's process keeps in its own store (pi-durable-disk RUN_STATUS_TABLE: its status, `detail` and
   *  `wakeAt`), read lock-free; null when it has none or it cannot be read. */
  private async runRecord(run: Run): Promise<Json | null> {
    const file = this.storeFile(run);
    if (!existsSync(file)) return null;
    try {
      return await readRunDb(file, this.live(run), (db) => {
        const row = db.prepare(`SELECT record FROM ${RUN_STATUS_TABLE} WHERE id = 1`).get() as { record: string } | undefined;
        return row ? (JSON.parse(row.record) as Json) : null;
      });
    } catch {
      return null;
    }
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
    const read: Array<{ conversation: number; entry: Json }> = [];
    const submissions: Json[] = [];
    // A fresh read-only, lock-free read (run-db.ts), after any take-back's checkpoint of this run: one at a time.
    const last = await this.runDb(run, () => readRunDb(file, this.live(run), (db) => {
      // A read made again (its file changed during it, run-db.ts) starts from none.
      read.length = 0;
      submissions.length = 0;
      const rows = run.kind === "workflow" || atEnd
        ? db.prepare("SELECT conversation_id, record FROM entries ORDER BY id").iterate()
        : db.prepare("SELECT conversation_id, record FROM entries WHERE conversation_id = (SELECT MIN(conversation_id) FROM entries) ORDER BY id").iterate();
      for (const row of rows as Iterable<{ conversation_id: number; record: string }>) read.push({ conversation: Number(row.conversation_id), entry: JSON.parse(String(row.record)) as Json });
      // pi's settlements of the person's messages, the root's (turns.ts): its turns' ends.
      if (run.kind === "agentic") {
        const inputs = db.prepare("SELECT record FROM submissions WHERE conversation_id = (SELECT MIN(conversation_id) FROM entries) ORDER BY id").all() as { record: string }[];
        for (const row of inputs) submissions.push(JSON.parse(String(row.record)) as Json);
      }
      return Number((db.prepare("SELECT max(id) AS last FROM entries").get() as { last: number | null }).last ?? 0);
    }));
    // An older view of the file than one read before is never shown: what was read before stays.
    try {
      this.reads.accept(run.id, last);
    } catch (error) {
      if (error instanceof BehindReadError) return warn(run.id, `a read of its store was behind one before (${error.message}); the earlier read stands`);
      throw error;
    }
    const root = read.reduce((min, r) => Math.min(min, r.conversation), Infinity);
    const entries = read.flatMap((r) => (run.kind === "workflow" || r.conversation === root ? [r.entry] : []));
    if (run.kind === "workflow") {
      const { durableDecisions } = await import("@parcha/agentrun-pi/durable");
      // Decisions it cannot read add no rows, and leave the served usage row's total unknown, as the run's cost read
      // does (readDecisionCost): never its model nodes' total alone.
      try { run.decisions = durableDecisions(file, { unlocked: true }); } catch { run.decisions = null; }
      run.llmRead = llmAnswers(await readNodeLog(run.dir)).length;
    }
    // Its decision requests count with its model requests: each receipt's tokens, or unmetered without them.
    if (atEnd) run.metrics = runMetricsWithDecisions(read.map((r) => r.entry) as never, run.kind === "workflow" ? (run.decisions ?? []) : []);
    run.working = false;
    noteTurns(run, entries, submissions);
    noteApprovals(run, entries);
    this.take(run, timelineOf(redactGateMessages(entries, this.redactor(run)) as never, { settled: true, path: rowPaths(run.dir), redact: this.redactor(run) }));
  }

  /** `act` on run `run`'s database, after every earlier one on it: its reads and its take-back's checkpoint never meet. */
  private runDb<T>(run: Run, act: () => Promise<T>): Promise<T> {
    const next = (run.dbQueue ?? Promise.resolve()).then(act);
    run.dbQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** The server takes run `run` back once no process holds it: its claim's epoch is bumped, with the server as its
   *  holder (the disk's revoke, disk.ts), and only then its database checkpointed (run-db.ts), its WAL emptied into the
   *  database file. A run whose process still lives is not taken. A take-back that fails (the agent store held by another
   *  writer, or not writable) only warns: the run settles all the same, its database read with its WAL, and the next
   *  settle or start takes it back. */
  private async takeBack(run: Run): Promise<void> {
    if (this.live(run)) return;
    await this.runDb(run, async () => {
      // Tried once: a store another writer holds is not waited on, since what follows (a relaunch, a message) must not wait
      // on it; the next take-back tries again. No checkpoint before the claim is the server's.
      await this.disk.revoke(run.id);
      const file = this.storeFile(run);
      if (await stat(file).catch(() => null)) await checkpointRunDb(file, this.live(run));
    }).catch((error: Error) => warn(run.id, `it was not taken back (${error.message}); its database keeps its WAL until the next take-back`));
  }

  /** New rows in: into the log, then the run's status, then whatever the status asks for. */
  /** `keep`: rows that stay served though `rows` no longer holds them (the live path's committed rows). */
  private take(run: Run, rows: TimelineEvent[], keep?: (id: string) => boolean): void {
    run.rows = withOverCap(labelled(run.meta.reflect, withApprovals(withAsks(rows.filter((r) => !QUIET.test(r.id))), run, this.redactor(run))), run.meta.max_cost_usd);
    // Counted by id: a snapshot of a compacted conversation shows fewer user messages than before, which is not more
    // messages waiting, so a count of rows would leave the run working forever.
    const arrived = run.rows.filter((r) => isMessageRow(r) && !run.users.has(r.id));
    for (const row of arrived) run.users.add(row.id);
    run.submitted = Math.max(0, run.submitted - arrived.length);
    run.keep = keep;
    this.show(run);
    this.refresh(run);
  }

  /** The approval rows as the run's answers say them now (a stop or a cancel withdraws a call, an answer settles one),
   *  shown at once: an answer takes no new rows. */
  private restate(run: Run): void {
    if (!run.approvals?.size) return;
    run.rows = withApprovals(run.rows.filter((row) => row.kind !== APPROVAL_ROW), run, this.redactor(run));
    this.show(run);
  }

  /** The run's rows into its log, as served: a workflow run's decisions and the run's learning row are the served view's
   *  only, never the run's own rows, which its cost and its answer are read from. */
  private show(run: Run): void {
    // The decisions' rows are the served view's only: the run's own rows, which its cost is read from, stay its model nodes'.
    // Their summary and text are redacted whole, then cut (decision-rows.ts): a provider's error can quote a held key.
    const own = run.decisions === undefined ? run.rows : withDecisions(run.rows, run.decisions, this.decisionShown(run));
    // An error row reads as the run's error does (errorWords): a refused key in plain words, no loopback address.
    const served = own.map((row) => (row.kind === "error" ? this.servedError(run, row) : row));
    // A run paused at its cap says so after the refusal, as the row its status reads.
    const said = pausedAt(run);
    const rows = said === undefined || run.meta.max_cost_usd === undefined ? served : withPaused(served);
    // While its harness installs, the run says so (a phase row of the server's, gone once it is installed).
    const installing = run.installRow ? [...rows, installRow(run.installRow)] : rows;
    if (run.log.sync(withLearning(installing, run.meta.learning, this.learning.shown()), run.keep)) run.updatedAt = new Date().toISOString();
  }

  /** A live process: the child this server started, or one an earlier server started that still serves the run. */
  private live(run: Run): boolean {
    return Boolean(run.child || run.orphan);
  }

  /** How an agentic run ends: over its cap, or as the turn of the person's newest message ended (turns.ts), once every
   *  message the run took has had its turn. Undefined while one is open, or when the run stopped, waits, or its turn
   *  ended interrupted (the run then waits for the person), or while its records name no message (a live process of an
   *  older server: the run's next process writes its turn's end as it opens). Never from the order of its rows, or from
   *  when its door said idle. A workflow run ends when its workflow does. */
  private decide(run: Run): { outcome: Status; error?: RunError; abort?: boolean } | undefined {
    if (run.kind === "workflow") return undefined;
    // A cancel ends the run cancelled, by its settle (whatever the turn it cut wrote, a cost over the cap too): nothing
    // ends it otherwise meanwhile, so its first terminal status is its last. The cancel has aborted the turn already.
    if (run.cancel) return undefined;
    const cap = run.meta.max_cost_usd;
    const cost = costOf(run.rows);
    if (cap !== undefined && cost !== null && cost > cap + FIT_TOLERANCE) return { outcome: "failed", abort: true, error: { code: SPEND_CAP_REACHED, message: `The run cost $${cost.toFixed(4)}, $${(cost - cap).toFixed(4)} over its cap of $${cap}.`, retryable: false } };
    if (run.submitted > 0) return undefined;
    if (run.turns.open > 0 || stopped(run)) return undefined;
    // A tool call waits for a person's approval, or for its answer to be acted on: the run goes on after it.
    if (waitingApproval(run) || actingOn(run)) return undefined;
    const end = run.turns.end();
    if (end?.status === "answered") return { outcome: "completed" };
    if (end?.status !== "failed") return undefined;
    const message = end.error ?? "The run failed.";
    // The cap's refusal for room pauses the run instead (pausedAt): a raise sends what was refused.
    if (roomRefusal(message) !== undefined) return undefined;
    // The cap's refusal in the run's process (cap.ts); a provider error with this exact prefix would read as one too.
    // Its code is `spend_cap_reached: `, or with a note after it (`spend_cap_reached (out of budget): `, cap.ts); the message is
    // the words after it.
    const capped = CAP_REFUSAL_PREFIX.exec(message);
    if (capped) return { outcome: "failed", error: { code: SPEND_CAP_REACHED, message: message.slice(capped[0].length), retryable: false } };
    // The provider's content filter stopped the answer (content-filter.ts): moderated, in words a person can act on.
    if (contentFiltered(message)) return { outcome: "failed", error: { code: MODERATED, message: CONTENT_FILTER_WORDS, retryable: false } };
    return { outcome: "failed", error: { code: "run_failed", message: this.errorWords(run, message) ?? message, retryable: false } };
  }

  /** A run's error as a person reads it, in its error box and on its Timeline row alike: a refused key in plain words
   *  (plainKey), else the harness's text with no loopback address (withoutLoopback: Codex names serve's own proxy). */
  private errorWords(run: Run, text: string | undefined): string | undefined {
    return text ? this.shown(run, this.plainKey(run, text) ?? text) : text;
  }

  /** An error row as served: its summary and text in errorWords' terms. The run's own rows, which its status reads, keep
   *  what the harness said. */
  private servedError(run: Run, row: TimelineEvent): TimelineEvent {
    // A refusal for room pauses the run (pausedAt), and its row says so (`paused`): the request was not sent, and a raise
    // goes on, so it reads as a pause, never as a failure. Every refusal for room pauses, so the row keeps it after a raise.
    const paused = roomRefusal(row.text ?? undefined) !== undefined ? { paused: true as const } : {};
    const plain = this.plainKey(run, row.text ?? undefined);
    if (plain) {
      const words = this.shown(run, plain);
      return { ...row, summary: words, text: words, ...paused };
    }
    return { ...row, ...(row.summary ? { summary: this.shown(run, row.summary) } : {}), ...(row.text ? { text: this.shown(run, row.text) } : {}), ...paused };
  }

  /** What serve shows of a run's error text, for every run kind: no held secret (redacted, key-refusal.ts' one rule) and
   *  no loopback address. */
  private shown(run: Run, text: string): string {
    return withoutLoopback(redacted(text, this.refusedValues(run)));
  }

  /** A run's answer as serve serves it: no held secret, never cut (redactedAnswer). Loopback addresses stay: an answer is
   *  the model's own words, and a local address there can be what the person asked about. */
  private servedAnswer(run: Run, text: string | null): string | null {
    return text ? (this.servedOnce(run, "answer", text, (values) => redactedAnswer(text, values)) as string) : text;
  }

  /** A workflow run's output as serve serves it: each string in it as servedAnswer, its shape kept. */
  private servedOutput(run: Run, output: unknown): unknown {
    return output === null ? null : this.servedOnce(run, "output", output, (values) => redactedOutput(output, values));
  }

  /** `redact(values)` over the values `run` holds, read once per input and held value set: a console polls a run's
   *  view, and an answer a run was made to write can be large. The run keeps the one it served last, of each slot; a key
   *  saved or deleted changes the values' digest, and the next view redacts again. */
  private servedOnce(run: Run, slot: "answer" | "output", input: unknown, redact: (values: string[]) => unknown): unknown {
    const values = this.refusedValues(run);
    const keys = digestOf([...values].sort());
    const last = run.served?.[slot];
    if (last && last.keys === keys && last.input === input) return last.out;
    const out = redact(values);
    run.served = { ...run.served, [slot]: { keys, input, out } };
    return out;
  }

  /** A workflow run's graph as serve serves it: its nodes, each decision and each call (its input, output and error) with
   *  no held secret, by its answer's rule (redactedOutput), and only then cut: a map item's label at 200 characters, a
   *  call's error at 2000, and a text stored cut (a decision's state past 64 KB, an error logged cut) less its last 6
   *  times the longest held value plus 16 characters, where a value the stored cut split would sit. The view comes whole
   *  from graph-view.ts's lock-free read at each poll, so a key saved since the last poll is found in it too. Each part is
   *  served once per content and held value set: a console polls the graph while the run goes. */
  private servedGraph<T extends { nodes: unknown; decisions: unknown[]; effects: unknown[] }>(run: Run, view: T): T {
    const values = this.refusedValues(run);
    const keys = digestOf([...values].sort());
    const once = (kind: PartKind, value: unknown): unknown => {
      const at = `part:${keys}:${kind}:${digestOf(value)}`;
      const kept = this.graphCache.get(at);
      if (kept !== undefined) return kept;
      const out = servedPart(kind, value, values);
      this.graphCache.set(at, out, Buffer.byteLength(JSON.stringify(out) ?? ""));
      return out;
    };
    return { ...view, nodes: once("nodes", view.nodes), decisions: view.decisions.map((value) => once("decision", value)), effects: view.effects.map((value) => once("effect", value)) };
  }

  /** The timeline's redaction of `run`'s error rows and of what a tool's result shows (its summary and preview), applied
   *  before a row is cut (timelineOf's `redact`), so a cut never leaves the head of a key. Every such cut is within
   *  redacted()'s SHOWN, so its window holds. */
  /** How a run's decision rows show a text (decision-rows.ts Shown): the run's redactor, and as many characters held back
   *  from a text stored cut as a held value takes in its widest form. */
  private decisionShown(run: Run): { redact: (text: string) => string; hold: number } {
    const values = this.refusedValues(run);
    return { redact: (text) => redacted(text, values), hold: 6 * values.reduce((most, value) => Math.max(most, value.length), 0) + 16 };
  }

  private redactor(run: Run): (text: string) => string {
    return (text) => redacted(text, this.refusedValues(run));
  }

  /** The last line of the run process's log (lastLogLine) for a failure's message, with every value its errors never
   *  show cut out: its process may have written a secret or its sign-in's pointer there. */
  private async lastLine(run: Run): Promise<string> {
    return this.redactor(run)(await lastLogLine(run));
  }

  /** Every secret value `run`'s errors never show, as learning's checker holds them (learning-run.ts refused): this
   *  server's secrets wherever its launcher put them and the keys saved on it, what each launch handed the run, and the
   *  server's own tokens. */
  private refusedValues(run: Run): string[] {
    return [...hostSecrets(process.env, this.options.storedKeys), ...(run.handed ?? []), this.options.token, this.options.doorToken];
  }

  /** A run's model error in a person's words when its provider refused the run's key (key-refusal.ts): the key its
   *  harness's route sends, by this server's settings and keys, and no secret's value. */
  private plainKey(run: Run, text: string | undefined): string | undefined {
    // A workflow's nodes run on their own tiers' models, and its error row does not say which one failed: naming the
    // default tier's key could name the wrong one, so its error keeps the provider's own words.
    if (!text || run.kind === "workflow") return undefined;
    const env = withSecrets(process.env, "all", this.options.storedKeys);
    return keyRefusal(text, runKeyOf(env, run.harness ?? run.tooling?.harness, run.tooling?.model), this.refusedValues(run));
  }

  /** Records the run's status as a change when it moves, and lets go of a live run that answered, failed or is over its cap. */
  /** What a run paused at its cap has spent once its process is gone: its store's spend as the cap reads it (spentIn),
   *  read once per pause (its refusal's row). None while its process lives, nor when the store says unknown or cannot
   *  be read: the refusal's own figure stands then. */
  private spentNow(run: Run): number | undefined {
    const mark = meaningful(run.rows)?.id;
    if (mark === undefined || !run.capRefusal || this.live(run) || pausedAt(run) === undefined) return undefined;
    // One read per pause, and a failed read again after a while, never kept until a restart.
    if (run.capSpent?.mark !== mark || (run.capSpent.usd === null && Date.now() - (run.capSpent.at ?? 0) > 30_000)) {
      let usd: number | null = null;
      try {
        usd = spentIn(this.storeFile(run));
      } catch (error) {
        warn(run.id, `its store's spend was not read (${(error as Error).message}); its refusal's figure stands`);
      }
      run.capSpent = { mark, usd, at: Date.now() };
    }
    return run.capSpent.usd ?? undefined;
  }

  /** The run's live process, by its pid and start ticks (processIdentity). */
  private liveIdentity(run: Run): string | undefined {
    return processIdentity(run.child?.pid ?? run.orphan);
  }

  private refresh(run: Run): void {
    this.mark(run);
    // A run whose cap was raised at its pause goes on once the process paused there is gone (resumeRaised): with no
    // process, or one another launch started (a server stopped between that launch and its message: the door takes the
    // message once, by its id). Never while one waits to be tried again.
    const next = continuationOf(run);
    const letting = next !== undefined && next.paused !== undefined && this.live(run) && this.liveIdentity(run) === next.paused;
    if (next && run.resuming === undefined && !this.closing && !run.cancel && !run.finishing && !run.outcome && !letting) void this.resumeRaised(run, next);
    if (!this.live(run) || run.finishing || run.outcome) return;
    const end = this.decide(run);
    // Paused at its cap, its process is let go: it waits without one, holding no place, until its cap is raised. Once
    // per pause (its refusal's row): SIGTERM drains and releases it, and the settle that follows leaves it waiting. A
    // raised one's paused process is let go too (a server started again finds it so).
    if (!end && (pausedAt(run) !== undefined || letting) && run.parked !== waitMark(run)) {
      run.parked = waitMark(run);
      this.terminate(run);
    }
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
    if (run.child) return void run.child.kill("SIGTERM");
    // An adopted process only once its identity is confirmed (its pid, of the same start, on this boot): a pid another
    // process took over gets no signal, and one that cannot be checked keeps its stop pending, tried again every second
    // until it can be (said once for each reason), never sent unidentified. The timer keeps no server up, and close()
    // clears it.
    const holder = run.orphanHolder;
    if (holder === undefined) return;
    const state = holderState(holder);
    if (state === "alive") {
      run.stopWaits = undefined;
      // Already exited (ESRCH) or another user's pid now (EPERM): nothing to stop.
      return void signal(holder.pid, "SIGTERM");
    }
    if (state === "gone" || this.closed) return;
    if (!run.stopWaits) warn(run.id, `its stop waits: its process ${holder.pid} cannot be identified (the process listing cannot be read); it is sent once it can be`);
    run.stopWaits = true;
    clearTimeout(run.stopPending);
    run.stopPending = setTimeout(() => {
      run.stopPending = undefined;
      try {
        if (run.orphanHolder === holder && !this.closed) this.terminate(run);
      } catch (error) {
        warn(run.id, `its stop is not sent: ${(error as Error).message}`);
      }
    }, 1_000).unref();
  }

  /** Supervise a run process an earlier server started, its row's holder: follow its door, and settle the run once the
   *  process is gone, or once the record it keeps in its store has said for EXIT_AFTER_RELEASE_MS that it let go while
   *  the process lives on. */
  private adoptProcess(run: Run, holder: RunHolder): void {
    const pid = holder.pid;
    run.orphan = pid;
    run.orphanHolder = holder;
    this.reportedBack(run);
    this.connect(run);
    let releasedAt: number | undefined;
    let reading = false;
    let failedWith: string | undefined;
    // A holder that never says where it serves within the ready time is fenced: killed, then taken over.
    const doorBy = Date.now() + (this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const done = (released: boolean) => {
      if (run.orphan !== pid) return;
      clearInterval(timer);
      run.orphan = undefined;
      run.orphanHolder = undefined;
      void this.settle(run, null, !holderLives(holder) && !released);
    };
    const timer = setInterval(() => {
      if (run.orphan !== pid) return clearInterval(timer);
      if (reading) return;
      reading = true;
      const lives = holderLives(holder);
      void this.runRecord(run)
        .then(async (now) => {
          const released = RELEASED.has(String(now?.status));
          if (!lives) return done(released);
          // Its door, when the server that launched it went before it read the line: the one this process keeps in its
          // own store (the record names its pid), under the epoch its row holds.
          if (this.doorOf(run) === undefined) {
            const claim = this.store.runClaim(run.id);
            const own = isObject(now?.holder) && now.holder.pid === holder.pid ? now.holder : undefined;
            const serve = own?.serve;
            // Proven with the nonce the launching server kept on the row, as that server would have.
            const proven = now?.generation === claim.epoch && typeof serve === "string" && holder.nonce !== undefined && (await verifyDoor(serve, holder.nonce, this.headers(run)));
            if (proven) {
              this.nameHolder(run, claim.epoch, { ...holder, door: serve as string });
              this.connect(run);
            } else if (Date.now() > doorBy) {
              warn(run.id, `its process ${pid} named no door within ${(this.options.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000} s; it is killed and the run taken over`);
              killHolder(holder);
              return;
            }
          }
          if (!released) return;
          releasedAt ??= Date.now();
          if (Date.now() - releasedAt < EXIT_AFTER_RELEASE_MS) return;
          warn(run.id, `its process ${pid} released the run ${EXIT_AFTER_RELEASE_MS / 1000} s ago and has not exited; reading its store anyway`);
          done(true);
        })
        // A poll that fails (the agent store held by another writer, a listing that cannot be read) changes nothing: the
        // run stays watched, and the next tick looks again.
        .catch((error: Error) => {
          // Said once for each reason, not at every tick.
          if (error.message !== failedWith) warn(run.id, `its watch of process ${pid} looks again: ${error.message}`);
          failedWith = error.message;
        })
        .finally(() => void (reading = false));
    }, 500);
    timer.unref();
  }

  /** At start: every run the store says is running is read, supervised when its process lives, carried back when it
   *  already ended, and opened again when its process went before it ended. */
  /** Every run's box let go that nothing owns, and every run cgroup no record names: once, before any run of this server
   *  starts, opens again or relaunches, so a box or cgroup being made is never swept away. */
  private sweepOnce(): Promise<void> {
    const { box, runBoxes, remoteBoxes, vmBoxes } = this.options;
    if (!box && !runBoxes && !remoteBoxes && !vmBoxes) return Promise.resolve();
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
      const agentOf = new Map(rows.map((row) => [row.id, row.agent]));
      const dirOf = (id: string) => runDirIn(this.options.agents.dir, agentOf.get(id) ?? "", id);
      const pulledFirst = (boxes: BoxProvider, daytona: boolean) => (id: string, boxId: string) =>
        pullRemoteBox(boxes, { id, dir: dirOf(id) }, boxContext(REMOTE_SYNC_MS)).then(
          () => true,
          async (error: Error) => {
            warn(id, `its box is kept: its pull failed (${error.message}); the next start tries again`);
            await this.keepBox(id, boxId, daytona);
            return false;
          },
        );
      if (vmBoxes) {
        await sweepRunBoxes(vmBoxes, (id) => ended.has(id), boxContext(REMOTE_SYNC_MS), pulledFirst(vmBoxes, false)).catch((error: Error) => warn("-", `its start's sweep of Modal sandboxes failed (${error.message}); the next start sweeps again`));
      }
      if (remoteBoxes) {
        // A box kept at a run's end that Daytona stopped once idle is woken first, so this sweep pulls it like the rest.
        const api = this.options.remoteApi;
        if (api) await wakeBoxes(api, (id) => ended.has(id)).catch((error: Error) => warn("-", `the stopped boxes of ended runs were not woken (${error.message}); the next start tries again`));
        await sweepRunBoxes(remoteBoxes, (id) => ended.has(id), boxContext(REMOTE_SYNC_MS), pulledFirst(remoteBoxes, true)).catch((error: Error) => warn("-", `its start's sweep of remote run boxes failed (${error.message}); the next start sweeps again`));
      }
      if (!box) return;
      const settled = await sweepBoxes(box.host, box.quarantine, rows.map((row) => ({ id: row.id, dir: runDirIn(this.options.agents.dir, row.agent, row.id) })));
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
    // The relay's hold on the run's programs (box-relay-vm.ts) ends with the run, whatever becomes of its box: one kept
    // for a later pull, or one whose destroy failed, still lets them go, and their output with them.
    this.options.vmRelay?.drop(run.id);
    const remote = remotePlace(place);
    const boxes = remote ? this.remoteOf(place) : this.options.runBoxes;
    if (!boxes) return;
    // Its background processes first (background.ts), so each one's exit code and whole log are in work/ before the
    // pull and the destroy. A bound box with no work/background/ started none, and costs no command here. A failure only
    // warns: the destroy ends them all the same.
    if (remote || existsSync(join(run.dir, "work", BACKGROUND_DIR))) {
      try {
        const ended = await endBackground(boxes, { [RUN_LABEL]: run.id }, boxContext());
        if (ended) this.options.log?.("background_ended", { run: run.id, ended });
      } catch (error) {
        warn(run.id, `its background processes were not ended before its box goes (${(error as Error).message}); destroying the box ends them`);
      }
    }
    if (remote) {
      try {
        await this.pullBox(run, true);
      } catch (error) {
        if (error instanceof PullIncomplete && error.lasting) {
          await this.keepBox(run.id, error.box, place.box === "daytona");
          return warn(run.id, `its box is kept, not destroyed: ${error.message}; what came back is in its files, and the box stops after ${KEPT_AUTOSTOP_MINUTES} idle minutes, its files kept for the next start's pull`);
        }
        const why = `its box's last pull failed (${(error as Error).message})`;
        if (ending) throw new PullPending(why);
        return warn(run.id, `${why}; its box is kept for its end`);
      }
    }
    try {
      await destroyRunBoxes(boxes, run.id, boxContext());
      // The box's egress proxy directory (box-egress.ts), its socket the run's process left: nothing binds it now.
      await removeEgressDir(run.id).catch(() => undefined);
    } catch (error) {
      warn(run.id, `its box was not destroyed (${(error as Error).message}); the next start sweeps it`);
    }
  }

  /** A remote box kept because its copy back is not whole: said in the log, and set to stop once idle, so it costs its
   *  disk alone until the next start's pull (which wakes it) or its lifetime. */
  private async keepBox(runId: string, boxId: string, daytona = true): Promise<void> {
    this.options.log?.("box_kept", { run: runId, box: boxId, reason: "pull_incomplete" });
    // A VM box keeps its lifetime alone: the provider has no idle stop to set.
    const api = daytona ? this.options.remoteApi : undefined;
    if (api) await keepWhenIdle(api, boxId).catch((error: Error) => warn(runId, `its kept box was not kept from deletion or set to stop when idle (${error.message})`));
  }

  /** What wakes run `runId`'s remote box when Daytona stopped or paused it (a class that pauses when idle, while the run
   *  waited for a person): how many it woke. */
  private wakeOf(runId: string, place?: Place): (() => Promise<number>) | undefined {
    // Only Daytona stops or pauses a box: a VM box that ended is made again.
    const api = place?.mode === "sandbox" && place.box !== "daytona" ? undefined : this.options.remoteApi;
    return api && (() => wakeBoxes(api, (id) => id === runId));
  }

  /** Pulls run `run`'s remote box into its work/, after any pull already running: at a turn's end in the background (a
   *  failure warns, and the next pull brings it), or awaited (`strict`: a failure throws). */
  private pullBox(run: Run, strict = false): Promise<void> {
    const place = run.meta.place;
    const boxes = place && remotePlace(place) ? this.remoteOf(place) : undefined;
    if (!boxes || !place) return Promise.resolve();
    // After any pull already running, and after the box's making and seed when one is under way.
    const pull = Promise.all([run.pulling, run.boxing?.catch(() => undefined)]).then(async () => {
      const pulled = await pullRemoteBox(boxes, run, boxContext(REMOTE_SYNC_MS), this.wakeOf(run.id, place));
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
    return Boolean(run && !run.outcome && run.meta.place && remotePlace(run.meta.place) && this.remoteOf(run.meta.place));
  }

  /** The server's provider of a remote place's boxes: the VM box's, or Daytona's. */
  private remoteOf(place: Place): BoxProvider | undefined {
    return place.mode === "sandbox" && place.box === VM_PROVIDER.id ? this.options.vmBoxes : this.options.remoteBoxes;
  }

  /** Run `id`'s remote box, found or made and seeded: what its process asks the relay for at its first tool call. */
  ensureBox(id: string): Promise<{ id: string; made: boolean }> {
    const run = this.runs.get(id);
    const place = run?.meta.place;
    const boxes = place && this.remoteOf(place);
    if (!run || !place || !boxes || !this.servesBox(id)) return Promise.reject(new Error(`no run ${id} of this server is in a remote box`));
    // The VM box has no network (its provider's host list cannot be read back), and takes the box limits.
    const vm = place.mode === "sandbox" && place.box === VM_PROVIDER.id;
    // After any pull of this run's box, so a seed never meets a pull.
    run.boxing ??= (run.pulling ?? Promise.resolve())
      .then(() =>
        ensureRemoteBox(boxes, run, boxContext(REMOTE_SYNC_MS), vm ? { allow: "none", ...(this.options.vmLimits ? { limits: this.options.vmLimits } : {}) } : {
          wake: this.wakeOf(run.id, place),
          allow: (this.remoteAllow ??= this.options.boxAllow ?? "none"),
          onNoList: (code, message) => {
            if (this.remoteAllow === "none") return;
            this.remoteAllow = "none";
            this.options.onNoBoxList?.(code, message);
          },
        }),
      )
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
    if (!this.options.box && !this.options.runBoxes && !this.options.remoteBoxes && !this.options.vmBoxes) return;
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
    // Only what an earlier server left: a store slow to answer here must not hand back a run a create is setting up now.
    const rows = (await this.options.agents.request(() => this.store.listRuns())).filter((row) => row.startedAt < this.bootedAt);
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
    if (status === "input_required") this.notice(run, "run.needs_input", waitMark(run), { kind: state !== "waiting" ? "stopped" : waitingApproval(run) ? "approval" : pausedAt(run) !== undefined ? "budget" : "question" });
  }

  /** Tells webhooks.ts (`notify`) of a moment of the run under `marker`: a wait it reached (mark), or an end the agent store
   *  has (settle, persistLater, reopen). What it already queued it queues no more. */
  private notice(run: Run, event: "run.needs_input" | "run.ended", marker: string | undefined, pending?: { kind: "question" | "approval" | "stopped" | "budget" }): Emitted | undefined {
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
        const door = this.doorOf(run);
        if (door) this.reportedBack(run);
        if (door && run.kind === "workflow") {
          if (!run.working && !run.outcome) {
            run.working = true;
            this.refresh(run);
          }
        } else if (door) await this.follow(run, door, abort.signal).catch(() => undefined);
        if (abort.signal.aborted || (!this.live(run) && !this.doorOf(run))) break;
        await sleep(run.kind === "workflow" ? 500 : 200);
      }
      if (run.feed === abort) run.feed = undefined;
    })();
  }

  private async follow(run: Run, door: string, signal: AbortSignal): Promise<void> {
    // A file a call names by its absolute path in the run's workspace (a harness's CLI sends one) reads by its name there.
    const reducer = timelineReducer({ path: rowPaths(run.dir), redact: this.redactor(run), redactLive: (text) => redactedLive(text, this.refusedValues(run)) });
    // `inputs=1`: the snapshot carries pi's newest input submissions, the settlements its turns end on (turns.ts).
    const up = await fetch(new URL(`/events?inputs=1&skip=${encodeURIComponent(REFLECT_REQUEST)}`, door), { signal, headers: { ...this.headers(run), accept: "text/event-stream" } });
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
        // The settlements of pi's turns: each a submission event in the commit of its turn's last entry, and the door's
        // snapshot of them on a (re)connect (pi-durable-disk's `inputs`), read as their whole state.
        const submissions = events.flatMap((e) => (e.type === "submission" && e.record !== undefined ? [e.record] : []));
        const inputs = events.find((e) => e.type === "snapshot" && Array.isArray(e.inputs))?.inputs as unknown[] | undefined;
        const entries = events.flatMap((e) => (Array.isArray(e.entries) ? e.entries : e.entry !== undefined ? [e.entry] : []));
        noteTurns(run, entries, submissions, inputs);
        noteApprovals(run, entries);
        const redact = this.redactor(run);
        reducer.apply(events.map((e) => (Array.isArray(e.entries) ? { ...e, entries: redactGateMessages(e.entries, redact) } : e.entry !== undefined ? { ...e, entry: redactGateMessages([e.entry], redact)[0] } : e)) as never);
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

  /** The install `run`'s harness waits for before it launches (claude-agent's Claude Code, claude-sdk.ts), or undefined
   *  when it waits for none. One per run at a time, every run's on the server's one install: while that runs the run
   *  shows it (installRow). A failed install ends the run failed, with the install's words, which name the command that
   *  installs it by hand. */
  private harnessReady(run: Run): Promise<boolean> | undefined {
    const install = this.options.claudeInstall;
    if (run.harness !== "claude-agent" || !install || install.installed) return undefined;
    if (run.installing) return run.installing;
    // Counted as holding its place until its launch (takePlace); a run whose process lives holds one already.
    if (!this.live(run)) run.waitsInstall = true;
    const installing = (async () => {
      if (!(await install.needed())) return true;
      run.installRow = new Date().toISOString();
      this.show(run);
      try {
        await install.ensure();
        return true;
      } catch (error) {
        // A server that stops mid-install leaves the run as it is, for the next server to install and launch.
        if (this.closing) return false;
        run.submitted = 0;
        if (!(run.outcome || run.finishing || run.cancel)) {
          run.error = { code: "run_failed", message: (error as Error).message, retryable: false };
          run.finishing = "failed";
          void this.settle(run, 1, true);
        }
        return false;
      } finally {
        run.installRow = undefined;
        this.show(run);
      }
    })().finally(() => void (run.installing = undefined));
    run.installing = installing;
    return installing;
  }

  /** The door of a run that is not finished, starting or waking its process when it is not live. */
  private async ensureLive(run: Run, timeoutMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS): Promise<string> {
    let deadline = Date.now() + timeoutMs;
    // A run brought up by a request (a message before the start's recovery reached it) waits for the sweep as well.
    await this.sweepOnce();
    await this.pinNeeds(run);
    // And for its files, which its start copies before it launches it: within the time left.
    const copying = run.preparing;
    if (copying) {
      await untilDeadline(copying, deadline);
      if (run.preparing === copying) throw new ApiError("unavailable", "the run's files are still being copied into its workspace", { retry_after_ms: 1000 }, { "retry-after": "1" });
    }
    // And for its harness, installed on first use (claude-sdk.ts): its own time, bounded by the install's, before the
    // ready time starts. A failed install ended the run, which the loop says.
    const installing = this.harnessReady(run);
    if (installing) {
      await installing;
      deadline = Date.now() + timeoutMs;
    }
    for (let launched = false; ; await sleep(100)) {
      // Checked first: a settle may have ended the run, and nothing starts a run that ended.
      if (run.outcome || run.finishing || run.cancel) throw this.finished(run);
      const door = this.doorOf(run);
      if (door) return door;
      if (!this.live(run)) {
        // A process that just went is being settled: its run may be over, so nothing starts it again before that.
        if (run.settles > 0) {
          // Within the time left: a settle waiting on a busy store must not hold this caller past its deadline.
          await untilDeadline(run.settling, deadline);
          if (Date.now() > deadline) throw this.notUp(run);
          continue;
        }
        // A launch waiting on its claim has no process yet, and tries again on its own (launch): waited for, within the time
        // left, never launched a second time nor read as a process that exited.
        if (run.claimWait) {
          if (Date.now() > deadline) throw this.notUp(run);
          continue;
        }
        if (launched) throw new ApiError("internal", `the run's process exited before it served: ${await this.lastLine(run)}`);
        // A holder another server started that lives on (its door still to come): waited for, never launched over.
        const holder = this.holder(run);
        const fresh = holder !== undefined && holder.pid !== process.pid && holderLives(holder);
        // A run already going is never refused a place, but one whose harness this host's memory never holds (after a
        // restart on a smaller one) is not started: said, never tried.
        const never = fresh ? undefined : neverFits(run.harness, this.memory);
        if (never) throw new ApiError("agent_not_runnable", never, { details: { unbound: [], missing: {}, harness: run.harness } });
        // Its sign-in pinned only for a launch: a run whose process still serves keeps the one it was handed.
        if (!fresh) {
          await this.pinSignIn(run);
          if (run.outcome || run.finishing || run.cancel || this.live(run)) continue;
          this.launch(run);
          launched = true;
        }
      }
      if (Date.now() > deadline) throw this.notUp(run);
    }
  }

  /** A request's 503 for a run that did not come up in time, naming why, as far as this server can tell: the process
   *  listing cannot be read (who holds it is unknown), the agent store is busy (its claim waits on it), or the run never
   *  opened (its process is up, its door not serving). */
  private notUp(run: Run): ApiError {
    const why = run.claimWait
      ? (run.claimWaitWhy ?? "its claim could not be written yet")
      : this.holderView(run).unknown
        ? "the process listing cannot be read, so who holds it is not known"
        : "its process has not opened it yet (its door does not serve)";
    return new ApiError("unavailable", `the run did not come up in time: ${why}`, { retry_after_ms: 1000 }, { "retry-after": "1" });
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
    const door = this.doorOf(run);
    if (door) await fetch(new URL("/abort", door), { method: "POST", headers: this.headers(run, true), body: "{}", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }

  /** One request to the door of a run whose process lives, never waking it (toDoor wakes no run that is finishing): again
   *  while it opens or parks. `turnOrigin`: who sent a turn this request sends (learning-run.ts's REFLECT_ORIGIN), kept in
   *  the run's directory before it goes, where the tool gate reads it (tool-gate.ts NOTE_ONLY_TEXT); a person's message
   *  removes it. */
  private async toLiveDoor(run: Run, path: string, body?: Json, turnOrigin?: TurnOrigin): Promise<Json | null> {
    if (turnOrigin) await (run.originWrite = writeWhole(join(run.dir, TURN_ORIGIN_FILE), `${JSON.stringify({ origin: turnOrigin })}\n`));
    for (const deadline = Date.now() + 30_000; ; await sleep(200)) {
      if (!this.live(run) || run.cancel) throw new Error("the run's process is gone");
      const door = this.doorOf(run);
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

  /** `run`'s pinned MCP tools: read from its directory, or at its first launch made from the granted `tools` and the
   *  servers saved now, and written before its process starts. Undefined when it grants none. */
  private mcpPin(run: Run, tools: readonly string[] | undefined): McpPin | undefined {
    const file = join(run.dir, MCP_PIN);
    if (existsSync(file)) {
      const pinned = JSON.parse(readFileSync(file, "utf8")) as McpPin;
      // A pin made before meta tools were refused (mcp-meta.ts) is checked at each launch, never rewritten: one it holds
      // refuses the launch, as making the pin does.
      for (const [server, { url, tools: listed }] of Object.entries(pinned)) {
        for (const tool of listed) if (metaToolOf(url, tool.name)) throw new Error(`mcp:${server}/${tool.name} can't be granted: ${META_REASON}`);
      }
      return pinned;
    }
    if (!tools?.some((name) => name.startsWith("mcp:")) || !this.options.mcpServers) return undefined;
    const pin = mcpPinOf(tools, this.options.mcpServers);
    if (!Object.keys(pin).length) return undefined;
    writeDurableSync(file, JSON.stringify(pin));
    return pin;
  }

  /** The saved sign-in the run's browser starts from (sign-ins.ts), resolved before each launch: made at the vendor when
   *  its agent has none, and leased to this run to save unless another run of the agent holds the lease. One that cannot
   *  be had (the vendor not answering, a seal key changed) leaves its browser signed out, said in its log. */
  private async pinSignIn(run: Run): Promise<void> {
    // Its browser as this launch will find it (launch: a vendor whose key is gone since is unavailable, and gets none).
    const browser = run.meta.tool_plane && recheckPlane(run.meta.tool_plane, withSecrets(process.env, "all", this.options.storedKeys)).browser;
    const signIns = this.options.signIns;
    run.signIn = browser && signIns ? ((await signIns.forRun(run.agentId, run.id, browser).catch((error: Error) => void warn(run.id, `its browser starts signed out: ${error.message}`))) ?? undefined) : undefined;
    // Never shown in its errors, from now on: a server started since its launch has handed it nothing yet.
    if (run.signIn && run.signIn.ref.length >= MIN_SECRET) (run.handed ??= new Set()).add(run.signIn.ref);
  }

  /** Lets go of the save lease the run holds on its agent's sign-in, if any: at once when its process let its sessions go
   *  (`clean`), else by the gone rule (sign-ins.ts). */
  private async releaseSignIn(run: Run, clean = true): Promise<void> {
    run.signIn = undefined;
    await this.options.signIns?.release(run.agentId, run.id, run.dir, clean).catch((error: Error) => warn(run.id, `its sign-in's save lease is not let go: ${error.message}`));
  }

  private launch(run: Run, followUp = run.followUpOpen === true): void {
    // A launch that waited on its claim lets go of the place it kept (takePlace) as it tries again: from here it is a live
    // run again, or not one at all.
    run.claimWait = undefined;
    run.claimWaitWhy = undefined;
    run.notOpened = undefined;
    if (run.child || this.closing || run.cancel || run.outcome || run.finishing || run.preparing || run.installing) return;
    // Every launch of a claude-agent run (its start, a recovery after a restart, a relaunch, a wake) waits for Claude Code
    // to be installed whole first (harnessReady), holding its place meanwhile (waitsInstall), and launches once it is:
    // never a process that would load a missing SDK.
    const installing = this.harnessReady(run);
    if (installing) return void installing.then((installed) => installed && this.launch(run, followUp));
    run.waitsInstall = undefined;
    // Taken by this launch only: a later launch (a relaunch after its process went) opens the run as any other.
    run.followUpOpen = undefined;
    // Its secrets go over fd 3, written whole and closed as it starts; it reads them first (secrets.ts). Each launch path
    // reads its revision's needs first (pinNeeds); one that did not hands no tool key. Which keys, from the keys this
    // server holds now (its launcher's and the saved ones, never its environment, which under the launcher holds none),
    // in this same turn as the handover, so a key saved with no restart counts at the next launch, and none can change
    // in between.
    const served = withSecrets(process.env, "all", this.options.storedKeys);
    const needs = this.needs.get(run.revision);
    const handed = needs ? keysFor(needs, served) : NO_TOOL_KEYS;
    // Its MCP servers: the tools it grants, pinned at its first launch in its directory (mcp-gateway.ts), and the
    // credentials of those servers alone, read now, on the same pipe.
    let pin: McpPin | undefined;
    try {
      pin = this.mcpPin(run, needs?.tools);
    } catch (error) {
      // A granted tool that cannot be pinned refuses the launch in words, rather than a run without the tool.
      run.error = { code: "run_failed", message: (error as Error).message, retryable: false };
      run.finishing = "failed";
      void this.settle(run, 1, true);
      return;
    }
    const mcp = pin && this.options.mcpServers ? mcpCredentialsOf(pin, this.options.mcpServers) : undefined;
    // And its saved sign-in, on the same pipe after them (pinSignIn): a pointer its browser opens, never in its environment.
    const secrets = Buffer.concat([handover(handed, this.options.storedKeys), ...(mcp ? [mcpHandover(mcp)] : []), ...(run.signIn ? [handoverSignIn(run.signIn)] : [])]);
    // What it was handed, for the check of what its end-of-run turn writes (learning-run.ts).
    this.learning.onLaunch(run, handed, mcpSecretValues(mcp ?? {}));
    // And for what its errors show (refusedValues): each value handed, kept past a key's rotation.
    run.handed ??= new Set();
    for (const name of handed) {
      const value = secret(name, this.options.storedKeys);
      if (value && value.length >= MIN_SECRET) run.handed.add(value);
    }
    for (const value of mcpSecretValues(mcp ?? {})) if (value.length >= MIN_SECRET) run.handed.add(value);
    if (run.signIn && run.signIn.ref.length >= MIN_SECRET) run.handed.add(run.signIn.ref);
    const env: NodeJS.ProcessEnv = {
      ...childEnv(process.env, this.options.token),
      // The run's box's network, as the server resolved it: never the setting itself, which the run's process ignores.
      [RUN_BOX_ALLOW_ENV]: this.options.dockerAllow === undefined || this.options.dockerAllow === "none" ? "none" : this.options.dockerAllow.join(","),
      // And, on a Mac, its proxy's volume: set always, empty for none, so a stale value in the server's own environment
      // never reaches a run.
      [RUN_BOX_VOLUME_ENV]: this.options.dockerVolume ?? "",
      [SECRETS_FD_ENV]: "3",
      [SECRETS_LEN_ENV]: String(secrets.length),
      // The server's data (dataOfRun: a run's directory is on its agent's disk under it): claude-agent loads Claude Code
      // from its harnesses.
      [DATA_ENV]: dataOfRun(run.dir),
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
    delete env[DEFAULT_MODEL_ENV];
    const harness = run.tooling?.harness ?? DEFAULT_HARNESS;
    const defaultModel = run.tooling && !run.tooling.model && harness !== "claude-agent" ? hostModel(served, "default", harness) : undefined;
    if (defaultModel) env[DEFAULT_MODEL_ENV] = defaultModel;
    // Opened for a person's follow-up to a run whose turn had ended: nothing it resumes was cut (app.ts markResumed).
    delete env[FOLLOW_UP_OPEN_ENV];
    if (followUp) env[FOLLOW_UP_OPEN_ENV] = "1";
    // Its tools' providers (tool-plane.ts): resolved at its first launch from its pinned revision and this server's
    // settings, and kept in its serve.json, so a later change of the settings never changes a run's tools; at a later
    // launch only checked again (a Parallel key gone makes Parallel unavailable, never another provider). A new run's are
    // in the serve.json its start writes (start); resolving here is for a run made before that, whose browser stays
    // Browserbase (keptFromBefore), the vendor it had then, kept as its choice and checked again at each launch like the
    // rest; a vendor's missing-key refusal an earlier server saved reads as that vendor again (keptVendor), saved back. A
    // description with no secret
    // in it, read by the run's process, never by a request. A key saved through the settings API counts as the launcher's
    // does (secrets.ts), so a saved Parallel key makes Parallel available, and a deleted one unavailable at the next launch.
    // A capability set to ask or deny since resolves again (a harness's own search cannot wait for a person). Its first
    // launch, from its start, is told a deny as under ask; a later one is told it denied (relaunchPlane).
    const settings = this.options.toolSettings?.() ?? {};
    const capped = run.meta.max_cost_usd !== undefined;
    const first = run.firstLaunch === true;
    run.firstLaunch = undefined;
    const kept = run.meta.tool_plane ? keptVendor(run.meta.tool_plane) : run.tooling ? keptFromBefore(planeFor(served, run.tooling, settings, { capped })) : {};
    const plane = relaunchPlane(kept, served, run.tooling, settings, { capped, first });
    if (kept !== run.meta.tool_plane && Object.keys(kept).length) {
      run.meta.tool_plane = kept;
      void this.saveMeta(run).catch(() => undefined);
    }
    delete env[TOOL_PLANE_ENV];
    if (Object.keys(plane).length) env[TOOL_PLANE_ENV] = JSON.stringify(plane);
    // No one can approve here (accounts off): the run's gate refuses an ask instead of parking it (tool-gate.ts).
    delete env[NO_APPROVER_ENV];
    if (this.options.approvers === false) env[NO_APPROVER_ENV] = "1";
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
    // The run's claim, for its process: from the epoch its row holds, bumped with the holder named, in one statement (a
    // claim that moved meanwhile is stale, and this launch writes nothing). A holder the row names that still lives (a
    // process an earlier server left that serves no door) is killed first, and the claim waits until it is gone: no
    // process of a lower epoch runs, or commits to the run's store, once the epoch is bumped. A claim that cannot be
    // written (the agent store held, or not writable) launches nothing now, and is tried again, the launch whole, soon at
    // first (CLAIM_RETRY_MS) and then every settle retry, until it is written: a run never stays without a process for
    // want of one.
    let epoch: number;
    const nonce = randomBytes(32).toString("hex");
    try {
      const claim = this.store.runClaim(run.id);
      const held = holderOfClaim(run.id, claim);
      if (held && killHolder(held)) throw new Error(`its holder ${held.pid} still lived; it is killed first`);
      epoch = this.store.claimRun(run.id, LAUNCH_HOLDER, claim.epoch);
      env[RUN_EPOCH_ENV] = String(epoch);
      // Its mark: should the row still name the launch when this server goes, the next one finds the process by it.
      env[RUN_LAUNCH_ENV] = `${run.id}:${epoch}`;

      run.claimTries = undefined;
    } catch (error) {
      // Soon at first (a store another writer holds for a moment), then every settle retry.
      const tries = run.claimTries ?? 0;
      run.claimTries = tries + 1;
      const every = CLAIM_RETRY_MS[tries] ?? this.options.settleRetryMs ?? SETTLE_RETRY_MS;
      // What this launch took goes back, so the next one launches as this one would have.
      if (followUp) run.followUpOpen = true;
      if (first) run.firstLaunch = true;
      run.claimWait = true;
      run.claimWaitWhy = storeBusy(error) ? "the agent store is busy (another writer holds it)" : /cannot be (checked|looked for)/.test((error as Error).message) ? "the process listing cannot be read, so its holder cannot be checked" : (error as Error).message;
      warn(run.id, `its process is not started: its claim was not written (${(error as Error).message}); trying again in ${every / 1000} s`);
      setTimeout(() => {
        if (this.closing) return;
        try {
          this.launch(run);
        } catch (error) {
          warn(run.id, `its process is not started: ${(error as Error).message}`);
        }
      }, every).unref();
      return;
    }
    this.markLaunching(run);
    const log = openSync(join(run.dir, PROCESS_LOG), "a", 0o600);
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", log, "pipe"];
    // The first descriptor after the others: macOS aborts the parent of a spawn with a pipe at 16 or above.
    const keyFd = stdio.length;
    if (handsKey) {
      stdio.push("pipe");
      env[DECISION_KEY_FD_ENV] = String(keyFd);
    }
    // This launch's door nonce, on a pipe of its own, never in an environment (which stays readable by the user's other
    // processes): the process reads it first and closes it, and its door proves it (door-line.ts).
    const nonceFd = stdio.length;
    stdio.push("pipe");
    // A workflow run resumes from its journal when it opens again, so SIGTERM lets it go at once, undrained.
    const drain = run.kind === "workflow" ? "0s" : (this.options.drainTimeout ?? DRAIN);
    // Its own door token, which its door takes and its calls to the box relay carry: no other run's process holds it.
    run.doorToken = ensureRunDoorToken(run.dir);
    const doorTokenFile = join(run.dir, RUN_DOOR_TOKEN);
    const child = spawn(process.execPath, [
      // secrets.ts first, as a preload: the pipe is read and closed before pi-durable-disk's CLI loads or starts anything.
      "--no-warnings=ExperimentalWarning", "--import", SECRETS_MODULE, this.cli, "run", "--dir", run.dir, "--app", this.app,
      "--serve", "0", "--serve-host", "127.0.0.1", "--serve-token-file", doorTokenFile, "--drain-timeout", drain, // key-gate: loopback-rule the door of a run listens on loopback only, for this server
      "--epoch", String(epoch), "--door-nonce-fd", String(nonceFd),
    ], { stdio, env });
    const noncePipe = (child.stdio as unknown as readonly (Writable | null | undefined)[])[nonceFd];
    // A process that dies before it reads the nonce closes the pipe: that is its exit to settle, not an error here.
    noncePipe?.on("error", () => undefined);
    noncePipe?.end(nonce);
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
    run.door = undefined;
    child.once("exit", (code) => {
      if (run.child === child) {
        run.child = undefined;
        run.door = undefined;
      }
      this.reportedBack(run);
      void this.settle(run, code, true);
    });
    child.once("error", () => {
      if (run.child === child) run.child = undefined;
      this.reportedBack(run);
    });
    // Only once the child is wired (its exit and error handled above): the row names the process (its pid, its start and
    // this boot) under the epoch it was given, and its door once it says, on stdout, where it serves: its one line there
    // (pi-durable-disk's run under its host's epoch). A process listing that cannot be read names nothing.
    this.nameHolder(run, epoch, child.pid === undefined ? undefined : withNonce(holderOfProcess(child.pid), nonce));
    // Its door: the first line it prints, before any harness or agent code of it runs, proven with this launch's nonce
    // before it is recorded; no later line is read (door-line.ts).
    if (child.stdout && child.pid !== undefined) {
      const pid = child.pid;
      void firstDoorLine(child.stdout, epoch).then(async (door) => {
        if (door === undefined || !isLoopback(new URL(door).hostname)) return warn(run.id, `its process ${pid} named no loopback door first on stdout; none is recorded`);
        if (!(await verifyDoor(door, nonce, this.headers(run)))) return warn(run.id, `its process ${pid}'s first line named a door that did not answer this launch's nonce; none is recorded`);
        // Recorded once its run serves: a door listens before its run opens, and the run is up only then. One that never
        // serves within the ready time is said once, by its cause, and stopped: its exit settles the run, which opens it
        // again (up to MAX_RELAUNCHES) as for any process that went before the run ended.
        const readyMs = this.options.readyTimeoutMs ?? READY_TIMEOUT_MS;
        const opened = await untilOpened(door, this.headers(run), () => run.child !== child, Date.now() + readyMs);
        if (!opened.opened) {
          if (opened.why === "deadline" && run.child === child) {
            run.notOpened = `its process did not open the run within ${readyMs / 1000} s (its door last answered ${opened.last})`;
            warn(run.id, `its process ${pid} did not open the run within ${readyMs / 1000} s (its door last answered ${opened.last}); it is stopped`);
            // Its launch came through (the server is up): its stop is no launch that took the server down.
            this.reportedBack(run);
            child.kill("SIGKILL");
          }
          return;
        }
        if (run.child === child) run.door = door;
        const holder = holderOfProcess(pid);
        if (holder) this.nameHolder(run, epoch, { ...holder, nonce, door });
      }).catch((error: Error) => warn(run.id, `its door is not recorded: ${error.message}`));
    }
    this.connect(run);
  }

  /** Names `holder` on the run's row under `epoch`, the claim its launch made: a claim that moved on since (a take-back,
   *  a later launch) is left as it is, and a store that is busy is tried again shortly, a few times. */
  private nameHolder(run: Run, epoch: number, holder: RunHolder | undefined): void {
    if (holder === undefined) return;
    const pending = run.naming;
    run.naming = { epoch, holder, tries: 0 };
    // One write at a time per run, of the newest holder: a retry under way takes this one.
    if (pending === undefined) this.writeHolder(run);
  }

  /** Writes the run's newest holder to name (`naming`); a store another writer holds is tried again, soon at first, then
   *  every settle retry, while the process lives and the server runs. */
  private writeHolder(run: Run): void {
    const naming = run.naming;
    if (naming === undefined) return;
    if (this.closed || !holderLives(naming.holder)) return void (run.naming = undefined);
    try {
      this.store.setRunHolder(run.id, naming.epoch, JSON.stringify(naming.holder));
    } catch (error) {
      if (storeBusy(error)) {
        const every = CLAIM_RETRY_MS[naming.tries] ?? this.options.settleRetryMs ?? SETTLE_RETRY_MS;
        naming.tries++;
        setTimeout(() => {
          try {
            this.writeHolder(run);
          } catch (error) {
            warn(run.id, `its holder is not named on its row: ${(error as Error).message}`);
          }
        }, every).unref();
        return;
      }
      if (!(error instanceof AgentHomeError && error.code === "stale")) warn(run.id, `its holder is not named on its row: ${(error as Error).message}`);
    }
    run.naming = undefined;
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
        if (!(storeBusy(error) || error instanceof PullPending || error instanceof HolderUnknown) || this.closing) return warn(run.id, `not settled: ${error.message}; the next start tries again`);
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
    // What the run's process said in its store: a release (its status), and a workflow's end (its detail).
    const record = await this.runRecord(run);
    const released = RELEASED.has(String(record?.status));
    run.letGo = released;
    // Gone unless another live process serves it (its row's holder, which has not released it): a holder that lives
    // but serves no door, or lives on after its release, is taken back, which kills it first (the disk's revoke).
    // This server's own process exited: nothing else holds the run. Any other settle asks the row, and a holder that
    // cannot be told (its row or the process listing unreadable) is never taken for gone: the settle is tried again.
    let door: string | undefined;
    if (!exited && !this.live(run)) {
      const view = this.holderView(run);
      if (view.unknown) throw new HolderUnknown("who holds it cannot be told now (its row or the process listing cannot be read)");
      const other = view.holder !== undefined && view.holder.pid !== process.pid && holderState(view.holder) === "alive" ? view.holder : undefined;
      // A live holder that has not let go and serves no door yet (a launch an earlier server left opening): watched, as
      // at a start, until it serves, goes, or is taken over past the ready time.
      if (other && !released && !run.orphan && !this.doorOf(run)) {
        this.adoptProcess(run, other);
        return;
      }
      door = !released && other ? this.doorOf(run) : undefined;
    }
    const gone = !this.live(run) && !door;
    // Its sign-in's save lease stays with it (below), but no longer than a session it opened could outlive its process.
    if (gone) await this.options.signIns?.markGone(run.agentId, run.id).catch((error: Error) => warn(run.id, `its sign-in's lease is not marked: ${error.message}`));
    // Its metrics are this settle's read, or none: never an earlier end's.
    run.metrics = undefined;
    // Its process gone: the server takes the run back, its database checkpointed, before it reads it.
    if (gone) await this.takeBack(run);
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
    // Even when another live holder still serves the run (!gone: its stop not through yet, kept pending), a cancel ends it
    // here: workflowEnd only reads the run's store lock-free and carries the end back, so it neither waits on nor writes
    // that holder's store, and the holder's exit later finds the run ended.
    if (run.cancel && !reflecting(run)) ended = run.kind === "workflow" ? await this.workflowEnd(run, workflowEnding(record) ?? { status: "stopped" }) : { outcome: "cancelled" };
    else if (run.finishing) ended = { outcome: run.finishing };
    else if (run.notSetUp && gone) {
      run.error = { code: "run_failed", message: "The server went down while it set the run up, before it saved the run's input; the run never started, and a new one can.", retryable: false, details: { reason: SETUP_LOST } };
      ended = { outcome: "failed" };
    } else if (run.launching && gone) {
      run.error = { code: "run_failed", message: "The server went down while it started the run's process, which never came up; it is not started again, since starting it may be what took the server down.", retryable: false, details: { reason: LAUNCH_LOST } };
      ended = { outcome: "failed" };
    } else if (exited && !released && code !== null && code !== 0 && (run.resuming !== undefined || continuationOf(run) !== undefined)) {
      // A raised run's paused process held nothing (its turn had ended at the refusal): its exit without a release, at
      // its drain's end, say, loses nothing, and the raise's follow-up goes (resumeRaised), never a failed run.
      return this.refresh(run);
    } else if (exited && !released && code !== null && code !== 0) {
      run.error = { code: "run_failed", message: `The run's process exited (${code}) without releasing the run: ${await this.lastLine(run)}`, retryable: false };
      ended = { outcome: "failed" };
    } else if (!gone && door) ended = undefined;
    else if (run.kind === "workflow") ended = await this.workflowEnd(run, workflowEnding(record));
    else {
      const end = this.decide(run);
      if (end?.error) run.error = end.error;
      ended = end && { outcome: end.outcome };
    }
    if (!ended) {
      // Work left and no process: opened again. A run that waits for the person waits without one, until a message.
      // A raised run whose follow-up is still to go let its process go as a paused one does: its sign-in's lease goes too.
      const stalled = run.kind === "workflow" || (statusOf(run).status !== "input_required" && !raisedToGo(run));
      // Its sign-in's save lease stays with it until it ends (carryBack), through a relaunch or a restart: a session it
      // opened before its process went may still be live at the vendor, and would write back over another run's. One
      // that let go cleanly to wait for its person released its sessions first, so its lease goes now.
      if (gone && released && !stalled) await this.releaseSignIn(run);
      // A raised run's follow-up, under way or still to go, opens the run's next process itself (resumeRaised): its
      // paused process going is no process lost, and no relaunch is counted for it.
      const continuing = run.resuming !== undefined || continuationOf(run) !== undefined || run.child !== undefined;
      if (!gone || !stalled || this.closing || continuing) return this.refresh(run);
      // Opened again without a place, as a run already going, unless its harness never fits this host (a restart on a
      // smaller one): that run fails with why.
      const never = neverFits(run.harness, this.memory);
      if (!never && run.relaunches < MAX_RELAUNCHES) {
        await this.pinNeeds(run);
        await this.pinSignIn(run);
        return this.relaunch(run);
      }
      run.error = { code: "run_failed", message: never ?? `The run's process went ${MAX_RELAUNCHES + 1} times before the run ended: ${run.notOpened ?? (await this.lastLine(run))}`, retryable: false };
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
    // Lock-free reads of its store, as every server read of a run's database (run-db.ts): nothing made beside it.
    const { state, summary } = await workflowCarry(at, ending, { unlocked: true });
    if (state === "completed") run.meta.output = (await readWorkflowRun(at, { unlocked: true })).output ?? null;
    else if (state === "escalated") {
      const { escalation, escalatedAt } = await readWorkflowRun(at, { unlocked: true });
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
    const paid = durableDecisions(this.storeFile(run), { unlocked: true }).map((row) => row.cost_usd);
    if (paid.length) run.decisionCost = paid.every((cost) => typeof cost === "number") ? (paid as number[]).reduce((a, b) => a + b, 0) : null;
    if (paid.length) run.decisionsPriced = { known: paid.reduce<number>((a, b) => a + (typeof b === "number" ? b : 0), 0), unpriced: paid.filter((cost) => typeof cost !== "number").length };
  }

  /** Ends the run in the agent store, once: how it ended, its cost, a line for the list and its metrics. A store held by
   *  another writer is tried again with backoff; past the last try the run stays unsettled, and the next start carries it back. */
  private async carryBack(run: Run, outcome: Status, state?: Ended, summary?: string): Promise<void> {
    // Its reads ended with its end's read (settleOnce): their guard goes. A follow-up's process starts it again from none.
    this.reads.forget(run.id);
    // Ended, it saves to its agent's sign-in no more; but a process that went without letting its sessions go may have
    // left one live at the vendor, so its lease then ends by the gone rule. One never launched (letGo unset) has none.
    await this.releaseSignIn(run, run.letGo !== false);
    // Its process is gone: its box goes with its end, whatever the end (a follow-up after it gets a fresh box; work/ stays).
    // A remote box's last pull lands first: the end is not recorded until its files are in work/.
    await this.dropBox(run, true);
    // Its end-of-run turn closed, and what the turn wrote set aside before the run reads ended (learning-run.ts).
    await this.learning.beforeSettle(run, outcome);
    const cost = run.decisionCost === undefined ? costOf(run.rows) : costView(run.rows, undefined, run.decisionCost);
    // An unknown cost keeps what it cost so far beside it, for the list row read from the store.
    const soFar = cost === null && !run.imported ? soFarOf(run.rows, run.decisionCost === undefined ? undefined : (run.decisionsPriced ?? null)) : undefined;
    if (soFar) run.meta.cost_so_far = soFar;
    else delete run.meta.cost_so_far;
    const line = summary ?? (outcome === "completed" ? answerOfRun(run) : outcome === "cancelled" ? "cancelled" : run.error?.message);
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
      // A run whose launch waits on its claim (launch) keeps the place it had, nothing else taking it meanwhile, until it is
      // cancelled or ends.
      // So does one that waits for its harness's install (waitsInstall), until that launch, a cancel or its end.
      const holding = [...this.runs.values()].filter((run) => this.live(run) || ((run.claimWait === true || run.waitsInstall === true) && !run.cancel && !run.outcome && !run.finishing));
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
      // A run that waits for its harness's install from here holds its place itself (waitsInstall).
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
    const plane = tooling ? planeFor(withSecrets(process.env, "all", this.options.storedKeys), tooling, this.options.toolSettings?.() ?? {}, { capped: options.maxCostUsd !== undefined, run: true }) : {};
    // A run that learns: its seed read before it is made (learning-run.ts).
    const pin = await this.learning.onStart(entry.agent.id, revision);
    const started = await this.options.agents.request(() => this.store.startRun({ agent: entry.agent.id, revision: revision.id, ...(options.origin ? { origin: options.origin } : {}) })).catch((error) => storeError(error, "revision"));
    // Only another writer of the store gets here first under the same origin: its run is the one asked for, set up by it.
    if (started.existing) return (await this.get(started.runId))!;
    const at = new Date().toISOString();
    const meta: RunMeta = {
      // Shown on the run list and its view: no held secret a person pasted into the message it is taken from.
      title: clip(redacted(options.title.trim().replace(/\s+/g, " "), [...hostSecrets(process.env, this.options.storedKeys), this.options.token, this.options.doorToken]), 80),
      created_at: at,
      input: options.input,
      place: options.place,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.maxCostUsd !== undefined ? { max_cost_usd: options.maxCostUsd } : {}),
      ...(options.trigger ? { trigger: options.trigger } : {}),
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
    await this.pinSignIn(run);
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
    run.firstLaunch = true;
    // A harness installed on first use (claude-agent's Claude Code) is installed first, in the background (launch): the
    // start answers now, and the run shows the install while it waits.
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

  /** One message to the run's door. `origin`: who wrote it when the person did not (a raised cap's follow-up, an
   *  approval's resume), carried to its user entry so the Timeline shows it as the server's (pi-durable-agent's
   *  MessageOrigin); the model reads the same text either way. `answers: false`: the run's door refuses the message
   *  (WAITING) when the run's turn ended on ask_person or a tool call of it waits for its owner's approval (the gate's
   *  park, APPROVAL_ENTRY), and when the run is busy (BUSY), so it is never queued behind a
   *  turn that may end so; decided at the door's admission, past every wait here. */
  private async submit(run: Run, content: string, whenBusy: "steer" | "followUp", requestId: string, readyMs?: number, origin?: MessageOrigin, answers = true): Promise<void> {
    await this.beforeSubmit?.(run.id, content);
    const answer = await this.toDoor(run, "/submit", { requestId, content, whenBusy, ...(origin ? { origin } : {}), ...(answers ? {} : { answers: false, asks: [ASK_TOOL], parks: [APPROVAL_ENTRY] }) }, readyMs);
    if (answer.status === 409 && answer.body?.error === "WAITING") throw new ApiError("not_continuable", WAITS_ON_A_PERSON, { details: { reason: "waiting" } });
    if (answer.status === 409 && answer.body?.error === "BUSY" && !answers) throw new ApiError("rate_limited", "The run is working: a message that may not answer it waits until it is idle.", { retry_after_ms: 5_000, details: { reason: "working" } });
    if (answer.status >= 400) throw new ApiError(answer.status === 409 ? "not_continuable" : "internal", String(answer.body?.message ?? answer.body?.error ?? "the run refused the message"));
  }

  /** Whether the run's harness takes a message mid-turn. */
  private steers(run: Run): boolean {
    return run.kind !== "agentic" || steersMidTurn(run.harness);
  }

  /** Whether the run's store already took a message under `requestId`: a trigger's firing sent it, and the server went
   *  down before it wrote so. Read before sending it again, so a completed run is not opened again for a message it
   *  already has. Only for a run with no live process: a live one holds its store, and takes the message through its
   *  door, which takes one per id anyway. The store keeps the id as JSON text, as pi submits it, or as a harness's door
   *  keeps its journal (doorKey), where a busy refusal is not a message taken (doorTook). A store held past the retries
   *  throws as busy. */
  async tookMessage(run: Run, requestId: string): Promise<boolean> {
    if (this.live(run)) return false;
    const file = this.storeFile(run);
    if (!(await stat(file).catch(() => null))) return false;
    // A fresh read-only, lock-free read (run-db.ts), after any take-back's checkpoint of this run.
    return this.runDb(run, async () => {
      try {
        const statusOf = await readRunDb(file, this.live(run), (db) => {
          if (db.prepare("SELECT 1 FROM submissions WHERE request_id = ? LIMIT 1").get(JSON.stringify(requestId)) !== undefined) return true;
          const status = db.prepare("SELECT json_extract(e.record, '$.data.status') AS status FROM submissions s JOIN entries e ON e.id = json_extract(s.record, '$.entry') WHERE s.request_id = ? LIMIT 1");
          // The door's journal for it, key by key until the first it does not hold (pi-durable-disk doorKey).
          const journal = new Map<string, string>();
          for (let n = 0; ; n++) {
            const key = doorKey(requestId, n);
            const at = (status.get(JSON.stringify(key)) as { status?: string } | undefined)?.status ?? undefined;
            if (at === undefined) break;
            journal.set(key, at);
          }
          return journal;
        });
        return statusOf === true ? true : await doorTook(requestId, (key) => statusOf.get(key));
      } catch (error) {
        // A store that keeps no submissions has taken none.
        if (/no such table/.test((error as Error).message)) return false;
        throw error;
      }
    });
  }

  /** Raises the cap of an agentic run that names one, to `cap`: above its own (by more than CAP_TOLERANCE), or the same as
   *  its newest raise (a retry, which changes nothing). serve.json keeps it before any answer, and a raise it could not keep
   *  is undone, so the run's next process opens under it (CAP_ENV), as does a server started again. A run paused at its
   *  cap goes on: the raise names the pause it answers, and the pause gets one follow-up, "The cap was raised to $X;
   *  continue the task." under an id fixed now, which refresh sends once the paused process is gone (resumeRaised), here
   *  or after a restart; a second raise before it goes raises what it says. A run working keeps the cap its process was
   *  opened with until its next process. Raises of one run are taken one at a time. */
  async raiseCap(run: Run, cap: number): Promise<{ resumed: boolean; messageId?: string; note?: string }> {
    const before = run.raising ?? Promise.resolve();
    const taking = before.catch(() => undefined).then(() => this.takeRaise(run, cap));
    run.raising = taking.catch(() => undefined);
    return taking;
  }

  private async takeRaise(run: Run, cap: number): Promise<{ resumed: boolean; messageId?: string; note?: string }> {
    if (run.imported) throw this.importedRefusal(run);
    if (run.cancel || run.finishing || TERMINAL.has(statusOf(run).status)) throw this.finished(run);
    const from = run.meta.max_cost_usd;
    if (from === undefined) throw invalid([{ field: "max_cost_usd", reason: "not_allowed", message: "This run has no cap to raise: a cap is named when a run starts." }]);
    const last = run.meta.cap_raised?.at(-1);
    const pause = pauseOf(run);
    const next = continuationOf(run);
    // The same raise again (a retry): what the first one did stands.
    if (Math.abs(cap - from) <= CAP_TOLERANCE && last && Math.abs(last.to - cap) <= CAP_TOLERANCE) {
      // Resumed, as the first answer said, unless the run has since paused anew at another refusal: no raise of that one.
      const answered = last.pause !== undefined && run.meta.cap_continue?.pause === last.pause && (pause === undefined || pause === last.pause) ? run.meta.cap_continue : undefined;
      return answered ? { resumed: true, messageId: answered.message_id } : { resumed: false };
    }
    if (!(cap > from + CAP_TOLERANCE)) throw invalid([{ field: "max_cost_usd", reason: "invalid", message: `A cap is only raised: name more than the run's ${money(from)}.` }]);
    // Built on a copy and written first: nothing reads the raise (its cap, the pause it answers, its follow-up) before
    // serve.json keeps it, so until then a message is still 409 budget_reached, the run reads its old cap and no
    // follow-up goes; a raise the write fails leaves the run as it was, and a retry raises it again.
    const raised = [...(run.meta.cap_raised ?? []), { from, to: cap, at: new Date().toISOString(), ...(pause ? { pause } : {}) }];
    let follow = run.meta.cap_continue;
    if (pause !== undefined && next === undefined) {
      // The pause's one follow-up, by an id fixed now, and the process being let go then, which it waits out.
      const paused = this.live(run) ? this.liveIdentity(run) : undefined;
      follow = { pause, message_id: `cap-${raised.length}-${randomBytes(4).toString("hex")}`, sent: false, tries: 0, ...(paused ? { paused } : {}) };
    } else if (next) {
      // A raise of a pause whose follow-up has not gone: that one follow-up goes, under this cap, with its tries anew.
      const { error: _, ...rest } = next;
      follow = { ...rest, tries: 0 };
    }
    await this.saveMeta(run, () => ({ ...run.meta, max_cost_usd: cap, cap_raised: raised, ...(follow ? { cap_continue: follow } : {}) }));
    run.meta.max_cost_usd = cap;
    run.meta.cap_raised = raised;
    if (next && follow) {
      // The same follow-up object resumeRaised may hold, renewed in place.
      next.tries = 0;
      delete next.error;
    } else if (follow) run.meta.cap_continue = follow;
    if (next && typeof run.resuming === "number") run.resuming = undefined;
    this.refresh(run);
    const answered = pause !== undefined ? run.meta.cap_continue : undefined;
    if (!answered) return { resumed: false, ...(this.live(run) ? { note: `The run's process keeps the ${money(from)} cap it was opened with; the ${money(cap)} cap holds from its next process.` } : {}) };
    return { resumed: true, messageId: answered.message_id };
  }

  /** Sends a raised run its pause's follow-up, under its id (the door takes one id once), at the run's cap now: as a
   *  follow-up to a run whose process has gone (message()), so the process it starts resumes nothing and opens under the
   *  new cap, or to the process another launch started. Marked sent in serve.json. One that cannot be sent is tried
   *  again (CONTINUE_RETRY_MS), and after CONTINUE_TRIES the run fails, saying why: never a pause stuck in silence. */
  private async resumeRaised(run: Run, next: NonNullable<RunMeta["cap_continue"]>): Promise<void> {
    run.resuming = "sending";
    if (!this.live(run)) run.followUpOpen = true;
    run.submitted++;
    this.refresh(run);
    const cap = run.meta.max_cost_usd ?? 0;
    try {
      // The server's line, shown as the server's (MessageOrigin), never as the person's: the model reads the same text.
      await this.submit(run, `The cap was raised to ${money(cap)}; continue the task.`, "followUp", next.message_id, undefined, { kind: "server", reason: "cap_raised" });
      // Marked sent once serve.json says so. Should that write fail, it went all the same (the door holds it), and its
      // run no longer stands at the pause, so nothing sends it again.
      await this.saveMeta(run, () => ({ ...run.meta, cap_continue: { ...next, sent: true } })).then(
        () => void (next.sent = true),
        (error: Error) => warn(run.id, `its raised cap's follow-up went, but is not marked sent: ${error.message}`),
      );
      run.resuming = undefined;
    } catch (error) {
      run.submitted = Math.max(0, run.submitted - 1);
      // The try counts here whether or not serve.json can say so, so its tries stay bounded.
      const tried = { tries: next.tries + 1, error: (error as Error).message };
      await this.saveMeta(run, () => ({ ...run.meta, cap_continue: { ...next, ...tried } })).catch(() => undefined);
      Object.assign(next, tried);
      if (next.tries >= CONTINUE_TRIES) {
        run.resuming = undefined;
        warn(run.id, `its raised cap's follow-up was not sent in ${next.tries} tries (${next.error}); the run fails`);
        return this.failRaised(run, cap, next.error);
      }
      const wait = CONTINUE_RETRY_MS[next.tries - 1] ?? CONTINUE_RETRY_MS.at(-1)!;
      warn(run.id, `its raised cap's follow-up was not sent (${next.error}); tried again in ${wait / 1000} s`);
      const at = Date.now() + wait;
      run.resuming = at;
      setTimeout(() => {
        if (run.resuming !== at) return;
        run.resuming = undefined;
        this.refresh(run);
      }, wait).unref();
      this.refresh(run);
    } finally {
      run.followUpOpen = undefined;
    }
  }

  /** Ends a raised run whose follow-up could not be sent: failed, in words a person can act on. */
  private async failRaised(run: Run, cap: number, why: string | undefined): Promise<void> {
    if (run.outcome || run.finishing || run.cancel) return;
    run.error = { code: "run_failed", message: `The run's cap was raised to ${money(cap)}, but the run could not be sent on (${why ?? "no answer"}). Start it again to go on.`, retryable: false };
    run.finishing = "failed";
    run.endedAt = new Date().toISOString();
    this.mark(run);
    if (this.live(run)) this.terminate(run);
    else await this.settle(run, null, false);
  }

  /** One message to an agentic run, its mode chosen by the run's state (the contract's table). `requestId`: the message's
   *  id in the run's store, which takes one message per id (a trigger's firing key); default a new one. */
  async message(run: Run, content: string, requestId?: string, { answers = true }: { answers?: boolean } = {}): Promise<{ mode: "steer" | "answer" | "follow_up"; messageId: string }> {
    if (run.imported) throw this.importedRefusal(run);
    // A cancelled run takes no message, whether or not its end is written yet.
    if (run.cancel) throw this.finished(run);
    // A message while a tool call waits for approval declines it, with the message as the reason (as Claude Code takes
    // what is typed at its permission prompt): the gate's resume carries the refusal and their words in one turn, and
    // nothing else is sent, so no second turn races the parked call.
    const read = run.kind === "agentic" ? waitingApproval(run) : undefined;
    if (read) {
      await this.personsTurn(run);
      // Read again after that wait, with nothing awaited from here to the decline's own write: an answer, a stop or a
      // cancel that landed meanwhile stands (the first answer wins, and a stop's withdrawal is never replaced), and the
      // message is then a message, under the run's state now. It declines only the call it read, which the person saw:
      // another parked since waits for its own answer.
      const waiting = waitingApproval(run);
      if (waiting?.id === read.id && !run.cancel && !run.stopping) return this.declineBy(run, waiting, content);
      if (run.cancel) throw this.finished(run);
    }
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
      // A raised run whose follow-up has not gone yet (its paused process still letting go, or the follow-up being sent)
      // takes a message once it has: after it, as the next turn, never into the process being let go.
      const following = () => continuationOf(run) !== undefined || run.resuming === "sending";
      if (following()) {
        await this.waitWhile(following, 100, "The run's raised cap's follow-up is still being sent");
        // Its follow-up's turn may have ended the run meanwhile (a quick answer): its end is written first, so the message
        // then opens it again, as one to any ended run does, never refused for an end still being written.
        await this.waitWhile(() => run.settles > 0 || Boolean(run.finishing && !run.outcome), 100, "The run's end is still being written");
      }
      if (run.kind === "agentic" && statusOf(run).status === "completed") await (run.reopening ??= this.reopen(run).finally(() => (run.reopening = undefined)));
    } while (run.stopping);
    const steers = this.steers(run);
    const { status, state } = statusOf(run);
    if (TERMINAL.has(status)) throw this.finished(run);
    // Paused at its cap: a message would be refused for the same room, so the cap is raised first.
    const paused = pausedAt(run);
    if (paused !== undefined) throw new ApiError("budget_reached", `The run is paused at its ${money(run.meta.max_cost_usd ?? 0)} cap: raise the cap first. ${paused}`, { details: { cap_usd: run.meta.max_cost_usd ?? null } });
    // A harness that cannot take a message mid-turn (any but pi, harness.ts) queues it for the turn's end: a new turn of
    // the same run, which the contract calls follow_up, never a steer it does not do.
    const working = status === "queued" || (status === "working" && state === "working");
    const mode = working ? (steers ? "steer" : "follow_up") : status === "input_required" && state === "waiting" ? "answer" : "follow_up";
    // A message that may not answer (a trigger's): one that would is refused here, past every wait, before it is sent.
    if (mode === "answer" && !answers) throw new ApiError("not_continuable", WAITS_ON_A_PERSON, { details: { reason: "waiting" } });
    const messageId = requestId ?? `m${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    // A follow-up to a run the person stopped, whose process has gone: its turn had ended, so the process this message
    // starts resumes nothing. With its process live the message starts none, and a relaunch after that process dies
    // under the message is a crash's, which keeps its row.
    if (status === "input_required" && state === "idle" && !this.live(run)) run.followUpOpen = true;
    run.submitted++;
    this.refresh(run);
    try {
      // After every wait, and once the count above holds the run from ending (so no end-of-run turn is asked from here):
      // one asked while this message waited for the run's end wrote its origin then, after any earlier removal.
      await this.personsTurn(run);
      await this.submit(run, content, mode === "steer" ? "steer" : "followUp", messageId, undefined, answers ? this.messageOrigin?.(run.id, content) : undefined, answers);
    } catch (error) {
      run.submitted = Math.max(0, run.submitted - 1);
      this.refresh(run);
      throw error;
    } finally {
      run.followUpOpen = undefined;
    }
    return { mode, messageId };
  }

  /** A person's turn is sent next: no turn from here on is the server's own end-of-run turn (tool-gate.ts NOTE_ONLY_TEXT),
   *  so its origin goes, right before the turn is sent. */
  private async personsTurn(run: Run): Promise<void> {
    // A write of the origin still in flight lands first, then goes: none starts from here (learning-run.ts reflectTurn).
    await run.originWrite?.catch(() => undefined);
    await rm(join(run.dir, TURN_ORIGIN_FILE), { force: true }).catch((error: Error) => warn(run.id, `its turn's origin is not removed: ${error.message}`));
    await runsTestHooks.personsTurn?.(run.dir);
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
      // With its outcome cleared the run reads open. Messages wait for this reopen (message()), so its launch below is
      // the follow-up's; set here, with the outcome, whichever launch comes first carries the flag (launch() takes it).
      run.followUpOpen = true;
      run.settled = false;
      run.endedAt = undefined;
      run.error = undefined;
      delete run.meta.error;
      run.relaunches = 0;
      // A run that learns finds its agent's notes in its work again (learning-run.ts).
      await this.learning.onReopen(run);
      await this.pinSignIn(run);
      await this.beforeReopenLaunch?.(run.id);
      this.refresh(run);
      // Opened for the follow-up: the run had answered, so its open resumes nothing.
      this.launch(run, true);
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
    // A tool call that waits for approval is withdrawn by the stop (never run, an answer after is 409); then a turn that
    // runs meanwhile is stopped as any working run's is, and with none the run is stopped as a stop leaves one.
    const open = run.kind === "agentic" && !run.cancel && !run.outcome && !run.finishing;
    const withdrawn = open && waitingApproval(run) ? await this.withdraw(run) : false;
    // An answer the run's process has not acted on yet is overridden too: a stop wins, so nothing runs and nothing resumes.
    const superseded = open ? await this.supersede(run, "withdrawn") : false;
    const { status, state } = statusOf(run);
    if (run.kind === "workflow" || !this.live(run) || !(status === "working" && state === "working") || run.submitted > 0) return withdrawn || superseded ? this.stopIdle(run) : false;
    run.stopping = true;
    try {
      return await this.stopTurn(run);
    } finally {
      run.stopping = undefined;
    }
  }

  /** message()'s decline of the tool call that waits for approval: a deny with the message as its note, which the
   *  run's gate acts on as any deny, resuming the session with the refusal and the person's words in one message. */
  private async declineBy(run: Run, waiting: Approval, content: string): Promise<{ mode: "answer"; messageId: string }> {
    // The person's message, whole: it is the reason the model reads. Nothing shows the note, so nothing cuts it.
    run.meta.approvals = { ...run.meta.approvals, [waiting.id]: { decision: "deny", note: content, answered_at: new Date().toISOString(), args_shown: shownArgs(waiting, this.redactor(run)), by: "message" } };
    await this.saveMeta(run);
    this.restate(run);
    this.refresh(run);
    if (!run.outcome && !run.finishing && !run.cancel) void this.ensureLive(run).catch((error: Error) => warn(run.id, `its declined approval waits for its process: ${error.message}`));
    return { mode: "answer", messageId: `m${Date.now().toString(36)}${randomBytes(4).toString("hex")}` };
  }

  /** The answers given and not acted on yet (the run's process has not resolved them), overridden by a stop or a cancel:
   *  `withdrawn` or `canceled`, each keeping the answer it superseded, so nothing runs and nothing resumes, and the
   *  history shows what was given. The run's gate reads the answer again just before it acts (tool-gate.ts). */
  private async supersede(run: Run, decision: "withdrawn" | "canceled"): Promise<boolean> {
    const given = [...(run.approvals?.values() ?? [])].filter((a) => !a.resolved && run.meta.approvals?.[a.id] && !withdrawn(run.meta.approvals[a.id]));
    if (!given.length) return false;
    const now = new Date().toISOString();
    const overridden = given.map((a) => {
      const was = run.meta.approvals![a.id]!;
      return [a.id, { decision, answered_at: now, superseded: { decision: was.decision, answered_at: was.answered_at, ...(was.note !== undefined ? { note: was.note } : {}), ...(was.by ? { by: was.by } : {}) } }] as const;
    });
    run.meta.approvals = { ...run.meta.approvals, ...Object.fromEntries(overridden) };
    await this.saveMeta(run);
    this.restate(run);
    return true;
  }

  /** Until every tool call of the run that waited for approval is resolved in its store (its process acted on its answer,
   *  or cut it), or `ms` pass. */
  private async untilResolved(run: Run, ms: number): Promise<void> {
    for (const end = Date.now() + ms; [...(run.approvals?.values() ?? [])].some((approval) => !approval.resolved) && Date.now() < end; ) await sleep(50);
  }

  /** stop()'s withdrawal of the tool call that waits for approval: never run, and an answer after is 409. */
  private async withdraw(run: Run): Promise<boolean> {
    const waiting = waitingApproval(run)!;
    run.meta.approvals = { ...run.meta.approvals, [waiting.id]: { decision: "withdrawn", answered_at: new Date().toISOString() } };
    await this.saveMeta(run);
    this.restate(run);
    return true;
  }

  /** stop() of a run with no turn to abort (parked on an approval it withdrew): the stop's mark, as a stop saves it. */
  private async stopIdle(run: Run): Promise<boolean> {
    delete run.meta.stopped_at;
    delete run.meta.stopped_after;
    Object.assign(run.meta, stopMark(run.rows));
    await this.saveMeta(run);
    this.refresh(run);
    return true;
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

  /** A person's answer to the tool call `id` that waits for approval (tool-gate.ts): kept in the run's serve.json before
   *  it returns, the first answer winning (the same one again changes nothing; another is 409, `already_answered`). The
   *  run's process reads it there, runs or refuses the call, and resumes; a run with no process gets one. */
  async approve(run: Run, id: string, decision: "allow" | "deny", note?: string): Promise<void> {
    const given = run.meta.approvals?.[id];
    if (!given && !run.approvals?.has(id)) throw new ApiError("not_found", `The run ${run.id} has no tool call ${id} waiting for approval.`);
    if (given) {
      if (given.decision === decision) return;
      throw new ApiError("not_continuable", `The tool call ${id} was already ${given.decision === "canceled" ? "canceled with its run" : given.decision === "withdrawn" ? "withdrawn when its run was stopped" : `answered: ${given.decision}`}.`, { details: { reason: "already_answered", decision: given.decision } });
    }
    run.meta.approvals = { ...run.meta.approvals, [id]: { decision, ...(note ? { note } : {}), answered_at: new Date().toISOString(), args_shown: shownArgs(run.approvals!.get(id)!, this.redactor(run)) } };
    await this.saveMeta(run);
    this.restate(run);
    this.refresh(run);
    if (!run.outcome && !run.finishing && !run.cancel) void this.ensureLive(run).catch((error: Error) => warn(run.id, `its answered approval waits for its process: ${error.message}`));
  }

  /** Record the cancel and signal the run. An agentic run reads `cancelled` from here on (the first end a run comes to is
   *  its last: nothing its turn writes later moves it), and is carried back so once its process has exited; a workflow
   *  run reads it once it is carried back, with how its workflow stopped. */
  async cancel(run: Run): Promise<boolean> {
    // As stop: already terminal, and no cancel mark is written.
    if (run.imported) return false;
    // Finishing is already ending with its outcome (an answer, a failure, the cap): a run's first end is its last.
    if (run.outcome || run.finishing) return false;
    run.cancel = true;
    // A tool call that waits for approval is canceled with its run: an answer after this one is refused.
    const waiting = waitingApproval(run);
    if (waiting) {
      run.meta.approvals = { ...run.meta.approvals, [waiting.id]: { decision: "canceled", answered_at: new Date().toISOString() } };
      await this.saveMeta(run).catch((error: Error) => warn(run.id, `its canceled approval is not saved: ${error.message}`));
      this.restate(run);
    }
    // An answer its process has not acted on yet is overridden too: nothing runs and nothing resumes.
    const superseded = await this.supersede(run, "canceled").catch((error: Error) => (warn(run.id, `its superseded approval is not saved: ${error.message}`), false));
    if (run.kind === "agentic") {
      run.finishing = "cancelled";
      run.endedAt = new Date().toISOString();
      this.mark(run);
    }
    // First, so no request leaves after the cancel landed, whether or not the process can be reached yet.
    await writeWhole(join(run.dir, RUN_CANCELLED), "").catch((error: Error) => warn(run.id, `its cancel mark is not written: ${error.message}`));
    if (this.live(run)) {
      // The turn is aborted first, so the drain that SIGTERM starts does not wait for it.
      await this.abortTurn(run);
      // An approved call in flight runs outside any turn: its process's gate cuts it once it reads the cancel (tool-gate.ts),
      // which ending the process at once would forestall. A short wait for that, never a refusal.
      if (superseded) {
        run.meta.cancel_waits_for = [...(run.approvals?.values() ?? [])].filter((approval) => !approval.resolved).map((approval) => approval.id);
        await this.saveMeta(run).catch((error: Error) => warn(run.id, `its cancel's wait is not saved: ${error.message}`));
        await this.untilResolved(run, 3_000);
      }
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
    // Every read of the run's database is lock-free (run-db.ts): a run's process holding it never makes a poll wait.
    return this.servedGraph(run, await runGraph(given));
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
    const adopted = all.filter((run) => !run.child && run.orphanHolder && holderLives(run.orphanHolder)).length;
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
    const adopted = [...this.runs.values()].filter((run) => run.orphanHolder && holderLives(run.orphanHolder));
    for (const run of adopted) this.terminate(run);
    for (const deadline = Date.now() + this.killAfterMs(); adopted.some((run) => run.orphanHolder && holderLives(run.orphanHolder)) && Date.now() < deadline; ) await sleep(100);
    await sleep(0);
    await Promise.all([...this.runs.values()].map((run) => run.settling));
    await this.learning.idle();
    for (const run of this.runs.values()) {
      run.feed?.abort();
      clearTimeout(run.stopPending);
      run.stopPending = undefined;
    }
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
    // The whole text of the answer the run's turn ended on (answerOfRun), never the line the store keeps, which is cut;
    // the store's line only for a run whose rows are not read (an import's).
    const finalAnswer = run.kind === "workflow" ? null : (answerOfRun(run) ?? row?.summary ?? null);
    // When the turn of a message still open last wrote: a run working shows it is moving, or not.
    const progress = TERMINAL.has(status) || run.kind === "workflow" ? undefined : run.turns.progressAt();
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
      // An answer is served with no held secret in it, whole (key-refusal.ts redactedAnswer); the stored one stays as written.
      result: status === "completed" ? { output: run.kind === "workflow" ? (this.servedOutput(run, run.meta.output ?? null)) : null, final_answer: this.servedAnswer(run, finalAnswer) } : kept ? { output: null, final_answer: this.servedAnswer(run, kept) } : null,
      error: status === "failed" ? (run.error ?? { code: "run_failed", message: "The run failed.", retryable: false }) : null,
      review: endedAt === null ? null : reviewAt(run.meta.review ?? (row ? reviewOfRow(row, run.meta) : null), endedAt),
      pending: status === "input_required" && state === "waiting" ? (approvalOf(run, this.redactor(run)) ?? budgetPending(run, this.spentNow(run)) ?? pendingOf(run.rows)) : null,
      cost: this.cost(run),
      archived_at: stored?.archivedAt ?? null,
      imported_from: run.imported ?? null,
      trigger: run.meta.trigger ?? null,
      // The notes it read once it settled: while it runs, or runs again for a follow-up, they are still being read.
      learning: this.learning.view(run.meta.learning, TERMINAL.has(status) && run.settled),
      poll_after_ms: TERMINAL.has(status) && run.settled ? 0 : 1000,
      last_progress_at: progress === undefined ? null : new Date(progress).toISOString(),
    };
  }

  async summary(run: Run) {
    const { run_id, agent_id, agent_version, revision, kind, sha, status, state, title, effort, created_at, ended_at, error, review, pending, cost, archived_at, imported_from, trigger, learning } = await this.view(run);
    return { run_id, agent_id, agent_version, revision, kind, sha, status, state, title, ...(effort ? { effort } : {}), created_at, ended_at, error, review, pending, cost, archived_at, imported_from, trigger, learning: learning && shortOf(learning) };
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
    const meta = (await readJson(join(runDirIn(this.options.agents.dir, row.agent, row.id), RUN_META))) as Partial<RunMeta> | null;
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
      trigger: triggerOf(meta),
      // Its row says it ended: what serve.json holds of its learning is as it settled.
      learning: this.learning.short(isObject(meta?.learning) ? (meta.learning as Learning) : null, true),
    };
  }

  /** A key was saved on this server or deleted from it: each held run's learning row and decision rows shown again, cut
   *  of the keys as they are now (learning-run.ts shown, decision-rows.ts), as its view and its lists already are from
   *  the next read on. */
  keysChanged(): void {
    this.learning.keysChanged();
    // A run's learning row and its decision rows are shown again with the keys as they are now (show): a key saved after
    // a workflow ended is redacted from its decisions on the next read, learning or not.
    for (const run of this.runs.values()) if (run.meta.learning || run.decisions) this.show(run);
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
