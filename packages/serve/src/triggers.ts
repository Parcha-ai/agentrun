// Triggers: what starts a run with no caller. A trigger is a source (one of the registry's adapters,
// trigger-adapters.ts: a schedule on a clock, a signed webhook pushed to the server) and a target (a run of an agent,
// always capped, or a message to one run). They live in the store (store.triggers): each trigger a row, and its firings
// rows of their own, so a burst of firings for one trigger writes that trigger's rows only. Every change is one store
// transaction.
// A firing starts exactly once. Its key is fixed by what it fires for: the trigger and its nominal time (a schedule), or
// the trigger and the caller's Idempotency-Key (run now) or the sender's id (a webhook). A key already recorded is not
// recorded again: a firing in the history, or a sender's key kept for its day after it left the history. Then its run is
// started with the key as its origin, so a firing driven again after a restart finds its run and starts no second one.
// While the trigger's last run is active (working, or waiting on a person), a firing is `skipped`, never queued: a firing
// queued behind a run parked on a person would wait for as long as the person does. A source whose adapter says each
// firing is its own work (concurrent: a webhook with accept) starts a run per firing instead. With max_active_runs set, a
// firing past it waits for a run of the trigger to end. A firing handed to the launch hook's host with no run yet is a run
// in progress for both, until its run starts or its start_by passes (a host start begun by then holds it through the
// start), and so is one mid-hand on this server: its hook not answered yet, or its host's start being written.
// One retry policy, kept in the store: a failed try (a full server, a thrown error, a store that could not read) keeps
// the firing due with its next try in retry_at, after the wait BACKOFF_MS gives for its attempts; past the table it fails.
// Each failed firing counts once toward the trigger's streak, however many tries it took, and FAILURES_TO_PAUSE in a row
// turn the trigger off. A firing past its trigger's max_active_runs is no failure: it waits (waits_on, no try counted) and
// is driven again once a run of the trigger ends, read from the store by one query per tick for every waiting firing (the runner is another process: the
// store is all the two share). One timer, at the soonest next time of an enabled trigger, next try of a due firing, or
// WAIT_POLL_MS while a firing waits, is armed again after each change. A next time is reckoned from the last nominal time, never from the clock, so a
// late timer does not drift. Of the times that came while the server was down, or its timer late past LATE_MS, the
// latest fires if it is within the trigger's catch-up window and the rest are one `missed` row; the schedule goes on from
// now. A failed firing queues a trigger.failed webhook message.
// With the launch hook set (trigger-launch-hook.ts), a firing that would start a run goes the same way up to the start,
// then is handed to the host instead: sent when the host takes it, a failed try (hook_failed and why) when it does not.
// A host that took a firing and then starts no run for it (its own job failed at launch) releases it: failed at once,
// host_released, so its trigger's room is free for the next firing without waiting out start_by.
import { createHash, randomBytes } from "node:crypto";
import { type MessageOrigin, TRIGGER_LABELS, type TriggerSource } from "./timeline/index.js";
import { agentDeleting, purgedAgent } from "./agents.js";
import { ownedElsewhere } from "./agents-store.js";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { EFFORTS } from "./model.js";
import { AgentArchived, type FiringChange, FiringMoved, type FiringRow, type NewFiring, type Store, StoreConstraint, TriggerFull, type TriggerPatch, type TriggerRow } from "./store/index.js";
import { carriesPrevious, type Clock, PAYLOAD_KEPT_BYTES, type PollResult, second, type Source, type TriggerAdapter, validZone } from "./trigger-adapter.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { type Handed, handToHost, HookFailed, type HookFiring, LAUNCH_HOOK_LATE_START_MS, type LaunchHook } from "./trigger-launch-hook.js";
import { MAX_EVERY_S } from "./trigger-schedule.js";
import { ID, IDEMPOTENCY_TTL_S, isObject, type Json, unknownFields } from "./validate.js";

export { MAX_EVERY_S, MIN_EVERY_S } from "./trigger-schedule.js";

/** The firings each trigger keeps in its history, newest first; a firing still due is never dropped, nor a failure whose
 *  trigger.failed is not queued yet, nor a started one whose run has not ended. */
export const HISTORY_KEPT = 200;
/** The most firings a trigger holds due. Past it a webhook event and a run now are refused (429, retryable) before
 *  anything is written, and a schedule's time is skipped. */
export const DUE_KEPT = 20;
/** How long a refused event is told to wait (Retry-After). */
const FULL_RETRY_S = 30;
/** The kinds of source this server has: its adapters' ids. */
export const SOURCE_KINDS: readonly string[] = TRIGGER_ADAPTERS.map((a) => a.id);
export const TARGET_KINDS = ["start_run", "message_run"] as const;
export const FIRING_STATUSES = ["due", "started", "sent", "skipped", "failed", "missed"] as const;
/** The reason of a firing the launch hook's host took (a 2xx) without starting its run here under the firing (RunCreate
 *  trigger_firing). */
export const HANDED_NO_RUN = "Handed to the host by the launch hook, which started no run here for it.";
/** The error code of a firing its launch hook's host released (Triggers.release): it took the firing (a 2xx) and said it
 *  will start no run for it. */
export const HOST_RELEASED = "host_released";
/** The reason of such a firing; its error's message is the host's own words. */
export const HOST_RELEASED_REASON = "Released by the launch hook's host, which took it and will start no run for it.";
/** The `details.reason` of a release refused because the firing's run started (Triggers.release), beside `details.run_id`:
 *  for a host to match without reading the words. A start refused because its host released the firing carries
 *  HOST_RELEASED there. */
export const RUN_STARTED = "run_started";
/** The most characters of the host's words a release keeps. */
export const RELEASE_WORDS_MAX = 500;
/** The most of a webhook's payload a firing passes on: the rest is cut, at a character's start (trigger-adapter.ts). */
/** How late a missed time may be and still fire once, by default: an hour. */
export const CATCHUP_WINDOW_S = 3600;
/** The failed tries in a row that turn a trigger off. */
export const FAILURES_TO_PAUSE = 5;
/** The one backoff table: the wait before a due firing's next try, by its failed tries so far. Past it, the firing fails. */
export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
/** The answers a try is retried on: the server or its store busy for now. Any other failure ends the firing failed. */
const RETRYABLE = new Set(["rate_limited", "home_busy", "unavailable"]);
/** How often the store is read for the waiting firings whose trigger has room again: one read for all of them. */
export const WAIT_POLL_MS = 500;
/** A nominal time the timer reaches later than this was missed: the server was down, or its timer late. */
const LATE_MS = 60_000;
/** The most missed times one row counts one by one; past it the schedule jumps to now. */
const MISSED_COUNTED = 10_000;
/** Node fires a longer timeout at once: a far next time is reached in steps of at most this. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_NAME = 200;
const DAY_MS = IDEMPOTENCY_TTL_S * 1000;
/** The most keys each trigger keeps for their day past its history (an ignored request's, a pushed or run now firing's
 *  that left the history): a sender's event sent again within its day starts nothing, however many came between. Past
 *  it the oldest go first, and the log says so. */
export const SEEN_KEPT = 5_000;
/** The highest max_active_runs a trigger may set (the store's CHECK holds the same). */
export const MAX_ACTIVE_RUNS = 100;
const ENDED = new Set(["completed", "failed", "cancelled"]);
/** A polled source's trigger setting its last check is kept in (TriggerAdapter.poll), with the sign-ins refused in a row. */
export const LAST_CHECK = "last_check";
/** The sign-ins a polled source's server refuses in a row that turn its trigger off. */
export const REFUSALS_TO_STOP = 3;
/** How long a create or a turn-on of a polled source waits for its first poll (where it starts watching) before it
 *  answers: past it, the answer goes out and the poll carries on. */
export const FIRST_POLL_WAIT_MS = 10_000;
/** Whether `adapter`'s firings are events from outside (pushed, or found by a poll), each its own, never a time. */
const eventful = (adapter: TriggerAdapter | undefined) => adapter?.delivery === "push" || adapter?.poll !== undefined;
/** A polled trigger's last check as kept (LAST_CHECK), when it reads. */
function checkOf(text: string | undefined): { at: string; ok: boolean; message: string; refused: number } | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as { at?: unknown; ok?: unknown; message?: unknown; refused?: unknown };
    return typeof value.at === "string" && typeof value.ok === "boolean" && typeof value.message === "string" ? { at: value.at, ok: value.ok, message: value.message, refused: Number.isSafeInteger(value.refused) ? (value.refused as number) : 0 } : undefined;
  } catch {
    return undefined;
  }
}
/** Why a message_run trigger turned itself off: the run it messages is gone. */
const RUN_DELETED = "its run was deleted";

/** What a source's sender keeps of a trigger, set up from here (composio-triggers.ts: Composio's trigger instance): made
 *  before the trigger is kept and undone when it is not, kept in step as the owner turns the trigger on and off (and as
 *  the server turns it off itself: offThere), removed after it. What it could not do there is answered beside the change (`said`, by its source's name: `{composio: {done:
 *  false, note}}`), and the change here holds. */
export type TriggerUpstream = {
  /** A trigger `id` of `source` being made (on or not): what it needs there made, then `keep` (the trigger's save here)
   *  given the source to keep, with what was made named in it; what `keep` answers is answered. When `keep` throws, what
   *  was made is undone and its refusal thrown. Throws the refusal when it can't be made. */
  make<T>(source: Source, id: string, enabled: boolean, keep: (source: Source) => Promise<T>): Promise<T>;
  /** A PATCH's source for the trigger that keeps `was`: the source to keep, or the refusal (thrown) of a change to what
   *  was made there. */
  patched(was: Source, given: Source): Source;
  /** The trigger `id` of `source`, turned on or off here: the same there. */
  turned(source: Source, id: string, on: boolean): Promise<Json | undefined>;
  /** The trigger `id` of `source`, deleted here: removed there, with what it keeps here for it (a sealed config). */
  removed(source: Source, id: string): Promise<Json | undefined>;
  /** The trigger `id` of `source`, still here: removed there, then `here` (its delete here) in the same step, so no other
   *  trigger's removal there reads it as still holding what they share; what it keeps here for it is left (`forgotten`
   *  drops that once the trigger is gone). Undefined when it is gone there and `here` is done; what could not be done
   *  there, said, with `here` not run. A refusal of `here`'s is thrown. */
  removedThere(source: Source, id: string, here: () => Promise<void>): Promise<Json | undefined>;
  /** What it keeps here for the trigger `id` of `source` (a sealed config), dropped once the trigger is gone here. */
  forgotten(source: Source, id: string): Promise<void>;
};

/** `max_cost_usd`: each run's cap; absent, the agent's default as it stands when the firing starts (one of the two is
 *  required: server.ts targetIssues and start). */
export type Target = { kind: "start_run"; agent_id: string; input: Json; max_cost_usd?: number; effort?: string } | { kind: "message_run"; run_id: string; input: Json };
/** A trigger as the engine reads its row. */
type Trigger = Omit<TriggerRow, "source" | "target"> & { source: Source; target: Target };
/** What the webhook did with a trigger.failed message (webhooks.ts emitTrigger). */
type Told = "queued" | "unsaved" | "off" | "closed";
/** What a trigger.failed webhook message says (webhooks.ts). `agent_id`: the agent the trigger runs as (its row's: a
 *  start_run's agent, or the agent of the run a message_run names), so every trigger has one; `agent_name`, that agent's
 *  name as the message is built, its id when it has none (an agent no longer in the store). */
export type TriggerFailed = { trigger_id: string; name: string; agent_id: string; agent_name: string; firing_key: string; nominal_at: string; error: { code: string; message: string }; auto_paused: boolean };
/** A run's provenance, kept with its launch row: the trigger that started it, and the firing. `name`: the trigger's name as
 *  it was at the firing, put on the run so its Timeline row names the trigger without a store read (runs.ts
 *  servedTriggerRow); a rename pushes the new name (server.ts triggerChanged). */
/** `attrs`: what its source said of the event that fired it (the firing's attrs, server-written), which the run's tools
 *  may read (an email's Message-ID: email/tools.ts reads the thread it started). */
export type RunTrigger = { id: string; firing_key: string; name?: string; attrs?: Record<string, string> };
/** A host's start of a firing the launch hook handed it (Triggers.handedStart): the firing's key, the trigger, input
 *  origin and title a start here would give the run, and the target and previous-result flag it starts on
 *  (TriggerDeps.start's, so a handed run gets its target's cap, effort and previous result as one started here does; the
 *  host may lower the cap, and its effort holds when the target sets none). The start writes its run with the firing's
 *  start in the same write (store.runs.create `firing`), so a release of the firing meanwhile, on any server, refuses
 *  it (FiringMoved) and leaves no run. */
export type HandedStart = { key: string; trigger: RunTrigger; from: MessageOrigin; title: string; target: Extract<Target, { kind: "start_run" }>; previous: boolean };
/** The engine's clock and its one timer: Date.now and setTimeout, or a test's. */
export type TriggerClock = { now(): number; arm(fire: () => void, ms: number): { clear(): void } };
export type TriggerDeps = {
  /** Where the triggers and their firings live, and the agents they run as (an archived agent's turn off with it). */
  store: Pick<Store, "triggers" | "runs" | "agents">;
  /** The refusal of a trigger of source `kind` made or turned on here, when it cannot be (the connection it needs is not
   *  there: GitHub not connected). Undefined, or no such dep, when it can. */
  unavailable?(kind: string): ApiError | undefined | Promise<ApiError | undefined>;
  /** A polled source's credentials, read as it polls (the email account, opened); undefined when there are none. */
  credentials?(kind: string): Promise<unknown>;
  /** What keeps a target from starting runs here, by field (its agent, its kind, its input). */
  targetIssues(target: Target): Promise<InputIssue[]>;
  /** The refusal of a trigger aimed at `target` whose firings could never start or message a run that has what it needs
   *  (run-keys.ts firingsOwe), once its fields read; undefined, or no such dep, when there is none. */
  targetRefusal?(target: Target): Promise<ApiError | undefined>;
  /** Starts the target's run with `input`, as POST /agents/{id}/runs would, under `origin`, titled `title` (its
   *  trigger's, never its input's); its first message is the trigger's (`from`, never the person's); ApiError when
   *  refused. */
  /** `previous` true: the run is handed its trigger's previous result (its adapter's previousResult, carriesPrevious). */
  start(target: Extract<Target, { kind: "start_run" }>, input: Json, origin: RunTrigger, from: MessageOrigin, title: string, previous: boolean): Promise<{ run_id: string }>;
  /** Queues `input` for the target's run as a command row (answers false) under `key`, as the trigger's (`from`), within
   *  `bound` (store.triggers.message: at most `max` of this trigger's rows untaken for the run, else skipped with
   *  `reason`); ApiError when refused. */
  message(target: Extract<Target, { kind: "message_run" }>, input: Json, key: string, from: MessageOrigin, bound: { max: number; reason: string }): Promise<void | { skipped: string }>;
  /** An adapter's sealed settings (over the store): a trigger's minted secret made (at its create or a rotation) and shown
   *  once, durable before it is answered; a trigger's settings removed with it. Undefined for an adapter that keeps none. */
  settings(adapterId: string): { mint(scope: string, field: string): Promise<string>; set(scope: string, field: string, value: string, as?: "utf8"): Promise<void>; remove(scope: string): Promise<void>; get(scope: string, field: string): string | undefined } | undefined;
  /** A run's status, or null when there is no such run. */
  statusOf(runId: string): Promise<string | null>;
  /** The run the store started under origin `key`, if one: a firing left due by a server that went down mid-start. A run
   *  is inserted whole (its row and launch in one transaction), so a found run started. */
  runOf(key: string): Promise<{ run_id: string } | null>;
  /** Queues a trigger.failed webhook message under `key`, the firing's (webhooks.ts emitTrigger): `off` when there is no
   *  webhook to send it to; `unsaved` or `closed` when it is not in the outbox. */
  notify(failed: TriggerFailed, key: string): Told | Promise<Told>;
  say(fields: Record<string, string | number>): void;
  clock?: TriggerClock;
  /** The sources this engine reads: the registry's (trigger-adapters.ts), unless a test gives its own. */
  adapters?: readonly TriggerAdapter[];
  /** SEEN_KEPT, unless a test gives its own. */
  seenKept?: number;
  /** The address people and senders reach this server at (AGENTRUN_PUBLIC_URL), with no trailing slash: a pushed
   *  trigger's hook_url starts with it. None: the hook's path alone. */
  publicUrl?: string;
  /** What source `kind`'s sender keeps of its triggers, when it is set up from here (TriggerUpstream); none for the rest. */
  upstream?(kind: string): TriggerUpstream | undefined;
  /** The launch hook (AGENTRUN_LAUNCH_HOOK_URL): set, a firing that would start a run here is handed to the host
   *  instead (trigger-launch-hook.ts); a message_run firing starts no run and is sent here as ever. */
  launchHook?: LaunchHook;
};

