// The supervisor: a stateless function that reads a run's `run.json` over the S3 API and its delegation over
// the control API, decides whether the run needs a new instance, and starts one through a host driver. It holds the
// API key; hosts and instances never do. It must run in a different process from any instance (a process with files
// on a hung mount cannot fork), and it never touches a run's mount itself: every mount operation happens in an
// instance or in a host driver's child processes.
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Delegation, Disk } from "disk";
import {
  acquire,
  createRunDir,
  findDelegations,
  matchDelegations,
  pathlessResolver,
  revokeBestEffort,
  revokeCompanions,
  mintMountToken,
  MOUNT_TOKEN_TTL,
  parseTokenNickname,
  removeMountToken,
  runPath,
  unmountClaim,
  type ArchilHost,
  type Claim,
  type ControlApi,
  type PathlessResolver,
  type RunRef,
} from "./claim.ts";
import { FencedError, HeldError, PdaError } from "./errors.ts";
import { parseRunRecord, RUN_JSON, type RunRecord } from "./status.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** What a host driver reports for an instance it started. `unknown`: the handle is not this driver's to judge. */
export type HostStatus = "running" | "stopped" | "failed" | "gone" | "unknown";

/** A driver's description of one instance; the instance writes it into `run.json` as `holder`. */
export type HostHandle = { driver: string; [key: string]: Json };

/** Which start this is: the generation the instance will open (run.json's generation + 1), also in the token's nickname. */
export type StartAttempt = { attempt: number };

/** Compute is disposable and pluggable: a driver is these three calls. */
export interface HostDriver {
  /**
   * Start an instance of the run that mounts with `mountToken` (a reusable token, minted for this attempt). A driver may
   * key the start on `attempt`, so a retry of the same attempt finds the instance it already started; it then returns
   * that instance's handle with `adopted: true`, and the supervisor removes the token it minted for this start, which no
   * instance used.
   */
  start(ref: RunRef, mountToken: string, attempt?: StartAttempt): Promise<HostHandle>;
  status(handle: HostHandle): Promise<HostStatus>;
  /** Stop the instance and whatever it left on its host. A handle the driver cannot reach is a no-op. */
  stop(handle: HostHandle): Promise<void>;
}

/** The control-plane calls the supervisor uses; an archil `Disk` satisfies it. */
export interface SupervisorControl extends ControlApi {
  getObject(key: string): Promise<Uint8Array>;
  headObject(key: string): Promise<unknown | null>;
}

export const CONTROL_TIMEOUT_MS = 10_000;

/** The same control API with every call bounded: one that does not settle in `ms` fails as CONTROL_API_FAILED. */
export function withTimeouts<T extends object>(control: T, ms: number): T {
  return new Proxy(control, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new SuperviseError("CONTROL_API_FAILED", `${String(prop)} did not answer in ${ms} ms`)), ms);
          Promise.resolve(value.apply(target, args)).then(
            (v) => (clearTimeout(timer), resolve(v)),
            (e: unknown) => (clearTimeout(timer), reject(e)),
          );
        });
    },
  });
}

export type SuperviseErrorCode = "CONTROL_API_FAILED" | "HOST_START_FAILED" | "RUN_TREE_NOT_DELETED";

/** A supervisor step failed; nothing was started. Exit 1; the next tick tries again. */
export class SuperviseError extends PdaError {
  constructor(code: SuperviseErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(code, message, options);
  }
}

// ---- run.json (status.ts) -------------------------------------------------------------------------------------

const notFound = (err: unknown) => {
  const e = err as { status?: unknown; statusCode?: unknown; code?: unknown };
  return e.status === 404 || e.statusCode === 404 || e.code === "NoSuchKey";
};

/**
 * `run.json` over S3 GetObject, strongly consistent once the writer fsynced the file and its directory. Absent: null.
 * status.ts's strict reader: an unknown status or a malformed field is RunRecordError (RUN_JSON_INVALID), which fails
 * this run's decision and nothing else.
 */
export async function readRunStatus(control: Pick<SupervisorControl, "getObject">, id: string): Promise<RunRecord | null> {
  const key = `${runPath(id)}/${RUN_JSON}`;
  let bytes: Uint8Array;
  try {
    bytes = await control.getObject(key);
  } catch (err) {
    if (notFound(err)) return null;
    throw new SuperviseError("CONTROL_API_FAILED", `GetObject ${key} failed`, { cause: err });
  }
  return parseRunRecord(new TextDecoder().decode(bytes));
}

// ---- ensureRunning ------------------------------------------------------------------------------------------

export const LEASE_EXPIRY_MS = 90_000;
export const STONITH_TIMEOUT_MS = 30_000;
/** Each start attempt's mount token lives one day (reusable: a single-use token dies at the client's 5 min refresh). */
export const TOKEN_TTL = MOUNT_TOKEN_TTL;
/** A token user younger than this may belong to a start still in flight (minted, not yet mounted): never removed. */
export const TOKEN_GRACE_MS = 15 * 60_000;
/** The longest start grace a run whose starts keep failing gets. */
export const START_BACKOFF_MAX_MS = 10 * 60_000;

