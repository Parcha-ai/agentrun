// Triggers: what starts a run with no caller. A trigger is a source (one of the registry's adapters,
// trigger-adapters.ts: a schedule on a clock, a signed webhook pushed to the server) and a target (a run of an agent,
// always capped, or a message to one run). They live in
// DIR/triggers.json, written whole and synced on every change, with each trigger's last HISTORY_KEPT firings. Never in
// store.sqlite, which runs open.
// A firing starts exactly once. Its key is fixed by what it fires for: the trigger and its nominal time (a schedule), or
// the trigger and the caller's Idempotency-Key (run now). One write records it `due` and moves the trigger's next time
// on; a key already in the history is not recorded again, nor a run now's key within its day after it left the history. Then its run is started with the key as its origin, which
// the agent store keeps in the run's own insert, so a firing driven again after a restart finds its run and starts no
// second one. While the trigger's last run is active (working, or waiting on a person), a firing is `skipped`, never
// queued: a firing queued behind a run parked on a person would wait for as long as the person does. A source whose
// adapter says each firing is its own work (concurrent: a webhook with accept) starts a run per firing instead.
// One timer, at the soonest next time of an enabled trigger (or a firing's retry), is armed again after each change. A
// next time is reckoned from the last nominal time, never from the clock, so a late timer does not drift. Of the times
// that came while the server was down, or its timer late past LATE_MS, the latest fires if it is within the trigger's
// catch-up window and the rest are one `missed` row; the schedule goes on from now. A failed firing queues a
// trigger.failed webhook message, and FAILURES_TO_PAUSE in a row turn the trigger off.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageOrigin } from "@parcha/pi-durable-agent/timeline";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { EFFORTS } from "./model.js";
import { instantOf, second, type Source, type TriggerAdapter, validZone } from "./trigger-adapter.js";
import { TRIGGER_ADAPTERS } from "./trigger-adapters.js";
import { MAX_EVERY_S } from "./trigger-schedule.js";
import { ID, IDEMPOTENCY_TTL_S, isObject, type Json, unknownFields } from "./validate.js";

export { MAX_EVERY_S, MIN_EVERY_S } from "./trigger-schedule.js";

export const TRIGGERS_FILE = "triggers.json";
/** The firings each trigger keeps, newest last; a firing still due is never dropped, nor a failure whose trigger.failed is
 *  not queued yet (up to UNTOLD_KEPT). */
export const HISTORY_KEPT = 200;
/** The most firings a trigger holds due. A message_run firing to a working run stays due, tried every 5 s, until the
 *  run takes it: one per idle point, so twenty is far past a sender's burst while the run works, and with up to 16 KiB of
 *  payload each they add at most 320 KiB to the file every write rewrites. Past it a webhook event and a run now are
 *  refused (429, retryable) before anything is written, and a schedule's time is skipped. */
export const DUE_KEPT = 20;
/** How long a refused event is told to wait (Retry-After). */
const FULL_RETRY_S = 30;
/** The most failures a trigger keeps past its history while their trigger.failed waits for the outbox. A schedule turns
 *  itself off after FAILURES_TO_PAUSE in a row, but runs that start between failures, and run now, can add more. */
const UNTOLD_KEPT = 50;
/** The kinds of source this server has: its adapters' ids. */
export const SOURCE_KINDS: readonly string[] = TRIGGER_ADAPTERS.map((a) => a.id);
export const TARGET_KINDS = ["start_run", "message_run"] as const;
export const FIRING_STATUSES = ["due", "started", "sent", "skipped", "failed", "missed"] as const;
/** The most of a webhook's payload a firing passes on: the rest is cut, at a character's start. */
export const PAYLOAD_KEPT_BYTES = 16 * 1024;
/** How late a missed time may be and still fire once, by default: an hour. */
export const CATCHUP_WINDOW_S = 3600;
/** The failed firings in a row that turn a trigger off. */
export const FAILURES_TO_PAUSE = 5;
/** A nominal time the timer reaches later than this was missed: the server was down, or its timer late. */
const LATE_MS = 60_000;
/** The most missed times one row counts one by one; past it the schedule jumps to now. */
const MISSED_COUNTED = 10_000;
/** The waits before a firing a full server refused (429), or whose last run could not be read, is tried again. */
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
/** How soon a message refused because its run is working is tried again: not a failure, so no backoff. */
const WORKING_RETRY_MS = 5_000;
/** How soon a write that failed under the timer is tried again. */
const WRITE_RETRY_MS = 5_000;
/** Node fires a longer timeout at once: a far next time is reached in steps of at most this. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_NAME = 200;
/** The most firings each trigger keeps past its history for their key's day: a bound on the file (commit()). */
const KEPT_FIRINGS = 1_000;
const ENDED = new Set(["completed", "failed", "cancelled"]);
const dueOf = (trigger: { firings: readonly { status: string }[] }) => trigger.firings.filter((f) => f.status === "due").length;
const LOST_AT_SETUP = "The server stopped while setting up the run.";

/** `max_cost_usd`: each run's cap; absent, the agent's default as it stands when the firing starts (one of the two is
 *  required: server.ts targetIssues and start). */
