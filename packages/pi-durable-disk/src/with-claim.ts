// A short exclusive claim on any path of a disk (withClaim), and a consistent S3 read of a released file (readReleased),
// for a host that keeps state beside its runs: pi-durable-agent's agent home under `agent/`, carried back at a run's end.
//
// A claim is one exclusive mount. Archil refuses a second client's mount of the path, of an ancestor or of a descendant,
// and that refusal is the exclusivity; the delegation listing only decides whom to wait for and whom to revoke. A holder
// is lost when its client is gone (orphaned) or when it is still there past the deadline its `.claim` names, and only a
// lost holder is revoked. Safety rests on the fence, never on the deadline: a holder revoked while still alive gets EIO at
// its next fsync, so its commit rolls back and its own call throws FENCED. Both calls are supervisor side: they need the
// API key's control API.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Delegation } from "disk";
import { CLAIM_PROBE, DEFAULT_MOUNT_ROOT, exclusiveMount, mintMountToken, removeMountToken, revokeCompanions, type ArchilHost } from "./claim.ts";
import { ClaimError, HeldError } from "./errors.ts";
import type { SupervisorControl } from "./supervise.ts";

/** The control API both calls use; `archilControl`'s satisfies it. */
export type ClaimControl = Pick<SupervisorControl, "addUser" | "removeUser" | "listDelegations" | "revokeDelegation" | "exec" | "getObject" | "headObject">;

/** The path `fn` holds: `root` is where it is mounted on this host. */
export interface HeldPath {
  readonly root: string;
  readonly path: string;
  /** Aborted once the claim is known lost (a barrier refused) or the caller's `signal` aborts. */
  readonly signal: AbortSignal;
  /** `archil sync` now: every write so far is durable when it resolves; a refusal is FENCED. */
  barrier(): Promise<{ ms: number }>;
}

export interface WithClaimOptions {
  /** How long the holder may hold the path; written in its `.claim` as its deadline. Default 60 s. */
  readonly holdMs?: number;
  /** How long to queue behind a live holder before CLAIM_HELD. Default 30 s. */
  readonly waitMs?: number;
  /** Where the mount goes, under a directory of this call's own. Default `/mnt/archil/.claims`. */
  readonly mountRoot?: string;
  readonly host?: ArchilHost;
  readonly signal?: AbortSignal;
}

export const DEFAULT_HOLD_MS = 60_000;
export const DEFAULT_WAIT_MS = 30_000;
const POLL_MS = 250;
const TOKEN_TTL = "10m";
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** CLAIM_HELD reads as retryable: the path is not released yet, and nothing older stands in for it. */
const notReleased = (path: string, why: string, cause?: unknown) =>
  new HeldError(
    "claim",
    `${path} is held by another client and is not released yet (${why}). CLAIM_HELD is retryable: retry within waitMs, ` +
      "and never fall back to an older release.",
    { cause },
  );

/** `path` if it is one relative path of safe segments that no run owns; else INVALID_ARGUMENT. */
function claimPath(path: string): string {
  const segments = path.split("/");
  if (path === "" || segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) {
    throw new ClaimError("INVALID_ARGUMENT", `${JSON.stringify(path)} is not a relative path of safe segments (letters, digits, ".", "_", "-")`);
  }
  if (segments[0] === "runs") throw new ClaimError("INVALID_ARGUMENT", `${path} is under runs/, which openDurableRun and the supervisor claim`);
  if (segments[0] === ".archil") throw new ClaimError("INVALID_ARGUMENT", `${path} is under .archil/, Archil's own`);
  return path;
}

/** Whether a delegation's path is `path`, under it, or above it (the disk root included): each conflicts with a mount of it. */
const conflicts = (delegated: string, path: string) => {
  const p = delegated.replace(/^\/+/, "").replace(/\/+$/, "");
  return p === "" || p === path || p.startsWith(`${path}/`) || path.startsWith(`${p}/`);
};

/**
 * The delegations that conflict with a mount of `path`, from one listing. A pathless one is attributed by inode with one
 * `exec` (the path's ancestors and everything under it); one that cannot be attributed fails CONTROL_API_FAILED, never
 * reads as unheld.
 */
async function holdersOf(control: ClaimControl, path: string): Promise<{ holders: Delegation[]; all: Delegation[] }> {
  let all: Delegation[];
  try {
    all = await control.listDelegations();
  } catch (err) {
    throw new ClaimError("CONTROL_API_FAILED", "listing delegations failed", { cause: err });
  }
  const holders = all.filter((d) => d.path !== undefined && d.path !== null && conflicts(d.path, path));
  const pathless = all.filter((d) => !d.path);
  if (pathless.length > 0) holders.push(...(await pathlessOn(control, path, pathless)));
  return { holders, all };
}

