// P4's live helpers: the resource ledger, the control API on the scratch disk, run directories, single-use tokens, the
// mount roots (each mount is its own FUSE client, standing in for a host), and cleanup that releases everything this
// lane made. Identifiers only are recorded; a token never is.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Disk } from "disk";
import { createRunDir, findDelegations, mintMountToken, removeMountToken, revoke, unmountClaim } from "../../src/claim.ts";
import { statePath } from "./_paths.ts";
import { REGION, scratchDisk, scratchDiskId } from "./_archil.ts";

export const LEDGER = statePath("PDA_P4_STATE", "P4-STATE.json");
export const BASE = "/mnt/pda/p4";
export const STAMP = Date.now().toString(36);

type Entry = Record<string, unknown>;
type Ledger = { lane: "P4"; disk: string | null; tokenUsers: Entry[]; subdirectories: Entry[]; mounts: Entry[]; events: Entry[] };

function load(): Ledger {
  if (!existsSync(LEDGER)) return { lane: "P4", disk: null, tokenUsers: [], subdirectories: [], mounts: [], events: [] };
  return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
}

function update(fn: (l: Ledger) => void): void {
  const l = load();
  fn(l);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, `${JSON.stringify(l, null, 2)}\n`);
}

const now = () => new Date().toISOString();

export const ledger = {
  disk: (id: string) => update((l) => void (l.disk = id)),
  token: (identifier: string, nickname: string, purpose: string) => update((l) => void l.tokenUsers.push({ identifier, nickname, purpose, createdAt: now() })),
  tokenRemoved: (identifier: string) =>
    update((l) => l.tokenUsers.filter((t) => t.identifier === identifier && !t.removedAt).forEach((t) => (t.removedAt = now()))),
  subdir: (key: string, purpose: string) => update((l) => void l.subdirectories.push({ key, purpose, createdAt: now() })),
  subdirDeleted: (key: string, objects: number) =>
    update((l) => l.subdirectories.filter((s) => s.key === key && !s.deletedAt).forEach((s) => Object.assign(s, { deletedAt: now(), objects }))),
  mount: (mountpoint: string, target: string) => update((l) => void l.mounts.push({ mountpoint, target, mountedAt: now() })),
  unmounted: (mountpoint: string, via: string) =>
    update((l) => l.mounts.filter((m) => m.mountpoint === mountpoint && !m.unmountedAt).forEach((m) => Object.assign(m, { unmountedAt: now(), via }))),
  event: (kind: string, detail: Entry = {}) => update((l) => void l.events.push({ at: now(), kind, ...detail })),
};

let disk: Disk | undefined;
const tokens = new Set<string>();
const runIds = new Set<string>();

export async function control(): Promise<Disk> {
  if (!disk) {
    disk = await scratchDisk();
    ledger.disk(disk.id);
  }
  return disk;
}

export const ref = (id: string) => ({ disk: scratchDiskId(), region: REGION, id });

export async function newRun(name: string): Promise<string> {
  const id = `p4-${STAMP}-${name}`;
  await createRunDir(await control(), id, { uid: process.getuid!(), gid: process.getgid!() });
  ledger.subdir(`runs/${id}/`, name);
  runIds.add(id);
  return id;
}

/** A single-use mount token (TTL 2h), recorded by identifier. */
export async function token(purpose: string): Promise<string> {
  const nickname = `pda-p4-${purpose}-${STAMP}`.slice(0, 60);
  const t = await mintMountToken(await control(), { nickname, ttl: "2h" });
  ledger.token(t.identifier, nickname, purpose);
  tokens.add(t.identifier);
  return t.token;
}

export async function revokeRun(id: string): Promise<number> {
  const held = await revoke(await control(), id);
  ledger.event("revoke", { id, delegations: held.length, orphaned: held.filter((d) => d.isOrphaned).length });
  return held.length;
}

export function archilMounts(): string[] {
  return readFileSync("/proc/self/mounts", "utf8")
    .split("\n")
    .map((l) => l.split(" "))
    .filter((f) => f[2] === "fuse.archil")
    .map((f) => f[1]!);
}