export interface EnsureOptions {
  control: SupervisorControl;
  /**
   * Attributes delegations the control API lists without a path (`pathlessResolver`). `superviseRuns` shares one across
   * its pass, so a pass costs at most one exec however many runs it decides; default: one per decision.
   */
  pathless?: PathlessResolver;
  /** A held, not orphaned delegation whose `heartbeatAt` is older than this is a lost instance. Default 90 s. */
  leaseExpiryMs?: number;
  /** Bound on the best-effort stop of a lost holder (status plus stop). Default 30 s. */
  stonithTimeoutMs?: number;
  /** TTL of each mount token (default 24 h). An instance whose token expires is fenced at the next 5 min refresh. */
  tokenTtl?: string;
  /** Prefix of each mount token's nickname. */
  tokenPrefix?: string;
  /** The caller has work for the run now: start a paused run, or a sleeping one before its `wakeAt`. */
  demand?: boolean;
  /** Create `runs/<id>/` with this owner when it does not exist and nothing holds it. */
  create?: { uid: number; gid: number; mode?: number };
  /** Bound on every control API call; one that does not answer fails this run's decision only. Default 10 s. */
  controlTimeoutMs?: number;
  /**
   * After a start, how long a tick leaves the run to the instance it started (no revoke, no second start) until that
   * instance writes run.json at its generation. Default: the lease expiry. 0 turns the grace, and the backoff, off.
   * A start that follows failed ones gets this doubled per failure, up to `startBackoffMaxMs`.
   */
  startGraceMs?: number;
  /** The cap on a backed-off start grace. Default 10 min. */
  startBackoffMaxMs?: number;
  /** Who starts, written into the start mark (`<host>:<pid>` by default). */
  supervisorId?: string;
  now?: () => number;
}

export type StonithOutcome =
  | { outcome: "no-holder" }
  /** The driver cannot reach the holder (another host, another driver) or its host is gone. */
  | { outcome: "unreachable"; status: "unknown" | "gone" }
  /** Stopped, and whatever it left on its host cleaned; `status` is what the driver reported first. */
  | { outcome: "stopped"; status: HostStatus; ms: number }
  | { outcome: "timed-out"; ms: number }
  | { outcome: "failed"; ms: number; error: string };

export type StartReason = "none" | "orphaned" | "lease-expired";

export type EnsureResult =
  /** `detail` is the instance's own word on why, e.g. `{ code: "STORE_BEHIND_SEAL", sealedSeq, head }`. */
  | { action: "terminal"; status: "done" | "failed"; generation: number; detail: Json }
  | { action: "paused"; generation: number }
  | { action: "sleeping"; wakeAt: string | null; generation: number }
  | { action: "pending"; delegations: number }
  /**
   * An instance this or another supervisor started is inside its start grace (it has not written run.json at its
   * generation): nothing is revoked or started. `delegations` 0: not mounted yet. `failures` > 0: the start follows
   * that many failed ones, and `graceMs` is its backed-off grace.
   */
  | {
      action: "starting";
      generation: number;
      sinceMs: number;
      graceMs: number;
      failures: number;
      lastExit: string | null;
      by: string | null;
      delegations: number;
    }
  | { action: "healthy"; heartbeatAt: string; ageMs: number; generation: number }
  | {
      action: "started";
      reason: StartReason;
      /** The run was sleeping and its `wakeAt` was due (or the caller demanded it). */
      woke: boolean;
      revoked: Pick<Delegation, "clientId" | "inodeId" | "path" | "isOrphaned">[];
      stonith?: StonithOutcome;
      /** The run directory did not exist and was created with `create`'s owner. */
      created: boolean;
      handle: HostHandle;
      /** The token user minted for this start; with `adopted` it was not used and is already removed. */
      token: { identifier: string; nickname: string };
      /** The driver found the instance an earlier start of this attempt made (another supervisor, a retried call). */
      adopted?: true;
      /** Whether the start mark (runs/<id>/start.json) was written; without it the next tick has no start grace. */
      startMark: boolean;
      /** Failed starts right before this one (0 after a start that wrote run.json), and what was seen of the last one. */
      failures: number;
      lastExit: string | null;
      /** The grace this start gets: the base, doubled per failure, capped. */
      graceMs: number;
      /** Milliseconds from after the revoke (or the decision, when nothing was revoked) to the driver's return. */
      startMs: number;
    };

