// The claim: one exclusive Archil mount of `runs/<id>/` per run. The supervisor side holds the API key and uses
// the control API: create the run directory, mint a mount token, revoke a delegation. The host side holds only
// a mount token and uses the archil client: mount, verify, barrier, release, dead-mount cleanup.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rmdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Delegation } from "disk";
import { ClaimError, FencedError, HeldError, ownWriteFenced } from "./errors.ts";

export type RunRef = { disk: string; region: string; id: string };

/** The control-plane calls the claim uses; an archil `Disk` (SDK `disk` 1.7.0) satisfies it. Supervisor side only. */
export interface ControlApi {
  putObject(key: string, body: string, options: { uid: number; gid: number; mode: number }): Promise<unknown>;
  addUser(user: { type: "token"; nickname: string; ttl: string; oneUse: boolean }): Promise<{ identifier?: string; token?: string }>;
  removeUser(type: "token", identifier: string): Promise<void>;
  listDelegations(): Promise<Delegation[]>;
  revokeDelegation(delegation: Pick<Delegation, "clientId" | "inodeId">): Promise<void>;
  /**
   * `Disk.exec`: a shell command in a container with the disk mounted in shared mode, at the disk root. The claim uses it
   * only to resolve `runs/<id>` to its inode when the control API lists a delegation without a path. Without it, such a
   * delegation cannot be attributed, and `findDelegations` fails rather than read the run as unheld.
   */
  exec?(command: string): Promise<{ exitCode: number; stdout: string; stderr?: string }>;
}

/** How this host runs the archil client. `archil mount`, `sync`, `delegations` and `unmount` all need root. */
export interface ArchilHost {
  /**
   * The archil command: `bin/archil-scoped` or a root-owned copy of it (default: this package's). Its `mount` takes the
   * token as one line on stdin; plain `/usr/bin/archil` does not, so a mount through it fails unauthenticated.
   */
  archil?: string;
  fusermount?: string;
  /** The sudo binary, or false when the process is root. Default: /usr/bin/sudo unless uid 0. */
  sudo?: string | false;
  procMounts?: string;
  /** The process table the claim reads to find a stale archil daemon on the run's mountpoint. Default /proc. */
  proc?: string;
  /** `staleGrace`: how long a daemon left on an unmounted mountpoint may take to exit by itself before it is killed. */
  timeoutMs?: { mount?: number; sync?: number; unmount?: number; cli?: number; staleGrace?: number };
  /** File access on the mount; replaceable so tests can inject a dead mount (ENOTCONN) or a fence (EIO). */
  fs?: { stat?(path: string): Promise<unknown>; persist?(path: string, data: string): Promise<void> };
}

export interface AcquireOptions {
  ref: RunRef;
  /** The mount token. It travels only on the archil wrapper's stdin; never in argv or an environment, never printed or written. */
  token: string;
  /** Default /mnt/archil; the claim mounts at `<mountRoot>/runs/<id>` so paths are identical on every host. */
  mountRoot?: string;
  /** `archil mount --force`: the takeover fallback when the control API cannot revoke. */
  force?: boolean;
  host?: ArchilHost;
}

export interface Claim {
  readonly ref: RunRef;
  readonly disk: string;
  readonly root: string;
  readonly work: string;
  readonly store: string;
  /** True when an in-place restart found its own live mount and kept it; no token was used. */
  readonly reused: boolean;
  /** Entries found in the mountpoint before mounting, moved aside whole and never brought into the run; else null. */
  readonly stray?: { to: string; entries: number } | null;
  readonly forced: boolean;
  readonly timings: { mountMs: number; verifyMs: number };
  readonly fenced: boolean;
  /** Mark the claim lost (the store's facade calls this on an I/O-class error); later barriers throw at once. */
  markFenced(cause?: unknown): void;
  /** `archil sync`: every pending write on the mount is durable when it resolves. A failure fences the claim. */
  barrier(): Promise<{ ms: number }>;
  /**
   * Barrier, then `archil unmount` (flush and check the delegation in); a dead mount is cleaned with `fusermount -u`.
   * Where the kernel refuses every unmount of a FUSE mount with ENOENT (Sysbox, Daytona's sandboxes): `archil checkin`,
   * then the mount is moved aside and its daemon killed (`moved`).
   */
  release(): Promise<{ via: Unmounted }>;
}

