// Triggers: what starts a run with no caller. A trigger is a source (here a schedule: a cron line in an IANA zone, one
// time, or every N seconds on a grid) and a target (here a run of an agent, always capped). They live in
// DIR/triggers.json, written whole and synced on every change, with each trigger's last HISTORY_KEPT firings. Never in
// store.sqlite, which runs open.
// A firing starts exactly once. Its key is fixed by what it fires for: the trigger and its nominal time (a schedule), or
// the trigger and the caller's Idempotency-Key (run now). One write records it `due` and moves the trigger's next time
// on; a key already in the history is not recorded again. Then its run is started with the key as its origin, which
// the agent store keeps in the run's own insert, so a firing driven again after a restart finds its run and starts no
// second one. A firing whose trigger's last run is still active (working, or waiting on a person) is `skipped`.
// One timer, at the soonest next time of an enabled trigger (or a firing's retry), is armed again after each change. A
// next time is reckoned from the last nominal time, never from the clock, so a late timer does not drift. Times missed
// while the server was down, or its timer late past LATE_MS, are one `missed` row; the schedule goes on from now.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Cron } from "croner";
import { ApiError, type InputIssue, invalid } from "./errors.js";
import { writeDurableSync } from "./files.js";
import { EFFORTS } from "./model.js";
import { ID, isObject, type Json, unknownFields } from "./validate.js";