/**
 * Make sure the run has a live instance, or has no business having one:
 * - `run.json` done or failed (a store behind its seal is failed, never restarted into): nothing. Paused, or sleeping
 *   with `wakeAt` later or null: nothing unless `demand`.
 * - No delegation on `runs/<id>`: start. Every delegation orphaned (the holder's client is gone): revoke, start.
 * - A delegation still checking out (`isPending`): someone is mounting; nothing.
 * - Held and the lease fresh: healthy. Held and the lease expired (or no heartbeat at all): stop the holder if the
 *   driver can reach it (bounded), revoke, start. Revoking a live holder is safe: its next fsync fails.
 * - The start grace: every start first writes `runs/<id>/start.json` (the generation the new instance will write, and
 *   when). While run.json is below that generation and the mark is younger than `startGraceMs`, a run with no
 *   delegation or with a lease that looks expired is `starting`: nothing is revoked or started, so a tick between a
 *   start and the instance's first run.json write never fences the instance it started. Past the grace, the start has
 *   failed and the rules above apply. Every delegation orphaned inside the grace waits too: the start's client is gone,
 *   which is a failed start like any other.
 * - The backoff: a start whose generation run.json never reached failed (it ended before its first run.json write, 76
 *   or on MOUNT_FAILED, or ran out its grace; 65 and 70 mark run.json failed, which is terminal). The next start counts
 *   it in its mark (`failures`, `lastExit`) and gets the base grace doubled per consecutive failure, capped by
 *   `startBackoffMaxMs`, so a run whose starts keep failing is started a handful of times an hour, not once a tick. A
 *   start that writes run.json at its generation spends its mark, and the next start counts from 0.
 * No wait follows a revoke: the fence is Archil's, enforced by the server at the old holder's next fsync. Two racing
 * supervisors are safe: the mount admits one claimant and the other instance exits 76.
 */
export async function ensureRunning(ref: RunRef, host: HostDriver, options: EnsureOptions): Promise<EnsureResult> {
  const opts = { ...options, control: withTimeouts(options.control, options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS) };
  const now = opts.now ?? Date.now;
  const leaseExpiryMs = opts.leaseExpiryMs ?? LEASE_EXPIRY_MS;
  const status = await readRunStatus(opts.control, ref.id);
  const generation = status?.generation ?? 0;
  let woke = false;
  if (status) {
    if (status.status === "done" || status.status === "failed") return { action: "terminal", status: status.status, generation, detail: status.detail };
    if (status.status === "paused" && !opts.demand) return { action: "paused", generation };
    if (status.status === "sleeping") {
      // null is an idle release, woken by a request; the reader has already refused an unreadable time.
      const at = status.wakeAt === null ? Number.POSITIVE_INFINITY : Date.parse(status.wakeAt);
      if (!opts.demand && at > now()) return { action: "sleeping", wakeAt: status.wakeAt, generation };
      woke = true;
    }
  }
  // A due wake still goes through the delegation check: an instance that wrote `sleeping` and died before releasing
  // left a held or orphaned delegation, which a plain start would hit (76) on every tick.
  const { held, all } = await listHeld(opts.control, ref.id, opts.pathless);
  // A start in flight: the instance has not written run.json at its generation yet (it may not even have mounted).
  // Revoking it or starting a second one would fence what was just started.
  const baseGraceMs = opts.startGraceMs ?? leaseExpiryMs;
  const maxGraceMs = opts.startBackoffMaxMs ?? START_BACKOFF_MAX_MS;
  let lastMark: Promise<StartMark | null> | undefined;
  const lastStart = () => (lastMark ??= baseGraceMs > 0 ? readStartMark(opts.control, ref.id) : Promise.resolve(null));
  const starting = async (): Promise<EnsureResult | null> => {
    const mark = await lastStart();
    if (!mark || mark.generation <= generation) return null;
    const graceMs = startGrace(baseGraceMs, mark.failures, maxGraceMs);
    const sinceMs = now() - Date.parse(mark.at);
    // A mark more than a grace ahead of this clock is treated as spent, so a clock step cannot hold a run indefinitely.
    if (Math.abs(sinceMs) >= graceMs) return null;
    return { action: "starting", generation: mark.generation, sinceMs, graceMs, failures: mark.failures, lastExit: mark.lastExit, by: mark.by, delegations: held.length };
  };
  const start = async (reason: StartReason, revoked: Delegation[] = [], stonith?: StonithOutcome, created = false) => {
    const prev = await lastStart();
    // The last start never wrote its generation, so it failed: this one backs off.
    const failed = prev !== null && prev.generation > generation;
    const failures = failed ? prev.failures + 1 : 0;
    const lastExit = failed ? seenOfFailedStart(held) : null;
    const backoff = { prev, failures, lastExit, graceMs: startGrace(baseGraceMs, failures, maxGraceMs) };
    return startInstance(ref, host, opts, { reason, woke, revoked, stonith, created, generation, backoff });
  };
  if (held.length === 0) {
    const inFlight = await starting();
    if (inFlight) return inFlight;
    const created = status === null && opts.create ? await ensureRunDir(opts.control, ref.id, opts.create) : false;
    return start("none", [], undefined, created);
  }
  if (held.every((d) => d.isOrphaned)) {
    const inFlight = await starting();
    if (inFlight) return inFlight;
    await revokeListed(opts.control, ref.id, held, all);
    return start("orphaned", held);
  }
  if (held.some((d) => d.isPending && !d.isOrphaned)) return { action: "pending", delegations: held.length };
  const beat = status?.heartbeatAt ? Date.parse(status.heartbeatAt) : Number.NaN;
  const ageMs = now() - beat;
  if (Number.isFinite(ageMs) && ageMs <= leaseExpiryMs) return { action: "healthy", heartbeatAt: status!.heartbeatAt!, ageMs, generation };
  const inFlight = await starting();
  if (inFlight) return inFlight;
  const stonith = status?.holder ? await stopHolder(host, status.holder, opts.stonithTimeoutMs ?? STONITH_TIMEOUT_MS) : ({ outcome: "no-holder" } as const);
  await revokeListed(opts.control, ref.id, held, all);
  return start("lease-expired", held, stonith);
}