const REAL_CLOCK: TriggerClock = {
  now: () => Date.now(),
  arm(fire, ms) {
    const timer = setTimeout(fire, Math.min(ms, MAX_TIMEOUT_MS));
    timer.unref();
    return { clear: () => clearTimeout(timer) };
  },
};
const iso = (ms: number) => new Date(ms).toISOString();
/** How many times a PATCH carrying a source is checked again when the trigger changed between its read and its write. */
const SOURCE_EDIT_TRIES = 3;
export const firingKey = (by: string, triggerId: string, what: string) => `fir_${createHash("sha256").update(`${by}\n${triggerId}\n${what}`).digest("hex").slice(0, 32)}`;
/** The adapter of `kind`, among `adapters`. */
const adapterIn = (adapters: readonly TriggerAdapter[], kind: string): TriggerAdapter | undefined => adapters.find((a) => a.id === kind);

/** A clock source's first time strictly after `after`, or null when it has none (or none a Date holds); a pushed
 *  source has none. */
function nextAfter(adapter: TriggerAdapter | undefined, source: Source, after: number): number | null {
  const at = adapter?.clock?.(source).next(after) ?? null;
  return at !== null && Number.isFinite(at) && Math.abs(at) <= DATE_MAX_MS ? at : null;
}

/** A time in `zone` as a person reads it: "Nov 1, 2026, 1:30 AM PDT". */
const local = (ms: number, zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: validZone(zone) ? zone : "UTC", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ms);

/** "A, B or C". */
const either = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

function sourceOf(adapters: readonly TriggerAdapter[], value: unknown, now: number, issues: InputIssue[]): Source | undefined {
  const bad = (field: string, reason: string, message: string) => void issues.push({ field: `source${field ? `.${field}` : ""}`, reason, message });
  if (!isObject(value)) return bad("", value === undefined ? "missing" : "wrong_type", `source is an object: ${either(adapters.map((a) => a.describe))}`), undefined;
  const adapter = typeof value.kind === "string" ? adapterIn(adapters, value.kind) : undefined;
  if (!adapter) return bad("kind", "not_an_option", `source.kind is one of ${adapters.map((a) => a.id).join(", ")}`), undefined;
  return adapter.parse(value, now, bad, issues);
}

function targetOf(value: unknown, issues: InputIssue[]): Target | undefined {
  const bad = (field: string, reason: string, message: string) => void issues.push({ field: `target${field ? `.${field}` : ""}`, reason, message });
  if (!isObject(value)) return bad("", value === undefined ? "missing" : "wrong_type", "target is an object: {kind: \"start_run\", agent_id, input, max_cost_usd?, effort?} or {kind: \"message_run\", run_id, input}"), undefined;
  const before = issues.length;
  if (value.kind === "message_run") {
    issues.push(...unknownFields(value, ["kind", "run_id", "input"]).map((i) => ({ ...i, field: `target.${i.field}` })));
    if (typeof value.run_id !== "string" || !ID.test(value.run_id)) bad("run_id", value.run_id === undefined ? "missing" : "wrong_type", "run_id is a run's id");
    if (!isObject(value.input) || typeof value.input.content !== "string") bad("input", value.input === undefined ? "missing" : "wrong_type", "input is the message, as POST /runs/{run_id}/messages takes it: {content}");
    return issues.length > before ? undefined : { kind: "message_run", run_id: value.run_id as string, input: { content: (value.input as Json).content } };
  }
  if (value.kind !== "start_run") return bad("kind", "not_an_option", `target.kind is one of ${TARGET_KINDS.join(", ")}`), undefined;
  issues.push(...unknownFields(value, ["kind", "agent_id", "input", "max_cost_usd", "effort"]).map((i) => ({ ...i, field: `target.${i.field}` })));
  if (typeof value.agent_id !== "string" || !ID.test(value.agent_id)) bad("agent_id", value.agent_id === undefined ? "missing" : "wrong_type", "agent_id is an agent's id");
  if (!isObject(value.input)) bad("input", value.input === undefined ? "missing" : "wrong_type", "input is the run's input, as POST /agents/{agent_id}/runs takes it: {content}");
  if (value.max_cost_usd !== undefined && !(typeof value.max_cost_usd === "number" && value.max_cost_usd > 0 && Number.isFinite(value.max_cost_usd))) bad("max_cost_usd", "wrong_type", "max_cost_usd is a number above 0");
  if (value.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(value.effort)) bad("effort", "not_an_option", `effort is one of ${EFFORTS.join(", ")}`);
  if (issues.length > before) return undefined;
  return { kind: "start_run", agent_id: value.agent_id as string, input: value.input as Json, ...(typeof value.max_cost_usd === "number" ? { max_cost_usd: value.max_cost_usd } : {}), ...(typeof value.effort === "string" ? { effort: value.effort } : {}) };
}

/** `catchup_window_s` and `max_active_runs`, as given (absent: undefined; `max_active_runs: null`, cleared). */
function settingsOf(body: Json, issues: InputIssue[]): { catchup_window_s?: number; max_active_runs?: number | null } {
  if (body.catchup_window_s !== undefined && !(Number.isSafeInteger(body.catchup_window_s) && (body.catchup_window_s as number) >= 0 && (body.catchup_window_s as number) <= MAX_EVERY_S)) issues.push({ field: "catchup_window_s", reason: "invalid", message: `catchup_window_s is a whole number of seconds, 0 to ${MAX_EVERY_S} (0: a missed time never fires)` });
  const max = body.max_active_runs;
  if (max !== undefined && max !== null && !(Number.isSafeInteger(max) && (max as number) >= 1 && (max as number) <= MAX_ACTIVE_RUNS)) issues.push({ field: "max_active_runs", reason: "invalid", message: `max_active_runs is a whole number, 1 to ${MAX_ACTIVE_RUNS}, or null for none` });
  return { ...(typeof body.catchup_window_s === "number" ? { catchup_window_s: body.catchup_window_s } : {}), ...(typeof max === "number" || max === null ? { max_active_runs: max as number | null } : {}) };
}
const WRITABLE = ["name", "enabled", "source", "target", "catchup_window_s", "max_active_runs"];

/** Why a trigger of `source` and `target` takes no max_active_runs, if it does not: any start_run trigger of a pushed
 *  or polled source does, with or without accept (set, each event starts its own run up to the cap); a schedule keeps
 *  the overlap skip, and a message_run target starts no run to bound. */
function capIssues(adapters: readonly TriggerAdapter[], source: Source, target: Target | undefined): InputIssue[] {
  if (!eventful(adapterIn(adapters, source.kind))) return [{ field: "max_active_runs", reason: "not_allowed", message: "Only a trigger of a pushed or polled source (a webhook, an email) takes max_active_runs: a schedule keeps the overlap skip. Set it to null to clear it." }];
  if (target?.kind === "message_run") return [{ field: "max_active_runs", reason: "not_allowed", message: "max_active_runs bounds the runs a trigger starts, and a message_run target starts none. Set it to null to clear it." }];
  return [];
}

/** A POST /triggers body's own fields, read as create reads them with the sources of `adapters`: its source, target,
 *  settings, name and enabled, with every issue. What it names (the agent, the run) is create's own check
 *  (TriggerDeps.targetIssues). */
function readBody(adapters: readonly TriggerAdapter[], body: Json, now: number) {
  const issues = unknownFields(body, WRITABLE);
  const source = sourceOf(adapters, body.source, now, issues);
  const target = targetOf(body.target, issues);
  const settings = settingsOf(body, issues);
  if (source && typeof settings.max_active_runs === "number") issues.push(...capIssues(adapters, source, target));
  if (body.name !== undefined && !(typeof body.name === "string" && body.name.trim() && body.name.length <= MAX_NAME)) issues.push({ field: "name", reason: "invalid", message: `name is a string of 1 to ${MAX_NAME} characters` });
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") issues.push({ field: "enabled", reason: "wrong_type", message: "enabled is true or false" });
  return { issues, source, target, settings };
}

/** What is wrong with a POST /triggers body by itself, as create refuses it with the sources of `adapters`, all but the
 *  agent or run its target names: a template package's triggers are checked with it before any apply (templates.ts). */
export const triggerBodyIssues = (adapters: readonly TriggerAdapter[], body: Json, now: number): InputIssue[] => readBody(adapters, body, now).issues;

/** A trigger is named once per agent (the store's UNIQUE (agent_id, name)): a second of the same name, at a create or a
 *  rename, is `409 name_taken`; any other error as it is. */
const nameTaken = (error: unknown, name: string): unknown =>
  error instanceof StoreConstraint && error.unique?.table === "triggers" && error.unique.columns.join(",") === "agent_id,name"
    ? new ApiError("name_taken", `This agent already has a trigger named ${name}.`)
    : error;
/** Why a trigger of an archived agent is off, and the 409 for turning one on: the agent by name. */
const archivedDetail = (name: string) => `The agent ${name} is archived: unarchive it, then turn the trigger on.`;
/** Why a trigger is off when the server turned it off, as its row keeps it (`disabled`, JSON). */
const reasonOf = (disabled: unknown): unknown => (isObject(disabled) ? disabled.reason : undefined);
/** Why a try failed, as its firing keeps it: an ApiError's code or a launch hook's (hook_failed), else internal. */
const errorOf = (error: unknown) => ({ code: error instanceof ApiError || error instanceof HookFailed ? error.code : "internal", message: String((error as Error)?.message ?? error) });
/** What a failed firing's reason says of its try: a launch hook's failure and its cause; nothing for the rest. */
const failedReason = (error: unknown): string | undefined => (error instanceof HookFailed ? error.message : undefined);
/** A firing its launch hook's host took (a 2xx) with no run yet: sent with no run, and a startBy, which only such a
 *  firing has. startBy is kept in the retry_at column: no column of its own, no migration. */
const tookWithNoRun = (firing: FiringRow): boolean => firing.status === "sent" && firing.runId === null && firing.startBy !== null;
/** Whether firing `firing` is one its launch hook's host released (Triggers.release). */
const released = (firing: FiringRow): boolean => firing.status === "failed" && firing.error?.code === HOST_RELEASED;
/** The refusal of a host start of firing `firing`, which its host released: its words, and `details.reason`
 *  HOST_RELEASED for a host to match. */
const releasedRefusal = (firing: FiringRow) => {
  const message = `Firing ${firing.key} starts no run: its host released it: ${firing.error?.message ?? ""}`;
  return new ApiError("input_invalid", message, { fields: [{ field: "trigger_firing.firing_id", reason: "not_due", message }], details: { reason: HOST_RELEASED } });
};
/** How long a host start of such a firing holds its trigger's room from its check, at least: a startBy sooner than this
 *  is pushed out to it before the run is written (handedStart), so the window never closes while the run is written. */
const START_WINDOW_MS = 60_000;

/** The room a host start found for its firing (startRoom), held until `release`: `ran` once its run is
 *  written, and the startBy it pushed out (`pushed`, from and to), put back if it writes none. */
type StartRoom = { firing: FiringRow; ran: (run: { run_id: string }) => void; release: () => void; pushed?: { from: number; to: number } };

export class Triggers {
  private readonly store: TriggerDeps["store"];
  private readonly clock: TriggerClock;
  private readonly adapters: readonly TriggerAdapter[];
  private timer?: { clear(): void };
  /** Each arm's turn: a later arm wins over one still reading the store. */
  private arming = 0;
  /** The firings in their turn, queued or being driven, by key, with that turn: a firing is asked for once at a time,
   *  and the timer arms for none of them until its turn ends. */
  private readonly driving = new Map<string, Promise<void>>();
  /** Each trigger's firings, driven one after another in the order asked: a firing's overlap check reads what the one
   *  before it settled to. */
  private readonly turns = new Map<string, Promise<void>>();
  /** Each trigger's firings mid-hand on this server, by key, with how many hold each: drive found room for it (busy) and
   *  has not yet written what came of it (sent, started, a failed try), or a host start is writing its run and has not
   *  yet started the firing with it. Either may hold a firing the other holds (its host starts it before its hook
   *  answers), so a firing leaves only once both let go. busy counts each here, but the one it checks, once with the
   *  store's firings in progress. */
  private readonly handing = new Map<string, Map<string, number>>();
  /** Each trigger's room checks on this server (drive's, a host start's), one after another: a check's hold (handing, a
   *  start_by pushed out) is in place before the next one reads, so two never both take the one place. Removed once idle. */
  private readonly checks = new Map<string, Promise<void>>();
  /** Each firing a host start on this server is writing the run of, by key: that start's run once written, or undefined
   *  when it wrote none. Another start of the firing meanwhile answers that run (handedStart), and its drive waits for it
   *  rather than handing it again. */
  private readonly starting = new Map<string, Promise<{ run_id: string } | undefined>>();
  /** Each trigger's removals and the edits that name a target (the one way it moves to another agent), one after another
   *  on this server: a move never lands between a template update's delete of its Composio instance and its conditional
   *  delete of the row (remove), so a moved trigger never stands on an instance that delete took. Across servers the
   *  store's conditional write holds the row. Removed from the map once idle. */
  private readonly edits = new Map<string, Promise<void>>();
  /** Whether a firing waits for its trigger's room (max_active_runs): the timer then reads the store every WAIT_POLL_MS. */
  private waiting = false;
  /** The triggers whose day-kept keys are at their cap, said once until they are under it again. */
  private readonly seenFull = new Set<string>();
  /** The polled triggers whose poll is running, one at a time each: true when it is a kick's (kick), which a time come
   *  meanwhile waits for (the first poll, the watching start, is never the reason a time is lost); false for a time's own,
   *  which a time come meanwhile skips (a server slower than every_s is never polled back to back). */
  private readonly polling = new Map<string, boolean>();
  /** The polled triggers kicked (kick), or whose time came during a kick's poll, while their poll ran: polled again once
   *  it is done, as a kick's poll (true) when a kick asked for it, else as a time's. */
  private readonly pollAgain = new Map<string, boolean>();
  /** Who waits on the poll after the one running (a kick made while it ran): told when that one is done. */
  private readonly pollWaiters = new Map<string, (() => void)[]>();
  /** Each polled trigger's count of turn-ons: a poll that sees it changed keeps nothing, its cursor read before. */
  private readonly restarts = new Map<string, number>();
  private closed = false;
  /** Aborted by close: a firing being handed to the host is cut short and left due. */
  private readonly stopping = new AbortController();