/** The pid of the archil daemon serving `mountpoint` (each mount has its own). */
export function daemonPid(mountpoint: string): number {
  const rows = (spawnSync("pgrep", ["-a", "-f", "archil mount"], { encoding: "utf8" }).stdout ?? "").split("\n").map((l) => l.trim().split(/\s+/));
  const hit = rows.filter((p) => p[1]?.endsWith("/archil") && p[2] === "mount" && p.includes(mountpoint));
  if (hit.length !== 1) throw new Error(`expected one daemon for ${mountpoint}, found ${hit.length}`);
  return Number(hit[0]![0]);
}

/** Unmount whatever this lane has at `mountpoint` (a live, revoked or dead mount); recorded only once it is gone. */
export async function cleanMount(mountpoint: string): Promise<string> {
  const via = await unmountClaim(mountpoint).catch((error: unknown) => `failed: ${String(error)}`);
  if (via.startsWith("failed")) ledger.event("unmount failed", { mountpoint, via });
  else ledger.unmounted(mountpoint, via);
  return via;
}

/** Kill this user's processes whose working directory is under `dir` (commands a killed instance left on a mount). */
function killProcessesUnder(dir: string): number[] {
  const killed: number[] = [];
  for (const entry of readdirSync("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (cwd !== dir && !cwd.startsWith(`${dir}/`)) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // gone, or not ours
    }
  }
  return killed;
}

async function deletePrefix(prefix: string): Promise<{ objects: number; errors: number; left: number }> {
  const d = await control();
  const keys = (await d.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
  const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])];
  const depth = (k: string) => k.split("/").length;
  let errors = (await d.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true })).errors.length;
  for (const level of [...new Set(dirs.map(depth))].sort((x, y) => y - x)) {
    errors += (await d.deleteObjects(dirs.filter((k) => depth(k) === level), { quiet: true })).errors.length;
  }
  const left = (await d.listObjects(prefix, { recursive: true })).objects.length;
  return { objects: keys.length, errors, left };
}

/** Release everything this process made: mounts under BASE, delegations, run directories, token users. */
export async function cleanupAll(): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {};
  const stray: string[] = [];
  for (const mp of archilMounts().filter((m) => m.startsWith(`${BASE}/`))) {
    const killed = killProcessesUnder(mp);
    if (killed.length > 0) await new Promise((resolve) => setTimeout(resolve, 200));
    stray.push(`${mp}: ${await cleanMount(mp)}${killed.length > 0 ? ` (after killing ${killed.join(", ")})` : ""}`);
  }
  report.strayMounts = stray;
  const prefixes: unknown[] = [];
  for (const id of runIds) {
    await revoke(await control(), id).catch(() => []);
    const del = await deletePrefix(`runs/${id}/`);
    prefixes.push({ id, ...del });
    if (del.left === 0) ledger.subdirDeleted(`runs/${id}/`, del.objects);
    else ledger.event("subdirectory not fully deleted", { key: `runs/${id}/`, ...del });
  }
  report.prefixes = prefixes;
  for (const identifier of tokens) {
    await removeMountToken(await control(), identifier);
    ledger.tokenRemoved(identifier);
  }
  spawnSync("bash", ["-c", `sudo find ${BASE} -mindepth 1 -depth -type d -empty -delete`]);
  report.mountsAfter = archilMounts().filter((m) => m.startsWith(`${BASE}/`));
  report.delegationsAfter = (await Promise.all([...runIds].map(async (id) => findDelegations(await control(), id)))).flat().length;
  const fresh = await scratchDisk();
  report.tokenUsersAfter = (fresh.authorizedUsers ?? []).filter((u) => JSON.stringify(u).includes(`pda-p4-`)).length;
  ledger.event("cleanup", report);
  return report;
}

export function prepareBase(): void {
  spawnSync("sudo", ["mkdir", "-p", BASE]);
  spawnSync("sudo", ["chown", `${process.getuid!()}:${process.getgid!()}`, BASE]);
}