/**
 * The supervisor's record of its last start of a run: the generation the instance will write, when, by whom, and the
 * failed starts right before it (`failures`; `lastExit`, what the decision saw of the last one).
 */
export const START_MARK = "start.json";
export type StartMark = { generation: number; at: string; by: string | null; failures: number; lastExit: string | null };

/** The grace of a start that follows `failures` failed ones: the base doubled per failure, capped, never below the base. */
export function startGrace(baseMs: number, failures: number, maxMs = START_BACKOFF_MAX_MS): number {
  if (baseMs <= 0) return 0;
  return Math.max(baseMs, Math.min(maxMs, baseMs * 2 ** failures));
}

/**
 * What the decision saw of a start that never wrote its generation (a diagnostic, not a trigger): no delegation (it
 * never mounted, or let go), its client gone (orphaned), or a delegation still held (mounted, never wrote).
 */
function seenOfFailedStart(held: Delegation[]): string {
  return held.length === 0 ? "no-delegation" : held.every((d) => d.isOrphaned) ? "orphaned" : "held";
}

/**
 * The start mark over S3, or null when absent or unreadable (an unreadable mark gives no grace). It lives in the run's
 * directory, so it goes with the run (deleteRunTree removes it), and a later start overwrites it; a mark whose
 * generation run.json has reached is spent.
 */
export async function readStartMark(control: Pick<SupervisorControl, "getObject">, id: string): Promise<StartMark | null> {
  let text: string;
  try {
    text = new TextDecoder().decode(await control.getObject(`${runPath(id)}/${START_MARK}`));
  } catch (err) {
    if (notFound(err)) return null;
    throw new SuperviseError("CONTROL_API_FAILED", `GetObject ${runPath(id)}/${START_MARK} failed`, { cause: err });
  }
  try {
    const v = JSON.parse(text) as Partial<StartMark>;
    if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 1 || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return null;
    const failures = Number.isSafeInteger(v.failures) && (v.failures as number) >= 0 ? (v.failures as number) : 0;
    const lastExit = typeof v.lastExit === "string" ? v.lastExit : null;
    return { generation: v.generation as number, at: v.at, by: typeof v.by === "string" ? v.by : null, failures, lastExit };
  } catch {
    return null;
  }
}

/** Only a run with no run.json and no holder gets here, so the directory is either absent or idle. */
async function ensureRunDir(control: SupervisorControl, id: string, owner: { uid: number; gid: number; mode?: number }): Promise<boolean> {
  let exists: unknown;
  try {
    exists = await control.headObject(`${runPath(id)}/`);
  } catch (err) {
    throw new SuperviseError("CONTROL_API_FAILED", `HeadObject ${runPath(id)}/ failed`, { cause: err });
  }
  if (exists) return false;
  await createRunDir(control, id, owner);
  return true;
}

/** The run's delegations (`matchDelegations`), and the listing they came from. */
async function listHeld(control: ControlApi, id: string, resolve?: PathlessResolver): Promise<{ held: Delegation[]; all: Delegation[] }> {
  try {
    const all = await control.listDelegations();
    return { held: await matchDelegations(all, id, resolve ?? pathlessResolver(control)), all };
  } catch (err) {
    throw new SuperviseError("CONTROL_API_FAILED", `listing delegations on ${runPath(id)} failed`, { cause: err });
  }
}

const sameDelegation = (a: Pick<Delegation, "clientId" | "inodeId">, b: Pick<Delegation, "clientId" | "inodeId">) =>
  a.clientId === b.clientId && a.inodeId === b.inodeId;

/**
 * Revoke exactly the delegations the decision was made on, never a fresh listing: a racing supervisor may have started
 * a new holder since, and that one is not ours to judge. A revoke that fails is fine only if the delegation is gone.
 * Then the same clients' private directories (`revokeCompanions`): those clients are gone or fenced.
 */