export const DEFAULT_MOUNT_ROOT = "/mnt/archil";
/** This package's `bin/archil-scoped`. A deployment installs a root-owned copy and passes its path as `archil`. */
export const ARCHIL_SCOPED = fileURLToPath(new URL("../bin/archil-scoped", import.meta.url));
/** The file the claim writes and fsyncs to prove it holds the delegation; written on every acquire. */
export const CLAIM_PROBE = ".claim";
// The client exits 1 for every refused mount; this phrase is its only signal that another client holds the delegation
// ("another client has an outstanding delegation to the root of the disk" or "... which conflicts with the checkout").
const HELD_MARKER = "has an outstanding delegation";
// A daemon of this host still runs for the mountpoint (with no mount, or mid-unmount) and holds its control socket
// ("Failed to bind control socket ... in use"): a local refusal, never another client's delegation, though archil's
// advice text mentions orphaning "outstanding delegations".
const STALE_MARKER = /an older Archil process is still running|Failed to bind control socket/;
// archil refuses to mount over a directory that has entries: in plain words ("'<mountpoint>' is not empty"), or with a
// misleading error (`os error 115` or `Unspecified Error`, its daemon logging `try_delete_delegation ... in Removing
// state`). The misleading one also comes from an Archil lockout on an empty mountpoint, so it means "not empty" only
// when the mountpoint has entries.
const NOT_EMPTY_MARKER = "is not empty";
const MISLEADING_REFUSAL = /os error 115|Unspecified Error|in Removing state/;
// Sysbox (nestybox/sysbox#854, the runtime of Daytona's sandboxes) refuses every umount2 of a FUSE mount with ENOENT,
// live or dead, while the mount stays listed; `archil unmount` and `fusermount -u` both report that errno.
const UNMOUNT_ENOENT = /No such file or directory/;

/** How a mount left its path: unmounted by archil, by fusermount, moved aside (Sysbox), or there was none. */
export type Unmounted = "archil" | "fusermount" | "moved" | "none";
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export function runPath(id: string): string {
  if (!RUN_ID.test(id)) throw new ClaimError("INVALID_ARGUMENT", `run id ${JSON.stringify(id)} is not one safe path segment`);
  return `runs/${id}`;
}

// ---- supervisor side: the control API -------------------------------------------------------------------------------

/** PutObject of the `/`-terminated key; uid/gid are required or the directory is root:root. 409: held. */
export async function createRunDir(control: ControlApi, id: string, owner: { uid: number; gid: number; mode?: number }): Promise<void> {
  const key = `${runPath(id)}/`;
  try {
    await control.putObject(key, "", { uid: owner.uid, gid: owner.gid, mode: owner.mode ?? 0o755 });
  } catch (err) {
    if ((err as { status?: unknown }).status === 409) throw new HeldError("claim", `${key} is held by another client`, { cause: err });
    throw new ClaimError("CONTROL_API_FAILED", `PutObject ${key} failed`, { cause: err });
  }
}

/** A mount token's lifetime: one day, a Go duration (the control plane rejects "1d"). */
export const MOUNT_TOKEN_TTL = "24h";
export const TOKEN_PREFIX = "pda-";

/** `<prefix><run id>-g<attempt>-<base36 ms>`: the token user names the run and start attempt it was minted for. */
export function tokenNickname(runId: string, attempt: number, at: number = Date.now(), prefix: string = TOKEN_PREFIX): string {
  runPath(runId);
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new ClaimError("INVALID_ARGUMENT", `attempt ${attempt} is not a count`);
  const nickname = `${prefix}${runId}-g${attempt}-${at.toString(36)}`;
  if (nickname.length > 255) throw new ClaimError("INVALID_ARGUMENT", `token nickname for ${runId} is longer than the 255 characters the control plane takes`);
  return nickname;
}

/** The run, attempt and minting time a nickname from `tokenNickname` names; null for anything else. */
export function parseTokenNickname(nickname: string, prefix: string = TOKEN_PREFIX): { runId: string; attempt: number; at: number } | null {
  if (!nickname.startsWith(prefix)) return null;
  const m = /^(.+)-g(\d+)-([0-9a-z]+)$/.exec(nickname.slice(prefix.length));
  if (!m || !RUN_ID.test(m[1])) return null;
  return { runId: m[1], attempt: Number(m[2]), at: parseInt(m[3], 36) };
}

/**
 * A reusable mount token with a one-day TTL by default, minted per start attempt. Not single-use: the client
 * re-authenticates at its background endpoint refresh, 5 min after the mount and every 5 min after, and the control plane
 * rejects a spent single-use token for good, after which every write on the mount fails (client 0.8.42). A token
 * whose TTL passes fences its mount the same way at the next refresh, so an instance never outlives its token by more
 * than one refresh. The nickname is given, or built from `run` so the user can be traced back to its run.
 */
