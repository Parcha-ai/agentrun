// The acceptance rig's plumbing: the resource ledger (identifiers only, never a token), supervisor processes, the two
// hosts' power-off and freeze, the units' journals, and cleanup of everything the rig made.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Disk } from "disk";
import { findDelegations, removeMountToken, unmountClaim } from "../../src/claim.ts";
import { localHost } from "../../src/hosts/local-host.ts";
import type { HostHandle } from "../../src/supervise.ts";
import { STATE_DIR, statePath } from "../live/_paths.ts";
import type { Config } from "./_supervisor.ts";

// Ledger, results and traces go to $PDA_STATE_DIR, or to a fresh temporary directory (test/live/_paths.ts).
export const LANES = STATE_DIR;
export const LEDGER = statePath("PDA_P6_STATE", "P6-STATE.json");
export const TRACES = join(LANES, "p6-traces");
export const BASE = "/mnt/pda/p6";
export const KEY_ENV = "ARCHIL_API_KEY";
const SUPERVISOR = fileURLToPath(new URL("./_supervisor.ts", import.meta.url));

// ---- the ledger --------------------------------------------------------------------------------------------------------

type Entry = Record<string, unknown>;
type Ledger = { lane: "P6"; disk: string | null; tokenUsers: Entry[]; subdirectories: Entry[]; mounts: Entry[]; units: Entry[]; events: Entry[] };

function load(): Ledger {
  if (!existsSync(LEDGER)) return { lane: "P6", disk: null, tokenUsers: [], subdirectories: [], mounts: [], units: [], events: [] };
  return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
}

function update(fn: (l: Ledger) => void): void {
  const l = load();
  fn(l);
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, `${JSON.stringify(l, null, 2)}\n`);
}

const iso = () => new Date().toISOString();
const close = (list: Entry[], key: string, value: string, fields: Entry) =>
  list.filter((e) => e[key] === value && !e.closedAt).forEach((e) => Object.assign(e, { closedAt: iso(), ...fields }));

export const ledger = {
  disk: (id: string) => update((l) => void (l.disk = id)),
  token: (identifier: string, nickname: string, purpose: string) => update((l) => void l.tokenUsers.push({ identifier, nickname, purpose, createdAt: iso() })),
  tokenRemoved: (identifier: string, how = "removeUser") => update((l) => close(l.tokenUsers, "identifier", identifier, { how })),
  subdir: (key: string, purpose: string) => update((l) => void l.subdirectories.push({ key, purpose, createdAt: iso() })),
  subdirDeleted: (key: string, objects: number) => update((l) => close(l.subdirectories, "key", key, { objects })),
  mount: (mountpoint: string, target: string) => update((l) => void l.mounts.push({ mountpoint, target, createdAt: iso() })),
  unmounted: (mountpoint: string, via: string) => update((l) => close(l.mounts, "mountpoint", mountpoint, { via })),
  unit: (name: string, purpose: string) => update((l) => void l.units.push({ name, purpose, createdAt: iso() })),
  unitGone: (name: string, how: string) => update((l) => close(l.units, "name", name, { how })),
  event: (kind: string, detail: Entry = {}) => update((l) => void l.events.push({ at: iso(), kind, ...detail })),
  open: (): Ledger => load(),
};

// ---- small things ------------------------------------------------------------------------------------------------------

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 60_000, everyMs = 50): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

export const archilMounts = () =>
  readFileSync("/proc/self/mounts", "utf8").split("\n").map((l) => l.split(" ")).filter((f) => f[2] === "fuse.archil" && f[1]?.startsWith(`${BASE}/`)).map((f) => f[1]!);

