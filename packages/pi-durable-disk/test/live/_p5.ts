// The supervise suites' harness (supervise.live.test.ts and supervise-slow.live.test.ts): the mount roots that stand in
// for hosts A, B and C, the run, token and unit bookkeeping, the CLI supervisor helpers, and the before and after hooks
// that set up /mnt/pda/p5 and remove everything a test made (recorded in P5-STATE.json), also on failure. Each file that
// imports it runs in its own process, with its own hooks; they share the ledger.
import { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDisk, type Disk } from "disk";
import { KEY_ENV, LIVE, REGION, RUN_OWNER, scratchDisk, scratchDiskId } from "./_archil.ts";
import { ledger, LEDGER } from "./_p5-ledger.ts";
import { createRunDir, findDelegations, removeMountToken, unmountClaim } from "../../src/claim.ts";
import { localHost } from "../../src/hosts/local-host.ts";
import { deleteRunTree, readRunStatus, type HostHandle } from "../../src/supervise.ts";

export const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
export const E2E_APP = fileURLToPath(new URL("../fixtures/e2e-app.ts", import.meta.url));
export const SEAL_APP = fileURLToPath(new URL("../fixtures/seal-app.ts", import.meta.url));
export const BASE = "/mnt/pda/p5";
export const A = `${BASE}/a`;
export const B = `${BASE}/b`;
export const C = `${BASE}/c`;
export const STAMP = Date.now().toString(36);
export const OUT = fileURLToPath(new URL(`../../.tmp/live-${STAMP}`, import.meta.url));
/** Next to the ledger, named after it: P5-STATE.json gives P5-live-results.json. */
let resultsFile: string;
/** Where `after` writes this file's measurements: by default <ledger>-live-results.json next to the ledger. */
export function writeResultsTo(file: string): void {
  resultsFile = file;
}
const DEFAULT_RESULTS = LEDGER.endsWith("-STATE.json") ? LEDGER.replace(/-STATE\.json$/, "-live-results.json") : join(LEDGER, "..", "P5-live-results.json");

resultsFile = DEFAULT_RESULTS;
export let disk: Disk;
export let tokenDirExisted = true;
export const runIds: string[] = [];
export const tokens = new Set<string>();
export const handles: HostHandle[] = [];
export const loops = new Set<ChildProcess>();
export const stopped = new Set<number>();
export const results: Record<string, unknown> = { at: new Date().toISOString(), host: "", client: "" };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

export async function newRun(name: string): Promise<string> {
  const id = `p5-${STAMP}-${name}`;
  await createRunDir(disk, id, RUN_OWNER);
  ledger.subdir(`runs/${id}/`, `live ${name}`);
  runIds.push(id);
  return id;
}

/** Every line a supervisor prints is a decision; record each token user and unit the moment it appears. */
export function noteLine(line: Record<string, unknown>): void {
  if (line.action === "started") {
    const t = line.token as { identifier: string; nickname: string };
    tokens.add(t.identifier);
    ledger.token(t.identifier, t.nickname, `live, minted by a supervise process for ${line.run}`);
    const h = line.handle as HostHandle;
    handles.push(h);
    ledger.unit(`${h.unit}.service`, `instance of ${line.run} (${h.host})`);
    ledger.mount(String(h.mountpoint), `${scratchDiskId()}:/runs/${line.run} (made by instance ${h.unit})`);
  }
  if (line.event === "check-resource") {
    const { kind, id, detail } = line as { kind: string; id: string; detail?: string };
    if (kind === "token") (tokens.add(id), ledger.token(id, String(detail), "live supervise --check"));
    if (kind === "token-removed") (tokens.delete(id), ledger.tokenRemoved(id));
    if (kind === "subdir") ledger.subdir(id, "live supervise --check probe");
    if (kind === "subdir-deleted") ledger.subdirDeleted(id, -1);
    if (kind === "mount") ledger.mount(id, String(detail));
    if (kind === "unmount") ledger.unmounted(id, String(detail));
  }
}

export const parseLines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

export function superviseArgs(id: string | null, flags: string[]): string[] {
  return [CLI, "supervise", "--disk", scratchDiskId(), "--region", REGION, ...(id ? ["--id", id] : []), "--api-key-env", KEY_ENV, "--token-prefix", "pda-p5-", "--token-ttl", "2h", ...flags];
}
export const supervisorEnv = () => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, [KEY_ENV]: process.env[KEY_ENV]! });

/** One supervise pass in its own process. */
export function superviseOnce(id: string | null, flags: string[]): { code: number | null; lines: Record<string, unknown>[]; stderr: string } {
  const r = spawnSync(process.execPath, superviseArgs(id, flags), { env: supervisorEnv(), encoding: "utf8", timeout: 180_000 });
  const lines = parseLines(r.stdout);
  lines.forEach(noteLine);
  return { code: r.status, lines, stderr: r.stderr };
}