export async function mintMountToken(
  control: ControlApi,
  opts: { nickname?: string; run?: { id: string; attempt: number }; prefix?: string; ttl?: string; oneUse?: boolean; now?: () => number },
): Promise<{ token: string; identifier: string; nickname: string }> {
  const nickname = opts.nickname ?? (opts.run ? tokenNickname(opts.run.id, opts.run.attempt, (opts.now ?? Date.now)(), opts.prefix) : undefined);
  if (!nickname) throw new ClaimError("INVALID_ARGUMENT", "a mount token needs a nickname or a run");
  let user: { identifier?: string; token?: string };
  try {
    user = await control.addUser({ type: "token", nickname, ttl: opts.ttl ?? MOUNT_TOKEN_TTL, oneUse: opts.oneUse ?? false });
  } catch (err) {
    throw new ClaimError("CONTROL_API_FAILED", "addUser failed", { cause: err });
  }
  if (!user.token || !user.identifier) throw new ClaimError("CONTROL_API_FAILED", "addUser returned no token or identifier");
  return { token: user.token, identifier: user.identifier, nickname };
}

export async function removeMountToken(control: ControlApi, identifier: string): Promise<void> {
  try {
    await control.removeUser("token", identifier);
  } catch (err) {
    throw new ClaimError("CONTROL_API_FAILED", `removeUser ${identifier} failed`, { cause: err });
  }
}

/**
 * Delegations on `runs/<id>` and anything under it; never a sibling or a parent. The control API resolves a delegation's
 * path best-effort: it can list one with no path, live or orphaned, on a never-reused run. So when nothing matches by
 * path and some entry has none, `runs/<id>` is resolved to its inode now (`runInode`), and the pathless entries on that
 * inode are the run's. A pathless entry that cannot be attributed fails CONTROL_API_FAILED: an unseen holder must never
 * read as none, or a caller starts over it.
 */
export async function findDelegations(control: Pick<ControlApi, "listDelegations" | "exec">, id: string): Promise<Delegation[]> {
  runPath(id);
  return matchDelegations(await control.listDelegations(), id, control);
}

/** `findDelegations` over a listing the caller already holds (one listing, many runs). */
export async function matchDelegations(all: readonly Delegation[], id: string, control: Pick<ControlApi, "exec">): Promise<Delegation[]> {
  const path = runPath(id);
  const byPath = all.filter((d) => {
    const p = d.path?.replace(/^\/+/, "");
    return p === path || p?.startsWith(`${path}/`) === true;
  });
  const pathless = all.filter((d) => !d.path);
  if (byPath.length > 0 || pathless.length === 0) return byPath;
  const inode = await runInode(control, id);
  return inode === null ? [] : pathless.filter((d) => d.inodeId === inode);
}

const ABSENT = "absent";

/**
 * The inode `runs/<id>` names now, or null when it does not exist: `stat` through `exec`, whose inode numbers are the
 * control API's inode ids. Resolved at each call, never recorded, so a deleted and recreated run directory (a new inode)
 * is matched as it is now.
 */
export async function runInode(control: Pick<ControlApi, "exec">, id: string): Promise<number | null> {
  const path = runPath(id);
  if (!control.exec) throw new ClaimError("CONTROL_API_FAILED", `a delegation with no path may be ${path}'s, and the control API has no exec to resolve the run's inode`);
  let r: { exitCode: number; stdout: string };
  try {
    r = await control.exec(`if [ -e '${path}' ]; then stat -c %i -- '${path}'; else echo ${ABSENT}; fi`);
  } catch (err) {
    throw new ClaimError("CONTROL_API_FAILED", `resolving ${path} to its inode failed`, { cause: err });
  }
  const out = String(r.stdout ?? "").trim();
  if (r.exitCode === 0 && out === ABSENT) return null;
  if (r.exitCode !== 0 || !/^\d+$/.test(out)) throw new ClaimError("CONTROL_API_FAILED", `resolving ${path} to its inode: exit ${r.exitCode}, ${JSON.stringify(out.slice(0, 80))}`);
  return Number(out);
}

/** Revoke every delegation on the run through the control API. The old holder's next fsync returns EIO. */
export async function revoke(control: ControlApi, id: string): Promise<Delegation[]> {
  const path = runPath(id);
  try {
    const held = await findDelegations(control, id);
    for (const d of held) await control.revokeDelegation(d);
    return held;
  } catch (err) {
    throw new ClaimError("CONTROL_API_FAILED", `revoking ${path} failed`, { cause: err });
  }
}