async function revokeListed(control: ControlApi, id: string, held: Delegation[], all: Delegation[]): Promise<void> {
  for (const d of held) {
    try {
      await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId });
    } catch (err) {
      const still = await listHeld(control, id).then((now) => now.held.some((n) => sameDelegation(n, d)));
      if (still) throw new SuperviseError("CONTROL_API_FAILED", `revoking ${runPath(id)} (client ${d.clientId}) failed`, { cause: err });
    }
  }
  await revokeCompanions(control, held, all);
}

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve({ value })),
      (error: unknown) => (clearTimeout(timer), resolve({ error })),
    );
  });
}

/**
 * STONITH, best effort: ask the driver about the holder and stop it unless the driver cannot reach it. A holder that
 * already stopped or failed is stopped too, so the driver cleans what it left on its host (a revoked mount the next
 * instance there would otherwise find). Never waits past `ms`.
 */
async function stopHolder(host: HostDriver, holder: HostHandle, ms: number): Promise<StonithOutcome> {
  const t0 = performance.now();
  const r = await settleWithin(
    (async () => {
      const status = await host.status(holder);
      if (status === "unknown" || status === "gone") return { status, stopped: false };
      await host.stop(holder);
      return { status, stopped: true };
    })(),
    ms,
  );
  const elapsed = Math.round(performance.now() - t0);
  if (r === "timeout") return { outcome: "timed-out", ms: elapsed };
  if ("error" in r) return { outcome: "failed", ms: elapsed, error: r.error instanceof Error ? r.error.message : String(r.error) };
  const { status, stopped } = r.value;
  return stopped ? { outcome: "stopped", status, ms: elapsed } : { outcome: "unreachable", status: status as "unknown" | "gone" };
}

/** A mount token per start attempt, then the driver. A driver that throws used no token, so its user is removed. */
async function startInstance(
  ref: RunRef,
  host: HostDriver,
  opts: EnsureOptions,
  why: {
    reason: StartReason;
    woke: boolean;
    revoked: Delegation[];
    stonith?: StonithOutcome;
    created: boolean;
    generation: number;
    backoff: { prev: StartMark | null; failures: number; lastExit: string | null; graceMs: number };
  },
): Promise<EnsureResult> {
  const t0 = performance.now();
  let token: { token: string; identifier: string; nickname: string };
  try {
    // The attempt is the generation the instance will write, so the token user names the incarnation it served.
    token = await mintMountToken(opts.control, { run: { id: ref.id, attempt: why.generation + 1 }, prefix: opts.tokenPrefix, ttl: opts.tokenTtl ?? TOKEN_TTL, now: opts.now });
  } catch (err) {
    throw new SuperviseError("CONTROL_API_FAILED", `minting a mount token for ${runPath(ref.id)} failed`, { cause: err });
  }
  // The mark goes before the driver, so a tick that runs while this start is in flight (in this process or another)
  // sees it. The run holds no delegation here (none, or revoked just now), so S3 accepts the write. A mark that cannot be
  // written costs only the grace.
  const { prev, failures, lastExit, graceMs } = why.backoff;
  const writeMark = (mark: StartMark) =>
    opts.control.putObject(`${runPath(ref.id)}/${START_MARK}`, JSON.stringify(mark), { uid: 0, gid: 0, mode: 0o644 }).then(
      () => true,
      () => false,
    );
  const at = new Date((opts.now ?? Date.now)()).toISOString();
  const by = opts.supervisorId ?? `${hostname()}:${process.pid}`;
  const startMark = await writeMark({ generation: why.generation + 1, at, by, failures, lastExit });
  let handle: HostHandle;
  try {
    handle = await host.start(ref, token.token, { attempt: why.generation + 1 });
  } catch (err) {
    // A driver that throws started nothing: its token goes, and the mark goes back to the last start's (whose grace is
    // over, or there would be no start), so the next tick starts again and this attempt adds no failure. With no last
    // start, the mark falls back to run.json's generation (spent).
    await removeMountToken(opts.control, token.identifier).catch(() => {});
    if (startMark) await writeMark(prev ?? { generation: why.generation, at, by, failures: 0, lastExit: null });
    throw new SuperviseError("HOST_START_FAILED", `starting an instance of ${runPath(ref.id)} failed: ${(err as Error)?.message ?? err}`, { cause: err });
  }
  // An adopted instance mounts with the token of the start that made it; this one's goes now, not at a later sweep, which
  // keeps a run's users while it holds a delegation.
  const adopted = handle.adopted === true;
  if (adopted) await removeMountToken(opts.control, token.identifier).catch(() => {});
  return {
    action: "started",
    reason: why.reason,
    woke: why.woke,
    revoked: why.revoked.map(({ clientId, inodeId, path, isOrphaned }) => ({ clientId, inodeId, path, isOrphaned })),
    ...(why.stonith ? { stonith: why.stonith } : {}),
    created: why.created,
    handle,
    token: { identifier: token.identifier, nickname: token.nickname },
    ...(adopted ? { adopted: true as const } : {}),
    startMark,
    failures,
    lastExit,
    graceMs,
    startMs: Math.round(performance.now() - t0),
  };
}

