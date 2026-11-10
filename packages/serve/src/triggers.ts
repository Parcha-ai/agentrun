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
// firing past it waits for a run of the trigger to end.
// One retry policy, kept in the store: a failed try (a full server, a thrown error, a store that could not read) keeps
// the firing due with its next try in retry_at, after the wait BACKOFF_MS gives for its attempts; past the table it fails.
// Every failed try counts toward the trigger's streak, and FAILURES_TO_PAUSE in a row turn the trigger off. A firing past
// its trigger's max_active_runs is no failure: it waits (waits_on, no try counted) and is driven again once a run of the
// trigger ends, read from the store by one query per tick for every waiting firing (the runner is another process: the
// store is all the two share). One timer, at the soonest next time of an enabled trigger, next try of a due firing, or
// WAIT_POLL_MS while a firing waits, is armed again after each change. A next time is reckoned from the last nominal time, never from the clock, so a
// late timer does not drift. Of the times that came while the server was down, or its timer late past LATE_MS, the
// latest fires if it is within the trigger's catch-up window and the rest are one `missed` row; the schedule goes on from
// now. A failed firing queues a trigger.failed webhook message.
import { createHash, randomBytes } from "node:crypto";
import { type MessageOrigin, triggerLabel } from "@parcha/pi-durable-agent/timeline";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { EFFORTS } from "./model.js";
import { AgentArchived, type FiringRow, type NewFiring, type Store, StoreConstraint, TriggerFull, type TriggerPatch, type TriggerRow } from "./store/index.js";
import { type PushEvent, second, SENDER_STARTS, type Source, type TriggerAdapter, validZone } from "./trigger-adapter.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
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
/** The most of a webhook's payload a firing passes on: the rest is cut, at a character's start. */
export const PAYLOAD_KEPT_BYTES = 16 * 1024;
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
/** A trigger's conversations (a Slack trigger's threads) are kept this long after their last event, and at most
 *  CONVERSATIONS_KEPT: a later event in one that went is no message to its run. */
const CONVERSATION_KEPT_MS = 30 * 86_400_000;
const CONVERSATIONS_KEPT = 1_000;
/** How soon a reply waits again for its conversation's run, while the conversation's start is still due. */
const CONVERSATION_WAIT_MS = 2_000;
/** Why a source that declares a steering message may answer a run's question is refused: no run takes a trigger's
 *  message as an answer yet. */
export const ANSWERS_UNSUPPORTED = "A steering message that answers a run's question is not supported yet: no run takes a trigger's message as an answer.";
/** The most keys each trigger keeps for their day past its history (an ignored request's, a pushed or run now firing's
 *  that left the history): a sender's event sent again within its day starts nothing, however many came between. Past
 *  it the oldest go first, and the log says so. */
export const SEEN_KEPT = 5_000;
/** The highest max_active_runs a trigger may set (the store's CHECK holds the same). */
export const MAX_ACTIVE_RUNS = 100;
const ENDED = new Set(["completed", "failed", "cancelled"]);
const LOST_AT_SETUP = "The server stopped while setting up the run.";
/** Why a message_run trigger turned itself off: the run it messages is gone. */
const RUN_DELETED = "its run was deleted";

/** `max_cost_usd`: each run's cap; absent, the agent's default as it stands when the firing starts (one of the two is
 *  required: server.ts targetIssues and start). */
export type Target = { kind: "start_run"; agent_id: string; input: Json; max_cost_usd?: number; effort?: string } | { kind: "message_run"; run_id: string; input: Json };
/** A trigger as the engine reads its row. */
type Trigger = Omit<TriggerRow, "source" | "target"> & { source: Source; target: Target };
/** What a trigger.failed webhook message says (webhooks.ts). */
export type TriggerFailed = { trigger_id: string; name: string; firing_key: string; nominal_at: string; error: { code: string; message: string }; auto_paused: boolean };
/** A run's provenance, kept in its serve.json: the trigger that started it, and the firing. `name`: the trigger's name as
 *  it was at the firing, put on the run so its Timeline row names the trigger without a store read (runs.ts
 *  servedTriggerRow); a rename pushes the new name (server.ts triggerChanged). */