async function pathlessOn(control: ClaimControl, path: string, pathless: readonly Delegation[]): Promise<Delegation[]> {
  if (!control.exec) throw new ClaimError("CONTROL_API_FAILED", `a delegation with no path may be on ${path}, and the control API has no exec to attribute it`);
  const inodes = [...new Set(pathless.map((d) => d.inodeId))];
  if (!inodes.every((i) => Number.isSafeInteger(i) && i >= 0)) throw new ClaimError("CONTROL_API_FAILED", "a pathless delegation has no valid inode id");
  const segments = path.split("/");
  const above = [".", ...segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join("/"))];
  const test = inodes.map((i) => `-inum ${i}`).join(" -o ");
  let r: { exitCode: number; stdout: string };
  try {
    r = await control.exec(`for a in ${above.join(" ")}; do if [ -e "$a" ]; then stat -c '%i' "$a" || exit 3; fi; done; if [ -e ${path} ]; then find ${path} \\( ${test} \\) -printf '%i\\n' || exit 3; fi`);
  } catch (err) {
    throw new ClaimError("CONTROL_API_FAILED", `attributing pathless delegations to ${path} failed`, { cause: err });
  }
  if (r.exitCode !== 0) throw new ClaimError("CONTROL_API_FAILED", `attributing pathless delegations to ${path}: exit ${r.exitCode}`);
  const on = new Set(String(r.stdout ?? "").split("\n").filter(Boolean).map(Number));
  return pathless.filter((d) => on.has(d.inodeId));
}

/** Whether the holder's `.claim` (read over S3) names a deadline that has passed; false when it cannot be read or parsed. */
async function pastDeadline(control: ClaimControl, path: string): Promise<boolean> {
  try {
    const claim = JSON.parse(new TextDecoder().decode(await control.getObject(`${path}/${CLAIM_PROBE}`))) as { deadline?: unknown };
    const deadline = typeof claim.deadline === "string" ? Date.parse(claim.deadline) : Number.NaN;
    return Number.isFinite(deadline) && deadline < Date.now();
  } catch {
    return false;
  }
}

/** Until nothing conflicts with a mount of `path`: lost holders are revoked, live ones waited for until `deadline`. */
async function settle(control: ClaimControl, path: string, deadline: number, signal: AbortSignal | undefined): Promise<void> {
  for (;;) {
    const { holders, all } = await holdersOf(control, path);
    if (holders.length === 0) return;
    if (holders.every((d) => d.isOrphaned) || (await pastDeadline(control, path))) {
      try {
        for (const d of holders) await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId });
      } catch (err) {
        throw new ClaimError("CONTROL_API_FAILED", `revoking the lost holder of ${path} failed`, { cause: err });
      }
      await revokeCompanions(control, holders, all);
      continue;
    }
    if (Date.now() >= deadline || signal?.aborted) throw notReleased(path, `a live holder within its deadline: ${holders.map((d) => d.clientId).join(", ")}`);
    await sleep(POLL_MS);
  }
}

const positive = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ClaimError("INVALID_ARGUMENT", `${name} ${value} is not a positive whole number of milliseconds`);
  return value;
};

/**
 * Hold `path` exclusively while `fn` runs: wait for a live holder (`waitMs`), revoke a lost one, mount `<disk>:/<path>` at
 * a fresh `<mountRoot>/<pid>-<uuid>`, write `.claim` with this holder's deadline (`holdMs`), run `fn`, then barrier,
 * unmount and give the mount token back, whether `fn` resolved or threw. Returns `fn`'s value; throws `fn`'s own error,
 * else INVALID_ARGUMENT, CLAIM_HELD (76, retryable), CONTROL_API_FAILED, the mount's errors, or FENCED (75: the claim was
 * revoked from under `fn`, whose writes are then not durable).
 */