/** One pass over many runs: each decision on its own, so a run whose calls fail or time out costs only its own line. */
export async function superviseRuns(
  refs: RunRef[],
  host: HostDriver,
  opts: EnsureOptions,
): Promise<({ run: string; ms: number } & (EnsureResult | { action: "error"; error: string; message: string; cause?: string }))[]> {
  const out: ({ run: string; ms: number } & (EnsureResult | { action: "error"; error: string; message: string; cause?: string }))[] = [];
  const pass = { ...opts, pathless: opts.pathless ?? pathlessResolver(opts.control) };
  for (const ref of refs) {
    const t0 = performance.now();
    try {
      const r = await ensureRunning(ref, host, pass);
      out.push({ run: ref.id, ms: Math.round(performance.now() - t0), ...r });
    } catch (err) {
      const e = err as PdaError;
      out.push({ run: ref.id, ms: Math.round(performance.now() - t0), action: "error", error: e.code ?? "ERROR", message: e.message, ...(e.cause instanceof Error ? { cause: e.cause.message } : {}) });
    }
  }
  return out;
}

// ---- the token janitor ------------------------------------------------------------------------------------------------

export type TokenUser = { identifier?: string; nickname?: string; status?: string; expiresAt?: string; createdAt?: string };

export interface TokenSweepOptions {
  /** The disk's token users (`getDisk(id).authorizedUsers`; the list lags by seconds). */
  listUsers(): Promise<TokenUser[]>;
  control: Pick<SupervisorControl, "getObject" | "listDelegations" | "removeUser" | "exec">;
  /** Only token users whose nickname starts with this (the supervisor's `tokenPrefix`). */
  prefix: string;
  /** The runs this pass may clean; undefined: every run a token nickname names. */
  runs?: readonly string[];
  /** Also remove expired token users of any run under the prefix (`supervise --sweep-tokens`). */
  expired?: boolean;
  /** Users younger than this are never removed (a start may be in flight). Default 15 min. */
  graceMs?: number;
  now?: () => number;
}

export type TokenSweep = {
  removed: { identifier: string; run: string | null; why: "released" | "expired" }[];
  failed: { identifier: string; error: string }[];
};

const RELEASED: readonly string[] = ["paused", "sleeping", "done", "failed"];

/**
 * Remove mount-token users that no live mount needs. Removing a token user under a live mount makes that mount lose its
 * claim at the client's next re-authentication, so a run's users go only when the run holds no delegation, its
 * run.json says it is released (paused, sleeping, done, failed; never running, absent or unreadable), and the user is
 * older than `graceMs` (a start mints before it mounts). With `expired`, users whose TTL has passed go too: an expired
 * token already fences its mount at the next refresh.
 */
export async function sweepTokens(opts: TokenSweepOptions): Promise<TokenSweep> {
  if (!opts.prefix) throw new SuperviseError("CONTROL_API_FAILED", "a token sweep needs a nickname prefix");
  const now = (opts.now ?? Date.now)();
  const grace = opts.graceMs ?? TOKEN_GRACE_MS;
  const users = (await opts.listUsers()).filter((u) => u.identifier && u.nickname?.startsWith(opts.prefix));
  const sweep: TokenSweep = { removed: [], failed: [] };
  if (!users.length) return sweep;
  const delegations = await opts.control.listDelegations();
  // A run whose pathless delegations cannot be attributed counts as held: its users stay.
  const heldBy = new Map<string, Promise<boolean>>();
  const resolve = pathlessResolver(opts.control);
  const held = (id: string) => {
    if (!heldBy.has(id)) heldBy.set(id, matchDelegations(delegations, id, resolve).then((d) => d.length > 0, () => true));
    return heldBy.get(id)!;
  };
  const released = new Map<string, Promise<boolean>>();
  const isReleased = (id: string) => {
    if (!released.has(id)) {
      released.set(id, readRunStatus(opts.control, id).then((r) => r !== null && RELEASED.includes(r.status), () => false));
    }
    return released.get(id)!;
  };
  for (const u of users) {
    const parsed = parseTokenNickname(u.nickname!, opts.prefix);
    const created = u.createdAt ? Date.parse(u.createdAt) : (parsed?.at ?? Number.NaN);
    const expiry = u.expiresAt ? Date.parse(u.expiresAt) : Number.NaN;
    let why: "released" | "expired" | null = null;
    if (opts.expired && (u.status === "expired" || expiry <= now)) why = "expired";
    else if (parsed && (!opts.runs || opts.runs.includes(parsed.runId)) && now - created > grace && !(await held(parsed.runId)) && (await isReleased(parsed.runId))) {
      why = "released";
    }
    if (!why) continue;
    await opts.control.removeUser("token", u.identifier!).then(
      () => sweep.removed.push({ identifier: u.identifier!, run: parsed?.runId ?? null, why: why! }),
      (e: unknown) => sweep.failed.push({ identifier: u.identifier!, error: (e as Error).message }),
    );
  }
  return sweep;
}