/** A `supervise --every` loop in its own process; `lines` fills as it prints. */
export function superviseLoop(id: string, flags: string[], every = "3s") {
  const child = spawn(process.execPath, superviseArgs(id, [...flags, "--every", every]), { env: supervisorEnv(), stdio: ["ignore", "pipe", "pipe"] });
  loops.add(child);
  const lines: (Record<string, unknown> & { seenAt: number })[] = [];
  let buf = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (c: string) => {
    buf += c;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.startsWith("{")) continue;
      const line = { ...(JSON.parse(l) as Record<string, unknown>), seenAt: Date.now() };
      noteLine(line);
      lines.push(line);
    }
  });
  child.stderr!.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  return {
    lines,
    stderr: () => stderr,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
      loops.delete(child);
    },
  };
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 60_000, everyMs = 100): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

export const show = (unit: string) =>
  Object.fromEntries(
    sh("systemctl", ["show", `${unit}.service`, "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode,MainPID,NRestarts,ControlGroup,ExecMainExitTimestampMonotonic"])
      .stdout.split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ) as Record<string, string>;

export function fuseScope(unit: string): string | null {
  const rows = sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "--type=scope", `${unit}-fuse-*`]).stdout.trim();
  return rows ? rows.split(/\s+/)[0] : null;
}

/** The FUSE daemon serving a unit's mount: the archil process in the unit's scope. */
export function daemonOf(unit: string): { pid: number; uid: number; scope: string } {
  const scope = fuseScope(unit);
  assert.ok(scope, `${unit} has a FUSE scope`);
  const cg = sh("systemctl", ["show", scope, "--property=ControlGroup", "--value"]).stdout.trim();
  const pids = readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf8").trim().split("\n").filter(Boolean).map(Number);
  const daemons = pids.filter((p) => readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").includes("mount"));
  assert.equal(daemons.length, 1, `one daemon in ${scope}: ${pids}`);
  const uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${daemons[0]}/status`, "utf8"))![1]);
  return { pid: daemons[0], uid, scope };
}

export const alive = (pid: number) => {
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
};
export const archilMounts = () =>
  readFileSync("/proc/self/mounts", "utf8").split("\n").map((l) => l.split(" ")).filter((f) => f[2] === "fuse.archil" && f[1]?.startsWith(`${BASE}/`)).map((f) => f[1]);
export const s3 = (id: string) => readRunStatus(disk, id);
/** The flags every real instance gets: the e2e app, its output directory, a 1 s heartbeat, and the given lease. */
export const instance = (lease: { expiryMs: number; marginMs: number } = { expiryMs: 600_000, marginMs: 0 }) => [
  "--env",
  `PDA_TEST_OUT=${OUT}`,
  `--run-arg=--app=${E2E_APP}`,
  "--run-arg=--heartbeat-ms=1000",
  `--run-arg=--lease-expiry-ms=${lease.expiryMs}`,
  `--run-arg=--lease-margin-ms=${lease.marginMs}`,
];
export type AppEvent = { ev: string; t: number; generation: number; unit: string; pid: number; n?: number; commandPid?: number; sudoExit?: number; resumedFrom?: number; ticks?: number; duplicates?: number; work?: boolean; instanceStdin?: string };
/** What the e2e app's instances of run `id` recorded, in order. */
export const events = (id: string): AppEvent[] => {
  const file = join(OUT, `${id}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AppEvent) : [];
};
export const ticksOf = (id: string, generation: number) => events(id).filter((e) => e.ev === "tick" && e.generation === generation);
export const eventOf = (id: string, ev: string, generation: number) => events(id).find((e) => e.ev === ev && e.generation === generation);
export const uidOf = (pid: number) => Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]);
/** The main process's exit status as the unit's journal recorded it (the unit may be unloaded by now). */
export function journalExit(unit: string): string | null {
  const line = sh("journalctl", ["-u", `${unit}.service`, "--no-pager", "-o", "cat"]).stdout.split("\n").findLast((l) => l.includes("Main process exited"));
  return line ? (/status=(\d+)/.exec(line)?.[1] ?? null) : null;
}

/** The latest incarnation's stderr line `running` (openDurableRun's step timings) from the unit's journal. */
export function openSteps(unit: string): Record<string, number> | null {
  const line = sh("journalctl", ["-u", `${unit}.service`, "--no-pager", "-o", "cat"]).stdout.split("\n").findLast((l) => l.includes('"event":"running"'));
  return line ? (JSON.parse(line).steps as Record<string, number>) : null;
}

/** The driver the tests use to stop instances: same options the supervise processes used. */
export const driverFor = (hostName: string, mountRoot: string) => localHost({ hostName, mountRoot, stopTimeoutMs: 5_000 });

/** Stop an instance through its driver and close its ledger rows; the mount table decides whether its mount is gone. */
export async function stopInstance(h: HostHandle, how = "driver stop"): Promise<void> {
  await driverFor(String(h.host), String(h.mountpoint).replace(/\/runs\/[^/]+$/, "")).stop(h);
  ledger.unitGone(`${h.unit}.service`, how);
  if (!archilMounts().includes(String(h.mountpoint))) ledger.unmounted(String(h.mountpoint), "released by the instance or the driver");
  const i = handles.indexOf(h);
  if (i >= 0) handles.splice(i, 1);
}