  constructor(private readonly deps: TriggerDeps) {
    this.store = deps.store;
    this.clock = deps.clock ?? REAL_CLOCK;
    this.adapters = deps.adapters ?? TRIGGER_ADAPTERS;
    // A pushed source's own hook path is its id, beside the trigger ids a hook path also names: none looks like one.
    const shaped = this.adapters.find((a) => a.id.startsWith("trg_"));
    if (shaped) throw new Error(`a trigger source's id never starts as a trigger's does: ${shaped.id}`);
    // A source's id is its kind, its firings' by and, for one pushed on the server's settings, its hook: one source each.
    const twice = this.adapters.find((a, i) => this.adapters.findIndex((b) => b.id === a.id) !== i);
    if (twice) throw new Error(`two trigger sources claim the id ${twice.id}${twice.push ? `, and its hook /v2/hooks/${twice.id}` : ""}: one source each`);
  }

  /** At the server's start: every enabled trigger whose source no longer reads turned off, each failure's trigger.failed
   *  queued that is not yet, each sent firing whose host's run is in the store started with it (relink), every firing an
   *  earlier server left due driven again (its origin key makes a run it already started the same run), the times missed
   *  while it was down recorded, and the timer armed. */
  async start(): Promise<void> {
    const now = this.clock.now();
    await this.offUnreadable((await this.all()).filter((t) => t.enabled && this.problem(t.source)), now);
    await this.relink();
    await this.tick();
  }

  close(): void {
    this.closed = true;
    this.stopping.abort();
    this.timer?.clear();
    this.timer = undefined;
  }

  async list() {
    return { triggers: await Promise.all((await this.all()).map((t) => this.view(t))) };
  }

  async get(id: string) {
    return this.view(await this.need(id));
  }

  async firings(id: string) {
    await this.need(id);
    return { firings: (await this.store.triggers.firings(id)).map(firingView) };
  }

  async create(body: Json, own: TriggerOwn = {}) {
    const now = this.clock.now();
    const { issues, source, target, settings } = readBody(this.adapters, body, now);
    // Checked as its runs are given it: the input, then the line saying what fired it (a name the trigger may yet take).
    if (target) issues.push(...(await this.deps.targetIssues(this.given(typeof body.name === "string" ? body.name.trim() : `trg_${"0".repeat(24)}`, source, target, now))));
    if (issues.length || !source || !target) throw invalid(issues);
    const refused = await this.deps.targetRefusal?.(target);
    if (refused) throw refused;
    const agentId = await this.agentOf(target);
    const id = `trg_${randomBytes(12).toString("hex")}`;
    const enabled = body.enabled !== false;
    // None for an agent being deleted, off too, told before anything is minted or registered upstream (the store's own
    // refusal is the backstop): the delete has listed its triggers already.
    await this.needNotDeleting(agentId);
    if (enabled) await this.needAvailable(source.kind);
    // Never made on for an archived agent: told before anything is minted (the store's own refusal is the backstop).
    if (enabled) await this.needAgentOn(agentId);
    // A scope belongs to one trigger: told before anything is minted or written (the store's scope rows are the backstop).
    if (enabled) await this.scopeFree(source, id);
    const name = typeof body.name === "string" ? body.name.trim() : id;
    const keep = async (kept: Source): Promise<{ row: TriggerRow; minted: Record<string, string> }> => {
      try {
        // Its secrets are kept before the trigger is: one whose secret cannot be kept makes none.
        const minted = await this.mint(kept, id);
        const row = await this.store.triggers.create({ id, agentId, name, enabled, source: kept, target, nextAt: enabled ? nextAfter(this.adapter(kept), kept, now) : null, catchupWindowS: settings.catchup_window_s ?? CATCHUP_WINDOW_S, ...(typeof settings.max_active_runs === "number" ? { maxActiveRuns: settings.max_active_runs } : {}), ...(own.templateId !== undefined ? { templateId: own.templateId } : {}) }, this.scopesOf(kept));
        return { row, minted };
      } catch (error) {
        throw (await this.scopeTaken(error, kept, id)) ?? (await this.archivedRefusal(error)) ?? nameTaken(error, name);
      }
    };
    // What its sender keeps of it is made first (Composio's instance), the trigger saved after, and what was made undone
    // there when it is not saved (the sender's own steps, one project's at a time).
    const upstream = this.deps.upstream?.(source.kind);
    const { row, minted } = upstream ? await upstream.make(source, id, enabled, keep) : await keep(source);
    // Armed before the answer: a create that answered is in effect, its first time on the timer (arm reads the store).
    await this.arm();
    // A polled source polls at once, and is answered once it has (FIRST_POLL_WAIT_MS at most): its first poll, with no
    // cursor, is where it starts watching, so mail after the answer starts runs, and the answer says the check.
    if (enabled) await this.firstPoll(asTrigger(row));
    // What it minted, shown this once, by field: a webhook's `secret`.
    return { ...(await this.view(asTrigger(row))), ...(minted as { secret?: string }) };
  }

  /** A trigger's new signing secret, shown this once; the old one signs nothing from now on. */
  async rotate(id: string): Promise<Record<string, string>> {
    const trigger = await this.need(id);
    const adapter = this.adapter(trigger.source);
    if (!mints(adapter)) throw invalid([{ field: "source.kind", reason: "not_allowed", message: "Only a webhook trigger has a secret." }]);
    return this.mint(trigger.source, id);
  }

  /** Whether `id` is a trigger of the pushed source `kind` that is on: the one a request delivered for `kind` may fire. */
  async hookable(id: string, kind: string): Promise<boolean> {
    return (await this.hookSource(id, kind)) !== undefined;
  }

  /** The source of trigger `id` when it is hookable: what its pushed source's check and parse read (its filter). With no
   *  `kind`, the source of any pushed trigger `id` that is on, so the hook's resolution can read its kind to find its
   *  adapter (push-handler.ts): a path that names no such trigger is checked against the decoy, and learns no id. */
  async hookSource(id: string, kind?: string): Promise<Source | undefined> {
    const row = await this.store.triggers.get(id);
    const trigger = row && asTrigger(row);
    return trigger !== undefined && (kind === undefined || trigger.source.kind === kind) && this.adapter(trigger.source)?.delivery === "push" && trigger.enabled ? trigger.source : undefined;
  }

  /** The triggers of the pushed source `kind` that are on and listen on `scope` (its adapter's scopeOf): the ones an
   *  event there fires. */
  async scoped(kind: string, scope: string): Promise<string[]> {
    const adapter = adapterIn(this.adapters, kind);
    if (!adapter?.scopeOf) return [];
    return this.store.triggers.scoped(kind, scope);
  }

  /** The triggers of the pushed source `kind` that are on, with their sources: the ones a server-wide source whose
   *  triggers choose their own events (its adapter's takes) reads, for each event. */
  async listening(kind: string): Promise<{ id: string; source: Source }[]> {
    return (await this.store.triggers.all()).map(asTrigger).filter((t) => t.enabled && t.source.kind === kind).map((t) => ({ id: t.id, source: t.source }));
  }

  /** Every trigger of source `kind`, on or off, with its name and source: what a source's sender keeps of them is shared
   *  between some (composio-triggers.ts: one Composio instance per server, event and config). */
  async ofKind(kind: string): Promise<{ id: string; name: string; enabled: boolean; source: Source; updatedAt: number }[]> {
    return (await this.store.triggers.all()).map(asTrigger).filter((t) => t.source.kind === kind).map((t) => ({ id: t.id, name: t.name, enabled: t.enabled, source: t.source, updatedAt: t.updatedAt }));
  }

  /** Every trigger of source `kind` that is on, turned off because the connection it needs is gone (`disabled: {reason:
   *  "connection_lost", detail}`), and said; how many. They are kept: on again once it is back. */
  async turnOff(kind: string, detail: string): Promise<number> {
    const on = (await this.store.triggers.all()).map(asTrigger).filter((t) => t.enabled && t.source.kind === kind);
    const at = iso(this.clock.now());
    for (const t of on) {
      await this.store.triggers.update(t.id, { enabled: false, nextAt: null, disabled: { at, reason: "connection_lost", detail } });
      this.deps.say({ condition: "trigger_connection_lost", trigger: t.id, detail });
    }
    if (on.length) await this.arm();
    await this.offThere(on);
    return on.length;
  }

  /** Agent `agentId` archived, and every trigger that runs as it (its rows: a start_run of it, a message_run to one of its
   *  runs) turned off with it in the store's one transaction (`disabled: {reason: "agent_archived", detail}`), and said;
   *  which, by name. From that commit no firing starts a run of it (store.triggers.fire refuses one, and drive skips). */
  async agentArchived(agentId: string): Promise<{ id: string; name: string }[]> {
    const name = (await this.store.agents.get(agentId))?.name ?? agentId;
    const off = await this.store.agents.archive(agentId, true, { at: iso(this.clock.now()), reason: "agent_archived", detail: archivedDetail(name) });
    for (const t of off) this.deps.say({ condition: "trigger_agent_archived", trigger: t.id, agent: agentId });
    if (off.length) await this.arm();
    await this.offThere((await Promise.all(off.map((t) => this.find(t.id)))).filter((t): t is Trigger => t !== undefined));
    return off;
  }

  /** Agent `agentId` unarchived: none of its triggers turns on again, but those its archive turned off whose source
   *  `turnOn` takes, each turned on as a PATCH with enabled true does (an API-only server's with the launch hook, which
   *  serves no trigger route: api-only.ts). The triggers its archive turned off that are off still, by name: each is
   *  turned on by a PATCH. One `turnOn` takes that can't be on (a schedule with no time left), or that its first check
   *  turns off again, is named: what is off is read from the store after the turn-ons, never taken from whether one
   *  resolved. */
  async agentUnarchived(agentId: string, turnOn: (source: Source) => boolean = () => false): Promise<{ id: string; name: string }[]> {
    await this.store.agents.archive(agentId, false);
    const off = (await this.store.triggers.list(agentId)).map(asTrigger).filter((t) => !t.enabled && reasonOf(t.disabled) === "agent_archived");
    for (const t of off) if (turnOn(t.source)) await this.update(t.id, { enabled: true }, { onAgent: agentId }).catch(() => undefined);
    const ids = new Set(off.map((t) => t.id));
    return (await this.store.triggers.list(agentId)).filter((t) => ids.has(t.id) && !t.enabled).map((t) => ({ id: t.id, name: t.name }));
  }

  /** Refused (409 agent_archived) when agent `agentId` is archived: a trigger made on, turned on or aimed at it. */
  private async needAgentOn(agentId: string): Promise<void> {
    const agent = await this.store.agents.get(agentId);
    if (agent?.archivedAt != null) throw new ApiError("agent_archived", archivedDetail(agent.name));
  }

  /** Refused (409 agent_not_runnable, agents.ts agentDeleting) when agent `agentId` is being deleted: another system's
   *  agent with an archive time, which only its delete writes (agent-delete.ts); and 410 purged once it is purged (a
   *  purge that commits past this is the store's to refuse, AgentPurged). */
  private async needNotDeleting(agentId: string): Promise<void> {
    const agent = await this.store.agents.get(agentId);
    if (agent?.purgedAt != null) throw purgedAgent(agent);
    if (agent?.archivedAt != null && ownedElsewhere(agent)) throw agentDeleting(agentId);
  }

  /** The store's refusal of a trigger left on for an archived agent (an archive that committed past needAgentOn) as the
   *  same 409; undefined for any other error. */
  private async archivedRefusal(error: unknown): Promise<ApiError | undefined> {
    if (!(error instanceof AgentArchived)) return undefined;
    return new ApiError("agent_archived", archivedDetail((await this.store.agents.get(error.agentId))?.name ?? error.agentId));
  }

  /** Why a firing of a trigger of agent `agentId` is skipped, if it is: the agent is archived. */
  private async archivedSkip(agentId: string): Promise<string | undefined> {
    const agent = await this.store.agents.get(agentId);
    return agent?.archivedAt != null ? `The agent ${agent.name} is archived.` : undefined;
  }

  /** Refused as its connection says when a trigger of `kind` cannot be on here (unavailable). */
  private async needAvailable(kind: string): Promise<void> {
    const refusal = await this.deps.unavailable?.(kind);
    if (refusal) throw refusal;
  }

  /** A verified request for trigger `id` that its filter ignored, under the key its event would have: an `ignored` row
   *  kept for its day and never in the history, so the same request sent again under another label answers duplicate. A
   *  write that fails is said, and the request is still answered. */
  async ignored(id: string, eventId: string): Promise<void> {
    try {
      const trigger = await this.need(id);
      const by = trigger.source.kind;
      await this.record(trigger, { key: firingKey(by, id, eventId), by, nominalAt: Math.floor(this.clock.now() / 1000) * 1000, status: "ignored", shown: false });
    } catch (error) {
      this.deps.say({ condition: "triggers_unwritable", trigger: id, error: String((error as Error)?.message ?? error) });
    }
  }

  /** A delivered request for trigger `id` (its pushed source's checks passed, server.ts): its firing, keyed by the
   *  sender's own id for it (a webhook's `webhook-id`), with what its source says of it (`attrs`), recorded due in one
   *  write and driven after the answer. `created` false: that id's firing, as it stands, or `{ok: "duplicate"}` for a
   *  request ignored within its day. */
  async receive(id: string, eventId: string, payload: string, attrs?: Record<string, string>): Promise<{ created: boolean; firing: ReturnType<typeof firingView> | { ok: "duplicate" } }> {
    const trigger = await this.need(id);
    const by = trigger.source.kind;
    const key = firingKey(by, id, eventId);
    const now = this.clock.now();
    const recorded = await this.record(trigger, { key, by, nominalAt: Math.floor(now / 1000) * 1000, status: "due", payload: cut(payload), ...(attrs && Object.keys(attrs).length ? { attrs } : {}) }, { room: true });
    if (recorded.created) void this.inTurn(id, key);
    if (!recorded.created && recorded.firing.status === "ignored") return { created: false, firing: { ok: "duplicate" } };
    return { created: recorded.created, firing: firingView(recorded.firing) };
  }

  /** PATCH: any of name, enabled, source, target, catchup_window_s and max_active_runs. Enabled again, or its source changed, a trigger goes on from now: a
   *  paused range is skipped, never caught up. Only the fields named change, applied to the trigger as it stands once
   *  the target's check is done: an edit made meanwhile keeps its own. */
  async update(id: string, body: Json, own: TriggerOwn = {}) {
    return isObject(body) && body.target !== undefined ? this.one(id, () => this.updating(id, body, own)) : this.updating(id, body, own);
  }

