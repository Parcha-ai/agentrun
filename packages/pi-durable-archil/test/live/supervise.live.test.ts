// Live supervisor and local host suite on the shared scratch disk (a hung host, the cgroup and in-place restart,
// `supervise --check`, live STONITH and racing supervisors). Supervisors run as separate CLI processes (they hold the
// API key; instances never do); instances run as systemd transient units through localHost. Mount roots with separate
// FUSE clients on this box (/mnt/pda/p5/a, b, c) stand in for hosts A, B and C. Everything lives under runs/p5-<stamp>-*/,
// /mnt/pda/p5/ and units named pda-p5-*; every token user, subdirectory, mount and unit is recorded in P5-STATE.json
// and removed in `after`, also on failure. Measurements go to <ledger>-live-results.json next to the ledger.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDisk, type Disk } from "disk";
import { KEY_ENV, LIVE, REGION, scratchDisk, scratchDiskId } from "./_archil.ts";
import { ledger, LEDGER } from "./_p5-ledger.ts";
import { ARCHIL_SCOPED, createRunDir, findDelegations, mintMountToken, removeMountToken, unmountClaim } from "../../src/claim.ts";
import { localHost } from "../../src/hosts/local-host.ts";
import { deleteRunTree, readRunStatus, type HostHandle } from "../../src/supervise.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const E2E_APP = fileURLToPath(new URL("../fixtures/e2e-app.ts", import.meta.url));
const SEAL_APP = fileURLToPath(new URL("../fixtures/seal-app.ts", import.meta.url));
const BASE = "/mnt/pda/p5";
const A = `${BASE}/a`;
const B = `${BASE}/b`;
const C = `${BASE}/c`;
const STAMP = Date.now().toString(36);
const OUT = fileURLToPath(new URL(`../../.tmp/live-${STAMP}`, import.meta.url));
/** Next to the ledger, named after it: P5-STATE.json gives P5-live-results.json. */
const RESULTS = LEDGER.endsWith("-STATE.json") ? LEDGER.replace(/-STATE\.json$/, "-live-results.json") : join(LEDGER, "..", "P5-live-results.json");

let disk: Disk;
let tokenDirExisted = true;
const runIds: string[] = [];
const tokens = new Set<string>();
const handles: HostHandle[] = [];
const loops = new Set<ChildProcess>();
const stopped = new Set<number>();
const results: Record<string, unknown> = { at: new Date().toISOString(), host: "", client: "" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

async function newRun(name: string): Promise<string> {
  const id = `p5-${STAMP}-${name}`;
  await createRunDir(disk, id, { uid: 1000, gid: 1000 });
  ledger.subdir(`runs/${id}/`, `live ${name}`);
  runIds.push(id);
  return id;
}

/** Every line a supervisor prints is a decision; record each token user and unit the moment it appears. */
function noteLine(line: Record<string, unknown>): void {
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

const parseLines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);

function superviseArgs(id: string | null, flags: string[]): string[] {
  return [CLI, "supervise", "--disk", scratchDiskId(), "--region", REGION, ...(id ? ["--id", id] : []), "--api-key-env", KEY_ENV, "--token-prefix", "pda-p5-", "--token-ttl", "2h", ...flags];
}
const supervisorEnv = () => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, [KEY_ENV]: process.env[KEY_ENV]! });

/** One supervise pass in its own process. */
function superviseOnce(id: string | null, flags: string[]): { code: number | null; lines: Record<string, unknown>[]; stderr: string } {
  const r = spawnSync(process.execPath, superviseArgs(id, flags), { env: supervisorEnv(), encoding: "utf8", timeout: 180_000 });
  const lines = parseLines(r.stdout);
  lines.forEach(noteLine);
  return { code: r.status, lines, stderr: r.stderr };
}

/** A `supervise --every` loop in its own process; `lines` fills as it prints. */
function superviseLoop(id: string, flags: string[], every = "3s") {
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

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 60_000, everyMs = 100): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

const show = (unit: string) =>
  Object.fromEntries(
    sh("systemctl", ["show", `${unit}.service`, "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainCode,MainPID,NRestarts,ControlGroup,ExecMainExitTimestampMonotonic"])
      .stdout.split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ) as Record<string, string>;

function fuseScope(unit: string): string | null {
  const rows = sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "--type=scope", `${unit}-fuse-*`]).stdout.trim();
  return rows ? rows.split(/\s+/)[0] : null;
}

/** The FUSE daemon serving a unit's mount: the archil process in the unit's scope. */
function daemonOf(unit: string): { pid: number; uid: number; scope: string } {
  const scope = fuseScope(unit);
  assert.ok(scope, `${unit} has a FUSE scope`);
  const cg = sh("systemctl", ["show", scope, "--property=ControlGroup", "--value"]).stdout.trim();
  const pids = readFileSync(`/sys/fs/cgroup${cg}/cgroup.procs`, "utf8").trim().split("\n").filter(Boolean).map(Number);
  const daemons = pids.filter((p) => readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").includes("mount"));
  assert.equal(daemons.length, 1, `one daemon in ${scope}: ${pids}`);
  const uid = Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${daemons[0]}/status`, "utf8"))![1]);
  return { pid: daemons[0], uid, scope };
}

const alive = (pid: number) => {
  try {
    return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return false;
  }
};
const archilMounts = () =>
  readFileSync("/proc/self/mounts", "utf8").split("\n").map((l) => l.split(" ")).filter((f) => f[2] === "fuse.archil" && f[1]?.startsWith(`${BASE}/`)).map((f) => f[1]);
const s3 = (id: string) => readRunStatus(disk, id);
/** The flags every real instance gets: the e2e app, its output directory, a 1 s heartbeat, and the given lease. */
const instance = (lease: { expiryMs: number; marginMs: number } = { expiryMs: 600_000, marginMs: 0 }) => [
  "--env",
  `PDA_TEST_OUT=${OUT}`,
  `--run-arg=--app=${E2E_APP}`,
  "--run-arg=--heartbeat-ms=1000",
  `--run-arg=--lease-expiry-ms=${lease.expiryMs}`,
  `--run-arg=--lease-margin-ms=${lease.marginMs}`,
];
type AppEvent = { ev: string; t: number; generation: number; unit: string; pid: number; n?: number; commandPid?: number; sudoExit?: number; resumedFrom?: number; ticks?: number; duplicates?: number; work?: boolean; instanceStdin?: string };
/** What the e2e app's instances of run `id` recorded, in order. */
const events = (id: string): AppEvent[] => {
  const file = join(OUT, `${id}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AppEvent) : [];
};
const ticksOf = (id: string, generation: number) => events(id).filter((e) => e.ev === "tick" && e.generation === generation);
const eventOf = (id: string, ev: string, generation: number) => events(id).find((e) => e.ev === ev && e.generation === generation);
const uidOf = (pid: number) => Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]);
/** The main process's exit status as the unit's journal recorded it (the unit may be unloaded by now). */
function journalExit(unit: string): string | null {
  const line = sh("journalctl", ["-u", `${unit}.service`, "--no-pager", "-o", "cat"]).stdout.split("\n").findLast((l) => l.includes("Main process exited"));
  return line ? (/status=(\d+)/.exec(line)?.[1] ?? null) : null;
}