/** Revoke through the control API, then mount plainly; if the API path fails, mount with `--force`. */
export async function takeOver(control: ControlApi, opts: AcquireOptions): Promise<Claim> {
  let force = false;
  try {
    await revoke(control, opts.ref.id);
  } catch (err) {
    if ((err as ClaimError).code !== "CONTROL_API_FAILED") throw err;
    force = true;
  }
  return acquire({ ...opts, force });
}

// ---- host side: the archil client -----------------------------------------------------------------------------------

type Host = Required<Omit<ArchilHost, "timeoutMs" | "fs">> & {
  timeoutMs: { mount: number; sync: number; unmount: number; cli: number; staleGrace: number };
  stat(path: string): Promise<unknown>;
  persist(path: string, data: string): Promise<void>;
};

function resolveHost(h: ArchilHost = {}): Host {
  return {
    archil: h.archil ?? ARCHIL_SCOPED,
    fusermount: h.fusermount ?? "/usr/bin/fusermount",
    sudo: h.sudo ?? (process.getuid?.() === 0 ? false : "/usr/bin/sudo"),
    procMounts: h.procMounts ?? "/proc/self/mounts",
    proc: h.proc ?? "/proc",
    timeoutMs: { mount: 120_000, sync: 300_000, unmount: 180_000, cli: 30_000, staleGrace: 5_000, ...h.timeoutMs },
    stat: h.fs?.stat ?? stat,
    persist: h.fs?.persist ?? persistFile,
  };
}

async function persistFile(path: string, data: string): Promise<void> {
  const fh = await open(path, "w", 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

type Ran = { code: number | null; timedOut: boolean; stdout: string; stderr: string; ms: number };

/**
 * Spawn with a minimal environment: the parent's (which may hold the API key) never reaches the child. `input` goes to
 * the child's stdin, the only way a secret may travel: never in argv, never in an environment sudo would log.
 */
function sh(argv: string[], timeoutMs: number, input?: string): Promise<Ran> {
  const env: Record<string, string> = { PATH: SAFE_PATH, LANG: "C.UTF-8", HOME: process.env.HOME ?? "/" };
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
    // A child that exits before reading (sudo refusing, a missing wrapper) closes the pipe; its exit code tells why.
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    const done = (fn: () => void) => void (settled || ((settled = true), clearTimeout(timer), fn()));
    // On timeout: SIGTERM (sudo relays it; it cannot relay SIGKILL), drop the pipes a grandchild may hold, settle now.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      child.stdout.destroy();
      child.stderr.destroy();
      done(() => resolve({ code: null, timedOut, stdout, stderr, ms: performance.now() - t0 }));
    }, timeoutMs);
    child.on("error", (err) => done(() => reject(new ClaimError("ARCHIL_CLI_FAILED", `cannot run ${argv[0]}`, { cause: err }))));
    child.on("close", (code) => done(() => resolve({ code, timedOut, stdout, stderr, ms: performance.now() - t0 })));
  });
}

function asRoot(host: Host, argv: string[]): string[] {
  return host.sudo ? [host.sudo, "-n", ...argv] : argv;
}

const archil = (host: Host, args: string[], timeoutMs = host.timeoutMs.cli) => sh(asRoot(host, [host.archil, ...args]), timeoutMs);
const ok = (r: Ran) => r.code === 0 && !r.timedOut;

/** One line of the child's stderr for an error message, with the token scrubbed. */
function detail(r: Ran, secret = ""): string {
  const text = secret ? r.stderr.split(secret).join("<token>") : r.stderr;
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith("✗")) ?? lines.at(-1) ?? "";
  return `${r.timedOut ? "timed out" : `exit ${r.code}`}${line ? `: ${line.slice(0, 400)}` : ""}`;
}

const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

async function mountEntry(host: Host, mountpoint: string): Promise<{ source: string; fstype: string } | null> {
  let found: { source: string; fstype: string } | null = null;
  for (const line of (await readFile(host.procMounts, "utf8")).split("\n")) {
    const f = line.split(" ");
    if (f.length >= 3 && unescapeMount(f[1]) === mountpoint) found = { source: unescapeMount(f[0]), fstype: f[2] };
  }
  return found;
}