// ---- the per-host self-check -----------------------------------------------------------

export interface CheckControl extends ControlApi {
  listObjects(prefix: string, options?: { recursive?: boolean }): Promise<{ objects: { key: string }[]; commonPrefixes: string[] }>;
  deleteObjects(keys: string[], options?: { quiet?: boolean }): Promise<{ errors: unknown[] }>;
}

/** The `disk` SDK's `Disk`, as far as `diskControl` reads it. */
export type ControlDisk = Pick<
  Disk,
  "getObject" | "headObject" | "putObject" | "addUser" | "removeUser" | "listDelegations" | "revokeDelegation" | "exec" | "listObjects" | "deleteObjects"
>;

/**
 * A disk's control API from the `disk` SDK: every call `ensureRunning`, `check`, `fork` and the run deletion make, each
 * straight to the disk. One builder for every caller (the CLI, the acceptance rig): a hand-kept copy lost `exec`, and
 * without `exec` a delegation the control API lists with no path (a dead client's private directory among them) cannot be
 * attributed, so every pass on a disk that lists one refuses with CONTROL_API_FAILED.
 */
export function diskControl(disk: ControlDisk): SupervisorControl & CheckControl {
  return {
    getObject: (key) => disk.getObject(key),
    headObject: (key) => disk.headObject(key),
    putObject: (key, body, options) => disk.putObject(key, body, options),
    addUser: (user) => disk.addUser(user),
    removeUser: (type, identifier) => disk.removeUser(type, identifier),
    listDelegations: () => disk.listDelegations(),
    revokeDelegation: (d) => disk.revokeDelegation(d),
    exec: (command) => disk.exec(command),
    listObjects: (prefix, options) => disk.listObjects(prefix, options),
    deleteObjects: (keys, options) => disk.deleteObjects(keys, options),
  };
}

export interface CheckOptions {
  control: CheckControl;
  disk: string;
  region: string;
  /** Where the probe's two mounts go: `<mountRoot>/runs/<probe>` and `<mountRoot>/.check-b/runs/<probe>`. */
  mountRoot: string;
  /** Owner of the probe directory (the instance's user). */
  owner: { uid: number; gid: number };
  host?: ArchilHost;
  idPrefix?: string;
  tokenPrefix?: string;
  /** Bound on every control API call. Default 10 s. */
  controlTimeoutMs?: number;
  /** Called with each token user minted and each probe directory created, so a caller can keep a ledger. */
  onResource?: (kind: "token" | "token-removed" | "subdir" | "subdir-deleted" | "mount" | "unmount", id: string, detail?: string) => void;
}

export type CheckStep = { step: string; ok: boolean; ms: number; detail?: string };
export type CheckReport = { ok: boolean; host: string; run: string; steps: CheckStep[]; cleanup: string[] };

/**
 * Prove on this host and client version that the claim's two server-side guarantees hold before serving runs: a second
 * exclusive mount of a probe directory is refused while the first holds it, and a revoked mount's fsync fails (and its
 * barrier fences). Then a third mount takes over. Every token, mount and the probe directory are removed.
 */