/** The latest incarnation's stderr line `running` (openDurableRun's step timings) from the unit's journal. */
function openSteps(unit: string): Record<string, number> | null {
  const line = sh("journalctl", ["-u", `${unit}.service`, "--no-pager", "-o", "cat"]).stdout.split("\n").findLast((l) => l.includes('"event":"running"'));
  return line ? (JSON.parse(line).steps as Record<string, number>) : null;
}

/** The driver the tests use to stop instances: same options the supervise processes used. */
const driverFor = (hostName: string, mountRoot: string) => localHost({ hostName, mountRoot, stopTimeoutMs: 5_000 });

/** Stop an instance through its driver and close its ledger rows; the mount table decides whether its mount is gone. */
async function stopInstance(h: HostHandle, how = "driver stop"): Promise<void> {
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
  tokenDirExisted = sh("sudo", ["-n", "test", "-d", "/run/pi-durable-archil"]).status === 0;
  if (!tokenDirExisted) ledger.file("/run/pi-durable-archil", "the token directory localHost creates on demand (root 0700, tmpfs); removed in after if empty");
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
  cleanup.tokenFilesWithContent = sh("sudo", ["-n", "find", "/run/pi-durable-archil", "-name", "pda-p5-*", "-size", "+0"]).stdout.trim();
  sh("sudo", ["-n", "find", "/run/pi-durable-archil", "-name", "pda-p5-*", "-delete"]);
  if (!tokenDirExisted) {
    sh("sudo", ["-n", "rmdir", "/run/pi-durable-archil"]);
    if (sh("sudo", ["-n", "test", "-e", "/run/pi-durable-archil"]).status !== 0) ledger.fileRemoved("/run/pi-durable-archil");
  }
  cleanup.delegationsAfter = (await Promise.all(runIds.map((id) => findDelegations(disk, id)))).flat().length;
  results.cleanup = cleanup;
  writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
});

// ---- supervise --check ------------------------------------------------------------------------------------------------

test("supervise --check passes on this host: a second exclusive mount is refused, a revoked mount's fsync fails", { skip: !LIVE }, async () => {
  const r = superviseOnce(null, ["--check", "--mount-root", `${BASE}/check`, "--check-id-prefix", `p5-${STAMP}-check-`]);
  const report = r.lines.find((l) => l.event === "check") as { ok: boolean; steps: { step: string; ok: boolean; ms: number; detail?: string }[]; cleanup: string[]; run: string };
  results.check = report;
  assert.equal(r.code, 0, `${r.stderr}\n${JSON.stringify(report, null, 1)}`);
  assert.equal(report.ok, true);
  assert.deepEqual(report.steps.map((s) => s.step), [
    "create probe directory",
    "first exclusive mount",
    "second exclusive mount is refused",
    "revoke the first mount",
    "revoked mount's fsync fails",
    "revoked mount's barrier fences",
    "a new mount takes over",
  ]);
  assert.equal(report.steps[4].detail, "EIO");
  const warnings = (report as unknown as { warnings: string[] }).warnings;
  assert.ok(warnings.some((w) => /not root/.test(w)), `this worktree's wrapper is not root-owned, and the check says so: ${warnings}`);
  results.checkWarnings = warnings;
  assert.ok(report.cleanup.every((c) => !c.includes("failed")), report.cleanup.join("\n"));
  assert.deepEqual(archilMounts(), []);
});

// ---- end to end with the real instance (openDurableRun) --------------------------------------------------------------