export async function withClaim<T>(
  where: { readonly control: ClaimControl; readonly disk: string; readonly region: string; readonly path: string },
  fn: (held: HeldPath) => Promise<T>,
  options: WithClaimOptions = {},
): Promise<T> {
  const path = claimPath(where.path);
  const holdMs = positive("holdMs", options.holdMs ?? DEFAULT_HOLD_MS);
  const deadline = Date.now() + positive("waitMs", options.waitMs ?? DEFAULT_WAIT_MS);
  const { control } = where;
  const mountRoot = options.mountRoot ?? join(DEFAULT_MOUNT_ROOT, ".claims");
  for (;;) {
    await settle(control, path, deadline, options.signal);
    const minted = await mintMountToken(control, { nickname: `pdc-${path.replaceAll("/", ".")}-${Date.now().toString(36)}`, ttl: TOKEN_TTL });
    const at = new Date();
    let mount: Awaited<ReturnType<typeof exclusiveMount>>;
    try {
      mount = await exclusiveMount({ disk: where.disk, region: where.region, path }, join(mountRoot, `${process.pid}-${randomUUID()}`), minted.token, {
        host: options.host,
        probe: `${JSON.stringify({ pid: process.pid, host: hostname(), at: at.toISOString(), deadline: new Date(at.getTime() + holdMs).toISOString() })}\n`,
      });
    } catch (err) {
      await removeMountToken(control, minted.identifier).catch(() => {});
      // Another caller mounted between the listing and the mount: queue again, within the same wait.
      if (err instanceof HeldError && Date.now() < deadline && !options.signal?.aborted) {
        await sleep(POLL_MS);
        continue;
      }
      throw err instanceof HeldError ? notReleased(path, "its mount was refused", err) : err;
    }
    const lost = new AbortController();
    const onAbort = () => lost.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const barrier = async () => {
      try {
        return await mount.barrier();
      } catch (err) {
        lost.abort(err);
        throw err;
      }
    };
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, value: await fn({ root: mount.root, path, signal: lost.signal, barrier }) };
    } catch (error) {
      outcome = { ok: false, error };
    }
    let release: unknown;
    try {
      await barrier();
    } catch (err) {
      release = err;
    }
    try {
      await mount.unmount();
    } catch (err) {
      release ??= err;
    }
    await removeMountToken(control, minted.identifier).catch(() => {});
    options.signal?.removeEventListener("abort", onAbort);
    if (!outcome.ok) throw outcome.error;
    if (release !== undefined) throw release;
    return outcome.value;
  }
}

/** An object's identity for "did it move": its etag, else its size and last-modified time. */
function identity(head: unknown): string | null {
  if (head === null || typeof head !== "object") return null;
  const { etag, size, lastModified } = head as { etag?: unknown; size?: unknown; lastModified?: unknown };
  if (typeof etag === "string" && etag !== "") return `etag:${etag}`;
  return `size:${String(size)}@${lastModified instanceof Date ? lastModified.toISOString() : String(lastModified)}`;
}

const sizeOf = (head: unknown) => (head !== null && typeof head === "object" ? Number((head as { size?: unknown }).size ?? 0) : 0);

/**
 * `<path>/<file>` over S3, once it is released: no delegation on the path (or an ancestor or a descendant) before or
 * after the read, for SQLite (`sqlite`) no `-wal` with content (its writer checkpointed with TRUNCATE and closed), and the
 * object unchanged across the read. A held path is CLAIM_HELD (76, retryable; never read an older release instead), a
 * WAL with content NOT_RELEASED; a file that moved during every one of `attempts` reads (default 3) is CLAIM_HELD. Null
 * when the file does not exist. It never mounts, so it never blocks a carry back.
 */
export async function readReleased(
  where: { readonly control: ClaimControl; readonly path: string },
  file: string,
  options: { readonly sqlite?: boolean; readonly attempts?: number } = {},
): Promise<{ bytes: Uint8Array; etag: string | null } | null> {
  const path = claimPath(where.path);
  const key = `${path}/${claimPath(file)}`;
  const attempts = positive("attempts", options.attempts ?? 3);
  const { control } = where;
  const head = async (name: string) => {
    try {
      return await control.headObject(name);
    } catch (err) {
      throw new ClaimError("CONTROL_API_FAILED", `head ${name} failed`, { cause: err });
    }
  };
  for (let attempt = 1; ; attempt++) {
    const { holders } = await holdersOf(control, path);
    if (holders.length > 0) throw notReleased(path, `held by ${holders.map((d) => d.clientId).join(", ")}`);
    if (options.sqlite && sizeOf(await head(`${key}-wal`)) > 0) {
      throw new ClaimError("NOT_RELEASED", `${key}-wal has content: its writer did not checkpoint (TRUNCATE) and close, so ${key} alone is not the database`);
    }
    const before = await head(key);
    if (before === null) return null;
    let bytes: Uint8Array;
    try {
      bytes = await control.getObject(key);
    } catch (err) {
      throw new ClaimError("CONTROL_API_FAILED", `get ${key} failed`, { cause: err });
    }
    const after = await head(key);
    const still = (await holdersOf(control, path)).holders.length === 0;
    if (still && after !== null && identity(after) === identity(before) && sizeOf(after) === bytes.length) {
      const etag = (after as { etag?: unknown }).etag;
      return { bytes, etag: typeof etag === "string" ? etag : null };
    }
    if (attempt >= attempts) throw notReleased(path, `${key} changed while it was read, ${attempts} times`);
  }
}