export type RunTrigger = { id: string; firing_key: string; name?: string };
/** The engine's clock and its one timer: Date.now and setTimeout, or a test's. */
export type TriggerClock = { now(): number; arm(fire: () => void, ms: number): { clear(): void } };
export type TriggerDeps = {
  /** Where the triggers and their firings live, and the agents they run as (an archived agent's turn off with it). */
  store: Pick<Store, "triggers" | "runs" | "agents">;
  /** The refusal of a trigger of source `kind` made or turned on here, when it cannot be (the connection it needs is not
   *  there: GitHub not connected). Undefined, or no such dep, when it can. */
  unavailable?(kind: string): ApiError | undefined;
  /** What keeps a target from starting runs here, by field (its agent, its kind, its input). */
  targetIssues(target: Target): Promise<InputIssue[]>;
  /** Starts the target's run with `input`, as POST /agents/{id}/runs would, under `origin`, titled `title` (its
   *  trigger's, never its input's); its first message is the trigger's (`from`, never the person's); ApiError when
   *  refused. */
  start(target: Extract<Target, { kind: "start_run" }>, input: Json, origin: RunTrigger, from: MessageOrigin, title: string): Promise<{ run_id: string }>;
  /** Queues `input` for the target's run as a command row (answers false) under `key`, as the trigger's (`from`), within
   *  `bound` (store.triggers.message: at most `max` of this trigger's rows untaken for the run, else skipped with
   *  `reason`); ApiError when refused. */
  message(target: Extract<Target, { kind: "message_run" }>, input: Json, key: string, from: MessageOrigin, bound: { max: number; reason: string }): Promise<void | { skipped: string }>;
  /** An adapter's sealed settings (over the store): a trigger's minted secret made (at its create or a rotation) and shown
   *  once, durable before it is answered; a trigger's settings removed with it. Undefined for an adapter that keeps none. */
  settings(adapterId: string): { mint(scope: string, field: string): Promise<string>; remove(scope: string): Promise<void> } | undefined;
  /** A run's status, or null when there is no such run. */
  statusOf(runId: string): Promise<string | null>;
  /** The run the store started under origin `key`, if one: a firing left due by a server that went down mid-start.
   *  `setup_lost`: that server went down before it set the run up, so the run never started. */
  runOf(key: string): Promise<{ run_id: string; setup_lost: boolean } | null>;
  /** Queues a trigger.failed webhook message under `key`, the firing's (webhooks.ts emitTrigger): `off` when there is no
   *  webhook to send it to; `unsaved` or `closed` when it is not in the outbox. */
  notify(failed: TriggerFailed, key: string): "queued" | "unsaved" | "off" | "closed";
  say(fields: Record<string, string | number>): void;
  clock?: TriggerClock;
  /** The sources this engine reads: the registry's (trigger-adapters.ts), unless a test gives its own. */
  adapters?: readonly TriggerAdapter[];
  /** SEEN_KEPT, unless a test gives its own. */
  seenKept?: number;
  /** The address people and senders reach this server at (AGENTRUN_PUBLIC_URL), with no trailing slash: a pushed
   *  trigger's hook_url starts with it. None: the hook's path alone. */
  publicUrl?: string;
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
 *  source does, with or without accept (set, each event starts its own run up to the cap); a schedule keeps the overlap
 *  skip, and a message_run target starts no run to bound. */
function capIssues(adapters: readonly TriggerAdapter[], source: Source, target: Target | undefined): InputIssue[] {
  if (adapterIn(adapters, source.kind)?.delivery !== "push") return [{ field: "max_active_runs", reason: "not_allowed", message: "Only a trigger of a pushed source (a webhook) takes max_active_runs: a schedule keeps the overlap skip. Set it to null to clear it." }];
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
/** Why a try failed, as its firing keeps it: an ApiError's code, else internal. */
const errorOf = (error: unknown) => ({ code: error instanceof ApiError ? error.code : "internal", message: String((error as Error)?.message ?? error) });

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
  /** Whether a firing waits for its trigger's room (max_active_runs): the timer then reads the store every WAIT_POLL_MS. */
  private waiting = false;
  /** The triggers whose day-kept keys are at their cap, said once until they are under it again. */
  private readonly seenFull = new Set<string>();
  private closed = false;

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
   *  queued that is not yet, every firing an earlier server left due driven again (its origin key makes a run it already
   *  started the same run), the times missed while it was down recorded, and the timer armed. */
  async start(): Promise<void> {
    const now = this.clock.now();
    await this.offUnreadable((await this.all()).filter((t) => t.enabled && this.problem(t.source)), now);
    await this.tick();
  }

  close(): void {
    this.closed = true;
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

  async create(body: Json) {
    const now = this.clock.now();
    const { issues, source, target, settings } = readBody(this.adapters, body, now);
    if (source && target) issues.push(...this.aimIssues(source, target));
    // Checked as its runs are given it: the input, then the line saying what fired it (a name the trigger may yet take).
    if (target) issues.push(...(await this.deps.targetIssues(this.given(typeof body.name === "string" ? body.name.trim() : `trg_${"0".repeat(24)}`, source, target, now))));
    if (issues.length || !source || !target) throw invalid(issues);
    const agentId = await this.agentOf(target);
    const id = `trg_${randomBytes(12).toString("hex")}`;
    const enabled = body.enabled !== false;
    if (enabled) this.needAvailable(source.kind);
    // Never made on for an archived agent: told before anything is minted (the store's own refusal is the backstop).
    if (enabled) await this.needAgentOn(agentId);
    // A scope belongs to one trigger: told before anything is minted or written (the store's scope rows are the backstop).
    if (enabled) await this.scopeFree(source, id);
    // Its secrets are kept before the trigger is: one that cannot be kept (no seal key) makes none.
    const minted = await this.mint(source, id);
    const name = typeof body.name === "string" ? body.name.trim() : id;
    let row: TriggerRow;
    try {
      row = await this.store.triggers.create({ id, agentId, name, enabled, source, target, nextAt: enabled ? nextAfter(this.adapter(source), source, now) : null, catchupWindowS: settings.catchup_window_s ?? CATCHUP_WINDOW_S, ...(typeof settings.max_active_runs === "number" ? { maxActiveRuns: settings.max_active_runs } : {}) }, this.scopesOf(source));
    } catch (error) {
      throw (await this.scopeTaken(error, source, id)) ?? (await this.archivedRefusal(error)) ?? nameTaken(error, name);
    }
    // Armed before the answer: a create that answered is in effect, its first time on the timer (arm reads the store).
    await this.arm();
    // What it minted, shown this once, by field: a webhook's `secret`.
    return { ...(await this.view(asTrigger(row))), ...(minted as { secret?: string }) };
  }

  /** A trigger's new signing secret, shown this once; the old one signs nothing from now on. */
  async rotate(id: string): Promise<Record<string, string>> {
    const trigger = await this.need(id);
    if (!mints(this.adapter(trigger.source))) throw invalid([{ field: "source.kind", reason: "not_allowed", message: "Only a webhook trigger has a secret." }]);
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
    return off;
  }

  /** Agent `agentId` unarchived: none of its triggers turns on again. The triggers its archive turned off that are off
   *  still, by name: each is turned on by a PATCH. */
  async agentUnarchived(agentId: string): Promise<{ id: string; name: string }[]> {
    await this.store.agents.archive(agentId, false);
    return (await this.store.triggers.list(agentId)).filter((t) => !t.enabled && reasonOf(t.disabled) === "agent_archived").map((t) => ({ id: t.id, name: t.name }));
  }

  /** Refused (409 agent_archived) when agent `agentId` is archived: a trigger made on, turned on or aimed at it. */
  private async needAgentOn(agentId: string): Promise<void> {
    const agent = await this.store.agents.get(agentId);
    if (agent?.archivedAt != null) throw new ApiError("agent_archived", archivedDetail(agent.name));
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
  private needAvailable(kind: string): void {
    const refusal = this.deps.unavailable?.(kind);
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

  /** A delivered request for trigger `id` with one event, as a webhook's is (`attrs`: what its source says of the
   *  payload): receiveEvent's, which takes it. */
  async receive(id: string, eventId: string, payload: string, attrs?: Record<string, string>): Promise<{ created: boolean; firing: ReturnType<typeof firingView> | { ok: "duplicate" } }> {
    return (await this.receiveEvent(id, { key: eventId, text: payload, ...(attrs ? { attrs } : {}) }))!;
  }

  /** An event its pushed source delivered for trigger `id` (its checks passed, push-handler.ts), held to the trust its
   *  source declares (Trust), here alone: one from an actor it may not start a run for starts nothing, and one in a
   *  conversation steers that conversation's run only from an actor it may steer. In a conversation this trigger
   *  started a run for (and kept), it is a message to that run; else, when it asks to (`opens`), a new conversation and
   *  its run. Keyed by the sender's own id for it, so a retry is one firing; recorded due, with its conversation (in its
   *  attrs), and driven after the answer; refused (429) while the trigger holds DUE_KEPT firings due. Undefined: nothing
   *  to act on. `created` false: that id's firing, as it stands, or `{ok: "duplicate"}` for one ignored within its day. */
  async receiveEvent(id: string, event: PushEvent): Promise<{ created: boolean; firing: ReturnType<typeof firingView> | { ok: "duplicate" } } | undefined> {
    const trigger = await this.need(id);
    const by = trigger.source.kind;
    const trust = this.adapter(trigger.source).trust ?? SENDER_STARTS;
    const actor = event.actor ?? "sender";
    const key = firingKey(by, id, event.key);
    // The same key again is its firing as it stands, whoever sent it: trust was held to when it was first taken.
    const known = await this.store.triggers.firing(id, key);
    if (known) return known.status === "ignored" ? { created: false, firing: { ok: "duplicate" } } : { created: false, firing: firingView(known) };
    const now = this.clock.now();
    const conversation = event.conversation;
    const held = conversation === undefined ? undefined : await this.store.triggers.conversation(id, conversation);
    const kept = held !== undefined && now - held.lastAt <= CONVERSATION_KEPT_MS;
    // A conversation whose start made no run (refused, or gone), and is not still due: an event that asks to opens it
    // again, under its own key; one that does not reaches nothing there.
    const unstarted = held !== undefined && held.runId === null && !(await this.startDue(id, conversation!));
    const reply = kept && !(unstarted && event.opens === true);
    if (reply ? !trust.steer.includes(actor) : !trust.start.includes(actor) || (conversation !== undefined && event.opens !== true)) return undefined;
    const attrs = { ...(event.attrs ?? {}), ...(conversation === undefined ? {} : { [CONVERSATION]: conversation }), ...(reply ? { [REPLY]: "1" } : {}) };
    const recorded = await this.record(trigger, { key, by, nominalAt: Math.floor(now / 1000) * 1000, status: "due", payload: cut(event.text), ...(Object.keys(attrs).length ? { attrs } : {}) }, { room: true });
    if (recorded.created && conversation !== undefined) {
      await this.store.triggers.keepConversation({ triggerId: id, key: conversation, at: now });
      // Conversations untouched for CONVERSATION_KEPT_MS go, and the oldest past CONVERSATIONS_KEPT.
      await this.store.triggers.pruneConversations(id, { keptMs: CONVERSATION_KEPT_MS, kept: CONVERSATIONS_KEPT, now });
    }
    if (recorded.created) void this.inTurn(id, key);
    if (!recorded.created && recorded.firing.status === "ignored") return { created: false, firing: { ok: "duplicate" } };
    return { created: recorded.created, firing: firingView(recorded.firing) };
  }

  /** Whether conversation `key` of trigger `id`'s start (a firing in it that is no reply) is still due: its run may yet
   *  start, so a reply waits for it. */
  private async startDue(id: string, key: string): Promise<boolean> {
    return (await this.store.triggers.pending()).some((f) => f.triggerId === id && f.status === "due" && conversationOf(f.attrs) === key && !isReply(f.attrs));
  }

  /** The conversation trigger `triggerId`'s firing `key` started a run in, if it started one: where a line about the run
   *  is posted (a Slack trigger's thread). */
  async conversationOfFiring(triggerId: string, key: string): Promise<{ trigger: Trigger; conversation: string } | undefined> {
    const firing = await this.store.triggers.firing(triggerId, key);
    const conversation = firing && !isReply(firing.attrs) ? conversationOf(firing.attrs) : undefined;
    const trigger = conversation === undefined ? undefined : await this.find(triggerId);
    return trigger && conversation !== undefined ? { trigger, conversation } : undefined;
  }

  /** PATCH: any of name, enabled, source, target, catchup_window_s and max_active_runs. Enabled again, or its source changed, a trigger goes on from now: a
   *  paused range is skipped, never caught up. Only the fields named change, applied to the trigger as it stands once
   *  the target's check is done: an edit made meanwhile keeps its own. */
  async update(id: string, body: Json) {
    const was = await this.need(id);
    const issues = unknownFields(body, WRITABLE);
    const source = body.source === undefined ? undefined : sourceOf(this.adapters, body.source, this.clock.now(), issues);
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
    const trigger = await this.need(id);
    if (source && source.kind !== trigger.source.kind) throw invalid([{ field: "source.kind", reason: "not_allowed", message: "A trigger's source kind is fixed: make a new trigger for another." }]);
    if (target) {
      const aimed = this.aimIssues(trigger.source, target);
      if (aimed.length) throw invalid(aimed);
    }
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
    if (enabled && (!trigger.enabled || source)) this.needAvailable(scopeSource.kind);
    if (enabled) await this.scopeFree(scopeSource, trigger.id);
    // A trigger belongs to its target's agent: aimed at another agent (or another agent's run), it moves to that agent,
    // whose one name per trigger and list of triggers it joins.
    const agentId = target ? await this.agentOf(target) : trigger.agentId;
    // Turned on, or aimed elsewhere while on: never for an archived agent (the store's own refusal is the backstop).
    if (enabled && (!trigger.enabled || target)) await this.needAgentOn(agentId);
    const patch: TriggerPatch = {
      ...(agentId !== trigger.agentId ? { agentId } : {}),
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}), ...(source ? { source } : {}), ...(target ? { target } : {}),
      ...(settings.catchup_window_s !== undefined ? { catchupWindowS: settings.catchup_window_s } : {}),
      ...(settings.max_active_runs !== undefined ? { maxActiveRuns: settings.max_active_runs } : {}), ...again, enabled, nextAt: next,
    };
    const row = await this.store.triggers.update(id, patch, enabled ? this.scopesOf(scopeSource) : []).catch(async (error: unknown) => {
      throw (await this.scopeTaken(error, scopeSource, trigger.id)) ?? (await this.archivedRefusal(error)) ?? nameTaken(error, patch.name ?? trigger.name);
    });
    if (!row) throw new ApiError("not_found", `no trigger ${id}`);
    await this.arm();
    return this.view(asTrigger(row));
  }

  async remove(id: string): Promise<void> {
    const trigger = await this.need(id);
    await this.store.triggers.remove(id);
    if (this.adapter(trigger.source)?.settings?.scope === "trigger") await this.deps.settings(trigger.source.kind)?.remove(id);
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
      const waiting = await this.store.triggers.waiting();
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

  /** A firing taken from due to its end: skipped when its trigger's last run is active, else its run started (or its
   *  message sent). A failed try keeps it due under the backoff table, or ends it failed. Each step reads the trigger and
   *  the firing again: either may be edited or deleted meanwhile. */
  private async drive(triggerId: string, key: string): Promise<void> {
    if (this.closed) return;
    try {
      const firing = await this.store.triggers.firing(triggerId, key);
      if (!firing || firing.status !== "due") return;
      // An event in a conversation whose run started is a message to that run.
      if (isReply(firing.attrs)) {
        const trigger = await this.find(triggerId);
        return trigger ? void (await this.send(trigger, firing)) : undefined;
      }
      // Its run already started (the store has its key) is its run, whatever runs now.
      const prior = await this.deps.runOf(key);
      if (this.closed) return;
      // A key stays bound to its run: one lost at setup is this firing's failure, never fired again.
      if (prior?.setup_lost) return void (await this.failed(triggerId, key, { code: "run_failed", message: LOST_AT_SETUP }, prior.run_id, LOST_AT_SETUP));
      if (prior) return void (await this.started(triggerId, key, prior.run_id));
      const trigger = await this.find(triggerId);
      if (!trigger) return;
      // Its agent archived since the firing was recorded (a firing waiting on its cap, or due on a retry): skipped, never a
      // run or a message.
      const archived = await this.archivedSkip(trigger.agentId);
      if (this.closed) return;
      if (archived) return void (await this.store.triggers.settle(triggerId, key, { status: "skipped", reason: archived }));
      if (trigger.target.kind === "message_run") return void (await this.send(trigger, firing));
      // A conversation is one run of its own: a new one starts its run whatever another's is doing.
      const busy = conversationOf(firing.attrs) !== undefined ? undefined : await this.busy(trigger, firing);
      if (this.closed) return;
      if (busy && "skipped" in busy) return void (await this.store.triggers.settle(triggerId, key, { status: "skipped", reason: busy.skipped }));
      if (busy && "waitsOn" in busy) return void (await this.wait(triggerId, key, busy.waitsOn, busy.reason));
      // The target as it is now: an edit during the overlap check may have made it a message.
      const now = await this.find(triggerId);
      if (!now) return;
      if (now.target.kind === "message_run") return void (await this.send(now, firing));
      let started: { run_id: string };
      try {
        started = await this.deps.start(now.target, this.inputOf(now, firing), { id: triggerId, firing_key: key, name: now.name }, this.originOf(now), this.titleOf(now, firing));
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
    } catch (error) {
      if (this.closed) return;
      await this.failedTry(triggerId, key, error);
    }
  }

  /** A message_run firing: its message to the target's run, under its key, queued as a command row the run takes at its
   *  next safe point, within the bound per (trigger, run): a clock's firings coalesce to one waiting message, a pushed
   *  source's or a run now's keep each, up to DUE_KEPT; past it the firing is skipped in words. A target run that is gone
   *  turns the trigger off. */
  private async send(trigger: Trigger, firing: FiringRow): Promise<void> {
    let target = trigger.target;
    if (isReply(firing.attrs)) {
      // An event in a conversation: its message to the conversation's run, once that run started; it waits while the
      // conversation's start is still due, and is skipped when that start made no run.
      const conversation = await this.store.triggers.conversation(trigger.id, conversationOf(firing.attrs)!);
      if (!conversation?.runId) {
        if (conversation && (await this.startDue(trigger.id, conversation.key))) return void (await this.store.triggers.settle(trigger.id, firing.key, { retryAt: this.clock.now() + CONVERSATION_WAIT_MS, reason: "The conversation's run has not started yet." }));
        return void (await this.store.triggers.settle(trigger.id, firing.key, { status: "skipped", reason: "The conversation's run never started." }));
      }
      target = { kind: "message_run", run_id: conversation.runId, input: {} };
    }
    if (target.kind !== "message_run") return;
    if (!(await this.store.runs.get(target.run_id))) {
      await this.store.triggers.update(trigger.id, { enabled: false, nextAt: null, disabled: { at: iso(this.clock.now()), reason: "source_unreadable", detail: RUN_DELETED } });
      await this.store.triggers.settle(trigger.id, firing.key, { status: "skipped", reason: RUN_DELETED });
      this.deps.say({ condition: "trigger_source_unreadable", trigger: trigger.id, error: RUN_DELETED });
      return;
    }
    const bound = adapterIn(this.adapters, firing.by)?.delivery === "clock" ? { max: 1, reason: "A message from this trigger is already waiting." } : { max: DUE_KEPT, reason: `${DUE_KEPT} messages from this trigger are already waiting for its run.` };
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
    await this.store.triggers.settle(triggerId, key, { waitsOn: runId, retryAt: null, reason });
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
   *  run limit still holding through retry. */
  private async busy(trigger: Trigger, firing: FiringRow): Promise<{ skipped: string } | { waitsOn: string; reason: string } | undefined> {
    if (trigger.maxActiveRuns !== null) {
      const active = await this.store.triggers.activeRuns(trigger.id);
      if (active < trigger.maxActiveRuns || !trigger.lastRunId) return undefined;
      return { waitsOn: trigger.lastRunId, reason: `${active} of this trigger's runs have not ended (max_active_runs ${trigger.maxActiveRuns}).` };
    }
    if (this.adapter(trigger.source)?.concurrent?.(trigger.source)) return undefined;
    const earlier = (await this.store.triggers.pending()).some((f) => f.triggerId === trigger.id && f.status === "due" && f.key !== firing.key && f.at < firing.at);
    if (earlier) return { skipped: "An earlier firing is still waiting to start its run." };
    const last = trigger.lastRunId;
    if (!last) return undefined;
    const status = await this.deps.statusOf(last);
    if (status === null || ENDED.has(status)) return undefined;
    return { skipped: status === "input_required" ? `The last run, ${last}, is waiting for a person.` : `The last run, ${last}, is still ${status}.` };
  }

  /** A failed try: kept due with its next try after the backoff table's wait (an answer's own Retry-After when longer), or,
   *  past the table, failed. Either way one more in the trigger's streak. A throw that is not a target's answer (a store
   *  or a run's status that did not read, a programming error) is a failed try like a busy server's. */
  private async failedTry(triggerId: string, key: string, error: unknown): Promise<void> {
    try {
      const firing = await this.store.triggers.firing(triggerId, key);
      if (!firing || firing.status !== "due") return;
      const attempts = firing.attempts + 1;
      if (attempts <= BACKOFF_MS.length) {
        const wait = Math.max(BACKOFF_MS[attempts - 1]!, error instanceof ApiError ? (error.extra.retry_after_ms ?? 0) : 0);
        const settled = await this.store.triggers.settle(triggerId, key, { attempts, retryAt: this.clock.now() + wait, error: errorOf(error), reason: errorOf(error).message, waitsOn: null }, { failure: true, pauseAt: FAILURES_TO_PAUSE });
        if (settled?.paused) this.deps.say({ condition: "trigger_auto_paused", trigger: triggerId, firing: key });
        return;
      }
      await this.failed(triggerId, key, errorOf(error));
    } catch (failure) {
      // The store could not keep the failure: said, and the timer tries again after the table's first wait.
      this.deps.say({ condition: "trigger_firing_failed", trigger: triggerId, firing: key, error: String((failure as Error)?.message ?? failure) });
      if (!this.closed) this.timer ??= this.clock.arm(() => void this.tick(), BACKOFF_MS[0]);
    }
  }

  /** A target refused the firing: a busy server's answer is a failed try under the table; any other (a refusal, a thrown
   *  error) fails the firing at once. Both count toward the streak. */
  private async answered(triggerId: string, key: string, error: unknown, runId?: string): Promise<void> {
    if (error instanceof ApiError && RETRYABLE.has(error.code)) return this.failedTry(triggerId, key, error);
    await this.failed(triggerId, key, errorOf(error), runId);
  }

  private async started(triggerId: string, key: string, runId: string): Promise<void> {
    await this.store.triggers.settle(triggerId, key, { status: "started", runId }, { reset: true });
    // A conversation's start: its run, which its later events message.
    const firing = await this.store.triggers.firing(triggerId, key);
    const conversation = firing && !isReply(firing.attrs) ? conversationOf(firing.attrs) : undefined;
    if (conversation !== undefined) await this.store.triggers.keepConversation({ triggerId, key: conversation, runId, at: this.clock.now() });
    this.deps.say({ condition: "trigger_fired", trigger: triggerId, firing: key, run: runId });
  }

  /** A failed firing: one more in its trigger's streak, the trigger turned off at FAILURES_TO_PAUSE, and trigger.failed
   *  queued (after the firing is written: a start finds one not yet queued and queues it, under the same webhook-id). */
  private async failed(triggerId: string, key: string, error: { code: string; message: string }, runId?: string, reason?: string): Promise<void> {
    await this.store.triggers.settle(triggerId, key, { status: "failed", error, ...(runId ? { runId } : {}), ...(reason ? { reason } : {}) }, { failure: true, pauseAt: FAILURES_TO_PAUSE });
    await this.notifyFailed(triggerId, key);
  }

  private async notifyFailed(triggerId: string, key: string): Promise<void> {
    const firing = await this.store.triggers.firing(triggerId, key);
    const trigger = await this.find(triggerId);
    if (!firing || !trigger || firing.status !== "failed" || firing.notified) return;
    const told = this.deps.notify({ trigger_id: trigger.id, name: trigger.name, firing_key: key, nominal_at: second(firing.nominalAt), error: firing.error ?? { code: "internal", message: "" }, auto_paused: firing.paused }, key);
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
    const over = await this.store.triggers.prune(trigger.id, { history: HISTORY_KEPT, dayMs: DAY_MS, keepByKey: (by) => by === "manual" || adapterIn(this.adapters, by)?.delivery === "push", kept: cap });
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
        else if (!this.driving.has(f.key) && f.waitsOn === null) soonest = Math.min(soonest, f.retryAt ?? this.clock.now() + BACKOFF_MS[0]);
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

  private async need(id: string): Promise<Trigger> {
    const row = await this.store.triggers.get(id);
    if (!row) throw new ApiError("not_found", `no trigger ${id}`);
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
    const hook = adapter?.push ? `/v2/hooks/${adapter.settings?.scope === "server" ? adapter.id : trigger.id}` : undefined;
    return {
      ...(hook ? { hook_url: `${this.deps.publicUrl ?? ""}${hook}` } : {}),
      id: trigger.id, name: trigger.name, enabled: trigger.enabled, source: trigger.source, target: trigger.target, catchup_window_s: trigger.catchupWindowS ?? CATCHUP_WINDOW_S,
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

  /** The 409 scope_taken for the first of `source`'s scopes another enabled trigger holds, else undefined. */
  private async scopeRefusal(source: Source, id: string): Promise<ApiError | undefined> {
    const adapter = this.adapter(source);
    if (!adapter.scopeOf) return undefined;
    for (const scope of adapter.scopeOf(source)) {
      const other = (await this.store.triggers.scoped(source.kind, scope)).find((t) => t !== id);
      if (other) return new ApiError("scope_taken", `The ${adapter.label} scope ${scope} belongs to the trigger ${other}: a scope belongs to one trigger. Turn that one off, or give this one another scope.`, { details: { source: adapter.id, scope, trigger_id: other } });
    }
    return undefined;
  }

  /** A store refusal on the scope rows (two writes raced past scopeFree): the same 409 scope_taken; undefined for any
   *  other error. */
  private async scopeTaken(error: unknown, source: Source, id: string): Promise<ApiError | undefined> {
    if (!(error instanceof StoreConstraint) || !/trigger_scopes/.test(error.message)) return undefined;
    return (await this.scopeRefusal(source, id)) ?? new ApiError("scope_taken", "That scope belongs to another trigger: a scope belongs to one trigger.");
  }

  /** `source`'s scope rows, while its trigger is on: one for each of its adapter's scopeOf (a Slack trigger's channels), or none. */
  private scopesOf(source: Source): { kind: string; scope: string }[] {
    const scopeOf = this.adapter(source).scopeOf;
    return scopeOf ? scopeOf(source).map((scope) => ({ kind: source.kind, scope })) : [];
  }

  /** A source whose events steer their conversation's run (its trust lets someone steer) starts a run for each new
   *  conversation: a target that messages one run is no target of it. A source that lets a steering message answer a
   *  run's question is refused until a run takes a trigger's message as an answer. */
  private aimIssues(source: Source, target: Target): InputIssue[] {
    const adapter = this.adapter(source);
    if (adapter.trust?.answers) return [{ field: "source.kind", reason: "not_allowed", message: ANSWERS_UNSUPPORTED }];
    if (!adapter.trust?.steer.length || target.kind === "start_run") return [];
    return [{ field: "target.kind", reason: "not_allowed", message: `A ${adapter.label} starts a run for each new conversation (a ${adapter.title} thread); a reply in it is a message to that run.` }];
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
   *  pi-durable-agent's triggerLabel), and the event its payload's tag names, when one does ("Webhook reviews:
   *  pull_request opened"); never its input, which may be a sender's markup. */
  private titleOf(trigger: Trigger, firing: Pick<FiringRow, "by" | "nominalAt" | "payload"> & { attrs?: unknown }): string {
    const source = triggerLabel(trigger.source.kind);
    const attrs = firing.attrs as Record<string, string> | undefined;
    const event = attrs?.event;
    const action = attrs?.action;
    return `${source} ${trigger.name}${event ? `: ${event}${action ? ` ${action}` : ""}` : ""}`;
  }

  /** Who a firing's input is from (pi-durable-agent's MessageOrigin): the trigger, by its definition as it fires, never
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
    const line = firing.by === "manual" ? `(Started by hand from ${what} at ${when}.)` : adapterIn(this.adapters, firing.by)?.delivery === "push" ? `(From ${what}, received at ${when}.)` : `(Started by ${what} for ${when}.)`;
    // The payload is whatever its sender wrote: an instruction in it is data, and its closing tag, in any case, cannot end
    // the block.
    const payload = firing.payload === null ? "" : `\n\n<trigger-payload source="${firing.by}"${tagAttrs(firing.attrs)} untrusted>\n${firing.payload.replace(/<(\/trigger-payload)/gi, "<\\$1")}\n</trigger-payload>`;
    // An event in a conversation whose run started is its message and that line alone.
    if (isReply(firing.attrs)) return { content: `${payload.trimStart()}\n\n${line}` };
    const { input } = trigger.target;
    return typeof input.content === "string" ? { ...input, content: `${input.content}${payload}\n\n${line}` } : input;
  }
}

/** A trigger row as the engine reads it: its source and target of their types (create and PATCH check them). */
const asTrigger = (row: TriggerRow): Trigger => row as Trigger;
/** Whether `adapter`'s triggers each get a secret it mints. */
const mints = (adapter: TriggerAdapter) => adapter.settings?.scope === "trigger" && Object.values(adapter.settings.fields).some((f) => f.mint);
/** A time a Date holds: past it (about the year 275760) a next time is none. */
const DATE_MAX_MS = 8.64e15;

function firingView(firing: FiringRow) {
  return {
    key: firing.key, by: firing.by, nominal_at: second(firing.nominalAt), status: firing.status, at: iso(firing.at), run_id: firing.runId, reason: firing.reason, error: firing.error,
    ...(firing.count !== null ? { count: firing.count } : {}), ...(firing.catchUp ? { catch_up: true } : {}), ...(firing.retryAt !== null ? { attempts: firing.attempts, retry_at: iso(firing.retryAt) } : {}),
  };
}

/** The attrs a firing keeps its conversation in (a Slack thread's key) and whether it is a reply in it (a message to that
 *  conversation's run): the kernel's own, never on the payload's tag or in a firing's view. */
const CONVERSATION = "conversation";
const REPLY = "reply";
const conversationOf = (attrs: unknown): string | undefined => (isObject(attrs) && typeof attrs[CONVERSATION] === "string" ? (attrs[CONVERSATION] as string) : undefined);
const isReply = (attrs: unknown): boolean => isObject(attrs) && attrs[REPLY] === "1";

/** A payload tag's attributes from its source's `attrs`, each ` name="value"`: a name of lowercase letters, digits, `_` and
 *  `-` (never one the tag sets itself), a value cut to 200 characters with `&`, `<`, `>`, `"` escaped and line breaks
 *  made spaces, so a sender's words cannot end the tag or open another. */
function tagAttrs(attrs: unknown): string {
  if (!isObject(attrs)) return "";
  const escape = (value: string) => value.slice(0, 200).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\r\n\t]/g, " ");
  return Object.entries(attrs).filter(([name, value]) => /^[a-z][a-z0-9_-]{0,31}$/.test(name) && name !== "source" && name !== "untrusted" && name !== CONVERSATION && name !== REPLY && typeof value === "string").map(([name, value]) => ` ${name}="${escape(value as string)}"`).join("");
}

/** `text` cut to PAYLOAD_KEPT_BYTES of UTF-8 at a character's start, and said to be cut. */
function cut(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= PAYLOAD_KEPT_BYTES) return text;
  let end = PAYLOAD_KEPT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n[cut: the payload was ${bytes.length} bytes, past ${PAYLOAD_KEPT_BYTES}]`;
}