test("end to end, restart in place: the real instance is SIGKILLed, the unit restarts it on the same claim, its old command dies, the run resumes", { skip: !LIVE }, async () => {
  const id = await newRun("inplace");
  const r = superviseOnce(id, ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", "pda-p5-ip-", "--stop-timeout", "5s", ...instance()]);
  const started = r.lines.find((l) => l.action === "started");
  assert.ok(started, `${r.stderr}\n${JSON.stringify(r.lines)}`);
  const h = started.handle as HostHandle;
  const unit = String(h.unit);
  const long1 = await waitFor("generation 1's long command", () => eventOf(id, "long-command", 1), 60_000);
  assert.equal(eventOf(id, "opened", 1)!.work, true, "the app module's context names the claim's work directory");
  await waitFor("generation 1 ticking", () => ticksOf(id, 1).length >= 3, 30_000);
  const cg = show(unit).ControlGroup;
  const daemon1 = daemonOf(unit);
  assert.equal(uidOf(long1.pid), 1000, "the instance does not run as root");
  assert.equal(uidOf(long1.commandPid!), 1000, "the agent's command does not run as root");
  assert.equal(readFileSync(`/proc/${long1.commandPid}/cgroup`, "utf8").trim(), `0::${cg}`, "the command is in the unit's cgroup");
  assert.notEqual(long1.sudoExit, 0, "the agent's command cannot use sudo (no_new_privs)");
  assert.equal(long1.instanceStdin, "/dev/null creds=none", "the instance read its token and closed stdin; there is no credential directory");
  assert.equal(daemon1.uid, 0);
  assert.notEqual(readFileSync(`/proc/${daemon1.pid}/cgroup`, "utf8").trim(), `0::${cg}`, "the FUSE daemon is outside the unit's cgroup");
  const held1 = await findDelegations(disk, id);

  // SIGKILL the instance: systemd restarts it in place on the same mount and claim.
  const main1 = Number(show(unit).MainPID);
  const tKill = Date.now();
  sh("sudo", ["-n", "kill", "-9", String(main1)]);
  const lastAck = Math.max(...ticksOf(id, 1).map((e) => e.n!));
  const opened2 = await waitFor("generation 2 open after the restart in place", () => eventOf(id, "opened", 2), 60_000, 50);
  const first2 = await waitFor("generation 2's first tick", () => ticksOf(id, 2)[0], 30_000, 50);
  assert.ok(opened2.resumedFrom! >= lastAck && opened2.resumedFrom! <= lastAck + 1, `every acknowledged tick is there: resumed from ${opened2.resumedFrom}, last acknowledged ${lastAck}`);
  assert.equal(opened2.duplicates, 0);
  assert.equal(first2.n, opened2.resumedFrom! + 1, "the run counts on");
  assert.equal(alive(long1.commandPid!), false, "the killed incarnation's long command was killed by the cgroup");
  assert.equal(daemonOf(unit).pid, daemon1.pid, "the FUSE daemon survived: the claim was reused");
  assert.deepEqual((await findDelegations(disk, id)).map((d) => d.clientId), held1.map((d) => d.clientId), "same client, same delegation");
  assert.equal(Number(show(unit).NRestarts), 1);
  const rec2 = (await s3(id))!;
  assert.equal(rec2.generation, 2);
  assert.equal(rec2.holder?.unit, unit, "the driver's handle survives in run.json");
  const long2 = await waitFor("generation 2's long command", () => eventOf(id, "long-command", 2), 30_000);

  // Stop: SIGTERM drains (sleeping, wake now), the cgroup kills the command, nothing is left.
  const tStop = Date.now();
  await stopInstance(h);
  const stopMs = Date.now() - tStop;
  assert.equal(alive(long2.commandPid!), false, "stopping the unit killed the long command");
  assert.equal(show(unit).LoadState, "not-found");
  assert.deepEqual(archilMounts(), []);
  assert.deepEqual(await findDelegations(disk, id), [], "release checked the delegation in");
  // The daemon exits a moment after its unmount; its scope goes with it.
  const tScope = Date.now();
  await waitFor("the FUSE scope to go", () => fuseScope(unit) === null, 15_000, 100);
  const scopeGoneMs = Date.now() - tScope;
  const sealed = (await s3(id))!;
  assert.equal(sealed.status, "sleeping", "a drained run is due at once (--on-sigterm resume, the default)");
  assert.equal(typeof sealed.sealedSeq, "number");
  results.restartInPlace = {
    killToFirstCommitMs: first2.t - tKill,
    killToOpenedMs: opened2.t - tKill,
    resumedFrom: opened2.resumedFrom,
    lastAcknowledgedBeforeKill: lastAck,
    openSteps: openSteps(unit),
    stopMs,
    scopeGoneAfterStopMs: scopeGoneMs,
    sudoExitFromCommand: long1.sudoExit,
    sealedSeq: sealed.sealedSeq,
  };
});

/**
 * T6 with the real instance: host A's FUSE daemon is frozen (SIGSTOP); host B's supervisor, a separate process, sees the
 * lease expire (6 s), cannot reach host A, revokes and starts a real instance on host B, which resumes the run; then host
 * A's daemon is thawed. `lease` is the instance's own lease (its self-fence fires at expiryMs - marginMs).
 */
async function hungHost(tag: string, lease: { expiryMs: number; marginMs: number }) {
  const id = await newRun(tag);
  const common = ["--lease-expiry", "6s", "--stop-timeout", "5s", ...instance(lease)];
  const a = superviseOnce(id, ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", "pda-p5-a-", ...common]);
  const startedA = a.lines.find((l) => l.action === "started");
  assert.ok(startedA, `${a.stderr}\n${JSON.stringify(a.lines)}`);
  const hA = startedA.handle as HostHandle;
  const unitA = String(hA.unit);
  const longA = await waitFor("host A's long command", () => eventOf(id, "long-command", 1), 60_000);
  await waitFor("host A ticking", () => ticksOf(id, 1).length >= 3, 30_000);
  const clientA = (await findDelegations(disk, id))[0].clientId;
  const daemon = daemonOf(unitA);
  const restartsA = Number(show(unitA).NRestarts);
  sh("sudo", ["-n", "kill", "-STOP", String(daemon.pid)]);
  stopped.add(daemon.pid);
  const tStop = Date.now();
  await sleep(300);
  const lastAckA = Math.max(...ticksOf(id, 1).map((e) => e.n!));

  // Host B's supervisor: a separate process that never touches host A's mount.
  const loop = superviseLoop(id, ["--mount-root", B, "--host-name", "host-b", "--unit-prefix", "pda-p5-b-", ...common]);
  const startedB = await waitFor("host B's supervisor to take over", () => loop.lines.find((l) => l.action === "started"), 60_000);
  assert.equal(startedB.reason, "lease-expired", JSON.stringify(startedB));
  assert.deepEqual(startedB.stonith, { outcome: "unreachable", status: "unknown" }, "host B cannot reach host A's systemd");
  assert.deepEqual((startedB.revoked as { clientId: string }[]).map((d) => d.clientId), [clientA]);
  const hB = startedB.handle as HostHandle;
  const openedB = await waitFor("host B's instance open", () => events(id).find((e) => e.ev === "opened" && e.generation > 1), 60_000, 50);
  const firstB = await waitFor("host B's first commit", () => ticksOf(id, openedB.generation)[0], 60_000, 50);
  assert.equal(openedB.unit, String(hB.unit), "the instance that resumed is the one the takeover started (no churn)");
  assert.ok(openedB.resumedFrom! >= lastAckA && openedB.resumedFrom! <= lastAckA + 1, `every acknowledged commit of host A is there: resumed from ${openedB.resumedFrom}, last acknowledged ${lastAckA}`);
  assert.equal(openedB.duplicates, 0);
  assert.equal(firstB.n, openedB.resumedFrom! + 1, "the run counts on");
  await waitFor("host B ticking", () => ticksOf(id, openedB.generation).length >= 3, 30_000);
  const heldB = await findDelegations(disk, id);
  assert.equal(heldB.length, 1);
  assert.notEqual(heldB[0].clientId, clientA);
  await loop.stop();
  const healthyTicks = loop.lines.filter((l) => l.action === "healthy").length;

  // Thaw host A's daemon: the frozen instance exits 75 (if it has not already), is not restarted, its command is dead.
  const atThaw = show(unitA).ActiveState;
  const commandAliveAtThaw = alive(longA.commandPid!);
  // Where the frozen instance's main thread waits: a FUSE request means its event loop (and every timer) is stuck.
  const mainA = show(unitA).MainPID;
  const mainThreadWchan = mainA && mainA !== "0" ? sh("sudo", ["-n", "cat", `/proc/${mainA}/wchan`]).stdout.trim() : null;
  const mainThreadState = mainA && mainA !== "0" ? (/^State:\s+(.*)$/m.exec(sh("cat", [`/proc/${mainA}/status`]).stdout)?.[1] ?? null) : null;
  const tCont = Date.now();
  sh("sudo", ["-n", "kill", "-CONT", String(daemon.pid)]);
  stopped.delete(daemon.pid);
  const exited = await waitFor("the frozen instance to exit", () => {
    const s = show(unitA);
    return s.ActiveState !== "active" && s.ActiveState !== "activating" && s.ActiveState !== "deactivating" ? s : null;
  }, 60_000, 50);
  const tExit = Date.now();
  assert.equal(exited.ExecMainStatus, "75", JSON.stringify(exited));
  assert.equal(exited.Result, "exit-code");
  assert.equal(Number(exited.NRestarts), restartsA, "exit 75 is terminal: no restart");
  assert.equal(alive(longA.commandPid!), false, "the frozen instance's long command is dead");
  await sleep(2_000);
  const after = (await s3(id))!;
  assert.equal(after.generation, openedB.generation, "the zombie's writes never reached the server");
  assert.equal(after.holder?.host, "host-b");
  assert.ok(Math.max(...ticksOf(id, 1).map((e) => e.n!)) <= lastAckA + 1, "the thawed instance acknowledged no new commit");
  const journal = sh("journalctl", ["-u", `${unitA}.service`, "--no-pager", "-o", "cat", "--since", new Date(tStop - 60_000).toISOString().replace("T", " ").slice(0, 19)]).stdout;
  const metrics = {
    supervisorLeaseExpiryMs: 6_000,
    supervisorTickMs: 3_000,
    heartbeatMs: 1_000,
    startsOnB: loop.lines.filter((l) => l.action === "started").length,
    instanceSelfFenceMs: lease.expiryMs - lease.marginMs,
    sigstopToSupervisorStartMs: startedB.seenAt - tStop,
    sigstopToFirstCommitMs: firstB.t - tStop,
    supervisorStartToFirstCommitMs: firstB.t - startedB.seenAt,
    openStepsB: openSteps(String(hB.unit)),
    startMs: startedB.startMs,
    healthyTicksBeforeTakeover: healthyTicks,
    lastAcknowledgedOnA: lastAckA,
    resumedFromOnB: openedB.resumedFrom,
    instanceStateAtThaw: atThaw,
    commandAliveAtThaw,
    mainThreadWchan,
    mainThreadState,
    sigcontToExit75Ms: tExit - tCont,
    fenceLog: journal.split("\n").find((l) => l.includes("fenced")) ?? null,
  };
  await stopInstance(hB);
  await stopInstance(hA, "driver stop (unit had exited 75; its revoked mount checked in)");
  assert.deepEqual(archilMounts(), []);
  return metrics;
}

test("T6 end to end: a real instance's FUSE daemon frozen; another process revokes and starts a real instance on host B; the run resumes; the frozen one exits 75 when thawed, its command dead", { skip: !LIVE }, async () => {
  const m = await hungHost("t6", { expiryMs: 600_000, marginMs: 0 });
  assert.equal(m.instanceStateAtThaw, "active", "the frozen instance was still running at the thaw");
  results.t6 = m;
});

test("T6 end to end with the instance's self-fence under the lease (4.5 s): the lease watchdog kills the frozen instance's command before the thaw", { skip: !LIVE }, async () => {
  // A store commit in flight when the daemon freezes holds the main thread in a FUSE request; the lease watchdog runs on
  // its own thread and, in a unit (ownCgroup), kills the command at the deadline while the main thread is still stuck.
  const m = await hungHost("t6sf", { expiryMs: 6_000, marginMs: 1_500 });
  results.t6SelfFence = m;
  assert.equal(m.commandAliveAtThaw, false, "the watchdog killed the long command while the instance was frozen");
});

// ---- a power off leaves a dead mount; the driver's stop removes it ------------------------------------------------------

test("power off: the instance and its FUSE daemon SIGKILLed together leave a dead mount; the driver's stop removes it", { skip: !LIVE }, async () => {
  const id = await newRun("poweroff");
  const r = superviseOnce(id, ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", "pda-p5-po-", "--no-restart", ...instance()]);
  const started = r.lines.find((l) => l.action === "started");
  assert.ok(started, `${r.stderr}\n${JSON.stringify(r.lines)}`);
  const h = started.handle as HostHandle;
  const unit = String(h.unit);
  const mp = String(h.mountpoint);
  await waitFor("the instance committing", () => ticksOf(id, 1).length >= 3, 60_000);
  // Power off: every process of the unit's cgroup and of its FUSE scope in one kill.
  const procsOf = (cgroup: string) => readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8").trim().split("\n").filter(Boolean);
  const scope = fuseScope(unit)!;
  const pids = [...procsOf(show(unit).ControlGroup), ...procsOf(sh("systemctl", ["show", scope, "--property=ControlGroup", "--value"]).stdout.trim())];
  sh("sudo", ["-n", "kill", "-9", ...pids]);
  await waitFor("the unit and its scope gone", () => show(unit).ActiveState !== "active" && fuseScope(unit) === null, 30_000, 100);
  const stat = sh("stat", ["-c", "%i", mp]);
  assert.ok(archilMounts().includes(mp), "the power off left the mount in the table");
  assert.match(stat.stderr, /Transport endpoint is not connected/, "and its daemon is gone");
  const t0 = Date.now();
  await stopInstance(h);
  assert.ok(!archilMounts().includes(mp), "the driver's stop removed the dead mount");
  results.powerOff = { killed: pids.length, deadMountBeforeStop: true, stopMs: Date.now() - t0 };
});

test("deleting a powered-off run: its orphaned delegation is revoked first, the prefix ends empty, and the same id reopens fresh", { skip: !LIVE }, async () => {
  const id = await newRun("deltree");
  const flags = ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", "pda-p5-dt-", "--no-restart", ...instance()];
  const r = superviseOnce(id, flags);
  const started = r.lines.find((l) => l.action === "started");
  assert.ok(started, `${r.stderr}\n${JSON.stringify(r.lines)}`);
  const h = started.handle as HostHandle;
  const unit = String(h.unit);
  await waitFor("the instance committing", () => ticksOf(id, 1).length >= 3, 60_000);
  const procsOf = (cgroup: string) => readFileSync(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8").trim().split("\n").filter(Boolean);
  const scope = fuseScope(unit)!;
  sh("sudo", ["-n", "kill", "-9", ...procsOf(show(unit).ControlGroup), ...procsOf(sh("systemctl", ["show", scope, "--property=ControlGroup", "--value"]).stdout.trim())]);
  await waitFor("the unit and its scope gone", () => show(unit).ActiveState !== "active" && fuseScope(unit) === null, 30_000, 100);
  const held = await findDelegations(disk, id);
  assert.equal(held.length, 1, "the powered-off client still holds the run");
  // What P7 measured, as evidence: a delete with the delegation in place leaves the objects.
  const before = (await disk.listObjects(`runs/${id}/`, { recursive: true })).objects.map((o) => o.key);
  await disk.deleteObjects(before.filter((k) => !k.endsWith("/")), { quiet: true });
  const leftWithoutRevoke = (await disk.listObjects(`runs/${id}/`, { recursive: true })).objects.length;
  const del = await deleteRunTree(disk, id);
  assert.equal(del.revoked, 1);
  assert.equal((await disk.listObjects(`runs/${id}/`, { recursive: true })).objects.length, 0, "the prefix is empty");
  assert.deepEqual(await findDelegations(disk, id), []);
  ledger.subdirDeleted(`runs/${id}/`, del.objects);
  await stopInstance(h);
  // The same id again: a fresh directory, a fresh store, generation 1, nothing to resume.
  await createRunDir(disk, id, { uid: 1000, gid: 1000 });
  ledger.subdir(`runs/${id}/`, "live deltree, reopened with the same id");
  const tReopen = Date.now();
  const again = superviseOnce(id, flags).lines.find((l) => l.action === "started");
  assert.ok(again);
  const opened = await waitFor("the reopened instance", () => events(id).find((e) => e.ev === "opened" && e.t > tReopen), 60_000);
  assert.deepEqual([opened.generation, opened.resumedFrom, opened.ticks], [1, 0, 0], "a fresh run: generation 1, an empty store");
  await stopInstance(again.handle as HostHandle);
  results.deleteTree = { objectsBefore: before.length, leftWithoutRevoke, deleted: del, reopened: { generation: opened.generation, resumedFrom: opened.resumedFrom } };
});

// ---- the start grace: a short tick never fences the instance it just started -----------------------------------------

/**
 * An archil wrapper for a slow host: the package's wrapper (the token passes through on stdin), then a pause once a
 * mount succeeded, so the instance holds its delegation that long before its first run.json write.
 */
function slowArchil(delayS: number): string {
  const path = join(OUT, `archil-slow-${delayS}s`);
  writeFileSync(path, `#!/bin/sh\n"${ARCHIL_SCOPED}" "$@"\nrc=$?\nif [ "$rc" = 0 ] && [ "\${1:-}" = mount ]; then sleep ${delayS}; fi\nexit $rc\n`, { mode: 0o755 });
  return path;
}

const SLOW = { lease: "10s", leaseMs: 10_000, tick: "2s", delayS: 5 };

/** Host A runs the run until its FUSE daemon is frozen (SIGSTOP): its lease then expires with its delegation held. */
async function frozenHostA(id: string, prefix: string) {
  const r = superviseOnce(id, ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", `${prefix}a-`, "--lease-expiry", SLOW.lease, ...instance()]);
  const started = r.lines.find((l) => l.action === "started");
  assert.ok(started, `${r.stderr}\n${JSON.stringify(r.lines)}`);
  const h = started.handle as HostHandle;
  await waitFor("host A ticking", () => ticksOf(id, 1).length >= 3, 60_000);
  const client = (await findDelegations(disk, id))[0].clientId;
  const daemon = daemonOf(String(h.unit));
  sh("sudo", ["-n", "kill", "-STOP", String(daemon.pid)]);
  stopped.add(daemon.pid);
  return { h, client, daemon, tStop: Date.now() };
}

/** Thaw host A's daemon, let its instance exit (fenced: its claim was revoked), and stop it through the driver. */
async function thawHostA(a: Awaited<ReturnType<typeof frozenHostA>>): Promise<string> {
  sh("sudo", ["-n", "kill", "-CONT", String(a.daemon.pid)]);
  stopped.delete(a.daemon.pid);
  const unit = String(a.h.unit);
  const exited = await waitFor("host A's instance to exit", () => (["active", "activating", "deactivating"].includes(show(unit).ActiveState) ? null : show(unit)), 60_000, 100);
  await stopInstance(a.h, "driver stop (exited after the thaw)");
  return exited.ExecMainStatus;
}

test("start grace at a 2 s tick: host A frozen, host B's start slowed 5 s before its first run.json write; 5 of 5 take over with one start and no self-revoke", { skip: !LIVE }, async () => {
  const slow = slowArchil(SLOW.delayS);
  const rounds: Record<string, unknown>[] = [];
  for (let round = 1; round <= 5; round++) {
    const id = await newRun(`grace${round}`);
    const a = await frozenHostA(id, `pda-p5-sg${round}-`);
    const loop = superviseLoop(id, ["--mount-root", B, "--host-name", "host-b", "--unit-prefix", `pda-p5-sg${round}-b-`, "--lease-expiry", SLOW.lease, "--archil", slow, ...instance()], SLOW.tick);
    const startedB = await waitFor("host B's takeover", () => loop.lines.find((l) => l.action === "started"), 60_000);
    assert.equal(startedB.reason, "lease-expired", JSON.stringify(startedB));
    assert.deepEqual((startedB.revoked as { clientId: string }[]).map((d) => d.clientId), [a.client]);
    assert.equal(startedB.startMark, true, "the start mark was written right after the revoke");
    const hB = startedB.handle as HostHandle;
    // Another supervisor process, on another host, inside the grace: it reads the mark and leaves the run alone.
    const other = round === 1 ? superviseOnce(id, ["--mount-root", C, "--host-name", "host-c", "--unit-prefix", "pda-p5-sg1-c-", "--lease-expiry", SLOW.lease, ...instance()]).lines : [];
    if (round === 1) assert.deepEqual(other.map((l) => [l.action, l.generation]), [["starting", 2]], JSON.stringify(other));
    const openedB = await waitFor("host B's instance open", () => events(id).find((e) => e.ev === "opened" && e.generation === 2), 60_000, 50);
    await waitFor("host B ticking", () => ticksOf(id, 2).length >= 3, 30_000);
    await waitFor("a healthy tick on host B", () => loop.lines.some((l) => l.action === "healthy" && l.seenAt > openedB.t), 30_000);
    await loop.stop();
    const starts = loop.lines.filter((l) => l.action === "started");
    // The race: a tick that saw B's delegation before B's first run.json write, with host A's heartbeat expired.
    const raced = loop.lines.filter((l) => l.action === "starting" && Number(l.delegations) > 0 && l.seenAt < openedB.t);
    const heldB = await findDelegations(disk, id);
    assert.equal(starts.length, 1, `one start on host B, nothing revoked after it: ${loop.lines.map((l) => l.action).join(",")}`);
    assert.ok(raced.length >= 1, `a tick landed between B's mount and its first run.json write: ${loop.lines.map((l) => `${l.action}/${l.delegations ?? "-"}`).join(",")}`);
    assert.equal(openedB.unit, String(hB.unit), "the instance that resumed is the one the takeover started");
    assert.equal(heldB.length, 1);
    assert.notEqual(heldB[0].clientId, a.client);
    const exitA = await thawHostA(a);
    assert.equal(exitA, "75", "host A, revoked, is fenced at its next write");
    await stopInstance(hB);
    rounds.push({
      round,
      actions: loop.lines.map((l) => (l.action === "starting" ? `starting(${l.delegations}, ${l.sinceMs} ms)` : String(l.action))),
      inGraceTicks: loop.lines.filter((l) => l.action === "starting").length,
      ticksBetweenMountAndFirstWrite: raced.length,
      takeoverToOpenedMs: openedB.t - startedB.seenAt,
      exitA,
      ...(round === 1 ? { otherProcess: other.map(({ action, sinceMs, delegations, by }) => ({ action, sinceMs, delegations, by })) } : {}),
    });
  }
  assert.deepEqual(archilMounts(), []);
  results.startGrace = { leaseExpiryMs: SLOW.leaseMs, tickMs: 2_000, mountDelayMs: SLOW.delayS * 1000, rounds };
});

test("start grace off (--start-grace 0), the same slow start: a pass between B's mount and its first run.json write revokes B; B never opens", { skip: !LIVE }, async () => {
  const slow = slowArchil(SLOW.delayS);
  const id = await newRun("grace0");
  const a = await frozenHostA(id, "pda-p5-sg0-");
  const flags = (root: string, host: string, archil: string[]) => ["--mount-root", root, "--host-name", host, "--unit-prefix", `pda-p5-sg0-${host.slice(-1)}-`, "--lease-expiry", SLOW.lease, "--start-grace", "0", "--no-restart", ...archil, ...instance()];
  const startedB = await waitFor("host B's takeover", () => superviseOnce(id, flags(B, "host-b", ["--archil", slow])).lines.find((l) => l.action === "started"), 60_000, 1_000);
  assert.equal(startedB.reason, "lease-expired");
  const hB = startedB.handle as HostHandle;
  const clientB = await waitFor("host B's delegation", async () => (await findDelegations(disk, id)).find((d) => d.clientId !== a.client && !d.isPending)?.clientId, 30_000, 100);
  assert.equal((await s3(id))!.generation, 1, "B has not written run.json yet");
  // A second pass (on host C, so the run's next mount is at a path B never used) while B sleeps after its mount.
  const second = superviseOnce(id, flags(C, "host-c", [])).lines.find((l) => l.action === "started");
  assert.ok(second, "the pass started another instance");
  assert.equal(second.reason, "lease-expired");
  assert.deepEqual((second.revoked as { clientId: string }[]).map((d) => d.clientId), [clientB], "it revoked the instance the previous pass started");
  const hC = second.handle as HostHandle;
  const openedC = await waitFor("host C's instance open", () => events(id).find((e) => e.ev === "opened" && e.generation === 2), 60_000, 50);
  const unitB = String(hB.unit);
  const exitedB = await waitFor("host B's instance to exit", () => (["active", "activating", "deactivating"].includes(show(unitB).ActiveState) ? null : show(unitB)), 60_000, 100);
  assert.equal(openedC.unit, String(hC.unit));
  assert.ok(!events(id).some((e) => e.ev === "opened" && e.unit === unitB), "B never opened the run");
  await stopInstance(hB, "driver stop (revoked during its start)");
  const exitA = await thawHostA(a);
  await stopInstance(hC);
  assert.deepEqual(archilMounts(), []);
  results.startGraceOff = { exitB: exitedB.ExecMainStatus, resultB: exitedB.Result, exitA, cOpenedGeneration: openedC.generation };
});

// ---- the backoff: a run whose starts keep failing is started a handful of times ----------------------------------------

/**
 * An archil wrapper whose `mount` is refused the way Archil refuses a run another client holds ("has an outstanding
 * delegation"; its stdin, the token, is read and dropped), so every instance exits 76 before it mounts. Any other verb is
 * the package's wrapper.
 */
function refusingArchil(): string {
  const path = join(OUT, "archil-refuses-mount");
  writeFileSync(path, `#!/bin/sh\nif [ "\${1:-}" = mount ]; then cat >/dev/null; echo "mount refused (test): runs/... has an outstanding delegation held by another client" >&2; exit 1; fi\nexec "${ARCHIL_SCOPED}" "$@"\n`, { mode: 0o755 });
  return path;
}

test("backoff: every start exits 76; over 5 minutes a 3 s tick with a 6 s grace starts 6 instances, each grace doubled, each failure recorded", { skip: !LIVE }, async () => {
  const id = await newRun("backoff");
  const t0 = Date.now();
  const loop = superviseLoop(id, ["--mount-root", B, "--host-name", "host-b", "--unit-prefix", "pda-p5-bo-", "--lease-expiry", "6s", "--archil", refusingArchil(), ...instance()], "3s");
  await sleep(300_000);
  await loop.stop();
  const starts = loop.lines.filter((l) => l.action === "started");
  const steps = loop.lines.filter((l) => l.event === "start-backoff");
  const waits = loop.lines.filter((l) => l.action === "starting");
  const units = starts.map((l) => String((l.handle as HostHandle).unit));
  const exits = units.map((u) => journalExit(u));
  for (const l of starts) await stopInstance(l.handle as HostHandle, "driver stop (exited 76)");
  assert.deepEqual(archilMounts(), []);
  // Grace 6 s doubled per failure: starts at about 0, 6, 18, 42, 90 and 186 s; the seventh would be at 378 s.
  assert.equal(starts.length, 6, loop.lines.map((l) => l.action ?? l.event).join(","));
  assert.deepEqual(starts.map((l) => l.failures), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(starts.map((l) => l.graceMs), [6_000, 12_000, 24_000, 48_000, 96_000, 192_000]);
  assert.deepEqual(starts.map((l) => l.lastExit), [null, "no-delegation", "no-delegation", "no-delegation", "no-delegation", "no-delegation"], "a refused mount leaves no delegation");
  assert.deepEqual(steps.map((l) => [l.failures, l.lastExit, l.graceMs]), starts.slice(1).map((l) => [l.failures, "no-delegation", l.graceMs]), "one start-backoff line per step");
  assert.deepEqual(exits, ["76", "76", "76", "76", "76", "76"]);
  assert.ok(waits.length >= 80, `the loop kept ticking: ${waits.length} ticks waited out a grace`);
  const s3Mark = JSON.parse(new TextDecoder().decode(await disk.getObject(`runs/${id}/start.json`))) as Record<string, unknown>;
  assert.deepEqual([s3Mark.generation, s3Mark.failures, s3Mark.lastExit], [1, 5, "no-delegation"]);
  results.backoff = {
    windowMs: 300_000,
    tickMs: 3_000,
    baseGraceMs: 6_000,
    startsAtMs: starts.map((l) => l.seenAt - t0),
    failures: starts.map((l) => l.failures),
    graceMs: starts.map((l) => l.graceMs),
    lastExit: starts.map((l) => l.lastExit),
    unitExits: exits,
    ticksInGrace: waits.length,
    backoffLines: steps.length,
  };
});

// ---- reusable mount tokens past the client's 5 min refresh ----------------------------------------------------------------

test("tokens past the 5 min refresh: a 24 h token's instance commits for 6 min, finishes, and its token user is swept; a 2 min token's instance is fenced at the refresh and restarted with a fresh token", { skip: !LIVE }, async () => {
  const long = await newRun("tok24h");
  const short = await newRun("tok2m");
  // The long run: the default token (24 h, reusable); the instance finishes by itself after 6.5 min.
  const lr = superviseOnce(long, ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", "pda-p5-tl-", "--token-ttl", "24h", ...instance(), "--env", "PDA_TEST_RUN_MS=390000"]);
  const lStarted = lr.lines.find((l) => l.action === "started")!;
  assert.ok(lStarted, `${lr.stderr}\n${JSON.stringify(lr.lines)}`);
  const lHandle = lStarted.handle as HostHandle;
  const lToken = lStarted.token as { identifier: string; nickname: string };
  // The short run: a 2 min token under a supervise loop; the client's refresh at 5:00 finds it expired.
  const loop = superviseLoop(short, ["--mount-root", B, "--host-name", "host-b", "--unit-prefix", "pda-p5-ts-", "--token-ttl", "2m", "--lease-expiry", "6s", "--stop-timeout", "5s", ...instance()]);
  const lOpened = await waitFor("the long run's instance open", () => eventOf(long, "opened", 1), 60_000);
  const sOpened = await waitFor("the short run's instance open", () => eventOf(short, "opened", 1), 60_000);
  const sUnit1 = String((loop.lines.find((l) => l.action === "started")!.handle as HostHandle).unit);

  // The short run's first instance is fenced at its refresh (about 5:00 after its mount) and the loop restarts the run.
  const sOpened2 = await waitFor("the short run's second instance (after the 5 min refresh fenced the first)", () => events(short).find((e) => e.ev === "opened" && e.generation > 1), 420_000, 1_000);
  const s1Exit = journalExit(sUnit1);
  const sLastTick1 = Math.max(...ticksOf(short, 1).map((e) => e.n!));
  const sFirst2 = await waitFor("the short run's second instance committing", () => ticksOf(short, sOpened2.generation)[0], 60_000);
  await loop.stop();
  assert.equal(s1Exit, "75", "the expired token fenced the first instance at the refresh (exit 75)");
  assert.ok(sOpened2.resumedFrom! >= sLastTick1, "the second instance resumed from every acknowledged tick");
  const sFenceAfterMs = ticksOf(short, 1).at(-1)!.t - sOpened.t;

  // The long run committed past the refresh, finished, released, and exited 0.
  await waitFor("the long run's instance to finish", () => eventOf(long, "done", 1), 480_000, 1_000);
  await waitFor("the long run's unit to exit", () => show(String(lHandle.unit)).ActiveState !== "active", 60_000);
  const lTicks = ticksOf(long, 1);
  const lSpanMs = lTicks.at(-1)!.t - lOpened.t;
  assert.ok(lSpanMs > 330_000, `the long run kept committing past the 5 min refresh (${lSpanMs} ms)`);
  assert.equal(journalExit(String(lHandle.unit)) ?? "0", "0", "finished, not fenced");
  assert.equal((await s3(long))!.status, "done");
  assert.deepEqual(await findDelegations(disk, long), []);

  // The next supervise pass removes the finished run's token user (released, older than the grace).
  const pass = superviseOnce(long, ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", "pda-p5-tl-", "--token-grace", "1m"]);
  const sweep = pass.lines.find((l) => l.event === "token-sweep") as { removed: { identifier: string; run: string; why: string }[] } | undefined;
  assert.deepEqual(sweep?.removed, [{ identifier: lToken.identifier, run: long, why: "released" }], JSON.stringify(pass.lines));
  assert.equal(pass.lines.find((l) => l.run === long)!.action, "terminal");
  tokens.delete(lToken.identifier);
  ledger.tokenRemoved(lToken.identifier, "the supervise pass's token sweep (released run)");
  results.tokens = {
    longRunCommitSpanMs: lSpanMs,
    longRunTicks: lTicks.length,
    shortTokenFirstInstanceLastTickAfterOpenMs: sFenceAfterMs,
    shortTokenRestartGeneration: sOpened2.generation,
    shortTokenSecondInstanceFirstCommitAfterLastTickMs: sFirst2.t - ticksOf(short, 1).at(-1)!.t,
    sweep: sweep?.removed,
  };
  await stopInstance(lHandle);
  for (const l of loop.lines.filter((x) => x.action === "started")) await stopInstance(l.handle as HostHandle);
  assert.deepEqual(archilMounts(), []);
});

// ---- the token janitor -------------------------------------------------------------------------------------------

/** Processes whose argument vector is an archil mount of the run at exactly `mp`: `/usr/bin/archil mount <disk>:/runs/<id> <mp> ...`. */
function archilMountsOf(id: string, mp: string): number[] {
  const pids: number[] = [];
  for (const d of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
    let argv: string[];
    try {
      argv = readFileSync(`/proc/${d}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    if (argv[0] === "/usr/bin/archil" && argv[1] === "mount" && argv.includes(`${scratchDiskId()}:/runs/${id}`) && argv.includes(mp)) pids.push(Number(d));
  }
  return pids;
}

test("a 2 min token's client past its 5 min refresh: the driver's stop leaves no archil process for the mountpoint (its FUSE scope goes whatever the mount table says), and a new mount at the path succeeds", { skip: !LIVE }, async () => {
  const id = await newRun("failedclient");
  const flags = (ttl: string) => ["--mount-root", B, "--host-name", "host-b", "--unit-prefix", "pda-p5-fc-", "--no-restart", "--lease-expiry", "6s", "--token-ttl", ttl, ...instance()];
  const r = superviseOnce(id, flags("2m"));
  const started = r.lines.find((l) => l.action === "started");
  assert.ok(started, `${r.stderr}\n${JSON.stringify(r.lines)}`);
  const h = started.handle as HostHandle;
  const unit = String(h.unit);
  const mp = String(h.mountpoint);
  await waitFor("the instance committing", () => ticksOf(id, 1).length >= 3, 60_000);
  const daemon = daemonOf(unit);
  assert.deepEqual(archilMountsOf(id, mp), [daemon.pid]);
  // At its 5 min refresh the client finds its token expired: the filesystem FAILED, the instance fenced (75).
  const exited = await waitFor("the instance fenced at the refresh", () => (["active", "activating", "deactivating"].includes(show(unit).ActiveState) ? null : show(unit)), 420_000, 1_000);
  const exit = journalExit(unit);
  assert.equal(exit, "75");
  // A supervisor stops it at its next tick (in the traced failure, 6 s after the exit).
  await sleep(6_000);
  const atStop = { mounted: archilMounts().includes(mp), scopeActive: fuseScope(unit) !== null, daemonAlive: alive(daemon.pid), archilProcs: archilMountsOf(id, mp).length };
  const t0 = Date.now();
  await stopInstance(h, "driver stop after the refresh fence");
  const stopMs = Date.now() - t0;
  assert.deepEqual(archilMountsOf(id, mp), [], "no archil process for the mountpoint");
  assert.equal(fuseScope(unit), null, "the FUSE scope is inactive");
  assert.ok(!archilMounts().includes(mp));
  // The next instance mounts at the same path.
  const again = superviseOnce(id, flags("2h")).lines.find((l) => l.action === "started");
  assert.ok(again, "a second start");
  assert.equal(String((again.handle as HostHandle).mountpoint), mp);
  const opened = await waitFor("the next instance open at the same path", () => eventOf(id, "opened", 2), 60_000);
  await stopInstance(again.handle as HostHandle);
  assert.deepEqual(archilMountsOf(id, mp), []);
  results.failedClient = { exit, result: exited.Result, atStop, stopMs, reopenedGeneration: opened.generation, reopenedResumedFrom: opened.resumedFrom };
});

test("supervise --sweep-tokens removes this supervisor's expired token users and keeps the live ones", { skip: !LIVE }, async () => {
  const prefix = `pda-p5-jan-${STAMP}-`;
  const mint = async (tag: string, ttl: string) => {
    const t = await mintMountToken(disk, { nickname: `${prefix}${tag}`, ttl });
    tokens.add(t.identifier);
    ledger.token(t.identifier, `${prefix}${tag}`, `live janitor (${tag}, oneUse, ttl ${ttl})`);
    return t.identifier;
  };
  const expiring = await mint("expired", "2s");
  const live = await mint("live", "1h");
  const listed = async () => ((await getDisk(disk.id)).authorizedUsers ?? []).filter((u) => u.nickname?.startsWith(prefix));
  const t0 = Date.now();
  await waitFor("the user list to show the expired token", async () => (await listed()).some((u) => u.identifier === expiring && (u.status === "expired" || Date.parse(u.expiresAt ?? "") <= Date.now())), 240_000, 2_000);
  const listLagMs = Date.now() - t0;
  // The user list is an eventually consistent snapshot: one call can still miss a user another call showed, so a pass may
  // find nothing to remove. Passes are idempotent and the supervisor repeats them every tick; so does this test.
  type Sweep = { removed: { identifier: string; why: string }[]; failed: unknown[] };
  const removed: Sweep["removed"] = [];
  let passes = 0;
  for (; passes < 20 && !removed.some((x) => x.identifier === expiring); passes++) {
    if (passes) await sleep(3_000);
    const r = superviseOnce(null, ["--sweep-tokens", "--token-prefix", prefix]);
    assert.equal(r.code, 0, r.stderr);
    removed.push(...((r.lines.find((l) => l.event === "token-sweep") as Sweep | undefined)?.removed ?? []));
  }
  assert.deepEqual(removed.map((x) => [x.identifier, x.why]), [[expiring, "expired"]], "the expired user went, the live one stayed");
  tokens.delete(expiring);
  ledger.tokenRemoved(expiring, "supervise --sweep-tokens");
  results.janitor = { listLagMs, passes };
});

// ---- a store behind its seal ------------------------------------------------------------------------------------------

test("a store behind its seal (65) or an unreadable store head (70): run.json failed with the code; the unit does not restart; the supervisor leaves it", { skip: !LIVE }, async () => {
  const cases = [
    { exit: 65, detail: { code: "STORE_BEHIND_SEAL", sealedSeq: 812, head: 811 } },
    { exit: 70, detail: { code: "STORE_HEAD_UNREADABLE" } },
  ];
  const seen: unknown[] = [];
  for (const c of cases) {
    const id = await newRun(`seal${c.exit}`);
    const flags = ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", `pda-p5-seal${c.exit}-`, "--env", `PDA_TEST_EXIT=${c.exit}`, `--run-arg=--app=${SEAL_APP}`, "--run-arg=--heartbeat-ms=5000"];
    const started = superviseOnce(id, flags).lines.find((l) => l.action === "started");
    assert.ok(started);
    const h = started.handle as HostHandle;
    const exited = await waitFor(`the instance to exit ${c.exit}`, () => {
      const s = show(String(h.unit));
      return s.ActiveState === "failed" || s.ActiveState === "inactive" ? s : null;
    }, 30_000);
    assert.equal(exited.ExecMainStatus, String(c.exit), JSON.stringify(exited));
    await sleep(2_000);
    assert.equal(Number(show(String(h.unit)).NRestarts), 0, `exit ${c.exit} is terminal: no restart`);
    const decision = superviseOnce(id, flags).lines.find((l) => l.run === id)!;
    assert.equal(decision.action, "terminal", JSON.stringify(decision));
    assert.equal(decision.status, "failed");
    assert.deepEqual(decision.detail, c.detail);
    assert.deepEqual(await findDelegations(disk, id), [], "the instance released its claim before exiting");
    seen.push({ exit: exited.ExecMainStatus, restarts: 0, decision: { action: decision.action, detail: decision.detail } });
    await stopInstance(h);
  }
  results.seal = seen;
  assert.deepEqual(archilMounts(), []);
});

test("an invalid run.json fails only that run's line in a `supervise --every` loop; the other run is started and kept healthy", { skip: !LIVE }, async () => {
  const bad = await newRun("badjson");
  const good = await newRun("goodjson");
  await disk.putObject(`runs/${bad}/run.json`, JSON.stringify({ run: bad, status: "zombie", generation: 1, heartbeatAt: null, holder: null }), { uid: 1000, gid: 1000, mode: 0o644 });
  const loop = superviseLoop(bad, ["--id", good, "--mount-root", A, "--host-name", "host-a", "--unit-prefix", "pda-p5-json-", ...instance()]);
  await waitFor("two ticks after the good run is healthy", () => loop.lines.filter((l) => l.run === good && l.action === "healthy").length >= 2, 60_000, 200);
  await loop.stop();
  const badLines = loop.lines.filter((l) => l.run === bad);
  const goodLines = loop.lines.filter((l) => l.run === good);
  assert.ok(badLines.length >= 3 && badLines.every((l) => l.action === "error" && l.error === "RUN_JSON_INVALID"), JSON.stringify(badLines.slice(0, 2)));
  assert.equal(goodLines.filter((l) => l.action === "started").length, 1, "started once");
  assert.ok(!loop.lines.some((l) => l.event === "tick-failed"), "no tick failed as a whole");
  assert.deepEqual(await findDelegations(disk, bad), [], "nothing was started for the invalid run");
  results.invalidRunJson = { badLines: badLines.length, badMessage: badLines[0].message, goodActions: goodLines.map((l) => l.action) };
  await stopInstance(goodLines.find((l) => l.action === "started")!.handle as HostHandle);
  assert.deepEqual(archilMounts(), []);
});

// ---- STONITH that works, and two racing supervisors ---------------------------------------------------------------------

test("lease expired on a host the driver reaches: the supervisor stops the unit, checks its mount in, revokes, and restarts on the same host", { skip: !LIVE }, async () => {
  const id = await newRun("stonith");
  const flags = ["--mount-root", A, "--host-name", "host-a", "--unit-prefix", "pda-p5-st-", "--lease-expiry", "5s", "--stop-timeout", "3s", "--stonith-timeout", "30s", ...instance()];
  const first = superviseOnce(id, flags).lines.find((l) => l.action === "started")!;
  const h1 = first.handle as HostHandle;
  await waitFor("generation 1", async () => (await s3(id))?.generation === 1);
  const main1 = Number(show(String(h1.unit)).MainPID);
  sh("sudo", ["-n", "kill", "-STOP", String(main1)]);
  const tFreeze = Date.now();
  const loop = superviseLoop(id, flags);
  const second = await waitFor("the supervisor to stop and replace the instance", () => loop.lines.find((l) => l.action === "started"), 60_000);
  await waitFor("generation 2", async () => (await s3(id))?.generation === 2, 30_000, 50);
  const tRunning = Date.now();
  await loop.stop();
  assert.equal(second.reason, "lease-expired");
  assert.equal((second.stonith as { outcome: string }).outcome, "stopped", JSON.stringify(second.stonith));
  assert.equal(show(String(h1.unit)).LoadState, "not-found", "the old unit was stopped and reset");
  assert.equal(alive(main1), false);
  results.stonith = { stonith: second.stonith, freezeToSupervisorStartMs: second.seenAt - tFreeze, freezeToRunningMs: tRunning - tFreeze, revoked: second.revoked };
  ledger.unitGone(`${h1.unit}.service`, "stopped by the supervisor (STONITH)");
  handles.splice(handles.indexOf(h1), 1);
  await stopInstance(second.handle as HostHandle);
  assert.deepEqual(archilMounts(), []);
});

test("two supervisor processes race on a run with no holder (start grace off, so neither defers to the other's mark): the mount admits one; the other instance exits 76 and is not restarted", { skip: !LIVE }, async () => {
  const id = await newRun("race");
  const flags = (root: string, name: string) => ["--mount-root", root, "--host-name", name, "--unit-prefix", `pda-p5-race${name.at(-1)}-`, "--start-grace", "0", ...instance()];
  const run = (root: string, name: string) =>
    new Promise<Record<string, unknown>[]>((resolve) => {
      const c = spawn(process.execPath, superviseArgs(id, flags(root, name)), { env: supervisorEnv(), stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      c.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
      c.on("exit", () => {
        const lines = parseLines(out);
        lines.forEach(noteLine);
        resolve(lines);
      });
    });
  const [la, lb] = await Promise.all([run(A, "host-a"), run(B, "host-b")]);
  const started = [...la, ...lb].filter((l) => l.action === "started");
  assert.equal(started.length, 2, "both supervisors saw no holder and started an instance");
  const units = started.map((l) => String((l.handle as HostHandle).unit));
  const outcome = await waitFor("one instance holding and one exited", () => {
    const s = units.map((u) => show(u));
    const active = s.filter((x) => x.ActiveState === "active");
    const done = s.filter((x) => x.ActiveState === "failed" || x.LoadState === "not-found" || x.ActiveState === "inactive");
    return active.length === 1 && done.length === 1 ? s : null;
  }, 60_000, 100);
  const loser = outcome.find((x) => x.ActiveState !== "active")!;
  assert.equal(loser.ExecMainStatus, "76", JSON.stringify(loser));
  assert.equal(Number(loser.NRestarts), 0, "exit 76 is terminal: no restart");
  const winner = units[outcome.findIndex((x) => x.ActiveState === "active")];
  const loserUnit = units.find((u) => u !== winner)!;
  await waitFor("the winner's heartbeat", async () => (await s3(id))?.holder?.unit === winner);
  assert.equal((await findDelegations(disk, id)).length, 1);
  // A refused `archil mount` exits 1 at once but its forked daemon lingers a few seconds with no mount, then exits.
  const tLoser = Date.now();
  await waitFor("the refused mount's daemon to exit by itself", () => fuseScope(loserUnit) === null, 30_000, 200);
  results.race = { winner, loserExit: loser.ExecMainStatus, refusedDaemonLingerMs: Date.now() - tLoser };
  for (const l of started) await stopInstance(l.handle as HostHandle);
  assert.deepEqual(archilMounts(), []);
});