function isOurs(entry: { source: string; fstype: string }, ref: RunRef): boolean {
  const base = `${ref.disk}:/${runPath(ref.id)}`;
  return entry.fstype === "fuse.archil" && (entry.source === base || entry.source === `${base}[${ref.region}]`);
}

/** A FUSE mount whose daemon is gone answers stat with ENOTCONN; `archil` refuses it as "not running". */
async function isDead(host: Host, mountpoint: string): Promise<boolean> {
  try {
    await host.stat(mountpoint);
    return false;
  } catch (err) {
    return (err as { code?: unknown }).code === "ENOTCONN";
  }
}

// Exit codes of the mount tools are not evidence (a busy mount can report success and stay); the mount table decides.
const refusedWithEnoent = (r: Ran) => !ok(r) && UNMOUNT_ENOENT.test(`${r.stderr}\n${r.stdout}`);

/** Remove a dead mount with `fusermount -u`; where the kernel refuses with ENOENT (Sysbox), move it aside instead. */
async function cleanDead(host: Host, mountpoint: string): Promise<"fusermount" | "moved"> {
  const r = await sh(asRoot(host, [host.fusermount, "-u", mountpoint]), host.timeoutMs.cli);
  if (!(await mountEntry(host, mountpoint))) return "fusermount";
  if (refusedWithEnoent(r)) {
    await moveAside(host, mountpoint, "DEAD_MOUNT_CLEANUP_FAILED");
    return "moved";
  }
  throw new ClaimError("DEAD_MOUNT_CLEANUP_FAILED", `${mountpoint} is still mounted after fusermount -u (${detail(r)})`);
}

/**
 * The wrapper's `retire`: move the mount to `<mountRoot>/.released/<run>-<tag>` and SIGKILL its daemon. Done only when
 * the mount table, read here, no longer lists the path and the wrapper reports its daemon gone.
 */
async function moveAside(host: Host, mountpoint: string, code: "UNMOUNT_FAILED" | "DEAD_MOUNT_CLEANUP_FAILED"): Promise<void> {
  const r = await archil(host, ["retire", mountpoint, Date.now().toString(36)]);
  if (await mountEntry(host, mountpoint)) throw new ClaimError(code, `${mountpoint} is still mounted after moving it aside (${detail(r)})`);
  if (!ok(r)) throw new ClaimError(code, `${mountpoint} was moved aside but its daemon was not stopped (${detail(r)})`);
}

/**
 * Release a live mount the kernel will not unmount (Sysbox): `archil checkin` gives the delegation back, the client must
 * then list none on the run, and only then is the mount moved aside and its daemon killed. Any failed step leaves the
 * mount where it is, as UNMOUNT_FAILED: a mount that may still hold the delegation is never abandoned.
 */
async function checkinAndMoveAside(host: Host, mountpoint: string): Promise<void> {
  const c = await archil(host, ["checkin", mountpoint], host.timeoutMs.unmount);
  if (!ok(c)) throw new ClaimError("UNMOUNT_FAILED", `${mountpoint} cannot be unmounted on this host (ENOENT) and archil checkin failed: ${detail(c)}`);
  const d = await archil(host, ["delegations", "--json", mountpoint]);
  let list: unknown = null;
  try {
    list = ok(d) ? JSON.parse(d.stdout) : null;
  } catch {
    list = null;
  }
  const mine = (p: unknown) => p === mountpoint || (typeof p === "string" && p.startsWith(`${mountpoint}/`));
  const held = !Array.isArray(list) || list.some((x: { path?: unknown; state?: unknown }) => x?.state === "Active" && mine(x.path));
  if (held) throw new ClaimError("UNMOUNT_FAILED", `${mountpoint} still lists a delegation after archil checkin: ${(ok(d) ? d.stdout : detail(d)).trim().slice(0, 300)}`);
  await moveAside(host, mountpoint, "UNMOUNT_FAILED");
}

/**
 * Unmount whatever the run has at `mountpoint`: `archil unmount` flushes and checks the delegation in; a dead mount
 * (which `archil unmount` refuses) is cleaned with `fusermount -u`; a live mount refused with ENOENT (Sysbox) is checked
 * in and moved aside. Any other live mount that refuses is never forced.
 */
export function unmountClaim(mountpoint: string, host?: ArchilHost): Promise<Unmounted> {
  return unmountWith(resolveHost(host), mountpoint);
}