export function show(unit: string): Record<string, string> {
  const out = sh("systemctl", ["show", `${unit}.service`, "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode,MainPID,NRestarts,ControlGroup"]).stdout;
  return Object.fromEntries(out.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

const procsOf = (cgroup: string) => {
  try {
    return readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8").trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};

/** The active FUSE scopes of a unit's mounts (`bin/archil-scoped` names them `<unit>-fuse-<n>.scope`). */
export function fuseScopes(unit: string): string[] {
  const rows = sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "--type=scope", `${unit}-fuse-*`]).stdout.trim();
  return rows ? rows.split("\n").map((r) => r.trim().split(/\s+/)).filter((f) => f[2] === "active").map((f) => f[0]!) : [];
}

/** Every process of host A's instance: its unit's cgroup (the instance and the agent's commands) and its FUSE daemons. */
export function hostProcesses(unit: string): { instance: number[]; fuse: number[] } {
  const instance = procsOf(show(unit).ControlGroup ?? "");
  const fuse = fuseScopes(unit).flatMap((scope) => procsOf(sh("systemctl", ["show", scope, "--property=ControlGroup", "--value"]).stdout.trim()));
  return { instance, fuse };
}

/** One signal to every pid in one kill(1) call: the instance and its FUSE client go together. Returns the epoch ms. */
export function signalAll(signal: "KILL" | "STOP" | "CONT", pids: number[]): number {
  const at = Date.now();
  const r = sh("sudo", ["-n", "kill", `-${signal}`, ...pids.map(String)]);
  if (r.status !== 0 && signal !== "CONT") throw new Error(`kill -${signal} ${pids.join(" ")}: ${r.stderr}`);
  return at;
}

export function journal(unit: string): string[] {
  return sh("journalctl", ["-u", `${unit}.service`, "--no-pager", "-o", "cat"]).stdout.split("\n").filter(Boolean);
}

/** The instance's stderr JSON events (`running`, `open failed`, ...) and its fence line, from the unit's journal. */
export function instanceLog(unit: string): { events: Record<string, unknown>[]; fence: string | null; exit: string | null } {
  const lines = journal(unit);
  const events = lines.filter((l) => l.startsWith("{")).flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const exitLine = lines.findLast((l) => l.includes("Main process exited"));
  return { events, fence: lines.find((l) => l.includes("pi-durable-disk: fenced")) ?? null, exit: exitLine ? (/status=(\d+)/.exec(exitLine)?.[1] ?? /status=\d+\/(\w+)/.exec(exitLine)?.[1] ?? exitLine) : null };
}

// ---- supervisor processes ----------------------------------------------------------------------------------------------

export type SupervisorLine = {
  tick: number;
  at: number;
  ms: number;
  seenAt: number;
  decision?: Record<string, unknown> & { action: string };
  error?: string;
  message?: string;
  calls: { call: string; at: number; ms: number; ok: boolean }[];
};

export interface SupervisorProcess {
  readonly lines: SupervisorLine[];
  readonly exited: Promise<number | null>;
  stderr(): string;
  stop(): Promise<void>;
}

/** Start a supervisor process; `onLine` sees each decision (the ledger records tokens and units from it). */
export function supervisor(config: Config, onLine: (line: SupervisorLine) => void): SupervisorProcess {
  const child: ChildProcess = spawn(process.execPath, [SUPERVISOR, JSON.stringify(config)], {
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR ?? "/tmp", [KEY_ENV]: process.env[KEY_ENV]! },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: SupervisorLine[] = [];
  let buf = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (c: string) => {
    buf += c;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.startsWith("{")) continue;
      const line = { ...(JSON.parse(l) as Omit<SupervisorLine, "seenAt">), seenAt: Date.now() };
      onLine(line);
      lines.push(line);
    }
  });
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return {
    lines,
    exited,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}

// ---- cleanup -----------------------------------------------------------------------------------------------------------

const hostOf = (h: HostHandle) => localHost({ hostName: String(h.host), mountRoot: String(h.mountpoint).replace(/\/runs\/[^/]+$/, ""), stopTimeoutMs: 5_000 });

/** Stop an instance through its driver, then clean whatever its host left at the mountpoint (a power-lost unit's dead mount). */
export async function stopInstance(h: HostHandle, how: string): Promise<string> {
  const r = await hostOf(h).stop(h).then(() => "stopped", (e: unknown) => `stop failed: ${(e as Error).message}`);
  ledger.unitGone(`${h.unit}.service`, `${how} (${r})`);
  const mp = String(h.mountpoint);
  if (archilMounts().includes(mp)) {
    const via = await unmountClaim(mp).catch((e: unknown) => `failed: ${(e as Error).message}`);
    if (!String(via).startsWith("failed")) ledger.unmounted(mp, `${via} after the driver's stop`);
    return `${r}; mount ${via}`;
  }
  ledger.unmounted(mp, "released by the instance or the driver");
  return r;
}

async function deletePrefix(disk: Disk, prefix: string): Promise<{ objects: number; errors: number; left: number }> {
  const keys = (await disk.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
  const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])];
  const depth = (k: string) => k.split("/").length;
  let errors = (await disk.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true })).errors.length;
  for (const level of [...new Set(dirs.map(depth))].sort((x, y) => y - x)) errors += (await disk.deleteObjects(dirs.filter((k) => depth(k) === level), { quiet: true })).errors.length;
  const left = (await disk.listObjects(prefix, { recursive: true })).objects.length;
  return { objects: keys.length, errors, left };
}

/** Revoke what still holds the run, delete its directory, and remove the token users the rig recorded for it. */
export async function cleanRun(disk: Disk, id: string, tokens: Iterable<string>): Promise<Record<string, unknown>> {
  const held = await findDelegations(disk, id).catch(() => []);
  for (const d of held) await disk.revokeDelegation(d).catch(() => {});
  const del = await deletePrefix(disk, `runs/${id}/`);
  if (del.left === 0) ledger.subdirDeleted(`runs/${id}/`, del.objects);
  else ledger.event("subdirectory not fully deleted", { id, ...del });
  const removed: string[] = [];
  for (const t of tokens) {
    const r = await removeMountToken(disk, t).then(() => "removed", (e: unknown) => `failed: ${(e as Error).message}`);
    if (r === "removed") (ledger.tokenRemoved(t), removed.push(t));
  }
  return { revokedLeftovers: held.length, ...del, tokensRemoved: removed.length };
}