export type Target = { kind: "start_run"; agent_id: string; input: Json; max_cost_usd?: number; effort?: string } | { kind: "message_run"; run_id: string; input: Json };
type FiringStatus = (typeof FIRING_STATUSES)[number];
type Firing = {
  key: string;
  /** `manual` (run now), or the id of the adapter that delivered it. */
  by: string;
  nominal_at: string;
  status: FiringStatus;
  /** When it was recorded. */
  at: string;
  run_id?: string;
  reason?: string;
  error?: { code: string; message: string };
  /** A `missed` row: how many times it stands for, from its nominal_at on. */
  count?: number;
  /** A firing kept due by a full server: how many tries so far, and when the next is. */
  attempts?: number;
  retry_at?: string;
  /** A failed firing whose trigger.failed is in the webhook's outbox, or had no webhook to go to. */
  notified?: boolean;
  /** A time that fired late, within the catch-up window: the server was down, or its timer late. */
  catch_up?: boolean;
  /** A failed firing that turned its trigger off (FAILURES_TO_PAUSE in a row). */
  paused?: boolean;
  /** A webhook firing's payload, cut to PAYLOAD_KEPT_BYTES, kept while it is due: what its run is given. */
  payload?: string;
  /** What its source says of the payload (a webhook's scheme, event and action), kept with it: named on its tag. */
  attrs?: Record<string, string>;
};
type Trigger = {
  id: string; name: string; enabled: boolean; source: Source; target: Target; created_at: string; updated_at: string; next_at: string | null; firings: Firing[];
  /** The latest run its firings started, kept here and not only in the history, which drops its oldest firings: overlap
   *  reads it. */
  last_run_id?: string;
  /** Firings keyed by a caller's id (run now's Idempotency-Key, a webhook's webhook-id) that left the history, kept for
   *  their key's day (IDEMPOTENCY_TTL_S), so a sender's retry answers its firing and never fires again. */
  kept_firings?: Firing[];
  catchup_window_s: number; failures_in_a_row: number;
  /** Why it is off, when a failure streak turned it off; null once it is on again. */
  disabled: { at: string; reason: "auto_paused" } | { at: string; reason: "source_unreadable"; detail: string } | null;
};
/** What a trigger.failed webhook message says (webhooks.ts). */
export type TriggerFailed = { trigger_id: string; name: string; firing_key: string; nominal_at: string; error: { code: string; message: string }; auto_paused: boolean };
/** A run's provenance, kept in its serve.json: the trigger that started it, and the firing. */
export type RunTrigger = { id: string; firing_key: string };
/** The engine's clock and its one timer: Date.now and setTimeout, or a test's. */
export type TriggerClock = { now(): number; arm(fire: () => void, ms: number): { clear(): void } };
export type TriggerDeps = {
  /** What keeps a target from starting runs here, by field (its agent, its kind, its input). */
  targetIssues(target: Target): Promise<InputIssue[]>;
  /** Starts the target's run with `input`, as POST /agents/{id}/runs would, under `origin`; its first message is the
   *  trigger's (`from`, never the person's); ApiError when refused. */
  start(target: Extract<Target, { kind: "start_run" }>, input: Json, origin: RunTrigger, from: MessageOrigin): Promise<{ run_id: string }>;
  /** Sends `input` to the target's run, as POST /runs/{id}/messages would, under `key` (the run's store takes a message
   *  once per key), as the trigger's (`from`); ApiError when refused. */
  message(target: Extract<Target, { kind: "message_run" }>, input: Json, key: string, from: MessageOrigin): Promise<void | { skipped: string }>;
  /** An adapter's sealed settings (sealed-settings.ts): a trigger's minted secret made (at its create or a rotation)
   *  and shown once; a trigger's settings removed with it. Undefined for an adapter that keeps none. */
  settings(adapterId: string): { mint(scope: string, field: string): string; remove(scope: string): void } | undefined;
  /** A run's status, or null when there is no such run. */
  statusOf(runId: string): Promise<string | null>;
  /** The run the agent store started under origin `key`, if one: a firing left due by a server that went down mid-start.
   *  `setup_lost`: that server went down before it set the run up, so the run never started (files.ts SETUP_LOST). */
  runOf(key: string): Promise<{ run_id: string; setup_lost: boolean } | null>;
  /** Queues a trigger.failed webhook message under `key`, the firing's (webhooks.ts emitTrigger): `off` when there is no
   *  webhook to send it to; `unsaved` or `closed` when it is not in the outbox on disk. */
  notify(failed: TriggerFailed, key: string): "queued" | "unsaved" | "off" | "closed";
  say(fields: Record<string, string | number>): void;
  clock?: TriggerClock;
  /** The sources this engine reads: the registry's (trigger-adapters.ts), unless a test gives its own. */
  adapters?: readonly TriggerAdapter[];
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

/** `catchup_window_s`, as given (absent: undefined). */
function settingsOf(body: Json, issues: InputIssue[]): { catchup_window_s?: number } {
  if (body.catchup_window_s !== undefined && !(Number.isSafeInteger(body.catchup_window_s) && (body.catchup_window_s as number) >= 0 && (body.catchup_window_s as number) <= MAX_EVERY_S)) issues.push({ field: "catchup_window_s", reason: "invalid", message: `catchup_window_s is a whole number of seconds, 0 to ${MAX_EVERY_S} (0: a missed time never fires)` });
  return typeof body.catchup_window_s === "number" ? { catchup_window_s: body.catchup_window_s } : {};
}
const WRITABLE = ["name", "enabled", "source", "target", "catchup_window_s"];

/** A trigger as triggers.json keeps it, whole: what the engine reads of it is there, of its type. */
function wellFormed(adapters: readonly TriggerAdapter[], t: unknown): t is Trigger {
  if (!isObject(t) || typeof t.id !== "string" || typeof t.name !== "string" || typeof t.enabled !== "boolean" || typeof t.created_at !== "string" || typeof t.updated_at !== "string") return false;
  if (!(t.next_at === null || instantOf(t.next_at) !== undefined) || !(t.last_run_id === undefined || typeof t.last_run_id === "string")) return false;
  if (!Number.isSafeInteger(t.catchup_window_s) || !Number.isSafeInteger(t.failures_in_a_row) || !(t.disabled === null || isObject(t.disabled))) return false;
  const { source, target } = t;
  const adapter = isObject(source) && typeof source.kind === "string" ? adapterIn(adapters, source.kind) : undefined;
  const timed = adapter !== undefined && adapter.wellFormed(source as Source);
  const aimed = isObject(target) && isObject(target.input) && (target.kind === "message_run" ? typeof target.run_id === "string" : target.kind === "start_run" && typeof target.agent_id === "string" && (target.max_cost_usd === undefined || typeof target.max_cost_usd === "number"));
  if (!timed || !aimed) return false;
  const firing = (f: unknown) => isObject(f) && typeof f.key === "string" && (FIRING_STATUSES as readonly unknown[]).includes(f.status) && typeof f.by === "string" && (f.by === "manual" || adapterIn(adapters, f.by) !== undefined) && instantOf(f.nominal_at) !== undefined && typeof f.at === "string";
  const list = (value: unknown) => value === undefined || (Array.isArray(value) && value.every(firing));
  return Array.isArray(t.firings) && t.firings.every(firing) && list(t.kept_firings);
}

export class Triggers {
  private readonly file: string;
  private readonly clock: TriggerClock;
  private readonly adapters: readonly TriggerAdapter[];
  private triggers: Trigger[] = [];
  /** Why triggers.json does not read: nothing fires and nothing is written over it until it does. */
  private readonly unreadable?: string;
  private timer?: { clear(): void };
  /** The firings in their turn, queued or being driven, by key, with that turn: a firing is asked for once at a time,
   *  and the timer arms for none of them until its turn ends. */
  private readonly driving = new Map<string, Promise<void>>();
  /** Due firings whose last write failed, by key, and when to drive them again: on disk they may hold no retry time. */
  private readonly rewrite = new Map<string, number>();
  /** Each trigger's firings, driven one after another in the order asked: a firing's overlap check reads what the one
   *  before it settled to (a firing a crash left due settles to its run before the next start's own is checked). */
  private readonly turns = new Map<string, Promise<void>>();
  private closed = false;

  constructor(data: string, private readonly deps: TriggerDeps) {
    this.file = join(data, TRIGGERS_FILE);
    this.clock = deps.clock ?? REAL_CLOCK;
    this.adapters = deps.adapters ?? TRIGGER_ADAPTERS;
    // A pushed source's own hook path is its id, beside the trigger ids a hook path also names: none looks like one.
    const shaped = this.adapters.find((a) => a.id.startsWith("trg_"));
    if (shaped) throw new Error(`a trigger source's id never starts as a trigger's does: ${shaped.id}`);
    let text: string | undefined;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = (error as Error).message;
    }
    if (text === undefined) return;
    try {
      const doc = JSON.parse(text) as unknown;
      if (!isObject(doc) || doc.v !== 1 || !Array.isArray(doc.triggers)) throw new Error("not a triggers file of version 1");
      const bad = doc.triggers.findIndex((t) => !wellFormed(this.adapters, t));
      if (bad >= 0) throw new Error(`its trigger at ${bad} is not one this server reads`);
      this.triggers = doc.triggers as Trigger[];
    } catch (error) {
      this.unreadable = (error as Error).message;
    }
    if (this.unreadable) deps.say({ condition: "triggers_unreadable", file: this.file, error: this.unreadable });
  }

  /** At the server's start: every firing an earlier server left due driven again (its origin key makes a run
   *  it already started the same run), the times missed while it was down recorded, the timer armed, and each failure's
   *  trigger.failed queued that is not yet. */
  start(): void {
    this.offUnreadable(this.triggers.filter((t) => t.enabled && this.problem(t.source)), this.clock.now());
    // A trigger.failed an earlier server wrote the firing of but never queued: queued before the first tick records
    // anything, so no trim reaches it first.
    for (const t of this.unreadable ? [] : this.triggers) for (const f of t.firings) if (unmarked(f)) this.notifyFailed(t.id, f.key);
    this.tick();
    this.arm();
  }

  close(): void {
    this.closed = true;
    this.timer?.clear();
    this.timer = undefined;
  }

  list() {
    return { triggers: this.readable().map((t) => this.view(t)) };
  }

  get(id: string) {
    return this.view(this.need(id));
  }

  firings(id: string) {
    return { firings: [...this.need(id).firings].reverse().map(firingView) };
  }

  async create(body: Json) {
    this.readable();
    const now = this.clock.now();
    const issues = unknownFields(body, WRITABLE);
    const source = sourceOf(this.adapters, body.source, now, issues);
    const target = targetOf(body.target, issues);
    const settings = settingsOf(body, issues);
    if (body.name !== undefined && !(typeof body.name === "string" && body.name.trim() && body.name.length <= MAX_NAME)) issues.push({ field: "name", reason: "invalid", message: `name is a string of 1 to ${MAX_NAME} characters` });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") issues.push({ field: "enabled", reason: "wrong_type", message: "enabled is true or false" });
    // Checked as its runs are given it: the input, then the line saying what fired it (a name the trigger may yet take).
    if (target) issues.push(...(await this.deps.targetIssues(this.given(typeof body.name === "string" ? body.name.trim() : `trg_${"0".repeat(24)}`, source, target, now))));
    if (issues.length || !source || !target) throw invalid(issues);
    const id = `trg_${randomBytes(12).toString("hex")}`;
    const enabled = body.enabled !== false;
    if (enabled) this.scopeFree(source, id);
    const trigger: Trigger = { id, name: typeof body.name === "string" ? body.name.trim() : id, enabled, source, target, catchup_window_s: settings.catchup_window_s ?? CATCHUP_WINDOW_S, failures_in_a_row: 0, disabled: null, created_at: iso(now), updated_at: iso(now), next_at: enabled ? this.nextIso(source, now) : null, firings: [] };
    // Its secrets are kept before the trigger is: one that cannot be kept (no seal key) makes none.
    const minted = this.mint(source, id);
    this.commit(() => void this.triggers.push(trigger));
    this.arm();
    // What it minted, shown this once, by field: a webhook's `secret`.
    return { ...this.view(trigger), ...(minted as { secret?: string }) };
  }

  /** A trigger's new signing secret, shown this once; the old one signs nothing from now on. */
  rotate(id: string): Record<string, string> {
    const trigger = this.need(id);
    if (!mints(this.adapter(trigger.source))) throw invalid([{ field: "source.kind", reason: "not_allowed", message: `Only a trigger whose source has a signing secret has one (${this.adapters.filter(mints).map((a) => a.id).join(", ")}).` }]);
    return this.mint(trigger.source, id);
  }

  /** Whether `id` is a trigger of the pushed source `kind` that is on: the one a request delivered for `kind` may fire. */
  hookable(id: string, kind: string): boolean {
    return this.hookSource(id, kind) !== undefined;
  }

  /** The source of trigger `id` when it is hookable: what its pushed source's check and parse read (its filter). */
  hookSource(id: string, kind: string): Source | undefined {
    const trigger = this.unreadable ? undefined : this.triggers.find((t) => t.id === id);
    return trigger !== undefined && trigger.source.kind === kind && this.adapter(trigger.source).delivery === "push" && trigger.enabled ? trigger.source : undefined;
  }

  /** The triggers of the pushed source `kind` that are on and listen on `scope` (its adapter's scopeOf): the ones an
   *  event there fires. */
  scoped(kind: string, scope: string): string[] {
    const adapter = adapterIn(this.adapters, kind);
    if (this.unreadable || !adapter?.scopeOf) return [];
    return this.triggers.filter((t) => t.enabled && t.source.kind === kind && adapter.scopeOf!(t.source) === scope).map((t) => t.id);
  }

  /** A delivered request for trigger `id` (its pushed source's checks passed, server.ts): its firing, keyed by the
   *  sender's own id for it (a webhook's `webhook-id`), recorded due in one write and driven after the answer. `created`
   *  false: that id's firing, as it stands. */
  receive(id: string, eventId: string, payload: string, attrs?: Record<string, string>): { created: boolean; firing: ReturnType<typeof firingView> } {
    const trigger = this.need(id);
    const by = trigger.source.kind;
    const key = firingKey(by, id, eventId);
    const known = this.known(trigger, key);
    if (known) return { created: false, firing: firingView(known) };
    this.roomFor(trigger);
    const now = this.clock.now();
    const firing: Firing = { key, by, nominal_at: second(now), status: "due", at: iso(now), payload: cut(payload), ...(attrs && Object.keys(attrs).length ? { attrs } : {}) };
    this.commit(() => this.record(trigger, firing));
    void this.inTurn(id, key);
    return { created: true, firing: firingView(firing) };
  }

  /** PATCH: any of name, enabled, source, target and catchup_window_s. Enabled again, or its source changed, a trigger goes on from now: a
   *  paused range is skipped, never caught up. Only the fields named change, applied to the trigger as it stands once
   *  the target's check is done: an edit made meanwhile keeps its own. */
  async update(id: string, body: Json) {
    const was = this.need(id);
    const issues = unknownFields(body, WRITABLE);
    const source = body.source === undefined ? undefined : sourceOf(this.adapters, body.source, this.clock.now(), issues);
    const target = body.target === undefined ? undefined : targetOf(body.target, issues);
    const settings = settingsOf(body, issues);
    if (body.name !== undefined && !(typeof body.name === "string" && body.name.trim() && body.name.length <= MAX_NAME)) issues.push({ field: "name", reason: "invalid", message: `name is a string of 1 to ${MAX_NAME} characters` });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") issues.push({ field: "enabled", reason: "wrong_type", message: "enabled is true or false" });
    if (target) issues.push(...(await this.deps.targetIssues(this.given(typeof body.name === "string" ? body.name.trim() : was.name, source ?? was.source, target, this.clock.now()))));
    if (issues.length || (body.source !== undefined && !source) || (body.target !== undefined && !target)) throw invalid(issues);
    const trigger = this.need(id);
    if (source && source.kind !== trigger.source.kind) throw invalid([{ field: "source.kind", reason: "not_allowed", message: "A trigger's source kind is fixed: make a new trigger for another." }]);
    const now = this.clock.now();
    const enabled = typeof body.enabled === "boolean" ? body.enabled : trigger.enabled;
    const adapter = this.adapter(trigger.source);
    const problem = enabled && !source ? this.problem(trigger.source) : undefined;
    if (problem) throw invalid([{ field: "source", reason: "invalid", message: `This ${adapter.label} no longer reads (${problem}): give it a new source.` }]);
    const next = !enabled ? null : source || !trigger.enabled ? this.nextIso(source ?? trigger.source, now) : trigger.next_at;
    if (enabled && next === null && adapter.delivery === "clock") throw invalid([{ field: "enabled", reason: "invalid", message: `This ${adapter.label} has no time left to fire at: give it a new source.` }]);
    // On again, a trigger starts a new streak: a failure streak that turned it off is behind it.
    const again = enabled && !trigger.enabled ? { failures_in_a_row: 0, disabled: null } : {};
    if (enabled) this.scopeFree(source ?? trigger.source, trigger.id);
    this.commit(() => Object.assign(trigger, { ...(typeof body.name === "string" ? { name: body.name.trim() } : {}), ...(source ? { source } : {}), ...(target ? { target } : {}), ...settings, ...again, enabled, updated_at: iso(now), next_at: next }));
    this.arm();
    return this.view(trigger);
  }

  remove(id: string): void {
    const trigger = this.need(id);
    this.commit(() => void (this.triggers = this.triggers.filter((t) => t !== trigger)));
    if (this.adapter(trigger.source).settings?.scope === "trigger") this.deps.settings(trigger.source.kind)?.remove(id);
    this.arm();
  }

  /** Run now: one firing per Idempotency-Key, driven before the answer. `created` false: the key's firing, as it stands. */
  async fire(id: string, idempotencyKey: string): Promise<{ created: boolean; firing: ReturnType<typeof firingView> }> {
    const trigger = this.need(id);
    const key = firingKey("manual", id, idempotencyKey);
    const known = this.known(trigger, key);
    if (known) return { created: false, firing: firingView(known) };
    this.roomFor(trigger);
    const now = this.clock.now();
    const firing: Firing = { key, by: "manual", nominal_at: second(now), status: "due", at: iso(now) };
    this.commit(() => this.record(trigger, firing));
    await this.inTurn(id, key);
    return { created: true, firing: firingView(this.find(id, key)?.firing ?? firing) };
  }

  // ---- the timer and the firings --------------------------------------------------------------------------------------

  /** Every enabled trigger whose next time has come: its firing recorded and its next time moved on, in one write; then
   *  each due firing whose time has come driven, and the timer armed again. */
  private tick(): void {
    this.timer = undefined;
    if (this.closed || this.unreadable) return;
    const now = this.clock.now();
    const due = this.triggers.filter((t) => t.enabled && t.next_at !== null && Date.parse(t.next_at) <= now);
    if (due.length) {
      // One whose source no longer reads is turned off alone, before the write, so it neither stalls the others nor
      // reads as a write that failed.
      const unreadable = due.filter((t) => this.problem(t.source));
      if (!this.offUnreadable(unreadable, now)) {
        this.timer = this.clock.arm(() => this.tick(), WRITE_RETRY_MS);
        return;
      }
      try {
        this.commit(() => { for (const trigger of due) if (!unreadable.includes(trigger)) this.advance(trigger, now); });
      } catch (error) {
        this.deps.say({ condition: "triggers_unwritable", file: this.file, error: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
        this.timer = this.clock.arm(() => this.tick(), WRITE_RETRY_MS);
        return;
      }
    }
    const drive = this.triggers.flatMap((t) => t.firings.filter((f) => f.status === "due" && ((!f.retry_at && !this.rewrite.has(f.key)) || this.dueAt(f) <= now)).map((f) => [t.id, f.key] as const));
    for (const [, key] of drive) this.rewrite.delete(key);
    const tell = this.triggers.flatMap((t) => t.firings.filter((f) => unmarked(f) && this.dueAt(f) <= now).map((f) => [t.id, f.key] as const));
    for (const [id, key] of tell) {
      this.rewrite.delete(key);
      this.notifyFailed(id, key);
    }
    this.arm();
    for (const [id, key] of drive) void this.inTurn(id, key);
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
      this.arm();
    });
    return turn;
  }

  /** Each of `triggers` turned off, with why its source no longer reads, in one write, and said. False when the write
   *  failed, which is said too: the caller tries again after WRITE_RETRY_MS. */
  private offUnreadable(triggers: Trigger[], now: number): boolean {
    if (!triggers.length) return true;
    const why = new Map(triggers.map((t) => [t, this.problem(t.source)!]));
    try {
      this.commit(() => {
        for (const [t, detail] of why) Object.assign(t, { enabled: false, next_at: null, disabled: { at: iso(now), reason: "source_unreadable", detail } });
      });
    } catch (error) {
      this.deps.say({ condition: "triggers_unwritable", file: this.file, error: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
      return false;
    }
    for (const [t, detail] of why) this.deps.say({ condition: "trigger_source_unreadable", trigger: t.id, error: detail });
    return true;
  }

  /** Records `trigger`'s firings up to now and moves its next time on from the last nominal one. Of the times that have
   *  come, the latest fires (on time, or late within catchup_window_s: a catch-up, under its own nominal key), and every
   *  other is one `missed` row with their count. A one-time schedule, or one that never fires again, is turned off. */
  private advance(trigger: Trigger, now: number): void {
    const adapter = this.adapter(trigger.source);
    // A pushed source has no next time, so it is never here.
    const clock = adapter.clock?.(trigger.source);
    if (!clock) return;
    const by = adapter.id;
    const windowMs = trigger.catchup_window_s * 1000;
    const first = Date.parse(trigger.next_at!);
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
    if (missed > 0) this.record(trigger, { key: firingKey(by, trigger.id, `missed\n${second(first)}`), by, nominal_at: second(first), status: "missed", at: iso(now), count: missed, reason: `The server was down or its timer late: ${missed === 1 && !capped ? "this time was" : `${missed}${capped ? " or more" : ""} times from this one were`} not fired.` });
    // A message_run firing has no overlap check, so a run that stays busy would hold one more due firing each time.
    const full = dueOf(trigger) >= DUE_KEPT ? { status: "skipped" as const, reason: `${DUE_KEPT} earlier firings are still waiting to reach the run.` } : { status: "due" as const };
    if (fires) this.record(trigger, { key: firingKey(by, trigger.id, second(last)), by, nominal_at: second(last), ...full, at: iso(now), ...(late > LATE_MS ? { catch_up: true } : {}) });
    trigger.next_at = next === null ? null : iso(next);
    if (next === null) trigger.enabled = false;
  }

  /** A firing taken from due to its end: skipped when its trigger's last run is active, else its run started. A full
   *  server (429), or a last run that could not be read, keeps it due and tries again later. Nothing it holds across a wait is an object: the trigger may be edited or
   *  deleted meanwhile, so each step finds it again by id and key. */
  private async drive(triggerId: string, key: string): Promise<void> {
    try {
      const found = this.find(triggerId, key);
      if (!found || found.firing.status !== "due") return;
      // Its run already started (the store has its key) is its run, whatever runs now.
      const prior = await this.deps.runOf(key).then((run) => ({ run }), (error: Error) => ({ retry: error }));
      if (this.closed) return;
      if ("retry" in prior) return this.retry(triggerId, key, prior.retry);
      // A key stays bound to its run: one lost at setup is this firing's failure, never fired again. The next firing
      // goes ahead, and a run now is the person's retry.
      if (prior.run?.setup_lost) return this.failed(triggerId, key, { code: "run_failed", message: LOST_AT_SETUP }, { run_id: prior.run.run_id, reason: LOST_AT_SETUP });
      if (prior.run) return this.started(triggerId, key, prior.run.run_id);
      if (found.trigger.target.kind === "message_run") return await this.send(triggerId, key);
      const busy = await this.busy(found.trigger, found.firing).catch((error: Error) => ({ retry: error }));
      if (this.closed) return;
      if (typeof busy === "string") return this.settle(triggerId, key, { status: "skipped", reason: busy });
      if (busy) return this.retry(triggerId, key, busy.retry);
      const now = this.find(triggerId, key);
      if (!now) return;
      // The target as it is now: an edit during the overlap check may have made it a message.
      if (now.trigger.target.kind === "message_run") return await this.send(triggerId, key);
      let started: { run_id: string };
      try {
        started = await this.deps.start(now.trigger.target, this.inputOf(now.trigger, now.firing), { id: triggerId, firing_key: key }, this.originOf(now.trigger));
      } catch (error) {
        // Stopping, the start may have been cut by the close: the firing stays due for the next start, whose origin key
        // finds a run this one made.
        if (this.closed) return;
        if (error instanceof ApiError && ["rate_limited", "home_busy", "unavailable"].includes(error.code)) return this.retry(triggerId, key, error);
        return this.failed(triggerId, key, { code: error instanceof ApiError ? error.code : "internal", message: (error as Error).message });
      }
      if (this.closed) return;
      this.started(triggerId, key, started.run_id);
    } catch (error) {
      // A throw none of the answers above handles: whatever it left (still due, most likely) is driven again after the
      // write retry's wait, never at once (its retry time may have passed).
      this.rewrite.set(key, this.clock.now() + WRITE_RETRY_MS);
      this.deps.say({ condition: "trigger_firing_failed", trigger: triggerId, firing: key, error: (error as Error).message });
    }
  }

  /** A message_run firing: its message to the target's run, under its key. No overlap: the run's own state picks how the
   *  message lands (steer, answer or follow-up). */
  private async send(triggerId: string, key: string): Promise<void> {
    const found = this.find(triggerId, key);
    if (!found || found.trigger.target.kind !== "message_run") return;
    const { target } = found.trigger;
    let skipped: string | undefined;
    try {
      skipped = (await this.deps.message(target, this.inputOf(found.trigger, found.firing), key, this.originOf(found.trigger)))?.skipped;
    } catch (error) {
      if (this.closed) return;
      if (error instanceof ApiError && ["rate_limited", "home_busy", "unavailable"].includes(error.code)) return this.retry(triggerId, key, error);
      return this.failed(triggerId, key, { code: error instanceof ApiError ? error.code : "internal", message: (error as Error).message }, { run_id: target.run_id });
    }
    if (this.closed) return;
    if (skipped) return this.settle(triggerId, key, { status: "skipped", reason: skipped });
    this.settle(triggerId, key, { status: "sent", run_id: target.run_id }, (t) => void (t.failures_in_a_row = 0));
  }

  private find(triggerId: string, key: string): { trigger: Trigger; firing: Firing } | undefined {
    const trigger = this.triggers.find((t) => t.id === triggerId);
    const firing = trigger?.firings.find((f) => f.key === key);
    return trigger && firing ? { trigger, firing } : undefined;
  }

  /** Why `firing` is skipped, if it is: an earlier firing still due, or the last run still active. Never, for a trigger
   *  whose source starts a run per firing (its adapter's concurrent): the server's run limit still holds, through retry. */
  private async busy(trigger: Trigger, firing: Firing): Promise<string | undefined> {
    if (this.adapter(trigger.source).concurrent?.(trigger.source)) return undefined;
    const earlier = trigger.firings.slice(0, trigger.firings.indexOf(firing));
    if (earlier.some((f) => f.status === "due")) return "An earlier firing is still waiting to start its run.";
    const last = trigger.last_run_id;
    if (!last) return undefined;
    const status = await this.deps.statusOf(last);
    if (status === null || ENDED.has(status)) return undefined;
    return status === "input_required" ? `The last run, ${last}, is waiting for a person.` : `The last run, ${last}, is still ${status}.`;
  }

  private retry(triggerId: string, key: string, error: Error): void {
    // A run that is working refused a message that may not answer it: no failed try, and looked at again soon, so the
    // message lands within WORKING_RETRY_MS of the turn's end.
    if (error instanceof ApiError && (error.extra.details as { reason?: string } | undefined)?.reason === "working") {
      return this.settle(triggerId, key, { status: "due", retry_at: iso(this.clock.now() + WORKING_RETRY_MS), reason: error.message });
    }
    const attempts = (this.find(triggerId, key)?.firing.attempts ?? 0) + 1;
    const wait = Math.max(RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1]!, error instanceof ApiError ? (error.extra.retry_after_ms ?? 0) : 0);
    this.settle(triggerId, key, { status: "due", attempts, retry_at: iso(this.clock.now() + wait), reason: error.message });
  }

  private started(triggerId: string, key: string, runId: string): void {
    this.settle(triggerId, key, { status: "started", run_id: runId }, (t) => void (t.failures_in_a_row = 0));
    this.deps.say({ condition: "trigger_fired", trigger: triggerId, firing: key, run: runId });
  }

  /** A failed firing: one more in its trigger's streak, the trigger turned off at FAILURES_TO_PAUSE, and trigger.failed
   *  queued (after the firing is written: a start finds one not yet queued and queues it, under the same webhook-id). */
  private failed(triggerId: string, key: string, error: { code: string; message: string }, also: Partial<Firing> = {}): void {
    this.settle(triggerId, key, { status: "failed", error, ...also }, (t, firing) => {
      t.failures_in_a_row += 1;
      if (t.failures_in_a_row < FAILURES_TO_PAUSE || !t.enabled) return;
      Object.assign(t, { enabled: false, next_at: null, disabled: { at: iso(this.clock.now()), reason: "auto_paused" } });
      firing.paused = true;
    });
    this.notifyFailed(triggerId, key);
  }

  private notifyFailed(triggerId: string, key: string): void {
    const found = this.find(triggerId, key);
    if (!found || found.firing.status !== "failed" || found.firing.notified) return;
    const { trigger, firing } = found;
    const told = this.deps.notify({ trigger_id: trigger.id, name: trigger.name, firing_key: key, nominal_at: firing.nominal_at, error: firing.error!, auto_paused: firing.paused === true }, key);
    // A mark that does not land (the outbox's write failed, or this file's: settle) is tried again soon while the server
    // runs (tick), under the same key, which the outbox holds once: a restart then finds it marked.
    if (told === "queued" || told === "off") this.settle(triggerId, key, { notified: true });
    else if (told === "unsaved") this.rewrite.set(key, this.clock.now() + WRITE_RETRY_MS);
  }

  /** The firing's new state, written with `also` done to its trigger; one whose trigger was deleted meanwhile is gone with it. */
  private settle(triggerId: string, key: string, change: Partial<Firing>, also?: (trigger: Trigger, firing: Firing) => void): void {
    try {
      this.commit(() => {
        const found = this.find(triggerId, key);
        if (!found) return;
        // Out of due, a firing keeps no retry, nor the reason the last try gave.
        Object.assign(found.firing, change.status === "due" || change.status === undefined ? change : { reason: undefined, attempts: undefined, retry_at: undefined, ...change });
        if (change.status !== undefined && change.status !== "due") {
          delete found.firing.payload;
          delete found.firing.attrs;
        }
        // Run ids are UUIDv7s, which sort by when the run started: a firing that finds an older run (a run now's key
        // retried past its day) never takes the place of a later one.
        const last = found.trigger.last_run_id;
        if (change.run_id && found.trigger.target.kind === "start_run" && !(last && last > change.run_id)) found.trigger.last_run_id = change.run_id;
        also?.(found.trigger, found.firing);
      });
    } catch (error) {
      // Left as it was: driven again soon (arm), under the same origin key, and at the next start.
      this.rewrite.set(key, this.clock.now() + WRITE_RETRY_MS);
      this.deps.say({ condition: "triggers_unwritable", file: this.file, error: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
    }
  }

  private record(trigger: Trigger, firing: Firing): void {
    if (trigger.firings.some((f) => f.key === firing.key)) return;
    trigger.firings.push(firing);
    let over = trigger.firings.length - HISTORY_KEPT;
    // Kept past the history: a firing still due, and a failure whose trigger.failed is not queued yet (the outbox's write,
    // or this file's, keeps failing), the newest UNTOLD_KEPT of them; an older one's notice is dropped, and said.
    const untold = new Set(trigger.firings.filter(unmarked).slice(-UNTOLD_KEPT));
    const gone = over > 0 ? trigger.firings.filter((f) => f.status !== "due" && !untold.has(f) && over-- > 0) : [];
    for (const f of gone) if (unmarked(f)) this.deps.say({ condition: "trigger_notice_dropped", trigger: trigger.id, firing: f.key });
    trigger.firings = trigger.firings.filter((f) => !gone.includes(f));
    const kept = [...(trigger.kept_firings ?? []), ...gone.filter((f) => f.by === "manual" || adapterIn(this.adapters, f.by)?.delivery === "push")].filter((f) => this.inDay(f)).slice(-KEPT_FIRINGS);
    if (kept.length) trigger.kept_firings = kept;
    else delete trigger.kept_firings;
  }

  /** A new firing's room: refused (429, retryable, nothing written) while the trigger holds DUE_KEPT firings due. */
  private roomFor(trigger: Trigger): void {
    if (dueOf(trigger) < DUE_KEPT) return;
    this.deps.say({ condition: "trigger_firings_full", trigger: trigger.id, due: DUE_KEPT });
    throw new ApiError("rate_limited", `${DUE_KEPT} firings are still due for this trigger, waiting on its run; send it again later.`, { retry_after_ms: FULL_RETRY_S * 1000, details: { due: DUE_KEPT } }, { "retry-after": String(FULL_RETRY_S) });
  }

  /** The firing `key` names, in the history or kept for its key's day after it left. */
  private known(trigger: Trigger, key: string): Firing | undefined {
    return trigger.firings.find((f) => f.key === key) ?? trigger.kept_firings?.find((f) => f.key === key && this.inDay(f));
  }

  /** Whether a firing is within its key's day, as an Idempotency-Key answers. */
  private inDay(firing: Firing): boolean {
    return this.clock.now() - Date.parse(firing.at) <= IDEMPOTENCY_TTL_S * 1000;
  }

  /** The timer, at the soonest next time of an enabled trigger or retry of a due firing. */
  private arm(): void {
    this.timer?.clear();
    this.timer = undefined;
    if (this.closed || this.unreadable) return;
    let soonest = Infinity;
    for (const t of this.triggers) {
      if (t.enabled && t.next_at !== null) soonest = Math.min(soonest, Date.parse(t.next_at));
      // One being driven arms nothing: its end arms the timer again. A failure whose mark did not land arms its retry.
      for (const f of t.firings) if ((f.status === "due" && !this.driving.has(f.key)) || unmarked(f)) soonest = Math.min(soonest, this.dueAt(f));
    }
    if (soonest !== Infinity) this.timer = this.clock.arm(() => this.tick(), Math.max(0, soonest - this.clock.now()));
  }

  /** When a due firing is driven next: after the write retry's wait when its write or its drive failed (that wait wins
   *  over a retry time that may have passed), else at its retry; one with neither is driven by whatever recorded it. */
  private dueAt(firing: Firing): number {
    return this.rewrite.get(firing.key) ?? (firing.retry_at ? Date.parse(firing.retry_at) : Infinity);
  }

  /** `change` applied and written whole, or, when the write fails, undone and thrown. Each change, a signed request's
   *  firing included, copies and rewrites the whole file and syncs it: one writer (server.lock), and a bounded file. A
   *  firing is about 170 bytes of JSON, a due webhook firing's payload at most 16 KiB more, and a trigger keeps at most
   *  HISTORY_KEPT (200) in its history and KEPT_FIRINGS (1,000) past it: about 230 KiB a trigger at its fullest, which
   *  measured about 3 ms a write (copy, JSON and fsync) on an SSD. Its history runs past HISTORY_KEPT by at most
   *  UNTOLD_KEPT (50) failures not yet told and DUE_KEPT (20) due firings, whose payloads add at most 320 KiB. */
  private commit<T>(change: () => T): T {
    if (this.closed) throw new ApiError("unavailable", "The server is stopping.");
    const before = structuredClone(this.triggers);
    try {
      const result = change();
      writeDurableSync(this.file, `${JSON.stringify({ v: 1, triggers: this.triggers })}\n`);
      return result;
    } catch (error) {
      this.triggers = before;
      throw error;
    }
  }

  private readable(): Trigger[] {
    if (this.unreadable) throw new ApiError("store_unreadable", `${TRIGGERS_FILE} in the data directory does not read (${this.unreadable}); it is never written over. Fix it or move it away, then restart.`);
    return this.triggers;
  }

  private need(id: string): Trigger {
    const trigger = this.readable().find((t) => t.id === id);
    if (!trigger) throw new ApiError("not_found", `no trigger ${id}`);
    return trigger;
  }

  private view(trigger: Trigger) {
    const { firings, kept_firings: _, ...rest } = trigger;
    return { ...rest, last_run_id: trigger.last_run_id ?? null, last_firing: firings.length ? firingView(firings.at(-1)!) : null };
  }

  // ---- what each source's adapter says ----------------------------------------------------------------------------------

  /** `source`'s adapter: every kept or given source has one (wellFormed, sourceOf). */
  private adapter(source: Source): TriggerAdapter {
    return adapterIn(this.adapters, source.kind)!;
  }

  /** Each field `source`'s adapter mints for its triggers, made now for trigger `id`, by field: none for one that keeps
   *  no trigger-scoped secret. */
  private mint(source: Source, id: string): Record<string, string> {
    const adapter = this.adapter(source);
    if (!mints(adapter)) return {};
    const store = this.deps.settings(adapter.id);
    if (!store) throw new Error(`no sealed settings for ${adapter.id}`);
    return Object.fromEntries(Object.entries(adapter.settings!.fields).filter(([, f]) => f.mint).map(([field]) => [field, store.mint(id, field)]));
  }

  /** A scope belongs to one trigger: `source`'s (its adapter's scopeOf), for a trigger `id` that is to be on, is refused
   *  409 scope_taken while another trigger of its kind that is on listens there. */
  private scopeFree(source: Source, id: string): void {
    const adapter = this.adapter(source);
    if (!adapter.scopeOf) return;
    const scope = adapter.scopeOf(source);
    const other = this.triggers.find((t) => t.id !== id && t.enabled && t.source.kind === source.kind && adapter.scopeOf!(t.source) === scope);
    if (other) throw new ApiError("scope_taken", `The ${adapter.label} scope ${scope} belongs to the trigger ${other.id}: a scope belongs to one trigger. Turn that one off, or give this one another scope.`, { details: { source: adapter.id, scope, trigger_id: other.id } });
  }

  /** Why `source` no longer reads on this server, if it does not. */
  private problem(source: Source): string | undefined {
    return this.adapter(source).problem?.(source);
  }

  private nextIso(source: Source, now: number): string | null {
    const at = nextAfter(this.adapter(source), source, now);
    return at === null ? null : iso(at);
  }

  /** `target` with its input as a firing of a trigger named `name` would give it to its run: what create and PATCH
   *  check. */
  private given(name: string, source: Source | undefined, target: Target, now: number): Target {
    const trigger = { name, source: source ?? { kind: this.adapters[0]!.id }, target } as Trigger;
    return { ...target, input: this.inputOf(trigger, { key: "", by: "manual", nominal_at: second(now), status: "due", at: iso(now) }) };
  }

  /** Who a firing's input is from (pi-durable-agent's MessageOrigin): the trigger, by its definition as it fires, never
   *  by its payload. Only a source whose words are its owner's (a schedule's, fired on time or by hand) gives owner true;
   *  a pushed source's come from outside, its body empty or not. */
  private originOf(trigger: Trigger): MessageOrigin {
    return { kind: "trigger", trigger_id: trigger.id, source: trigger.source.kind as Extract<MessageOrigin, { kind: "trigger" }>["source"], owner: this.adapter(trigger.source).owner };
  }

  /** The run's input: the trigger's, then a pushed firing's payload marked untrusted (tagged with its source and what the
   *  source says of it), then a line saying what fired it and when, in the trigger's zone. */
  private inputOf(trigger: Trigger, firing: Firing): Json {
    const adapter = this.adapter(trigger.source);
    const when = local(Date.parse(firing.nominal_at), adapter.zone?.(trigger.source) ?? "UTC");
    const what = `the ${adapter.label} "${trigger.name}"`;
    const line = firing.by === "manual" ? `(Started by hand from ${what} at ${when}.)` : adapterIn(this.adapters, firing.by)?.delivery === "push" ? `(From ${what}, received at ${when}.)` : `(Started by ${what} for ${when}.)`;
    // The payload is whatever its sender wrote: an instruction in it is data, and its closing tag cannot end the block.
    const payload = firing.payload === undefined ? "" : `\n\n<trigger-payload source="${firing.by}"${tagAttrs(firing.attrs)} untrusted>\n${firing.payload.replaceAll("</trigger-payload", "<\\/trigger-payload")}\n</trigger-payload>`;
    const { input } = trigger.target;
    return typeof input.content === "string" ? { ...input, content: `${input.content}${payload}\n\n${line}` } : input;
  }
}

/** Whether `adapter`'s triggers each get a secret it mints. */
const mints = (adapter: TriggerAdapter) => adapter.settings?.scope === "trigger" && Object.values(adapter.settings.fields).some((f) => f.mint);
/** A failed firing whose trigger.failed is not marked queued. */
const unmarked = (firing: Firing) => firing.status === "failed" && !firing.notified;
/** A time a Date holds: past it (about the year 275760) a next time is none. */
const DATE_MAX_MS = 8.64e15;

function firingView(firing: Firing) {
  return { key: firing.key, by: firing.by, nominal_at: firing.nominal_at, status: firing.status, at: firing.at, run_id: firing.run_id ?? null, reason: firing.reason ?? null, error: firing.error ?? null, ...(firing.count !== undefined ? { count: firing.count } : {}), ...(firing.catch_up ? { catch_up: true } : {}), ...(firing.retry_at ? { attempts: firing.attempts ?? 0, retry_at: firing.retry_at } : {}) };
}

/** A payload tag's attributes from its source's `attrs`, each ` name="value"`: a name of lowercase letters, digits, `_` and
 *  `-` (never one the tag sets itself), a value cut to 200 characters with `&`, `<`, `>`, `"` escaped and line breaks
 *  made spaces, so a sender's words cannot end the tag or open another. */
function tagAttrs(attrs: Record<string, string> | undefined): string {
  const escape = (value: string) => value.slice(0, 200).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!).replace(/[\r\n\t]/g, " ");
  return Object.entries(attrs ?? {}).filter(([name, value]) => /^[a-z][a-z0-9_-]{0,31}$/.test(name) && name !== "source" && name !== "untrusted" && typeof value === "string").map(([name, value]) => ` ${name}="${escape(value)}"`).join("");
}

/** `text` cut to PAYLOAD_KEPT_BYTES of UTF-8 at a character's start, and said to be cut. */
function cut(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= PAYLOAD_KEPT_BYTES) return text;
  let end = PAYLOAD_KEPT_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n[cut: the payload was ${bytes.length} bytes, past ${PAYLOAD_KEPT_BYTES}]`;
}