async function unmountWith(host: Host, mountpoint: string): Promise<Unmounted> {
  if (!(await mountEntry(host, mountpoint))) return "none";
  const r = await archil(host, ["unmount", mountpoint], host.timeoutMs.unmount);
  let via: Unmounted = "archil";
  if (await mountEntry(host, mountpoint)) {
    if (await isDead(host, mountpoint)) via = await cleanDead(host, mountpoint);
    else if (refusedWithEnoent(r)) {
      await checkinAndMoveAside(host, mountpoint);
      via = "moved";
    } else throw new ClaimError("UNMOUNT_FAILED", `${mountpoint} is still mounted after archil unmount (${detail(r)})`);
  }
  await rmdir(mountpoint).catch(() => (host.sudo ? sh([host.sudo, "-n", "rmdir", mountpoint], host.timeoutMs.cli).catch(() => {}) : undefined));
  return via;
}

async function ensureMountpoint(host: Host, dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    return;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (!host.sudo || (code !== "EACCES" && code !== "EPERM")) throw new ClaimError("MOUNT_FAILED", `cannot create ${dir}`, { cause: err });
  }
  const r = await sh([host.sudo, "-n", "mkdir", "-p", dir], host.timeoutMs.cli);
  if (!ok(r)) throw new ClaimError("MOUNT_FAILED", `cannot create ${dir}: ${detail(r)}`);
}

/**
 * Exclusive mode is the absence of `--shared`, `--read-only` and `--conditional`; `verify` proves the mode took. The token
 * goes to the wrapper as one line on stdin (`bin/archil-scoped`), with or without sudo.
 */
async function mountRun(host: Host, ref: RunRef, mountpoint: string, token: string, force: boolean): Promise<void> {
  const path = runPath(ref.id);
  const args = [host.archil, "mount", ...(force ? ["--force"] : []), `${ref.disk}:/${path}`, mountpoint, "--region", ref.region];
  const r = await sh(asRoot(host, args), host.timeoutMs.mount, `${token}\n`);
  const entry = await mountEntry(host, mountpoint);
  if (ok(r) && entry && isOurs(entry, ref)) return;
  if (entry) await unmountWith(host, mountpoint).catch(() => {});
  if (ok(r)) throw new ClaimError("MOUNT_FAILED", `archil mount ${path} exited 0 but ${mountpoint} is not an archil mount of the run`);
  if (STALE_MARKER.test(r.stderr)) throw new ClaimError("MOUNT_FAILED", `an archil daemon of this host still runs for ${mountpoint}: ${detail(r, token)}`);
  if (!force && r.stderr.includes(HELD_MARKER)) throw new HeldError("claim", `${path} is held by another client (${detail(r, token)})`);
  if (r.stderr.includes(NOT_EMPTY_MARKER) || (MISLEADING_REFUSAL.test(r.stderr) && (await entries(mountpoint)) > 0)) {
    throw new ClaimError("MOUNTPOINT_NOT_EMPTY", `archil mount ${path} refused ${mountpoint}, which is not empty: ${detail(r, token)}`);
  }
  throw new ClaimError("MOUNT_FAILED", `archil mount ${path} failed: ${detail(r, token)}`);
}

/**
 * Pids whose argument vector is an archil `mount` naming exactly `mountpoint`. The wrapper's `stale` matches the archil
 * binary's full path; this match is what decides whether to call it. Read synchronously: one pass over a few thousand
 * processes takes tens of milliseconds this way and several times that through the promise API.
 */
function archilDaemons(proc: string, mountpoint: string): number[] {
  const needle = Buffer.from(`\0${mountpoint}\0`);
  const pids: number[] = [];
  let names: string[];
  try {
    names = readdirSync(proc);
  } catch {
    return pids;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let raw: Buffer;
    try {
      raw = readFileSync(join(proc, name, "cmdline"));
    } catch {
      continue;
    }
    if (!raw.includes(needle)) continue;
    const argv = raw.toString("utf8").split("\0");
    if (basename(argv[0]) === "archil" && argv[1] === "mount" && argv.slice(2).includes(mountpoint)) pids.push(Number(name));
  }
  return pids;
}

/**
 * An archil daemon naming the run's mountpoint while no mount is listed there is stale: a client can drop its FUSE mount
 * (after an authentication failure) and keep its process and the mountpoint's control socket, and archil then refuses
 * every mount there ("an older Archil process is still running"). It gets `staleGrace` to exit by itself (a client
 * unmounted moments ago may still be checking its delegation in), then the wrapper's `stale` SIGKILLs it as root. The
 * wrapper refuses while a mount is listed there, so a live mount's daemon is never killed. A daemon that survives is
 * MOUNT_FAILED (exit 1, retried), never held. One line on stderr names the run and the pids.
 */