  private async updating(id: string, body: Json, own: TriggerOwn) {
    // A source is written only on the row it was checked against (its updatedAt): another write meanwhile (the
    // after-start seal's, a poll's next time) checks it again on the row as it is then, so a source read before a seal
    // never writes the clear value back over it.
    for (let tries = 1; ; tries++) {
      const done = await this.updateOnce(id, body, tries < SOURCE_EDIT_TRIES, own);
      if (done) return done;
    }
  }

  /** One try of `update`: undefined when its source write was refused because the trigger changed since it was read and
   *  `retry` (try again); refused on the last try, precondition_failed. */
  private async updateOnce(id: string, body: Json, retry: boolean, own: TriggerOwn) {
    const was = await this.need(id, own.onAgent);
    const issues = unknownFields(body, WRITABLE);
    let source = body.source === undefined ? undefined : sourceOf(this.adapters, body.source, this.clock.now(), issues);
    const target = body.target === undefined ? undefined : targetOf(body.target, issues);
    const settings = settingsOf(body, issues);
    // A cap kept, or set, needs a pushed source and a target that starts runs: a PATCH that aims a capped trigger at a run
    // is refused unless it also sends max_active_runs: null. Taking accept away keeps it.
    const cap = settings.max_active_runs === undefined ? was.maxActiveRuns : settings.max_active_runs;
    if (typeof cap === "number" && (source || target || typeof settings.max_active_runs === "number")) issues.push(...capIssues(this.adapters, source ?? was.source, target ?? was.target));
    if (body.name !== undefined && !(typeof body.name === "string" && body.name.trim() && body.name.length <= MAX_NAME)) issues.push({ field: "name", reason: "invalid", message: `name is a string of 1 to ${MAX_NAME} characters` });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") issues.push({ field: "enabled", reason: "wrong_type", message: "enabled is true or false" });
    if (target) issues.push(...(await this.deps.targetIssues(this.given(typeof body.name === "string" ? body.name.trim() : was.name, source ?? was.source, target, this.clock.now()))));
    if (issues.length || (body.source !== undefined && !source) || (body.target !== undefined && !target)) throw invalid(issues);
    const refused = target ? await this.deps.targetRefusal?.(target) : undefined;
    if (refused) throw refused;
    const trigger = await this.need(id, own.onAgent);
    if (source && source.kind !== trigger.source.kind) throw invalid([{ field: "source.kind", reason: "not_allowed", message: "A trigger's source kind is fixed: make a new trigger for another." }]);
    // What its sender keeps of it stays as it was made (Composio's instance): only what reads it here changes.
    const upstream = this.deps.upstream?.(trigger.source.kind);
    if (source && upstream) source = upstream.patched(trigger.source, source);
    const now = this.clock.now();
    const enabled = typeof body.enabled === "boolean" ? body.enabled : trigger.enabled;
    const adapter = this.adapter(trigger.source);
    const problem = enabled && !source ? this.problem(trigger.source) : undefined;
    if (problem) throw invalid([{ field: "source", reason: "invalid", message: `This ${adapter.label} no longer reads (${problem}): give it a new source.` }]);
    const next = !enabled ? null : source || !trigger.enabled ? nextAfter(this.adapter(source ?? trigger.source), source ?? trigger.source, now) : trigger.nextAt;
    if (enabled && next === null && adapter.delivery === "clock") throw invalid([{ field: "enabled", reason: "invalid", message: `This ${adapter.label} has no time left to fire at: give it a new source.` }]);
    // On again, a trigger starts a new streak: a failure streak that turned it off is behind it.
    const again: TriggerPatch = enabled && !trigger.enabled ? { failuresInARow: 0, disabled: null } : {};
    const scopeSource = source ?? trigger.source;
    if (enabled && (!trigger.enabled || source)) await this.needAvailable(scopeSource.kind);
    if (enabled) await this.scopeFree(scopeSource, trigger.id);
    // A trigger belongs to its target's agent: aimed at another agent (or another agent's run), it moves to that agent,
    // whose one name per trigger and list of triggers it joins.
    const agentId = target ? await this.agentOf(target) : trigger.agentId;
    // Moved to an agent being deleted, off too, or turned on for one: never (the store's own refusal is the backstop).
    if (agentId !== trigger.agentId || (enabled && !trigger.enabled)) await this.needNotDeleting(agentId);
    // Turned on, or aimed elsewhere while on: never for an archived agent (the store's own refusal is the backstop).
    if (enabled && (!trigger.enabled || target)) await this.needAgentOn(agentId);
    // A polled source turned on again starts over: a poll still running from before is not its own any more.
    const polls = enabled && adapter.poll !== undefined && (!trigger.enabled || source !== undefined);
    if (polls && !trigger.enabled) this.restarts.set(id, (this.restarts.get(id) ?? 0) + 1);
    // Moved to another agent, it is no package's (its mark cleared in the same write): a template update of the agent it
    // left, or of the one it was moved back to, never takes it for one of its own. Kept in place by an apply, it is marked.
    const patch: TriggerPatch = {
      ...(agentId !== trigger.agentId ? { agentId, templateId: null } : own.templateId !== undefined ? { templateId: own.templateId } : {}),
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}), ...(source ? { source } : {}), ...(target ? { target } : {}),
      ...(settings.catchup_window_s !== undefined ? { catchupWindowS: settings.catchup_window_s } : {}),
      ...(settings.max_active_runs !== undefined ? { maxActiveRuns: settings.max_active_runs } : {}), ...again, enabled, nextAt: next,
    };
    const conditions = { ...(source ? { ifUpdatedAt: trigger.updatedAt, ifSource: trigger.source } : {}), ...(own.onAgent !== undefined ? { ifAgent: own.onAgent } : {}) };
    const row = await this.store.triggers.update(id, patch, enabled ? this.scopesOf(scopeSource) : [], Object.keys(conditions).length ? conditions : undefined).catch(async (error: unknown) => {
      throw (await this.scopeTaken(error, scopeSource, trigger.id)) ?? (await this.archivedRefusal(error)) ?? nameTaken(error, patch.name ?? trigger.name);
    });
    const still = !row && source ? await this.store.triggers.get(id) : undefined;
    if (still && (own.onAgent === undefined || still.agentId === own.onAgent)) {
      if (retry) return undefined;
      throw new ApiError("precondition_failed", "the trigger kept changing while this edit was checked: read it again, then send the edit again");
    }
    if (!row) throw new ApiError("not_found", `no trigger ${id}`);
    // Turned on again, a polled source forgets its cursor and last check, so its first poll watches from now, and is
    // answered once it has (as a create is); an edit of its source keeps the cursor (a poll whose cursor was read on
    // another mailbox or account starts over itself) and polls at once, unawaited: that poll may start runs.
    if (polls && !trigger.enabled) await this.deps.settings(adapter.id)?.remove(id);
    await this.arm();
    if (polls && !trigger.enabled) await this.firstPoll(asTrigger(row));
    else if (polls) void this.kick(asTrigger(row));
    // Turned on or off by the owner: the same at its sender, once it holds here; what could not be done there is said.
    const said = upstream && enabled !== trigger.enabled ? await upstream.turned(row.source as Source, id, enabled) : undefined;
    return { ...(await this.view(asTrigger(row))), ...said };
  }

  /** The trigger deleted, and what its sender keeps of it removed after (said, when it could not be: the delete holds).
   *  On its agent's condition (`onAgent`: a template update's removal), what its sender keeps goes first: one its sender
   *  did not remove is said, and the trigger is kept here as it was (its row, its package mark, its sealed config and
   *  whether it is on), for the next update to remove; once it is gone there, the trigger goes here while it is still that
   *  agent's, then what its sender kept here for it. */
  async remove(id: string, own: Pick<TriggerOwn, "onAgent"> = {}): Promise<Json | undefined> {
    return this.one(id, () => this.removing(id, own));
  }

  private async removing(id: string, own: Pick<TriggerOwn, "onAgent">): Promise<Json | undefined> {
    const trigger = await this.need(id, own.onAgent);
    const upstream = this.deps.upstream?.(trigger.source.kind);
    if (own.onAgent === undefined) {
      await this.dropHere(trigger);
      return upstream?.removed(trigger.source, id);
    }
    const here = () => this.dropHere(trigger, own.onAgent);
    if (!upstream) return void (await here());
    const said = await upstream.removedThere(trigger.source, id, here);
    if (said !== undefined) return said;
    await upstream.forgotten(trigger.source, id);
    return undefined;
  }

  /** `value` as a create keeps a source (its adapter's defaults filled in: a feed's every_s), or undefined when a create
   *  would refuse it. */
  sourceAsKept(value: unknown): Source | undefined {
    const issues: InputIssue[] = [];
    const source = sourceOf(this.adapters, value, this.clock.now(), issues);
    return issues.length ? undefined : source;
  }

  /** A deleted agent's trigger (agent-delete.ts), its first half: what its sender keeps of it removed there, the trigger
   *  kept here, so a failure, or a stop before the second half (removeHere), leaves the row that names what is left to
   *  remove for the next delete to find. Throws `unavailable` with what could not be done there. */
  async removeThere(id: string): Promise<void> {
    const trigger = await this.need(id);
    const said = await this.deps.upstream?.(trigger.source.kind)?.removed(trigger.source, id);
    if (said === undefined) return;
    const notes = isObject(said) ? Object.values(said).flatMap((one) => (isObject(one) && typeof one.note === "string" ? [one.note] : [])) : [];
    throw new ApiError("unavailable", `What ${trigger.source.kind} keeps of the trigger ${id} is not removed there yet${notes.length ? ` (${notes.join(" ")})` : ""}.`, { retry_after_ms: 5_000 });
  }

  /** The second half's first part, once removeThere is done: the trigger's adapter settings removed, its row kept. */
  async removeSettings(id: string): Promise<void> {
    await this.dropSettings(await this.need(id));
  }

  /** The second half, once removeThere is done: the trigger deleted here, its adapter settings and then its row. */
  async removeHere(id: string): Promise<void> {
    await this.dropHere(await this.need(id));
  }

  /** A trigger's adapter settings (a webhook's secret, a poll's cursor) removed; nothing else of it. */
  private async dropSettings(trigger: Trigger): Promise<void> {
    if (this.adapter(trigger.source)?.settings?.scope === "trigger") await this.deps.settings(trigger.source.kind)?.remove(trigger.id);
  }

  /** The trigger's settings and row removed. Without `onAgent`, its settings first, then its row: the settings have no
   *  link to the row, so a failure or a stop between the two leaves the row, which the next remove finds, never settings
   *  with no trigger left to name them. With `onAgent` (a template update's removal), the row first, on its agent's
   *  condition compared in the delete, then its settings: a trigger moved to another agent meanwhile keeps both. A stop
   *  between the two there leaves settings no row names (keyed by an id never used again), never a moved trigger
   *  without its own. */
  private async dropHere(trigger: Trigger, onAgent?: string): Promise<void> {
    if (onAgent === undefined) {
      await this.dropSettings(trigger);
      await this.store.triggers.remove(trigger.id);
    } else {
      if (!(await this.store.triggers.remove(trigger.id, { ifAgent: onAgent }))) throw new ApiError("not_found", `no trigger ${trigger.id} on the agent ${onAgent}`);
      await this.dropSettings(trigger);
    }
    await this.arm();
  }

  /** Run now: one firing per Idempotency-Key, driven before the answer. `created` false: the key's firing, as it stands. */
  async fire(id: string, idempotencyKey: string): Promise<{ created: boolean; firing: ReturnType<typeof firingView> }> {
    const trigger = await this.need(id);
    const key = firingKey("manual", id, idempotencyKey);
    const now = this.clock.now();
    const recorded = await this.record(trigger, { key, by: "manual", nominalAt: Math.floor(now / 1000) * 1000, status: "due" }, { room: true });
    if (!recorded.created) return { created: false, firing: firingView(recorded.firing) };
    await this.inTurn(id, key);
    return { created: true, firing: firingView((await this.store.triggers.firing(id, key)) ?? recorded.firing) };
  }

  // ---- the timer and the firings --------------------------------------------------------------------------------------

  /** Every enabled trigger whose next time has come: its firings recorded and its next time moved on, in one write each;
   *  then each failure's trigger.failed queued that is not yet, each due firing whose time has come driven, each waiting
   *  firing whose trigger has room again driven (one read for all of them), and the timer armed again. */
  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.closed) return;
    const now = this.clock.now();
    try {
      const due = (await this.all()).filter((t) => t.enabled && t.nextAt !== null && t.nextAt <= now);
      // One whose source no longer reads is turned off alone, so it neither stalls the others nor reads as a failure.
      const unreadable = due.filter((t) => this.problem(t.source));
      await this.offUnreadable(unreadable, now);
      for (const trigger of due) if (!unreadable.includes(trigger)) await this.advance(trigger, now);
      for (const firing of await this.store.triggers.pending()) {
        if (firing.status === "failed") await this.notifyFailed(firing.triggerId, firing.key);
        else if (firing.waitsOn === null && !this.driving.has(firing.key) && (firing.retryAt === null || firing.retryAt <= now)) void this.inTurn(firing.triggerId, firing.key);
      }
      const waiting = await this.store.triggers.waiting(now);
      this.waiting = waiting.length > 0;
      for (const firing of waiting) if (firing.free && !this.driving.has(firing.key)) void this.inTurn(firing.triggerId, firing.key);
    } catch (error) {
      // The store did not answer: the timer tries again after the backoff table's first wait.
      this.deps.say({ condition: "triggers_unreadable", error: String((error as Error)?.message ?? error) });
      if (!this.closed) this.timer = this.clock.arm(() => void this.tick(), BACKOFF_MS[0]);
      return;
    }
    await this.arm();
  }

  /** `work` on trigger `id` once every edit or removal of it asked before has settled (edits). Neither update nor remove
   *  calls the other, so a turn never waits on itself. Only a target edit takes a turn: any other edit runs beside one, as
   *  concurrent edits each keep their change (trigger-engine.test.mjs, two edits at once, one a target whose check is
   *  slow: the source edit lands while the target's check waits). One racing a removal writes its row while the row is
   *  there, or finds it gone (not_found): the store's update changes no row a delete took. */
  private one<T>(id: string, work: () => Promise<T>): Promise<T> {
    const done = (this.edits.get(id) ?? Promise.resolve()).then(work);
    const turn = done.then(() => undefined, () => undefined);
    this.edits.set(id, turn);
    void turn.then(() => {
      if (this.edits.get(id) === turn) this.edits.delete(id);
    });
    return done;
  }

  /** `check` on trigger `triggerId` once every room check of it asked before has settled (checks). A check reads the store
   *  and holds what it found (hold, a start_by pushed out); it never waits on a hook or a start. */
  private checked<T>(triggerId: string, check: () => Promise<T>): Promise<T> {
    const done = (this.checks.get(triggerId) ?? Promise.resolve()).then(check);
    const turn = done.then(() => undefined, () => undefined);
    this.checks.set(triggerId, turn);
    void turn.then(() => {
      if (this.checks.get(triggerId) === turn) this.checks.delete(triggerId);
    });
    return done;
  }

  /** Firing `key` of `triggerId` held mid-hand (handing) until the returned release, counted: held while any of its
   *  holders has not released. A release lets go once, however often it is called. */
  private hold(triggerId: string, key: string): () => void {
    let keys = this.handing.get(triggerId);
    if (!keys) this.handing.set(triggerId, (keys = new Map()));
    const held = keys;
    held.set(key, (held.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = held.get(key)! - 1;
      if (left > 0) return void held.set(key, left);
      held.delete(key);
      if (held.size === 0 && this.handing.get(triggerId) === held) this.handing.delete(triggerId);
    };
  }

  /** `key`'s firing driven after every firing of its trigger asked before it. */
  private inTurn(triggerId: string, key: string): Promise<void> {
    const known = this.driving.get(key);
    if (known) return known;
    const turn = (this.turns.get(triggerId) ?? Promise.resolve()).then(() => this.drive(triggerId, key));
    this.turns.set(triggerId, turn);
    this.driving.set(key, turn);
    void turn.finally(() => {
      this.driving.delete(key);
      if (this.turns.get(triggerId) === turn) this.turns.delete(triggerId);
      // A firing still due after its turn (a retry) is armed for again.
      void this.arm();
    });
    return turn;
  }

  /** Each of `triggers` turned off, with why its source no longer reads, and said. */
  private async offUnreadable(triggers: Trigger[], now: number): Promise<void> {
    for (const t of triggers) {
      const detail = this.problem(t.source)!;
      await this.store.triggers.update(t.id, { enabled: false, nextAt: null, disabled: { at: iso(now), reason: "source_unreadable", detail } });
      this.deps.say({ condition: "trigger_source_unreadable", trigger: t.id, error: detail });
    }
    await this.offThere(triggers);
  }

  /** Records `trigger`'s firings up to now and moves its next time on from the last nominal one, in one write. Of the
   *  times that have come, the latest fires (on time, or late within catchup_window_s: a catch-up, under its own nominal
   *  key), and every other is one `missed` row with their count. A one-time schedule, or one that never fires again, is
   *  turned off. */
  private async advance(trigger: Trigger, now: number): Promise<void> {
    const adapter = this.adapter(trigger.source);
    // A pushed source has no next time, so it is never here.
    const clock = adapter.clock?.(trigger.source);
    if (!clock) return;
    if (adapter.poll) return this.pollDue(trigger, adapter, clock, now);
    const by = adapter.id;
    const windowMs = (trigger.catchupWindowS ?? CATCHUP_WINDOW_S) * 1000;
    const first = trigger.nextAt!;
    const last = clock.latest(first, now);
    const nextOf = (after: number) => {
      const at = clock.next(after);
      return at !== null && Number.isFinite(at) && Math.abs(at) <= DATE_MAX_MS ? at : null;
    };
    // The times from first to last: an interval's counted on its grid, a cron line's walked, at most MISSED_COUNTED.
    let count = 1;
    let capped = false;
    if (clock.step) count += (last - first) / clock.step;
    else for (let at = first; at < last; count++) {
      if (count === MISSED_COUNTED) {
        capped = true;
        break;
      }
      at = nextOf(at) ?? last;
    }
    const late = now - last;
    const fires = late <= LATE_MS || late <= windowMs;
    // Capped, the times counted are all before the last: every one of them was missed, and more besides.
    const missed = capped || !fires ? count : count - 1;
    // Every time reckoned before anything is written: a source that throws leaves the trigger as it was.
    const next = nextOf(last);
    const firings: NewFiring[] = [];
    if (missed > 0) firings.push({ key: firingKey(by, trigger.id, `missed\n${second(first)}`), by, nominalAt: first, status: "missed", count: missed, reason: `The server was down or its timer late: ${missed === 1 && !capped ? "this time was" : `${missed}${capped ? " or more" : ""} times from this one were`} not fired.` });
    // A full trigger skips its time, never queues a 21st.
    const full = (await this.store.triggers.pending()).filter((f) => f.triggerId === trigger.id && f.status === "due").length >= DUE_KEPT;
    if (fires) firings.push({ key: firingKey(by, trigger.id, second(last)), by, nominalAt: last, ...(full ? { status: "skipped" as const, reason: `${DUE_KEPT} earlier firings are still waiting to reach the run.` } : { status: "due" as const }), ...(late > LATE_MS ? { catchUp: true } : {}) });
    await this.store.triggers.record(trigger.id, firings, { patch: { nextAt: next, ...(next === null ? { enabled: false } : {}) } });
    await this.prune(trigger);
  }

  /** A polled source's time come: its next time moved on from the latest that has come (a time it was not there for is no
   *  `missed` row: what came meanwhile is still there to read), then its poll, off the timer, so a slow server never
   *  holds the other triggers. With one still running for it: once that one is done when it is a kick's (pollDone),
   *  else skipped. */
  private async pollDue(trigger: Trigger, adapter: TriggerAdapter, clock: Clock, now: number): Promise<void> {
    const last = clock.latest(trigger.nextAt!, now);
    const next = clock.next(last);
    await this.store.triggers.update(trigger.id, { nextAt: next !== null && Number.isFinite(next) && Math.abs(next) <= DATE_MAX_MS ? next : null });
    const running = this.polling.get(trigger.id);
    if (running !== undefined) return void (running && !this.pollAgain.has(trigger.id) && this.pollAgain.set(trigger.id, false));
    this.polling.set(trigger.id, false);
    void this.polled(trigger, adapter, last, now).finally(() => this.pollDone(trigger.id));
  }

  /** A poll of `trigger` now, answered once the poll that answers it is done: its own, or, when an edit of its source
   *  drops its result (polled), the one after it, which it asks for at once; when one is running, the one after that. */
  private kick(trigger: Trigger, waitedFor = true): Promise<void> {
    const adapter = this.adapter(trigger.source);
    if (!adapter.poll || this.closed) return Promise.resolve();
    if (this.polling.has(trigger.id)) {
      this.pollAgain.set(trigger.id, true);
      return new Promise<void>((done) => this.pollWaiters.set(trigger.id, [...(this.pollWaiters.get(trigger.id) ?? []), done]));
    }
    const now = this.clock.now();
    this.polling.set(trigger.id, waitedFor);
    return this.polled(trigger, adapter, now, now).then(
      (kept) => {
        // Dropped for an edit of its source: the poll after it (the edit's) runs at once, and is the one this answers by.
        const after = kept || this.closed ? undefined : new Promise<void>((done) => this.pollWaiters.set(trigger.id, [...(this.pollWaiters.get(trigger.id) ?? []), done]));
        if (after) this.pollAgain.set(trigger.id, true);
        this.pollDone(trigger.id);
        return after;
      },
      (error: unknown) => {
        this.deps.say({ condition: "trigger_poll_unrecorded", trigger: trigger.id, error: String((error as Error)?.message ?? error) });
        this.pollDone(trigger.id);
      },
    );
  }

  /** `trigger`'s first poll (made, or turned on again) kicked and waited on, FIRST_POLL_WAIT_MS at most. */
  private async firstPoll(trigger: Trigger): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((done) => {
      timer = setTimeout(done, FIRST_POLL_WAIT_MS);
      timer.unref?.();
    });
    await Promise.race([this.kick(trigger), bound]).finally(() => clearTimeout(timer));
  }

  /** `id`'s poll done: a kick, or a time come during a kick's poll, polls now, once however many came, the trigger read
   *  again (on, and as it is now). A time come during this one skips, as during a time's own. */
  private pollDone(id: string): void {
    this.polling.delete(id);
    const again = this.pollAgain.get(id);
    this.pollAgain.delete(id);
    const waiters = this.pollWaiters.get(id) ?? [];
    this.pollWaiters.delete(id);
    const told = () => waiters.forEach((done) => done());
    if (again === undefined || this.closed) return told();
    void this.find(id).then((trigger) => (trigger?.enabled ? this.kick(trigger, again) : undefined)).then(told, (error: unknown) => {
      this.deps.say({ condition: "trigger_poll_unrecorded", trigger: id, error: String((error as Error)?.message ?? error) });
      told();
    });
  }

  /** One poll of `trigger`'s source for its time `nominalAt`: each event it found recorded in order (its note a skipped
   *  history line; one it leaves, skipped and said; one its accept does not take, an ignored row kept for its day; any
   *  other due, and driven), its cursor kept once they are, then its last check, and at the REFUSALS_TO_STOPth refused
   *  sign-in in a row the trigger turned off. A poll that throws is a failed check. */
  /** False when an edit of its source while it polled dropped what it found, or landed while its cursor was written and
   *  left its stop and its check unwritten (the edit's poll comes after it); else true. */
  private async polled(trigger: Trigger, adapter: TriggerAdapter, nominalAt: number, now: number): Promise<boolean> {
    const settings = this.deps.settings(adapter.id);
    // Turned on again while it polled (off and on): its cursor was forgotten, and nothing this poll found is its own.
    const generation = this.restarts.get(trigger.id);
    const restarted = () => this.restarts.get(trigger.id) !== generation;
    let result: PollResult;
    try {
      result = await adapter.poll!(trigger.source, { trigger: trigger.id, setting: (field) => settings?.get(trigger.id, field), credentials: async () => this.deps.credentials?.(adapter.id) });
    } catch (error) {
      result = { check: { ok: false, message: String((error as Error)?.message ?? error) } };
    }
    if (this.closed) return true;
    try {
      // Edited, turned off or deleted while it polled: nothing it found is kept. An edit of its source polls again.
      const current = await this.find(trigger.id);
      if (!current || !current.enabled || restarted()) return true;
      if (JSON.stringify(current.source) !== JSON.stringify(trigger.source)) return false;
      const by = adapter.id;
      const at = Math.floor(nominalAt / 1000) * 1000;
      if (result.note) await this.record(current, { key: firingKey(by, trigger.id, `note\n${second(nominalAt)}`), by, nominalAt: at, status: "skipped", reason: result.note });
      const events = result.events ?? [];
      // The last event recorded: the cursor is its once they are (each event's is read only here, once: a source may make
      // it when asked, as the feed's does).
      let last: (typeof events)[number] | undefined;
      let full = false;
      for (const event of events) {
        const key = firingKey(by, trigger.id, event.key);
        const attrs = event.attrs && Object.keys(event.attrs).length ? { attrs: event.attrs } : {};
        const refused = event.left ? undefined : adapter.takes?.(current.source, event);
        try {
          if (event.left) await this.record(current, { key, by, nominalAt: at, status: "skipped", reason: event.left, ...attrs });
          else if (refused) await this.record(current, { key, by, nominalAt: at, status: "ignored", shown: false, ...attrs });
          else {
            const recorded = await this.record(current, { key, by, nominalAt: at, status: "due", payload: cut(event.text), ...attrs }, { room: true });
            if (recorded.created) void this.inTurn(trigger.id, key);
          }
        } catch (error) {
          // Full (DUE_KEPT firings still due): this event and those after it wait for the next poll, the cursor before it.
          if (!(error instanceof ApiError && error.code === "rate_limited")) throw error;
          full = true;
          break;
        }
        last = event;
      }
      const cursor = !events.length ? result.cursor : full ? last?.cursor : (result.cursor ?? last?.cursor);
      if (restarted()) return true;
      for (const [field, value] of Object.entries(cursor ?? {})) await settings?.set(trigger.id, field, value);
      // Edited, turned off or on again while its cursor was written: its stop, a refusal's turn-off and its check were read
      // on the source as it was. None is applied; an edit's poll, after this one, says what holds now.
      const still = await this.find(trigger.id);
      if (!still || !still.enabled || restarted()) return true;
      if (JSON.stringify(still.source) !== JSON.stringify(trigger.source)) return false;
      const refusals = result.refused ? (checkOf(settings?.get(trigger.id, LAST_CHECK))?.refused ?? 0) + 1 : 0;
      if (result.refused && refusals >= REFUSALS_TO_STOP) {
        await this.store.triggers.update(trigger.id, { enabled: false, nextAt: null, disabled: { at: iso(this.clock.now()), reason: "sign_in_refused", detail: result.refused.detail } });
        this.deps.say({ condition: "trigger_sign_in_refused", trigger: trigger.id, refused: refusals });
        await this.arm();
      }
      // Its source can't be read again as it is (every feed gone): off now, in its words, until an owner edits it and
      // turns it on again. Before its last check is written, as a refused sign-in's is: a check that says so is never read
      // beside a trigger still on.
      if (result.stop && !result.refused) {
        await this.store.triggers.update(trigger.id, { enabled: false, nextAt: null, disabled: { at: iso(this.clock.now()), reason: "source_unreadable", detail: result.stop.detail } });
        this.deps.say({ condition: "trigger_source_unreadable", trigger: trigger.id, error: result.stop.detail });
        await this.offThere([current]);
        await this.arm();
      }
      const message = full ? `${result.check.message} ${DUE_KEPT} firings are still waiting for their runs: the rest wait for the next check.` : result.check.message;
      await settings?.set(trigger.id, LAST_CHECK, JSON.stringify({ at: iso(now), ok: result.check.ok, message, refused: refusals }));
      if (!result.check.ok) this.deps.say({ condition: "trigger_check_failed", trigger: trigger.id, error: result.check.message });
    } catch (error) {
      this.deps.say({ condition: "trigger_poll_unrecorded", trigger: trigger.id, error: String((error as Error)?.message ?? error) });
    }
    return true;
  }

  /** A firing taken from due to its end: skipped when its trigger's last run is active, else its run started (or its
   *  message sent). A failed try keeps it due under the backoff table, or ends it failed. Each step reads the trigger and
   *  the firing again: either may be edited or deleted meanwhile. */
  private async drive(triggerId: string, key: string): Promise<void> {
    if (this.closed) return;
    try {
      const firing = await this.store.triggers.firing(triggerId, key);
      if (!firing || firing.status !== "due") return;
      // Its run already started (the store has its key) is its run, whatever runs now.
      const prior = await this.deps.runOf(key);
      if (this.closed) return;
      if (prior) return void (await this.started(triggerId, key, prior.run_id));
      const trigger = await this.find(triggerId);
      if (!trigger) return;
      // Its agent archived since the firing was recorded (a firing waiting on its cap, or due on a retry): skipped, never a
      // run or a message.
      const archived = await this.archivedSkip(trigger.agentId);
      if (this.closed) return;
      if (archived) return void (await this.store.triggers.settle(triggerId, key, { status: "skipped", reason: archived }));
      if (trigger.target.kind === "message_run") return void (await this.send(trigger, firing));
      // Room found is held (handing) until what came of it is written: a host start meanwhile counts this firing. The
      // firing is read again in the check: a host start may have started it since, or be writing its run. One being
      // written is left as it is (its retry kept, no wait written): that start starts it, or, writing no run, arms the
      // timer again for its retry (startHold).
      const claimed = await this.checked(triggerId, async () => {
        const now = await this.store.triggers.firing(triggerId, key);
        if (!now || now.status !== "due" || this.starting.has(key)) return { gone: true as const };
        return (await this.busy(trigger, now)) ?? this.hold(triggerId, key);
      });
      if (typeof claimed !== "function") {
        if (this.closed || "gone" in claimed) return;
        if ("skipped" in claimed) return void (await this.store.triggers.settle(triggerId, key, { status: "skipped", reason: claimed.skipped }));
        return void (await this.wait(triggerId, key, claimed.waitsOn, claimed.reason));
      }
      try {
        await this.roomFound(triggerId, firing);
      } finally {
        claimed();
      }
    } catch (error) {
      if (this.closed) return;
      await this.failedTry(triggerId, key, error);
    }
  }

  /** A start_run firing drive found room for: its run started, or it handed to the launch hook's host, on the target as it
   *  is now (an edit during the overlap check may have made it a message, sent instead). */
  private async roomFound(triggerId: string, firing: FiringRow): Promise<void> {
    const { key } = firing;
    if (this.closed) return;
    const now = await this.find(triggerId);
    if (!now) return;
    if (now.target.kind === "message_run") return void (await this.send(now, firing));
    if (this.deps.launchHook) return void (await this.handed(now, firing, this.deps.launchHook));
    let started: { run_id: string };
    try {
      const attrs = firing.attrs as Record<string, string> | null | undefined;
      started = await this.deps.start(now.target, this.inputOf(now, firing), { id: triggerId, firing_key: key, name: now.name, ...(attrs && Object.keys(attrs).length ? { attrs } : {}) }, this.originOf(now), this.titleOf(now, firing), carriesPrevious(this.adapter(now.source)));
    } catch (error) {
      // Stopping, the start may have been cut by the close: the firing stays due for the next start, whose origin key
      // finds a run this one made.
      if (this.closed) return;
      // The archive committed between the read above and the start, which refused the run (the store's fire reads the
      // archive in its own transaction): skipped, as above, and no failure counted.
      const raced = await this.archivedSkip(now.agentId).catch(() => undefined);
      if (raced) return void (await this.store.triggers.settle(triggerId, key, { status: "skipped", reason: raced }));
      return void (await this.answered(triggerId, key, error));
    }
    if (this.closed) return;
    await this.started(triggerId, key, started.run_id);
  }

  /** A message_run firing: its message to the target's run, under its key, queued as a command row the run takes at its
   *  next safe point, within the bound per (trigger, run): a clock's firings coalesce to one waiting message, a pushed
   *  source's or a run now's keep each, up to DUE_KEPT; past it the firing is skipped in words. A target run that is gone
   *  turns the trigger off. */
  private async send(trigger: Trigger, firing: FiringRow): Promise<void> {
    if (trigger.target.kind !== "message_run") return;
    const { target } = trigger;
    if (!(await this.store.runs.get(target.run_id))) {
      await this.store.triggers.update(trigger.id, { enabled: false, nextAt: null, disabled: { at: iso(this.clock.now()), reason: "source_unreadable", detail: RUN_DELETED } });
      await this.store.triggers.settle(trigger.id, firing.key, { status: "skipped", reason: RUN_DELETED });
      this.deps.say({ condition: "trigger_source_unreadable", trigger: trigger.id, error: RUN_DELETED });
      await this.offThere([trigger]);
      return;
    }
    const bound = adapterIn(this.adapters, firing.by)?.delivery === "clock" && !eventful(adapterIn(this.adapters, firing.by)) ? { max: 1, reason: "A message from this trigger is already waiting." } : { max: DUE_KEPT, reason: `${DUE_KEPT} messages from this trigger are already waiting for its run.` };
    let skipped: string | undefined;
    try {
      skipped = (await this.deps.message(target, this.inputOf(trigger, firing), firing.key, this.originOf(trigger), bound))?.skipped;
    } catch (error) {
      if (this.closed) return;
      return this.answered(trigger.id, firing.key, error, target.run_id);
    }
    if (this.closed) return;
    if (skipped) return void (await this.store.triggers.settle(trigger.id, firing.key, { status: "skipped", reason: skipped }));
    await this.store.triggers.settle(trigger.id, firing.key, { status: "sent", runId: target.run_id }, { reset: true });
  }

  /** The firing kept due, waiting for its trigger's room (no try counted, no retry time): a tick drives it once the store
   *  says a run of its trigger ended. */
  private async wait(triggerId: string, key: string, runId: string, reason: string): Promise<void> {
    await this.store.triggers.settle(triggerId, key, { waitsOn: runId, retryAt: null, reason, from: "due" });
    this.waiting = true;
  }

  private async find(triggerId: string): Promise<Trigger | undefined> {
    const row = await this.store.triggers.get(triggerId);
    return row && asTrigger(row);
  }

  /** Why `firing` does not start now, if it does not: skipped (overlap: an earlier firing still due, or the last run still
   *  active), or, with max_active_runs (a pushed trigger's, with or without accept), waiting on the last run while that
   *  many of the trigger's runs have not ended: a capped trigger starts a run per firing and never skips. A trigger whose
   *  source starts a run per firing (its adapter's concurrent) is never skipped either: with no cap it starts, the server's
   *  run limit still holding through retry. A firing its launch hook's host took with no run yet holds the room as a run in
   *  progress until it starts or its startBy passes (the store's activeKeys and held): with a cap, a firing waits on it (on
   *  its key while the trigger has no run), and the overlap check skips for it. So does a firing mid-hand on this server
   *  (handing), other than `firing`: one whose hook has not answered yet, or whose host's start is being written. */
  private async busy(given: Trigger, firing: FiringRow): Promise<{ skipped: string } | { waitsOn: string; reason: string } | undefined> {
    const now = this.clock.now();
    // Read before the store: a firing whose hand ends meanwhile is in the store by then, so it is counted, and counted
    // once (a key in both is one firing).
    const mid = [...(this.handing.get(given.id)?.keys() ?? [])].filter((key) => key !== firing.key);
    // The trigger as it is now, after mid: a firing started since the caller read it is its last run here (its cap, its
    // last run, as the start of that firing left them).
    const trigger = (await this.find(given.id)) ?? given;
    if (trigger.maxActiveRuns !== null) {
      const keys = await this.store.triggers.activeKeys(trigger.id, now);
      const active = new Set([...keys, ...mid]).size;
      if (active < trigger.maxActiveRuns) return undefined;
      // Never room at the cap: a firing started after the trigger's read (by another server) is waited on by its key.
      const on = trigger.lastRunId ?? (await this.store.triggers.held(trigger.id, now)) ?? mid[0] ?? keys[0]!;
      return { waitsOn: on, reason: `${active} of this trigger's runs have not ended (max_active_runs ${trigger.maxActiveRuns}).` };
    }
    if (this.adapter(trigger.source)?.concurrent?.(trigger.source)) return undefined;
    const earlier = (await this.store.triggers.pending()).some((f) => f.triggerId === trigger.id && f.status === "due" && f.key !== firing.key && f.at < firing.at);
    if (earlier) return { skipped: "An earlier firing is still waiting to start its run." };
    if (mid.length) return { skipped: `The firing ${mid[0]} is being handed to the launch hook's host, or started by it.` };
    const held = await this.store.triggers.held(trigger.id, now);
    if (held) return { skipped: `The last firing, ${held}, was handed to the launch hook's host, which may still start its run.` };
    const last = trigger.lastRunId;
    if (!last) return undefined;
    const status = await this.deps.statusOf(last);
    if (status === null || ENDED.has(status)) return undefined;
    return { skipped: status === "input_required" ? `The last run, ${last}, is waiting for a person.` : `The last run, ${last}, is still ${status}.` };
  }

  /** A failed try: kept due with its next try after the backoff table's wait (an answer's own Retry-After when longer), or,
   *  past the table, failed. A try is no failure in the trigger's streak: its firing is one, once it fails, however many
   *  tries it took. A throw that is not a target's answer (a store or a run's status that did not read, a programming
   *  error) is a failed try like a busy server's. */
  private async failedTry(triggerId: string, key: string, error: unknown): Promise<void> {
    try {
      const firing = await this.store.triggers.firing(triggerId, key);
      if (!firing || firing.status !== "due") return;
      const attempts = firing.attempts + 1;
      if (attempts <= BACKOFF_MS.length) {
        const wait = Math.max(BACKOFF_MS[attempts - 1]!, error instanceof ApiError ? (error.extra.retry_after_ms ?? 0) : 0);
        await this.store.triggers.settle(triggerId, key, { attempts, retryAt: this.clock.now() + wait, error: errorOf(error), reason: errorOf(error).message, waitsOn: null, from: "due" });
        return;
      }
      await this.failed(triggerId, key, errorOf(error), undefined, failedReason(error));
    } catch (failure) {
      // The store could not keep the failure: said, and the timer tries again after the table's first wait.
      this.deps.say({ condition: "trigger_firing_failed", trigger: triggerId, firing: key, error: String((failure as Error)?.message ?? failure) });
      if (!this.closed) this.timer ??= this.clock.arm(() => void this.tick(), BACKOFF_MS[0]);
    }
  }

  /** A target refused the firing: a busy server's answer, or a launch hook that did not answer (a retryable HookFailed),
   *  is a failed try under the table; any other (a refusal, a hook's other answer, a thrown error) fails the firing at
   *  once. The firing counts toward the streak once it fails. */
  private async answered(triggerId: string, key: string, error: unknown, runId?: string): Promise<void> {
    if ((error instanceof ApiError && RETRYABLE.has(error.code)) || (error instanceof HookFailed && error.retryable)) return this.failedTry(triggerId, key, error);
    await this.failed(triggerId, key, errorOf(error), runId, failedReason(error));
  }

  /** A start_run firing handed to the host by the launch hook, never started here. The run the host started for it
   *  (handedStart: under the firing's key) makes it started, as a run started here would, whatever the hook answered;
   *  else a 2xx makes it sent, with no run (its attrs kept for a run the host starts late: handedRan) and its startBy
   *  LAUNCH_HOOK_LATE_START_MS after that answer, and any other answer or none is a failed try (answered). The server's
   *  stop leaves it due, so the next start hands it again under the same webhook-id (or finds the run the host started). */
  private async handed(trigger: Trigger, firing: FiringRow, hook: LaunchHook): Promise<void> {
    if (trigger.target.kind !== "start_run") return;
    const agentId = trigger.target.agent_id;
    const sent: HookFiring = {
      firing_id: firing.key, trigger_id: trigger.id, agent_id: agentId, revision_id: (await this.store.agents.get(agentId))?.currentRevision ?? null,
      input: this.inputOf(trigger, firing), fired_at: second(firing.nominalAt),
    };
    const handed: Handed | HookFailed = await handToHost(hook, sent, this.stopping.signal, () => this.clock.now()).catch((error: unknown) => (error instanceof HookFailed ? error : Promise.reject(error)));
    if (this.closed || "stopped" in handed) return;
    // handedRan starts the firing with its run once: the host's own start may have already.
    const linked = await this.deps.runOf(firing.key);
    if (this.closed) return;
    if (linked) return void (await this.handedRan(trigger.id, firing.key, linked.run_id));
    if (handed instanceof HookFailed) return void (await this.answered(trigger.id, firing.key, handed));
    // Sent only while it is due: a host start between the read above and this write left it started with its run.
    await this.store.triggers.settle(trigger.id, firing.key, { status: "sent", reason: HANDED_NO_RUN, keepAttrs: true, startBy: this.clock.now() + LAUNCH_HOOK_LATE_START_MS, from: "due" }, { reset: true });
    // The host may start the run right after its answer: one it started after this write is read again here.
    const after = await this.deps.runOf(firing.key);
    if (this.closed) return;
    if (after) return void (await this.handedRan(trigger.id, firing.key, after.run_id));
    this.deps.say({ condition: "trigger_handed", trigger: trigger.id, firing: firing.key });
  }

  /** The run the host starts through the API for a firing the launch hook handed it (RunCreate `trigger_firing`),
   *  written by `start` from the firing's key (the run's origin key, so the firing finds it), the trigger, input origin
   *  and title its own start would give the run, and the target and previous-result flag it starts on (the policy's
   *  start, as drive's); then the firing started with it (handedRan). Or the run already started under that key,
   *  `replayed`. Refused, in words, unless this server has the hook and the firing, of a start_run trigger on `agentId`,
   *  may start now (startRoom). */
  async handedStart(given: unknown, agentId: string, start: (firing: HandedStart) => Promise<{ run_id: string }>): Promise<{ run_id: string; replayed: boolean }> {
    const refused = (reason: string, message: string, field = "trigger_firing") => invalid([{ field, reason, message }]);
    if (!this.deps.launchHook) throw refused("not_allowed", "This server has no launch hook: a run starts as a trigger firing's only when the hook handed that firing to its host.");
    if (!isObject(given)) throw refused("wrong_type", "trigger_firing is { trigger_id, firing_id }, as the launch hook sent them.");
    const extra = unknownFields(given, ["trigger_id", "firing_id"]);
    if (extra.length) throw invalid(extra.map((issue) => ({ ...issue, field: `trigger_firing.${issue.field}` })));
    const { trigger_id: triggerId, firing_id: key } = given;
    if (typeof triggerId !== "string" || !ID.test(triggerId)) throw refused("wrong_type", "trigger_id is the trigger's id, as the launch hook sent it.", "trigger_firing.trigger_id");
    if (typeof key !== "string" || !/^fir_[0-9a-f]{32}$/.test(key)) throw refused("wrong_type", "firing_id is the firing's id, as the launch hook sent it.", "trigger_firing.firing_id");
    const trigger = await this.find(triggerId);
    if (!trigger || trigger.target.kind !== "start_run" || trigger.target.agent_id !== agentId) throw refused("not_found", `This agent has no trigger ${triggerId} that starts its runs.`, "trigger_firing.trigger_id");
    const firing = await this.store.triggers.firing(triggerId, key);
    if (!firing) throw refused("not_found", `Trigger ${triggerId} has no firing ${key}.`, "trigger_firing.firing_id");
    // The run already under its key is its run. A stop between that run's write and handedRan left the firing sent with
    // no run, so a repeated start starts the firing with it.
    const prior = await this.deps.runOf(key);
    if (prior) {
      await this.handedRan(triggerId, key, prior.run_id);
      return { run_id: prior.run_id, replayed: true };
    }
    const room = await this.checked(triggerId, () => this.startRoom(trigger, key));
    // Its start_by moved under the check (its run started meanwhile, by another start of it): read again from the top.
    if (!room) return this.handedStart(given, agentId, start);
    if ("replay" in room) {
      await this.handedRan(triggerId, key, room.replay);
      return { run_id: room.replay, replayed: true };
    }
    if ("follow" in room) {
      // Another start of the firing on this server is writing its run: that run is this start's answer. One that wrote
      // none leaves this start to try on its own.
      const run = await room.follow;
      return run ? { run_id: run.run_id, replayed: true } : this.handedStart(given, agentId, start);
    }
    let run: { run_id: string } | undefined;
    try {
      const attrs = room.firing.attrs as Record<string, string> | null | undefined;
      try {
        run = await start({
          key, trigger: { id: triggerId, firing_key: key, name: trigger.name, ...(attrs && Object.keys(attrs).length ? { attrs } : {}) }, from: this.originOf(trigger), title: this.titleOf(trigger, room.firing),
          target: trigger.target, previous: carriesPrevious(this.adapter(trigger.source)),
        });
      } catch (error) {
        // The run's write found the firing moved since its room was checked (its host released it, on any server):
        // nothing was written, and the start is refused in words that say what it is now.
        if (error instanceof FiringMoved) throw await this.movedRefusal(triggerId, key);
        throw error;
      }
      room.ran(run);
      try {
        // The run's write started the firing (store.runs.create `firing`): said here. One a start wrote without it is
        // started by handedRan, which says so.
        if (!(await this.handedRan(triggerId, key, run.run_id))) this.deps.say({ condition: "trigger_fired", trigger: triggerId, firing: key, run: run.run_id });
      } catch (error) {
        // Its run is written but the firing's start is not: the firing's next turn starts it with the run under its key,
        // so the run is counted while it works.
        void this.inTurn(triggerId, key);
        throw error;
      }
      return { run_id: run.run_id, replayed: false };
    } finally {
      // No run written: a start_by this start pushed out goes back, so a host's failed starts never extend its window.
      if (!run && room.pushed) await this.unpush(triggerId, key, room.firing.reason, room.pushed);
      room.release();
    }
  }

  /** Firing `key`'s startBy, which a host start pushed out from `pushed.from` to `pushed.to` and then wrote no run, put
   *  back: only while it is still sent with no run at `pushed.to`. A store that does not answer leaves it pushed, a minute
   *  past that start's beginning at most. */
  private async unpush(triggerId: string, key: string, reason: string | null, pushed: { from: number; to: number }): Promise<void> {
    try {
      await this.store.triggers.settle(triggerId, key, { status: "sent", reason, keepAttrs: true, startBy: pushed.from, from: "sent", startByWas: pushed.to });
    } catch (error) {
      this.deps.say({ condition: "trigger_start_by_kept", trigger: triggerId, firing: key, error: String((error as Error)?.message ?? error) });
    }
  }

  /** Firing `key` of `triggerId` held mid-hand (hold) by a host start writing its run, and in starting until `release`:
   *  `ran` gives another start of the firing meanwhile the run written. A start that wrote none arms the timer again on
   *  release, so a retry that came due while it wrote (left to it by drive and arm) is driven at once, and a later one at
   *  its time. */
  private startHold(triggerId: string, key: string): { ran: (run: { run_id: string }) => void; release: () => void } {
    const release = this.hold(triggerId, key);
    let answer!: (run: { run_id: string } | undefined) => void;
    const run = new Promise<{ run_id: string } | undefined>((resolve) => (answer = resolve));
    let written = false;
    this.starting.set(key, run);
    return {
      ran: (done) => {
        written = true;
        answer(done);
      },
      release: () => {
        answer(undefined);
        if (this.starting.get(key) === run) this.starting.delete(key);
        release();
        if (!written && !this.closed) void this.arm();
      },
    };
  }

  /** Whether the host may start firing `key` of `trigger` now, read again within its trigger's room checks (checked), and
   *  what holds its room until `release`. Refused, in words, unless the firing is due (being handed over, or waiting on
   *  its retry) with room by drive's own check (busy: max_active_runs, the overlap, firings mid-hand), then held mid-hand
   *  until its run starts; or is one its host took with no run, up to its startBy (the host may answer first and start
   *  the run after), then held mid-hand the same way, however long its run takes to write. Its startBy is pushed out to
   *  at least START_WINDOW_MS from now if it is sooner, so the store holds its room too, for another server's checks.
   *  Undefined when the push was not written: the firing moved meanwhile. A start that would be refused once its run is
   *  under its key (`replay`) answers that run: another start of the firing (the host's repeat) wrote it since handedStart
   *  read none. One while another start of the firing on this server is writing its run (starting) follows that start. */
  private async startRoom(trigger: Trigger, key: string): Promise<StartRoom | { replay: string } | { follow: Promise<{ run_id: string } | undefined> } | undefined> {
    const follow = this.starting.get(key);
    if (follow) return { follow };
    const refused = (reason: string, message: string) => invalid([{ field: "trigger_firing.firing_id", reason, message }]);
    const notDue = async (message: string): Promise<{ replay: string }> => {
      const ran = await this.deps.runOf(key);
      if (ran) return { replay: ran.run_id };
      throw refused("not_due", message);
    };
    const firing = await this.store.triggers.firing(trigger.id, key);
    if (!firing) throw refused("not_found", `Trigger ${trigger.id} has no firing ${key}.`);
    if (released(firing)) throw releasedRefusal(firing);
    const now = this.clock.now();
    const minutes = LAUNCH_HOOK_LATE_START_MS / 60_000;
    if (tookWithNoRun(firing)) {
      if (now > firing.startBy!) return notDue(`Firing ${key}'s host answered without starting its run, and the ${minutes} minutes after its host answered in which it may still start it have passed (start_by ${iso(firing.startBy!)}).`);
      if (firing.startBy! >= now + START_WINDOW_MS) return { firing, ...this.startHold(trigger.id, key) };
      const to = now + START_WINDOW_MS;
      const pushed = await this.store.triggers.settle(trigger.id, key, { status: "sent", reason: firing.reason, keepAttrs: true, startBy: to, from: "sent", holdsAt: now });
      return pushed && { firing: pushed.firing, pushed: { from: firing.startBy!, to }, ...this.startHold(trigger.id, key) };
    }
    if (firing.status !== "due") return notDue(`Firing ${key} is ${firing.status}${firing.reason ? ` (${firing.reason})` : ""}: a run starts only for a firing the launch hook is handing over, or one its host took within ${minutes} minutes of its answer.`);
    // Another firing's run, or another hand or start on this server, may have taken its trigger's room since it was handed.
    const busy = await this.busy(trigger, firing);
    if (busy) return notDue(`Firing ${key} does not start now. ${"skipped" in busy ? busy.skipped : busy.reason}`);
    return { firing, ...this.startHold(trigger.id, key) };
  }

  /** Run `runId`, which the host started for firing `key` (handedStart), started: a firing with no run yet, still due
   *  (being handed, or waiting on its retry after the hook failed) or one its host took first, is made started here, as
   *  handed() makes it when the run came first, so the overlap check, max_active_runs and last_run_id count it. A failed
   *  or settled firing is left as it is. Whether it started it here. */
  async handedRan(triggerId: string, key: string, runId: string): Promise<boolean> {
    const firing = await this.store.triggers.firing(triggerId, key);
    if (!firing || !(firing.status === "due" ? firing.runId === null : tookWithNoRun(firing))) return false;
    await this.started(triggerId, key, runId);
    return true;
  }

  /** The refusal of a host start of firing `key` whose run's write found the firing moved (FiringMoved): released by
   *  its host, or another not_due naming what it is now. */
  private async movedRefusal(triggerId: string, key: string): Promise<ApiError> {
    const firing = await this.store.triggers.firing(triggerId, key);
    if (firing && released(firing)) return releasedRefusal(firing);
    const now = firing ? `${firing.status}${firing.reason ? ` (${firing.reason})` : ""}` : "gone";
    return invalid([{ field: "trigger_firing.firing_id", reason: "not_due", message: `Firing ${key} moved while its run was written, and is ${now}: no run started for it.` }]);
  }

  /** Firing `key` of trigger `triggerId` released by the host the launch hook handed it to: the host answered it 2xx and
   *  says it will start no run for it (its job failed before any run started). `body` is `{ error }`, the host's words
   *  (1 to RELEASE_WORDS_MAX characters), which `cut` takes the server's secrets out of before they are kept. A firing
   *  sent with no run, before or after its start_by, fails at once: host_released with those words, one failure in its
   *  trigger's streak and a trigger.failed, as any failed firing. Its trigger's room is free from that write, so a firing
   *  waiting on it is driven on the next tick. The same call on a firing it released already answers that firing as it
   *  is. Refused in words: 422 not_allowed on a server with no launch hook, not_due for a firing whose run started, one
   *  still due (not handed yet) or any other, with `details` { reason: RUN_STARTED, run_id } when its run started; 404
   *  for a trigger or firing this server does not have. A host start of the firing already writing its run on this server
   *  is waited for first: a run it writes makes the firing started, and refused. Any other start, on this server (its
   *  room check landing after that wait) or another, is decided by the store: its run's write and this release's are each
   *  conditional on the firing being sent with no run, so the one that lands second finds it moved (a start, FiringMoved;
   *  this release, the firing read again and refused). */
  async release(triggerId: string, key: string, body: Json, cut: (text: string) => string) {
    if (!this.deps.launchHook) throw invalid([{ field: "firing_id", reason: "not_allowed", message: "This server has no launch hook: only a firing the hook handed to its host is released by that host." }]);
    await this.need(triggerId);
    const issues = unknownFields(body, ["error"]);
    const words = typeof body.error === "string" ? body.error.trim() : "";
    if (!words || words.length > RELEASE_WORDS_MAX) issues.unshift({ field: "error", reason: typeof body.error === "string" ? "invalid" : "wrong_type", message: `error is why the host starts no run for the firing, in plain words: 1 to ${RELEASE_WORDS_MAX} characters.` });
    if (issues.length) throw invalid(issues);
    const message = cut(words);
    for (;;) {
      const starting = this.starting.get(key);
      if (starting) {
        const run = await starting;
        if (run) throw this.ranRefusal(key, run.run_id);
        continue;
      }
      const found = await this.checked(triggerId, () => this.releasable(triggerId, key));
      if ("firing" in found) return firingView(found.firing);
      if ("ran" in found) {
        await this.handedRan(triggerId, key, found.ran);
        throw this.ranRefusal(key, found.ran);
      }
      // Written out of the room checks, as drive writes what its check found (a check never waits on a hook, and a failed
      // firing's trigger.failed and auto-pause call out): only while the firing is still sent with no run and its start_by
      // is the one read, so a start that moved it meanwhile (on any server) leaves it as it is, and it is read again.
      const failed = await this.failed(triggerId, key, { code: HOST_RELEASED, message }, undefined, HOST_RELEASED_REASON, { from: "sent", startByWas: found.startBy });
      if (!failed) continue;
      this.deps.say({ condition: "trigger_firing_released", trigger: triggerId, firing: key });
      // Its room is free now: a firing waiting on it is driven on the next tick, not at start_by.
      void this.arm();
      return firingView(failed);
    }
  }

  /** What a release of firing `key` finds, read within its trigger's room checks (release): the firing, released already;
   *  the run already under its key (`ran`, linked or not: a stop between its write and handedRan); or the start_by of a
   *  firing its host took with no run, which the release then fails. Any other is refused in words. */
  private async releasable(triggerId: string, key: string): Promise<{ firing: FiringRow } | { ran: string } | { startBy: number }> {
    const firing = await this.store.triggers.firing(triggerId, key);
    if (!firing) throw new ApiError("not_found", `Trigger ${triggerId} has no firing ${key}.`);
    if (released(firing)) return { firing };
    const ran = firing.status === "started" ? firing.runId : firing.status === "due" || tookWithNoRun(firing) ? (await this.deps.runOf(key))?.run_id : undefined;
    if (ran) return { ran };
    if (firing.status === "due") throw this.notDue(key, "it has not been handed to the launch hook's host yet");
    if (!tookWithNoRun(firing)) throw this.notDue(key, `it is ${firing.status}${firing.reason ? ` (${firing.reason})` : ""}, not a firing the launch hook's host took with no run`);
    return { startBy: firing.startBy! };
  }

  /** A release refused for firing `key`, `why` saying what it is. */
  private notDue(key: string, why: string) {
    return invalid([{ field: "firing_id", reason: "not_due", message: `Firing ${key} is not released: ${why}.` }]);
  }

  /** A release refused for firing `key` because its run `runId` started: in words, and in `details` (RUN_STARTED and the
   *  run) for a host to match. Never retryable: the run stays started. */
  private ranRefusal(key: string, runId: string) {
    const refused = this.notDue(key, `its run ${runId} started`);
    return new ApiError(refused.code, refused.message, { ...refused.extra, details: { reason: RUN_STARTED, run_id: runId } });
  }

  /** Each sent firing whose host's run is in the store under its key, though the server stopped before the firing was
   *  started with it (a late start writes the run, then handedRan): started with that run, so the overlap check and
   *  max_active_runs count it. */
  private async relink(): Promise<void> {
    for (const trigger of await this.all()) {
      if (trigger.target.kind !== "start_run") continue;
      for (const firing of await this.store.triggers.firings(trigger.id)) {
        if (firing.status !== "sent" || firing.runId !== null) continue;
        const run = await this.deps.runOf(firing.key);
        if (this.closed) return;
        if (run) await this.handedRan(trigger.id, firing.key, run.run_id);
      }
    }
  }

  private async started(triggerId: string, key: string, runId: string): Promise<void> {
    await this.store.triggers.settle(triggerId, key, { status: "started", runId }, { reset: true });
    this.deps.say({ condition: "trigger_fired", trigger: triggerId, firing: key, run: runId });
  }

  /** A failed firing: one more in its trigger's streak, the trigger turned off at FAILURES_TO_PAUSE, and trigger.failed
   *  queued (after the firing is written: a start finds one not yet queued and queues it, under the same webhook-id).
   *  Failed only while it is due (or as `only` says: a release's, while it is sent with no run and its start_by unmoved):
   *  one its host's run started meanwhile is left started, with no failure and no message. The firing as written, or
   *  undefined when nothing was. */
  private async failed(triggerId: string, key: string, error: { code: string; message: string }, runId?: string, reason?: string, only: Pick<FiringChange, "from" | "startByWas"> = { from: "due" }): Promise<FiringRow | undefined> {
    const settled = await this.store.triggers.settle(triggerId, key, { status: "failed", error, ...(runId ? { runId } : {}), ...(reason ? { reason } : {}), ...only }, { failure: true, pauseAt: FAILURES_TO_PAUSE });
    if (!settled) return undefined;
    await this.notifyFailed(triggerId, key);
    if (settled.paused) {
      this.deps.say({ condition: "trigger_auto_paused", trigger: triggerId, firing: key });
      await this.pausedThere(triggerId);
    }
    return settled.firing;
  }

  /** Trigger `triggerId`, turned off by its failure streak: off at its sender too (offThere). */
  private async pausedThere(triggerId: string): Promise<void> {
    const trigger = await this.find(triggerId);
    if (trigger && !trigger.enabled) await this.offThere([trigger]);
  }

  /** Triggers the server turned off itself (their agent archived, a failure streak, a connection or a run gone, a source
   *  that no longer reads): off at their sender too, as an owner's pause is, by its own rule (Composio's instance only
   *  once no trigger holding it is on). What could not be done there is said, with what to do by hand; the change here
   *  holds either way. */
  private async offThere(triggers: readonly { id: string; source: Source }[]): Promise<void> {
    for (const t of triggers) {
      const upstream = this.deps.upstream?.(t.source.kind);
      if (!upstream) continue;
      try {
        const said = await upstream.turned(t.source, t.id, false);
        for (const [where, what] of Object.entries(isObject(said) ? said : {})) {
          if (isObject(what) && typeof what.note === "string") this.deps.say({ condition: "trigger_off_upstream_failed", trigger: t.id, upstream: where, note: what.note });
        }
      } catch (error) {
        this.deps.say({ condition: "trigger_off_upstream_failed", trigger: t.id, upstream: t.source.kind, note: String((error as Error)?.message ?? error) });
      }
    }
  }

  private async notifyFailed(triggerId: string, key: string): Promise<void> {
    const firing = await this.store.triggers.firing(triggerId, key);
    const trigger = await this.find(triggerId);
    if (!firing || !trigger || firing.status !== "failed" || firing.notified) return;
    const agentName = (await this.store.agents.get(trigger.agentId))?.name || trigger.agentId;
    const told = await this.deps.notify({ trigger_id: trigger.id, name: trigger.name, agent_id: trigger.agentId, agent_name: agentName, firing_key: key, nominal_at: second(firing.nominalAt), error: firing.error ?? { code: "internal", message: "" }, auto_paused: firing.paused }, key);
    // A mark that does not land (the outbox's write failed) is tried again at the next tick, under the same key, which
    // the outbox holds once: a restart then finds it marked.
    if (told === "queued" || told === "off") await this.store.triggers.settle(triggerId, key, { notified: true });
  }

  /** `firing` recorded for `trigger` (pruned first, so a key past its day is no longer known): `created` false and the
   *  key's firing as it stands when it is known. `room`: refused (429, retryable, nothing written) while the trigger holds
   *  DUE_KEPT firings due. */
  private async record(trigger: Trigger, firing: NewFiring, { room = false } = {}): Promise<{ created: boolean; firing: FiringRow }> {
    await this.prune(trigger);
    let recorded: { created: boolean[] } | undefined;
    try {
      recorded = await this.store.triggers.record(trigger.id, [firing], room ? { room: DUE_KEPT } : {});
    } catch (error) {
      if (!(error instanceof TriggerFull)) throw error;
      // The same key again answers its firing, full or not.
      const known = await this.store.triggers.firing(trigger.id, firing.key);
      if (known) return { created: false, firing: known };
      this.deps.say({ condition: "trigger_firings_full", trigger: trigger.id, due: DUE_KEPT });
      throw new ApiError("rate_limited", `${DUE_KEPT} firings are still due for this trigger, waiting on its run; send it again later.`, { retry_after_ms: FULL_RETRY_S * 1000, details: { due: DUE_KEPT } }, { "retry-after": String(FULL_RETRY_S) });
    }
    if (!recorded) throw new ApiError("not_found", `no trigger ${trigger.id}`);
    const row = await this.store.triggers.firing(trigger.id, firing.key);
    return { created: recorded.created[0] === true, firing: row! };
  }

  /** The trigger's history kept to HISTORY_KEPT: a sender's keys (run now's, a pushed source's) kept for their day, at
   *  most SEEN_KEPT of them; past it the oldest go, said once each time the cap is reached. */
  private async prune(trigger: Trigger): Promise<void> {
    const cap = this.deps.seenKept ?? SEEN_KEPT;
    const over = await this.store.triggers.prune(trigger.id, { history: HISTORY_KEPT, dayMs: DAY_MS, keepByKey: (by) => by === "manual" || eventful(adapterIn(this.adapters, by)), kept: cap, now: this.clock.now() });
    if (over > 0) {
      if (!this.seenFull.has(trigger.id)) this.deps.say({ condition: "trigger_seen_full", trigger: trigger.id, kept: cap });
      this.seenFull.add(trigger.id);
    } else this.seenFull.delete(trigger.id);
  }

  /** The timer, at the soonest next time of an enabled trigger or next try of a due firing not being driven; a failure
   *  whose trigger.failed is not queued yet is tried again after the table's first wait. */
  private async arm(): Promise<void> {
    const turn = ++this.arming;
    let soonest = Infinity;
    try {
      soonest = (await this.store.triggers.soonest()) ?? Infinity;
      for (const f of await this.store.triggers.pending()) {
        if (f.status === "failed") soonest = Math.min(soonest, this.clock.now() + BACKOFF_MS[0]);
        // A due firing not being driven: at its next try; one with none (its last write did not land, so it holds no retry
        // time) after the table's first wait, never left with no time to drive it. A waiting one is the poll's.
        // One its host's start is writing is that start's until it ends (startHold arms again then).
        else if (!this.driving.has(f.key) && !this.starting.has(f.key) && f.waitsOn === null) soonest = Math.min(soonest, f.retryAt ?? this.clock.now() + BACKOFF_MS[0]);
      }
    } catch {
      soonest = this.clock.now() + BACKOFF_MS[0];
    }
    if (this.waiting) soonest = Math.min(soonest, this.clock.now() + WAIT_POLL_MS);
    if (turn !== this.arming || this.closed) return;
    this.timer?.clear();
    this.timer = soonest === Infinity ? undefined : this.clock.arm(() => void this.tick(), Math.max(0, soonest - this.clock.now()));
  }

  private async all(): Promise<Trigger[]> {
    return (await this.store.triggers.all()).map(asTrigger);
  }

  private async need(id: string, onAgent?: string): Promise<Trigger> {
    const row = await this.store.triggers.get(id);
    if (!row || (onAgent !== undefined && row.agentId !== onAgent)) throw new ApiError("not_found", onAgent !== undefined && row ? `no trigger ${id} on the agent ${onAgent}` : `no trigger ${id}`);
    return asTrigger(row);
  }

  /** The agent a trigger belongs to: its start_run target's, or the run its message_run target names. */
  private async agentOf(target: Target): Promise<string> {
    if (target.kind === "start_run") return target.agent_id;
    const run = await this.store.runs.get(target.run_id);
    if (!run) throw invalid([{ field: "target.run_id", reason: "not_found", message: `no run ${target.run_id}` }]);
    return run.agentId;
  }

  /** A trigger as the API answers it: its fields (openapi.ts TRIGGER), named one by one, with its newest firing; a pushed
   *  source's, where its sender posts (`hook_url`: its own hook, or its source's one hook when its settings are the
   *  server's). */
  private async view(trigger: Trigger) {
    const [last] = await this.store.triggers.firings(trigger.id);
    const adapter = adapterIn(this.adapters, trigger.source.kind);
    const hook = adapter?.push ? `/v2/hooks/${adapter.hookOf?.(trigger.source) ?? (adapter.settings?.scope === "server" ? adapter.id : trigger.id)}` : undefined;
    // A polled source's last check: when, whether it read, in words; null before its first.
    const check = adapter?.poll ? checkOf(this.deps.settings(adapter.id)?.get(trigger.id, LAST_CHECK)) : undefined;
    return {
      ...(hook ? { hook_url: `${this.deps.publicUrl ?? ""}${hook}` } : {}),
      ...(adapter?.poll ? { last_check: check ? { at: check.at, ok: check.ok, message: check.message } : null } : {}),
      id: trigger.id, name: trigger.name, enabled: trigger.enabled, source: adapter?.shown ? adapter.shown(trigger.source) : trigger.source, target: trigger.target, catchup_window_s: trigger.catchupWindowS ?? CATCHUP_WINDOW_S,
      max_active_runs: trigger.maxActiveRuns ?? null, failures_in_a_row: trigger.failuresInARow, disabled: trigger.disabled ?? null, next_at: trigger.nextAt === null ? null : iso(trigger.nextAt), last_run_id: trigger.lastRunId,
      created_at: iso(trigger.createdAt), updated_at: iso(trigger.updatedAt), last_firing: last ? firingView(last) : null,
    };
  }

  // ---- what each source's adapter says ----------------------------------------------------------------------------------

  /** `source`'s adapter: every kept or given source has one (sourceOf). */
  private adapter(source: Source): TriggerAdapter {
    return adapterIn(this.adapters, source.kind)!;
  }

  /** Each field `source`'s adapter mints for its triggers, made now for trigger `id`, by field: none for one that keeps
   *  no trigger-scoped secret. */
  private async mint(source: Source, id: string): Promise<Record<string, string>> {
    const adapter = this.adapter(source);
    if (!mints(adapter)) return {};
    const store = this.deps.settings(adapter.id);
    if (!store) throw new Error(`no sealed settings for ${adapter.id}`);
    return Object.fromEntries(await Promise.all(Object.entries(adapter.settings!.fields).filter(([, f]) => f.mint).map(async ([field]) => [field, await store.mint(id, field)] as const)));
  }

  /** A scope belongs to one trigger: `source`'s (its adapter's scopeOf), for a trigger `id` that is to be on, is refused
   *  409 scope_taken while another trigger of its kind that is on listens there (its scope rows). */
  private async scopeFree(source: Source, id: string): Promise<void> {
    const refused = await this.scopeRefusal(source, id);
    if (refused) throw refused;
  }

  /** The 409 scope_taken for `source`'s scope when another enabled trigger holds it, else undefined. */
  private async scopeRefusal(source: Source, id: string): Promise<ApiError | undefined> {
    const adapter = this.adapter(source);
    if (!adapter.scopeOf) return undefined;
    const scope = adapter.scopeOf(source);
    const other = (await this.store.triggers.scoped(source.kind, scope)).find((t) => t !== id);
    return other ? new ApiError("scope_taken", `The ${adapter.label} scope ${scope} belongs to the trigger ${other}: a scope belongs to one trigger. Turn that one off, or give this one another scope.`, { details: { source: adapter.id, scope, trigger_id: other } }) : undefined;
  }

  /** A store refusal on the scope rows (two writes raced past scopeFree): the same 409 scope_taken; undefined for any
   *  other error. */
  private async scopeTaken(error: unknown, source: Source, id: string): Promise<ApiError | undefined> {
    if (!(error instanceof StoreConstraint) || !/trigger_scopes/.test(error.message)) return undefined;
    return (await this.scopeRefusal(source, id)) ?? new ApiError("scope_taken", "That scope belongs to another trigger: a scope belongs to one trigger.");
  }

  /** `source`'s scope rows, while its trigger is on: its adapter's scopeOf, or none. */
  private scopesOf(source: Source): { kind: string; scope: string }[] {
    const scopeOf = this.adapter(source).scopeOf;
    return scopeOf ? [{ kind: source.kind, scope: scopeOf(source) }] : [];
  }

  /** Why `source` no longer reads on this server, if it does not. */
  private problem(source: Source): string | undefined {
    // A kind this server has no adapter for (a source the store kept that this build does not take) no longer reads.
    const adapter = adapterIn(this.adapters, source.kind);
    return adapter ? adapter.problem?.(source) : `this server has no ${source.kind} source`;
  }

  /** `target` with its input as a firing of a trigger named `name` would give it to its run: what create and PATCH
   *  check. */
  private given(name: string, source: Source | undefined, target: Target, now: number): Target {
    const trigger = { name, source: source ?? { kind: this.adapters[0]!.id }, target } as Trigger;
    return { ...target, input: this.inputOf(trigger, { by: "manual", nominalAt: now, payload: null }) };
  }

  /** A run's title, from the trigger that starts it: "<its source> <its name>" (the word its Timeline row begins with,
   *  TRIGGER_LABELS), and the event its payload's tag names, when one does ("Webhook reviews:
   *  pull_request opened"); never its input, which may be a sender's markup. */
  private titleOf(trigger: Trigger, firing: Pick<FiringRow, "by" | "nominalAt" | "payload"> & { attrs?: unknown }): string {
    const source = TRIGGER_LABELS[trigger.source.kind as TriggerSource] ?? trigger.source.kind;
    const attrs = firing.attrs as Record<string, string> | undefined;
    const own = attrs && firing.by === trigger.source.kind ? this.adapter(trigger.source).title?.(attrs) : undefined;
    if (own) return `${source} ${trigger.name}: ${own}`;
    const event = attrs?.event;
    const action = attrs?.action;
    return `${source} ${trigger.name}${event ? `: ${event}${action ? ` ${action}` : ""}` : ""}`;
  }

  /** Who a firing's input is from (a MessageOrigin): the trigger, by its definition as it fires, never
   *  by its payload. Only a source whose words are its owner's (a schedule's, fired on time or by hand) gives owner true;
   *  a pushed source's come from outside, its body empty or not. */
  private originOf(trigger: Trigger): MessageOrigin {
    return { kind: "trigger", trigger_id: trigger.id, source: trigger.source.kind as Extract<MessageOrigin, { kind: "trigger" }>["source"], owner: this.adapter(trigger.source).owner };
  }

  /** The run's input: the trigger's, then a pushed firing's payload marked untrusted (tagged with its source and what the
   *  source says of it), then a line saying what fired it and when, in the trigger's zone. */
  private inputOf(trigger: Trigger, firing: Pick<FiringRow, "by" | "nominalAt" | "payload"> & { attrs?: unknown }): Json {
    const adapter = this.adapter(trigger.source);
    const when = local(firing.nominalAt, adapter.zone?.(trigger.source) ?? "UTC");
    const what = `the ${adapter.label} "${trigger.name}"`;
    const line = firing.by === "manual" ? `(Started by hand from ${what} at ${when}.)` : eventful(adapterIn(this.adapters, firing.by)) ? `(From ${what}, received at ${when}.)` : `(Started by ${what} for ${when}.)`;
    // The payload is whatever its sender wrote: an instruction in it is data, and its closing tag, in any case, cannot end
    // the block.
    const payload = firing.payload === null ? "" : `\n\n<trigger-payload source="${firing.by}"${tagAttrs(firing.attrs)} untrusted>\n${firing.payload.replace(/<(\/trigger-payload)/gi, "<\\$1")}\n</trigger-payload>`;
    const { input } = trigger.target;
    return typeof input.content === "string" ? { ...input, content: `${input.content}${payload}\n\n${line}` } : input;
  }
}