before(async () => {
  if (!LIVE) return;
  disk = await scratchDisk();
  ledger.disk(disk.id);
  results.host = sh("hostname", []).stdout.trim();
  results.client = sh("/usr/bin/archil", ["--version"]).stdout.split("\n")[0];
  assert.deepEqual(archilMounts(), [], "no P5 mounts left from an earlier run");
  assert.equal(sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "pda-p5-*"]).stdout.trim(), "", "no pda-p5 units left from an earlier run");
  sh("sudo", ["-n", "mkdir", "-p", BASE]);
  sh("sudo", ["-n", "chown", `${process.getuid!()}:${process.getgid!()}`, BASE]);
  for (const d of [A, B, C, OUT]) mkdirSync(d, { recursive: true, mode: 0o755 });
  tokenDirExisted = sh("sudo", ["-n", "test", "-d", "/run/pi-durable-disk"]).status === 0;
  if (!tokenDirExisted) ledger.file("/run/pi-durable-disk", "the token directory localHost creates on demand (root 0700, tmpfs); removed in after if empty");
  sh("chmod", ["755", OUT]);
});

after(async () => {
  if (!LIVE) return;
  const cleanup: Record<string, unknown> = { stoppedDaemonsResumed: [...stopped], loops: loops.size, units: [], mounts: [], prefixes: [], tokens: [] };
  for (const pid of stopped) sh("sudo", ["-n", "kill", "-CONT", String(pid)]);
  for (const l of loops) l.kill("SIGTERM");
  await sleep(500);
  for (const h of [...handles]) {
    const r = await stopInstance(h, "stopped in after").then(() => "stopped", (e: unknown) => `stop failed: ${(e as Error).message}`);
    (cleanup.units as unknown[]).push({ unit: h.unit, r });
  }
  for (const line of sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "pda-p5-*"]).stdout.trim().split("\n").filter(Boolean)) {
    const unit = line.split(/\s+/)[0];
    sh("sudo", ["-n", "systemctl", "stop", unit]);
    sh("sudo", ["-n", "systemctl", "reset-failed", unit]);
    (cleanup.units as unknown[]).push({ unit, r: "stray, stopped" });
    ledger.unitGone(unit, "stray, stopped in after");
  }
  for (const mp of archilMounts()) {
    const via = await unmountClaim(mp).catch((e: unknown) => `failed: ${(e as Error).message}`);
    (cleanup.mounts as unknown[]).push({ mp, via });
    ledger.unmounted(mp, String(via));
  }
  for (const id of [...new Set(runIds)]) {
    const r = await deleteRunTree(disk, id).then((x) => ({ ...x, left: 0 }), (e: unknown) => ({ error: (e as Error).message, left: -1 }));
    (cleanup.prefixes as unknown[]).push({ id, ...r });
    if (r.left === 0) ledger.subdirDeleted(`runs/${id}/`, (r as { objects: number }).objects);
    else ledger.event("subdirectory not fully deleted", { id, ...r });
  }
  // Every token user this run minted, by identifier, then a sweep by nickname for any a crashed supervisor printed late.
  for (const identifier of tokens) {
    const r = await removeMountToken(disk, identifier).then(() => "removed", (e: unknown) => `failed: ${(e as Error).message}`);
    (cleanup.tokens as unknown[]).push({ identifier, r });
    if (r === "removed") ledger.tokenRemoved(identifier);
  }
  const fresh = await getDisk(disk.id);
  const strays = (fresh.authorizedUsers ?? []).filter((u) => u.nickname?.startsWith("pda-p5-") && u.identifier);
  for (const u of strays) {
    await disk.removeUser("token", u.identifier!).catch(() => {});
    ledger.tokenRemoved(u.identifier!, "sweep by nickname in after");
  }
  cleanup.strayTokens = strays.length;
  sh("bash", ["-c", `sudo -n find ${BASE} -mindepth 1 -depth -type d -empty -delete`]);
  cleanup.mountsAfter = archilMounts();
  cleanup.unitsAfter = sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "pda-p5-*"]).stdout.trim();
  // Units that ended on their own leave an empty token file (the path a restart in place would reopen); none holds a token.
  cleanup.tokenFilesWithContent = sh("sudo", ["-n", "find", "/run/pi-durable-disk", "-name", "pda-p5-*", "-size", "+0"]).stdout.trim();
  sh("sudo", ["-n", "find", "/run/pi-durable-disk", "-name", "pda-p5-*", "-delete"]);
  if (!tokenDirExisted) {
    sh("sudo", ["-n", "rmdir", "/run/pi-durable-disk"]);
    if (sh("sudo", ["-n", "test", "-e", "/run/pi-durable-disk"]).status !== 0) ledger.fileRemoved("/run/pi-durable-disk");
  }
  cleanup.delegationsAfter = (await Promise.all(runIds.map((id) => findDelegations(disk, id)))).flat().length;
  results.cleanup = cleanup;
  writeFileSync(resultsFile, JSON.stringify(results, null, 2) + "\n");
});