export async function checkHost(options: CheckOptions): Promise<CheckReport> {
  const opts = { ...options, control: withTimeouts(options.control, options.controlTimeoutMs ?? CONTROL_TIMEOUT_MS) };
  const id = `${opts.idPrefix ?? "pda-check-"}${hostname().replace(/[^A-Za-z0-9._-]/g, "-")}-${Date.now().toString(36)}`.slice(0, 120);
  const ref: RunRef = { disk: opts.disk, region: opts.region, id };
  const note = opts.onResource ?? (() => {});
  const steps: CheckStep[] = [];
  const cleanup: string[] = [];
  const tokens: string[] = [];
  const claims: Claim[] = [];
  let created = false;
  let first: Claim | null = null;

  const mount = async (mountRoot: string, tag: string): Promise<Claim> => {
    const nickname = `${opts.tokenPrefix ?? "pda-"}check-${tag}-${Date.now().toString(36)}`.slice(0, 64);
    const t = await mintMountToken(opts.control, { nickname, ttl: "1h" });
    tokens.push(t.identifier);
    note("token", t.identifier, nickname);
    const c = await acquire({ ref, token: t.token, mountRoot, host: opts.host });
    claims.push(c);
    note("mount", c.root, `${ref.disk}:/${runPath(id)}`);
    return c;
  };
  const plan: [string, () => Promise<string | undefined>][] = [
    ["create probe directory", async () => {
      await createRunDir(opts.control, id, opts.owner);
      created = true;
      note("subdir", `${runPath(id)}/`);
      return undefined;
    }],
    ["first exclusive mount", async () => {
      first = await mount(opts.mountRoot, "a");
      return `mount ${Math.round(first.timings.mountMs)} ms, verify ${Math.round(first.timings.verifyMs)} ms`;
    }],
    ["second exclusive mount is refused", async () => {
      const err = await mount(join(opts.mountRoot, ".check-b"), "b").then(() => null, (e: unknown) => e);
      if (err === null) throw new Error("a second client mounted the held directory");
      if (!(err instanceof HeldError)) throw err;
      return "HeldError (76)";
    }],
    ["revoke the first mount", async () => {
      const held = await findDelegations(opts.control, id);
      if (held.length !== 1) throw new Error(`expected one delegation, found ${held.length}`);
      await opts.control.revokeDelegation(held[0]);
      return undefined;
    }],
    ["revoked mount's fsync fails", async () => {
      const fh = await open(join(first!.root, ".check-revoked"), "w");
      const err = await fh.writeFile("revoked\n").then(() => fh.sync()).then(() => null, (e: unknown) => e);
      await fh.close().catch(() => {});
      if (err === null) throw new Error("write and fsync succeeded on a revoked mount");
      return (err as { code?: string }).code ?? String(err);
    }],
    ["revoked mount's barrier fences", async () => {
      const err = await first!.barrier().then(() => null, (e: unknown) => e);
      if (err === null) throw new Error("archil sync succeeded on a revoked mount");
      if (!(err instanceof FencedError)) throw err;
      return "FencedError (75)";
    }],
    ["a new mount takes over", async () => {
      const c = await mount(join(opts.mountRoot, ".check-b"), "c");
      return `mount ${Math.round(c.timings.mountMs)} ms`;
    }],
  ];
  try {
    for (const [name, fn] of plan) {
      const t0 = performance.now();
      const r = await fn().then((detail) => ({ ok: true, detail }), (e: unknown) => ({ ok: false, detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
      steps.push({ step: name, ok: r.ok, ms: Math.round(performance.now() - t0), ...(r.detail ? { detail: r.detail } : {}) });
      if (!r.ok) break;
    }
  } finally {
    // release() unmounts even when its barrier finds the claim fenced; unmountClaim then confirms against the mount table.
    for (const c of claims.reverse()) {
      await c.release().catch(() => {});
      const via = await unmountClaim(c.root, opts.host).then((v) => (v === "none" ? "released" : v), (e: unknown) => `failed: ${(e as Error).message}`);
      cleanup.push(`unmount ${c.root}: ${via}`);
      note("unmount", c.root, via);
    }
    if (created) {
      const r = await deleteRunTree(opts.control, id).then(() => "deleted", (e: unknown) => `failed: ${(e as Error).message}`);
      cleanup.push(`delete ${runPath(id)}/: ${r}`);
      if (r === "deleted") note("subdir-deleted", `${runPath(id)}/`);
    }
    for (const t of tokens) {
      const r = await removeMountToken(opts.control, t).then(() => "removed", (e: unknown) => `failed: ${(e as Error).message}`);
      cleanup.push(`token ${t}: ${r}`);
      if (r === "removed") note("token-removed", t);
    }
  }
  const ok = steps.length === plan.length && steps.every((s) => s.ok) && cleanup.every((c) => !c.includes("failed"));
  return { ok, host: hostname(), run: id, steps, cleanup };
}

/**
 * Delete a run's directory tree over S3. A tree with a delegation on it, even an orphaned one, is not deleted: S3
 * DeleteObjects leaves its objects in place and reports no error, and the run id would later reopen with its old
 * store. So: revoke every delegation on the subtree and its holders' private directories, delete the files, then the
 * directory markers deepest first (a directory with children refuses), then list the prefix. Anything left is
 * RUN_TREE_NOT_DELETED; a non-empty prefix is never reported as deleted.
 */
export async function deleteRunTree(control: CheckControl, id: string): Promise<{ objects: number; revoked: number }> {
  const prefix = `${runPath(id)}/`;
  const held = await revokeBestEffort(control, id);
  const keys = (await control.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
  const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])];
  const depth = (k: string) => k.split("/").length;
  let errors = (await control.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true })).errors.length;
  for (const d of [...new Set(dirs.map(depth))].sort((x, y) => y - x)) {
    errors += (await control.deleteObjects(dirs.filter((k) => depth(k) === d), { quiet: true })).errors.length;
  }
  const left = (await control.listObjects(prefix, { recursive: true })).objects.length;
  if (left > 0) {
    const still = (await findDelegations(control, id).catch(() => [])).length;
    throw new SuperviseError("RUN_TREE_NOT_DELETED", `${prefix} still holds ${left} objects (${errors} delete errors, ${still} delegations after revoking ${held.length})`);
  }
  return { objects: keys.length, revoked: held.length };
}