/** A trigger row as the engine reads it: its source and target of their types (create and PATCH check them). */
const asTrigger = (row: TriggerRow): Trigger => row as Trigger;
/** What a template apply alone gives a trigger write, never an API body: `templateId`, the package mark it makes the
 *  trigger with or sets on one it keeps in place (TriggerRow.templateId); `onAgent`, the agent it read the trigger on, so
 *  the write (an update, a removal) is made only while the trigger is still that agent's, compared in the store's
 *  statement: one moved to another agent meanwhile is not_found, and nothing is written. */
export interface TriggerOwn {
  readonly templateId?: string;
  readonly onAgent?: string;
}
/** Whether `adapter`'s triggers each get a secret it mints. */
const mints = (adapter: TriggerAdapter) => adapter.settings?.scope === "trigger" && Object.values(adapter.settings.fields).some((f) => f.mint);
/** A time a Date holds: past it (about the year 275760) a next time is none. */
const DATE_MAX_MS = 8.64e15;

function firingView(firing: FiringRow) {
  return {
    key: firing.key, by: firing.by, nominal_at: second(firing.nominalAt), status: firing.status, at: iso(firing.at), run_id: firing.runId, reason: firing.reason, error: firing.error,
    ...(firing.count !== null ? { count: firing.count } : {}), ...(firing.catchUp ? { catch_up: true } : {}), ...(firing.retryAt !== null ? { attempts: firing.attempts, retry_at: iso(firing.retryAt) } : {}),
    ...(firing.startBy !== null ? { start_by: iso(firing.startBy) } : {}),
  };
}

/** A payload tag's attributes from its source's `attrs`, each ` name="value"`: a name of lowercase letters, digits, `_` and
 *  `-` (never one the tag sets itself), a value cut to 200 characters with `&`, `<`, `>`, `"` escaped and line breaks
 *  made spaces, so a sender's words cannot end the tag or open another. */
function tagAttrs(attrs: unknown): string {
  if (!isObject(attrs)) return "";
  const escape = (value: string) => value.slice(0, 200).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\r\n\t]/g, " ");
  return Object.entries(attrs).filter(([name, value]) => /^[a-z][a-z0-9_-]{0,31}$/.test(name) && name !== "source" && name !== "untrusted" && typeof value === "string").map(([name, value]) => ` ${name}="${escape(value as string)}"`).join("");
}

/** `text` cut to PAYLOAD_KEPT_BYTES of UTF-8 at a character's start, and said to be cut. */
function cut(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= PAYLOAD_KEPT_BYTES) return text;
  let end = PAYLOAD_KEPT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n[cut: the payload was ${bytes.length} bytes, past ${PAYLOAD_KEPT_BYTES}]`;
}