export const TRIGGERS_FILE = "triggers.json";
/** The firings each trigger keeps, newest last; a firing still due is never dropped. */
export const HISTORY_KEPT = 200;
/** The shortest every_s, and so the most often a schedule fires: a cron line has no seconds field. */
export const MIN_EVERY_S = 60;
export const SOURCE_KINDS = ["schedule"] as const;
export const TARGET_KINDS = ["start_run"] as const;
export const OVERLAP = ["skip"] as const;
export const FIRING_STATUSES = ["due", "started", "skipped", "failed", "missed"] as const;
/** A nominal time the timer reaches later than this was missed: the server was down, or its timer late. */
const LATE_MS = 60_000;
/** The most missed times one row counts one by one; past it the schedule jumps to now. */
const MISSED_COUNTED = 10_000;
/** The waits before a firing a full server refused (429), or whose last run could not be read, is tried again. */
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
/** How soon a write that failed under the timer is tried again. */
const WRITE_RETRY_MS = 5_000;
/** Node fires a longer timeout at once: a far next time is reached in steps of at most this. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_NAME = 200;
const ENDED = new Set(["completed", "failed", "cancelled"]);
const LOST_AT_SETUP = "The server stopped while setting up the run.";

type Schedule = { kind: "schedule"; cron: string; timezone: string } | { kind: "schedule"; at: string } | { kind: "schedule"; every_s: number; start_at: string };
type Target = { kind: "start_run"; agent_id: string; input: Json; max_cost_usd: number; effort?: string };
type FiringStatus = (typeof FIRING_STATUSES)[number];
type Firing = {
  key: string;
  by: "schedule" | "manual";
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
};
type Trigger = { id: string; name: string; enabled: boolean; source: Schedule; target: Target; created_at: string; updated_at: string; next_at: string | null; firings: Firing[] };
/** A run's provenance, kept in its serve.json: the trigger that started it, and the firing. */
export type RunTrigger = { id: string; firing_key: string };
/** The engine's clock and its one timer: Date.now and setTimeout, or a test's. */
export type TriggerClock = { now(): number; arm(fire: () => void, ms: number): { clear(): void } };
export type TriggerDeps = {
  /** What keeps a target from starting runs here, by field (its agent, its kind, its input). */
  targetIssues(target: Target): Promise<InputIssue[]>;
  /** Starts the target's run with `input`, as POST /agents/{id}/runs would, under `origin`; ApiError when refused. */
  start(target: Target, input: Json, origin: RunTrigger): Promise<{ run_id: string }>;
  /** A run's status, or null when there is no such run. */
  statusOf(runId: string): Promise<string | null>;
  /** The run the agent store started under origin `key`, if one: a firing left due by a server that went down mid-start.
   *  `setup_lost`: that server went down before it set the run up, so the run never started (files.ts SETUP_LOST). */
  runOf(key: string): Promise<{ run_id: string; setup_lost: boolean } | null>;
  say(fields: Record<string, string | number>): void;
  clock?: TriggerClock;
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
/** RFC 3339 in UTC, to the second: the form a schedule's key is made of. */
const second = (ms: number) => iso(ms).replace(/\.\d{3}Z$/, "Z");
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;
export const firingKey = (kind: "schedule" | "manual", triggerId: string, what: string) => `fir_${createHash("sha256").update(`${kind}\n${triggerId}\n${what}`).digest("hex").slice(0, 32)}`;
const cronOf = (source: { cron: string; timezone: string }) => new Cron(source.cron, { timezone: source.timezone, mode: "5-part" });

/** The source's first nominal time strictly after `after`, or null when it has none. */
function nextAfter(source: Schedule, after: number): number | null {
  if ("cron" in source) return cronOf(source).nextRun(new Date(after))?.getTime() ?? null;
  if ("at" in source) return Date.parse(source.at) > after ? Date.parse(source.at) : null;
  const start = Date.parse(source.start_at);
  const step = source.every_s * 1000;
  return start > after ? start : start + (Math.floor((after - start) / step) + 1) * step;
}

/** A time in `zone` as a person reads it: "Nov 1, 2026, 1:30 AM PDT". */
const local = (ms: number, zone: string) => new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(ms);
const zoneOf = (source: Schedule) => ("timezone" in source ? source.timezone : "UTC");
const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

function sourceOf(value: unknown, now: number, issues: InputIssue[]): Schedule | undefined {
  const bad = (field: string, reason: string, message: string) => void issues.push({ field: `source${field ? `.${field}` : ""}`, reason, message });
  if (!isObject(value)) return bad("", value === undefined ? "missing" : "wrong_type", "source is an object: {kind: \"schedule\", cron, timezone}, {kind: \"schedule\", at} or {kind: \"schedule\", every_s, start_at?}"), undefined;
  if (value.kind !== "schedule") return bad("kind", "not_an_option", "source.kind is schedule: this server's triggers fire on a schedule only, for now"), undefined;
  const forms = ["cron", "at", "every_s"].filter((field) => value[field] !== undefined);
  if (forms.length !== 1) return bad("", "invalid", "a schedule names exactly one of cron, at and every_s"), undefined;
  if (value.cron !== undefined) {
    issues.push(...unknownFields(value, ["kind", "cron", "timezone"]).map((i) => ({ ...i, field: `source.${i.field}` })));
    const timezone = value.timezone ?? "UTC";
    if (typeof timezone !== "string" || !validZone(timezone)) return bad("timezone", "invalid", "timezone is an IANA zone, such as America/Los_Angeles (default UTC)"), undefined;
    if (typeof value.cron !== "string" || value.cron.trim().split(/\s+/).length !== 5) return bad("cron", "invalid", "cron is five fields, minute hour day-of-month month day-of-week: a schedule fires at most once a minute"), undefined;
    const source = { kind: "schedule" as const, cron: value.cron.trim(), timezone };
    try {
      if (nextAfter(source, now) === null) return bad("cron", "invalid", "cron never fires"), undefined;
    } catch (error) {
      return bad("cron", "invalid", `cron does not read: ${(error as Error).message}`), undefined;
    }
    return source;
  }
  if (value.at !== undefined) {
    issues.push(...unknownFields(value, ["kind", "at"]).map((i) => ({ ...i, field: `source.${i.field}` })));
    if (typeof value.at !== "string" || !RFC3339.test(value.at)) return bad("at", "invalid", "at is an RFC 3339 date-time with its offset"), undefined;
    const at = Math.floor(Date.parse(value.at) / 1000) * 1000;
    if (at <= now) return bad("at", "invalid", "at is in the past"), undefined;
    return { kind: "schedule", at: second(at) };
  }
  issues.push(...unknownFields(value, ["kind", "every_s", "start_at"]).map((i) => ({ ...i, field: `source.${i.field}` })));
  if (!Number.isSafeInteger(value.every_s) || (value.every_s as number) < MIN_EVERY_S) return bad("every_s", "invalid", `every_s is a whole number of seconds, ${MIN_EVERY_S} or more`), undefined;
  if (value.start_at !== undefined && (typeof value.start_at !== "string" || !RFC3339.test(value.start_at))) return bad("start_at", "invalid", "start_at is an RFC 3339 date-time with its offset"), undefined;
  // The grid's origin, to the second: the first firing is at it when it is ahead, else one step after it.
  const start = value.start_at === undefined ? Math.ceil(now / 1000) * 1000 : Math.floor(Date.parse(value.start_at as string) / 1000) * 1000;
  return { kind: "schedule", every_s: value.every_s as number, start_at: second(start) };
}

function targetOf(value: unknown, issues: InputIssue[]): Target | undefined {
  const bad = (field: string, reason: string, message: string) => void issues.push({ field: `target${field ? `.${field}` : ""}`, reason, message });
  if (!isObject(value)) return bad("", value === undefined ? "missing" : "wrong_type", "target is an object: {kind: \"start_run\", agent_id, input, max_cost_usd, effort?}"), undefined;
  if (value.kind !== "start_run") return bad("kind", "not_an_option", "target.kind is start_run: a trigger starts a run of an agent"), undefined;
  const before = issues.length;
  issues.push(...unknownFields(value, ["kind", "agent_id", "input", "max_cost_usd", "effort"]).map((i) => ({ ...i, field: `target.${i.field}` })));
  if (typeof value.agent_id !== "string" || !ID.test(value.agent_id)) bad("agent_id", value.agent_id === undefined ? "missing" : "wrong_type", "agent_id is an agent's id");
  if (!isObject(value.input)) bad("input", value.input === undefined ? "missing" : "wrong_type", "input is the run's input, as POST /agents/{agent_id}/runs takes it: {content}");
  if (value.max_cost_usd === undefined) bad("max_cost_usd", "missing", "max_cost_usd is required: every run a trigger starts is capped");
  else if (!(typeof value.max_cost_usd === "number" && value.max_cost_usd > 0 && Number.isFinite(value.max_cost_usd))) bad("max_cost_usd", "wrong_type", "max_cost_usd is a number above 0");
  if (value.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(value.effort)) bad("effort", "not_an_option", `effort is one of ${EFFORTS.join(", ")}`);
  if (issues.length > before) return undefined;
  return { kind: "start_run", agent_id: value.agent_id as string, input: value.input as Json, max_cost_usd: value.max_cost_usd as number, ...(typeof value.effort === "string" ? { effort: value.effort } : {}) };
}

export class Triggers {
  private readonly file: string;
  private readonly clock: TriggerClock;
  private triggers: Trigger[] = [];
  /** Why triggers.json does not read: nothing fires and nothing is written over it until it does. */
  private readonly unreadable?: string;
  private timer?: { clear(): void };
  /** The firings being driven, by key: a firing is driven once at a time. */
  private readonly driving = new Set<string>();
  private closed = false;

  constructor(data: string, private readonly deps: TriggerDeps) {
    this.file = join(data, TRIGGERS_FILE);
    this.clock = deps.clock ?? REAL_CLOCK;
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
      this.triggers = doc.triggers as Trigger[];
    } catch (error) {
      this.unreadable = (error as Error).message;
    }
    if (this.unreadable) deps.say({ condition: "triggers_unreadable", file: this.file, error: this.unreadable });
  }

  /** At the server's start: every firing an earlier server left due driven again (its origin key makes a run it already
   *  started the same run), the times missed while it was down recorded, and the timer armed. */
  start(): void {
    this.tick();
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
    const issues = unknownFields(body, ["name", "enabled", "source", "target"]);
    const source = sourceOf(body.source, now, issues);
    const target = targetOf(body.target, issues);
    if (body.name !== undefined && !(typeof body.name === "string" && body.name.trim() && body.name.length <= MAX_NAME)) issues.push({ field: "name", reason: "invalid", message: `name is a string of 1 to ${MAX_NAME} characters` });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") issues.push({ field: "enabled", reason: "wrong_type", message: "enabled is true or false" });
    if (target) issues.push(...(await this.deps.targetIssues(target)));
    if (issues.length || !source || !target) throw invalid(issues);
    const id = `trg_${randomBytes(12).toString("hex")}`;
    const enabled = body.enabled !== false;
    const trigger: Trigger = { id, name: typeof body.name === "string" ? body.name.trim() : id, enabled, source, target, created_at: iso(now), updated_at: iso(now), next_at: enabled ? nextIso(source, now) : null, firings: [] };
    this.commit(() => void this.triggers.push(trigger));
    this.arm();
    return this.view(trigger);
  }

  /** PATCH: any of name, enabled, source and target. Enabled again, or its source changed, a trigger goes on from now: a
   *  paused range is skipped, never caught up. */
  async update(id: string, body: Json) {
    const trigger = this.need(id);
    const now = this.clock.now();
    const issues = unknownFields(body, ["name", "enabled", "source", "target"]);
    const source = body.source === undefined ? trigger.source : sourceOf(body.source, now, issues);
    const target = body.target === undefined ? trigger.target : targetOf(body.target, issues);
    if (body.name !== undefined && !(typeof body.name === "string" && body.name.trim() && body.name.length <= MAX_NAME)) issues.push({ field: "name", reason: "invalid", message: `name is a string of 1 to ${MAX_NAME} characters` });
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") issues.push({ field: "enabled", reason: "wrong_type", message: "enabled is true or false" });
    if (body.target !== undefined && target) issues.push(...(await this.deps.targetIssues(target)));
    if (issues.length || !source || !target) throw invalid(issues);
    const enabled = typeof body.enabled === "boolean" ? body.enabled : trigger.enabled;
    const restart = body.source !== undefined || (enabled && !trigger.enabled);
    const next = !enabled ? null : restart ? nextIso(source, now) : trigger.next_at;
    if (enabled && next === null) throw invalid([{ field: "enabled", reason: "invalid", message: "This schedule has no time left to fire at: give it a new source." }]);
    this.commit(() => Object.assign(trigger, { name: typeof body.name === "string" ? body.name.trim() : trigger.name, enabled, source, target, updated_at: iso(now), next_at: next }));
    this.arm();
    return this.view(trigger);
  }

  remove(id: string): void {
    const trigger = this.need(id);
    this.commit(() => void (this.triggers = this.triggers.filter((t) => t !== trigger)));
    this.arm();
  }

  /** Run now: one firing per Idempotency-Key, driven before the answer. `created` false: the key's firing, as it stands. */
  async fire(id: string, idempotencyKey: string): Promise<{ created: boolean; firing: ReturnType<typeof firingView> }> {
    const trigger = this.need(id);
    const key = firingKey("manual", id, idempotencyKey);
    const known = trigger.firings.find((f) => f.key === key);
    if (known) return { created: false, firing: firingView(known) };
    const now = this.clock.now();
    const firing: Firing = { key, by: "manual", nominal_at: second(now), status: "due", at: iso(now) };
    this.commit(() => this.record(trigger, firing));
    await this.drive(id, key);
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
      try {
        this.commit(() => { for (const trigger of due) this.advance(trigger, now); });
      } catch (error) {
        this.deps.say({ condition: "triggers_unwritable", file: this.file, error: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
        this.timer = this.clock.arm(() => this.tick(), WRITE_RETRY_MS);
        return;
      }
    }
    const drive = this.triggers.flatMap((t) => t.firings.filter((f) => f.status === "due" && (!f.retry_at || Date.parse(f.retry_at) <= now)).map((f) => [t.id, f.key] as const));
    this.arm();
    for (const [id, key] of drive) void this.drive(id, key);
  }

  /** Records `trigger`'s firing for its next time, or the times it missed and the one that is not late, and moves its next
   *  time on from that last nominal time. A one-time schedule, or one that never fires again, is turned off. */
  private advance(trigger: Trigger, now: number): void {
    const { source } = trigger;
    let at: number | null = Date.parse(trigger.next_at!);
    const first = at;
    let missed = 0;
    while (at !== null && at <= now && now - at > LATE_MS) {
      if (++missed >= MISSED_COUNTED) {
        at = nextAfter(source, now - LATE_MS);
        break;
      }
      at = nextAfter(source, at);
    }
    if (missed) this.record(trigger, { key: firingKey("schedule", trigger.id, `missed\n${second(first)}`), by: "schedule", nominal_at: second(first), status: "missed", at: iso(now), count: missed, reason: `The server was down or its timer late: ${missed === 1 ? "this time was" : `${missed}${missed >= MISSED_COUNTED ? " or more" : ""} times from this one were`} not fired.` });
    if (at !== null && at <= now) {
      this.record(trigger, { key: firingKey("schedule", trigger.id, second(at)), by: "schedule", nominal_at: second(at), status: "due", at: iso(now) });
      at = nextAfter(source, at);
    }
    trigger.next_at = at === null ? null : iso(at);
    if (at === null) trigger.enabled = false;
  }

  /** A firing taken from due to its end: skipped when its trigger's last run is active, else its run started. A full
   *  server (429), or a last run that could not be read, keeps it due and tries again later. Nothing it holds across a
   *  wait is an object: the trigger may be edited or deleted meanwhile, so each step finds it again by id and key. */
  private async drive(triggerId: string, key: string): Promise<void> {
    if (this.driving.has(key)) return;
    this.driving.add(key);
    try {
      const found = this.find(triggerId, key);
      if (!found || found.firing.status !== "due") return;
      // Its run already started (the store has its key) is its run, whatever runs now.
      const prior = await this.deps.runOf(key).then((run) => ({ run }), (error: Error) => ({ retry: error }));
      if (this.closed) return;
      if ("retry" in prior) return this.retry(triggerId, key, prior.retry);
      // A key stays bound to its run: one lost at setup is this firing's failure, never fired again. The next firing
      // goes ahead, and a run now is the person's retry.
      if (prior.run?.setup_lost) return this.settle(triggerId, key, { status: "failed", run_id: prior.run.run_id, reason: LOST_AT_SETUP, error: { code: "run_failed", message: LOST_AT_SETUP } });
      if (prior.run) return this.settle(triggerId, key, { status: "started", run_id: prior.run.run_id });
      const busy = await this.busy(found.trigger, found.firing).catch((error: Error) => ({ retry: error }));
      if (this.closed) return;
      if (typeof busy === "string") return this.settle(triggerId, key, { status: "skipped", reason: busy });
      if (busy) return this.retry(triggerId, key, busy.retry);
      const now = this.find(triggerId, key);
      if (!now) return;
      let started: { run_id: string };
      try {
        started = await this.deps.start(now.trigger.target, inputOf(now.trigger, now.firing), { id: triggerId, firing_key: key });
      } catch (error) {
        // Stopping, the start may have been cut by the close: the firing stays due for the next start, whose origin key
        // finds a run this one made.
        if (this.closed) return;
        if (error instanceof ApiError && ["rate_limited", "home_busy", "unavailable"].includes(error.code)) return this.retry(triggerId, key, error);
        return this.settle(triggerId, key, { status: "failed", error: { code: error instanceof ApiError ? error.code : "internal", message: (error as Error).message } });
      }
      if (this.closed) return;
      this.settle(triggerId, key, { status: "started", run_id: started.run_id });
      this.deps.say({ condition: "trigger_fired", trigger: triggerId, firing: key, run: started.run_id });
    } catch (error) {
      this.deps.say({ condition: "trigger_firing_failed", trigger: triggerId, firing: key, error: (error as Error).message });
    } finally {
      this.driving.delete(key);
      this.arm();
    }
  }

  private find(triggerId: string, key: string): { trigger: Trigger; firing: Firing } | undefined {
    const trigger = this.triggers.find((t) => t.id === triggerId);
    const firing = trigger?.firings.find((f) => f.key === key);
    return trigger && firing ? { trigger, firing } : undefined;
  }

  /** Why `firing` is skipped (overlap: skip), if it is: an earlier firing still due, or the last run still active. */
  private async busy(trigger: Trigger, firing: Firing): Promise<string | undefined> {
    const earlier = trigger.firings.slice(0, trigger.firings.indexOf(firing));
    if (earlier.some((f) => f.status === "due")) return "An earlier firing is still waiting to start its run.";
    const last = earlier.findLast((f) => f.run_id !== undefined);
    if (!last) return undefined;
    const status = await this.deps.statusOf(last.run_id!);
    if (status === null || ENDED.has(status)) return undefined;
    return status === "input_required" ? `The last run, ${last.run_id}, is waiting for a person.` : `The last run, ${last.run_id}, is still ${status}.`;
  }

  private retry(triggerId: string, key: string, error: Error): void {
    const attempts = (this.find(triggerId, key)?.firing.attempts ?? 0) + 1;
    const wait = Math.max(RETRY_MS[Math.min(attempts, RETRY_MS.length) - 1]!, error instanceof ApiError ? (error.extra.retry_after_ms ?? 0) : 0);
    this.settle(triggerId, key, { status: "due", attempts, retry_at: iso(this.clock.now() + wait), reason: error.message });
  }

  /** The firing's new state, written; one whose trigger was deleted meanwhile is gone with it. */
  private settle(triggerId: string, key: string, change: Partial<Firing>): void {
    try {
      this.commit(() => {
        const found = this.find(triggerId, key);
        // Out of due, a firing keeps no retry, nor the reason the last try gave.
        if (found) Object.assign(found.firing, change.status === "due" ? change : { reason: undefined, attempts: undefined, retry_at: undefined, ...change });
      });
    } catch (error) {
      // Left due on disk: driven again at the next start, under the same origin key.
      this.deps.say({ condition: "triggers_unwritable", file: this.file, error: (error as NodeJS.ErrnoException).code ?? (error as Error).message });
    }
  }

  private record(trigger: Trigger, firing: Firing): void {
    if (trigger.firings.some((f) => f.key === firing.key)) return;
    trigger.firings.push(firing);
    const over = trigger.firings.length - HISTORY_KEPT;
    if (over > 0) {
      let drop = over;
      trigger.firings = trigger.firings.filter((f) => f.status === "due" || drop-- <= 0);
    }
  }

  /** The timer, at the soonest next time of an enabled trigger or retry of a due firing. */
  private arm(): void {
    this.timer?.clear();
    this.timer = undefined;
    if (this.closed || this.unreadable) return;
    let soonest = Infinity;
    for (const t of this.triggers) {
      if (t.enabled && t.next_at !== null) soonest = Math.min(soonest, Date.parse(t.next_at));
      // One being driven arms nothing: its end arms the timer again.
      for (const f of t.firings) if (f.status === "due" && f.retry_at && !this.driving.has(f.key)) soonest = Math.min(soonest, Date.parse(f.retry_at));
    }
    if (soonest !== Infinity) this.timer = this.clock.arm(() => this.tick(), Math.max(0, soonest - this.clock.now()));
  }

  /** `change` applied and written whole, or, when the write fails, undone and thrown. */
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
    const { firings, ...rest } = trigger;
    return { ...rest, overlap: "skip" as const, last_firing: firings.length ? firingView(firings.at(-1)!) : null };
  }
}

const nextIso = (source: Schedule, now: number) => {
  const at = nextAfter(source, now);
  return at === null ? null : iso(at);
};

function firingView(firing: Firing) {
  return { key: firing.key, by: firing.by, nominal_at: firing.nominal_at, status: firing.status, at: firing.at, run_id: firing.run_id ?? null, reason: firing.reason ?? null, error: firing.error ?? null, ...(firing.count !== undefined ? { count: firing.count } : {}), ...(firing.retry_at ? { attempts: firing.attempts ?? 0, retry_at: firing.retry_at } : {}) };
}

/** The run's input: the trigger's, with a line saying what started it and for when, in the trigger's zone. */
function inputOf(trigger: Trigger, firing: Firing): Json {
  const when = local(Date.parse(firing.nominal_at), zoneOf(trigger.source));
  const line = firing.by === "manual" ? `(Started by hand from the schedule "${trigger.name}" at ${when}.)` : `(Started by the schedule "${trigger.name}" for ${when}.)`;
  const { input } = trigger.target;
  return typeof input.content === "string" ? { ...input, content: `${input.content}\n\n${line}` } : input;
}