async function clearStaleDaemon(host: Host, ref: RunRef, mountpoint: string): Promise<number[]> {
  const deadline = performance.now() + host.timeoutMs.staleGrace;
  let pids = archilDaemons(host.proc, mountpoint);
  while (pids.length && performance.now() < deadline) {
    await sleep(Math.min(250, Math.max(0, deadline - performance.now())));
    pids = archilDaemons(host.proc, mountpoint);
  }
  if (!pids.length) return [];
  const r = await archil(host, ["stale", mountpoint]);
  const left = archilDaemons(host.proc, mountpoint);
  if (!ok(r) || left.length) {
    const why = ok(r) ? `pid ${left.join(", ")} survived archil-scoped stale` : detail(r);
    throw new ClaimError("MOUNT_FAILED", `a stale archil daemon (pid ${pids.join(", ")}) runs for ${mountpoint} with no mount and was not cleared: ${why}`);
  }
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event: "stale archil daemon killed", run: ref.id, pids })}\n`);
  return pids;
}

/** How many entries a directory holds; 0 when it cannot be read. */
const entries = (dir: string) => readdir(dir).then((names) => names.length, () => 0);

/**
 * A run's mountpoint that is no mount but has entries (files a process wrote by path after the run's mount vanished)
 * is moved aside whole, as root, by the wrapper's `stray` to `<mountRoot>/.stray/<run>-<tag>` and replaced by an empty
 * directory with its owner and mode: archil refuses to mount over entries, and nothing in them may enter the run. One
 * line on stderr names the run and the count of entries, never a name or a byte of them. An unreadable mountpoint goes
 * to the wrapper too, which looks as root.
 */
async function moveStrayAside(host: Host, ref: RunRef, mountRoot: string, mountpoint: string): Promise<{ to: string; entries: number } | null> {
  const names = await readdir(mountpoint).catch(() => null);
  if (names && names.length === 0) return null;
  const tag = Date.now().toString(36);
  const r = await archil(host, ["stray", mountpoint, tag]);
  if (!ok(r)) throw new ClaimError("MOUNTPOINT_NOT_EMPTY", `${mountpoint} is not empty and could not be moved aside: ${detail(r)}`);
  const counted = /entries=(\d+)/.exec(r.stdout);
  if (!counted) return null;
  const left = await readdir(mountpoint).catch(() => null);
  if (!left || left.length) throw new ClaimError("MOUNTPOINT_NOT_EMPTY", `${mountpoint} is not empty after its entries were moved aside`);
  const moved = { to: join(mountRoot, ".stray", `${ref.id}-${tag}`), entries: Number(counted[1]) };
  process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event: "stray entries moved aside", run: ref.id, entries: moved.entries, to: moved.to })}\n`);
  return moved;
}

/**
 * Ownership is never inferred from a call the client can answer from its cache: on a revoked mount, opening the store,
 * mkdir and writing a new file all succeed locally, and the client keeps listing its delegation Active. So:
 * 1. the client must list an Active delegation on the run, which proves the mount is exclusive (a shared or conditional
 *    mount holds none); then
 * 2. a write and fsync of the probe must succeed, which the server answers and refuses on a revoked mount. Any error
 *    there is a fence (`ownWriteFenced`).
 * The control API cannot replace step 2: a host cannot learn its own client id, so the API can show that someone holds
 * the run but not that this mount does.
 */
async function verify(host: Host, ref: RunRef, mountpoint: string): Promise<void> {
  const path = runPath(ref.id);
  const r = await archil(host, ["delegations", "--json", mountpoint]);
  if (!ok(r)) throw new ClaimError("CLAIM_NOT_VERIFIED", `archil delegations ${mountpoint}: ${detail(r)}`);
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    list = null;
  }
  const accepted = [mountpoint, join(mountpoint, path)];
  const active = Array.isArray(list) && list.some((d: { path?: unknown; state?: unknown }) => d?.state === "Active" && accepted.includes(d.path as string));
  if (!active) throw new ClaimError("CLAIM_NOT_VERIFIED", `${mountpoint} holds no Active delegation on ${path}: ${r.stdout.trim().slice(0, 300)}`);
  try {
    await host.persist(join(mountpoint, CLAIM_PROBE), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  } catch (err) {
    throw ownWriteFenced(join(mountpoint, CLAIM_PROBE), err);
  }
}

/**
 * Take the run's claim: mount `<disk>:/runs/<id>` exclusively at `<mountRoot>/runs/<id>` and verify it. A live mount of
 * the same run already there is kept (in-place restart); a dead one is cleaned first. With no mount there, a stale archil
 * daemon on the mountpoint is killed (`stale`) and entries in it are moved aside to `<mountRoot>/.stray` (`stray`) before
 * the mount. Throws HeldError (exit 76) only when another client holds the delegation, FencedError (exit 75) when the
 * verifying write is refused, MOUNTPOINT_NOT_EMPTY when the mountpoint cannot be emptied or archil still finds it not
 * empty, MOUNT_FAILED (exit 1) for a daemon of this host that is still running there.
 */
export async function acquire(opts: AcquireOptions): Promise<Claim> {
  const { ref, token } = opts;
  const path = runPath(ref.id);
  const mountRoot = opts.mountRoot ?? DEFAULT_MOUNT_ROOT;
  if (!isAbsolute(mountRoot)) throw new ClaimError("INVALID_ARGUMENT", `mountRoot ${mountRoot} is not absolute`);
  // The wrapper reads exactly one line, so a token with a line break would reach archil cut short.
  if (!token || /[\r\n]/.test(token)) throw new ClaimError("INVALID_ARGUMENT", "no mount token, or one with a line break");
  const host = resolveHost(opts.host);
  const root = join(mountRoot, path);
  const t0 = performance.now();
  let reused = false;
  const existing = await mountEntry(host, root);
  if (existing) {
    if (!isOurs(existing, ref)) throw new ClaimError("MOUNTPOINT_BUSY", `${root} already holds ${existing.fstype} ${existing.source}`);
    if (await isDead(host, root)) await cleanDead(host, root);
    else reused = true;
  }
  let stray: { to: string; entries: number } | null = null;
  if (!reused) {
    await ensureMountpoint(host, root);
    await clearStaleDaemon(host, ref, root);
    stray = await moveStrayAside(host, ref, mountRoot, root);
    await mountRun(host, ref, root, token, opts.force === true);
  }
  const t1 = performance.now();
  try {
    await verify(host, ref, root);
  } catch (err) {
    await unmountWith(host, root).catch(() => {});
    throw err;
  }
  return new ArchilClaim(host, ref, root, reused, !reused && opts.force === true, { mountMs: t1 - t0, verifyMs: performance.now() - t1 }, stray);
}

class ArchilClaim implements Claim {
  readonly ref: RunRef;
  readonly disk: string;
  readonly root: string;
  readonly work: string;
  readonly store: string;
  readonly reused: boolean;
  readonly forced: boolean;
  readonly timings: { mountMs: number; verifyMs: number };
  readonly stray: { to: string; entries: number } | null;
  #host: Host;
  #fence: { cause: unknown } | null = null;
  #released = false;

  constructor(host: Host, ref: RunRef, root: string, reused: boolean, forced: boolean, timings: { mountMs: number; verifyMs: number }, stray: { to: string; entries: number } | null = null) {
    this.#host = host;
    this.ref = ref;
    this.disk = ref.disk;
    this.root = root;
    this.work = join(root, "work");
    this.store = join(root, "store");
    this.reused = reused;
    this.forced = forced;
    this.timings = timings;
    this.stray = stray;
  }

  get fenced(): boolean {
    return this.#fence !== null;
  }

  markFenced(cause?: unknown): void {
    this.#fence ??= { cause };
  }

  async barrier(): Promise<{ ms: number }> {
    if (this.#released) throw new ClaimError("CLAIM_RELEASED", `${this.root} was released`);
    if (this.#fence) throw new FencedError(`${this.root} is fenced; nothing is retried on it`, { cause: this.#fence.cause });
    const r = await archil(this.#host, ["sync", this.root], this.#host.timeoutMs.sync);
    if (ok(r)) return { ms: r.ms };
    // `archil sync` fails only when the mount has failed or is read-only: its pending writes did not become durable.
    const err = new FencedError(`archil sync ${this.root}: ${detail(r)}`);
    this.markFenced(err);
    throw err;
  }

  async release(): Promise<{ via: Unmounted }> {
    if (this.#released) return { via: "none" };
    let lost: FencedError | null = null;
    if (!this.#fence) {
      try {
        await this.barrier();
      } catch (err) {
        if (!(err instanceof FencedError)) throw err;
        lost = err;
      }
    }
    const via = await unmountWith(this.#host, this.root);
    this.#released = true;
    if (lost) throw lost;
    return { via };
  }
}
