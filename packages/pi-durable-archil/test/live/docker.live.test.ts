// T13, driver conformance, for dockerHost, on this machine's Docker daemon. The instances are containers from
// the package's image ($PDA_DOCKER_IMAGE, built from docker/Dockerfile) running test/fixtures/docker-app.ts: a faux model,
// a `sleep 600` command through pi's bash tool, a tick commit every 500 ms, and probes of what a command can reach.
//   1. A starts; a second container of the same run is refused its mount (exit 76); commit latency from a container.
//   2. `docker kill` A (power off): the next tick sees the delegation orphaned, revokes, B resumes with every tick.
//   3. `docker pause` B where the supervisor's driver cannot reach it: the lease expires, revoke, C resumes; `docker
//      unpause` B: it exits 75, commits nothing more, and a later instance finds none of its rows past its last tick.
//   4. `docker pause` C with the real driver: STONITH stops the paused container (`stopped`), revoke, D resumes.
//   5. D stops through the driver (drain, released `sleeping`); E wakes, reads the whole store, stops.
// The supervisor is this process, a different process from every instance. Every container is named pda-<fleet>-t13-*,
// labeled pda.fleet=<fleet> ($PDA_DOCKER_FLEET, default `live`), recorded in the ledger before it is created, and
// removed, also on failure. Results go to docker-T13.json next to the ledger ($PDA_DOCKER_T13 names another file).
//   docker build -f docker/Dockerfile -t pi-durable-archil:local .   (after npm pack --pack-destination docker/package)
//   PDA_LIVE=1 PDA_LIVE_DISK=dsk-... ARCHIL_API_KEY=... npm run test:live:docker
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeMountToken, type ControlApi, type RunRef } from "../../src/claim.ts";
import { diskKey, dockerHost } from "../../src/hosts/docker.ts";
import { ensureRunning, readRunStatus, type EnsureOptions, type EnsureResult, type HostDriver, type HostHandle } from "../../src/supervise.ts";
import { LIVE as ARCHIL_LIVE, REGION, scratchDisk, scratchDiskId } from "./_archil.ts";
import { deletePrefix, delegationsOn, docker, fleetContainers, FLEET, IMAGE, LEDGER, ledger, NAME_PREFIX, removeContainer } from "./_docker.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_ROOT = process.env.TMPDIR ?? "/tmp";
const T13_OUT = process.env.PDA_DOCKER_T13 ?? join(dirname(LEDGER), "docker-T13.json");
const PREFIX = `${NAME_PREFIX}-t13-`;
/** Opt-in on top of PDA_LIVE: the suite needs a Docker daemon and the image built from this checkout. */
const LIVE = ARCHIL_LIVE && process.env.PDA_LIVE_DOCKER === "1";
const LEASE_MS = 6_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const since = new Date(Date.now() - 1000).toISOString().replace("T", " ").slice(0, 19);
const results: Record<string, unknown> = { at: new Date().toISOString(), image: IMAGE, leaseMs: LEASE_MS };
const tokens: string[] = [];
let runId = "";
let outDir = "";

type AppEvent = { ev: string; t: number; generation: number; host: string; pid: number; uid?: number; n?: number; commitMs?: number; resumedFrom?: number; ticks?: number; duplicates?: number; byGeneration?: Record<string, number>; probes?: Record<string, unknown>; commandPid?: number };

function hostArchilMounts(): string[] {
  return readFileSync("/proc/mounts", "utf8").split("\n").filter((l) => l.includes("fuse.archil") && l.includes(runId || "-"));
}

/** Journal lines since the start carrying the mount token's variable name (pattern on stdin, never printed). */
function journalTokenLines(): { tokenLines: number; mountLines: number } {
  const count = (pattern: string) => {
    const out = spawnSync("bash", ["-c", 'p=$(mktemp); cat > "$p"; sudo -n journalctl --utc --since "$1" --no-pager -o cat </dev/null | /usr/bin/grep -c -F -f "$p"; rm -f "$p"; true', "bash", since], { input: `${pattern}\n`, encoding: "utf8" });
    return Number(out.stdout.trim().split("\n").at(-1) || "0");
  };
  return { tokenLines: count("ARCHIL_MOUNT_TOKEN="), mountLines: count("archil-scoped mount") };
}

after(async () => {
  if (!LIVE) return;
  const cleanup: Record<string, unknown> = {};
  for (const name of fleetContainers().filter((n) => n.startsWith(PREFIX))) removeContainer(name);
  cleanup.containersLeft = fleetContainers().filter((n) => n.startsWith(PREFIX));
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  for (const t of tokens) await removeMountToken(control, t).then(() => ledger.tokenRemoved(t), (e: unknown) => ((cleanup.tokenErrors ??= []) as unknown[]).push(String(e)));
  if (runId) {
    for (const d of (await control.listDelegations()).filter((d) => d.path?.replace(/^\/+/, "").startsWith(`runs/${runId}`))) {
      await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId }).catch(() => {});
    }
    cleanup.prefix = await deletePrefix(`runs/${runId}/`).catch((e: unknown) => ({ error: (e as Error).message }));
  }
  cleanup.hostMounts = hostArchilMounts();
  cleanup.journal = journalTokenLines();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  results.cleanup = cleanup;
  writeFileSync(T13_OUT, `${JSON.stringify(results, null, 2)}\n`);
});

test("T13 on dockerHost: kill A, resume on B; freeze B, resume on C, B exits 75 when thawed; freeze C, STONITH, resume on D", { skip: !LIVE, timeout: 30 * 60_000 }, async () => {
  const disk = await scratchDisk();
  const stamp = Date.now().toString(36);
  runId = `${FLEET}-t13-${stamp}`;
  outDir = join(OUT_ROOT, `${FLEET}-out-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  chmodSync(outDir, 0o755);
  const ref: RunRef = { disk: scratchDiskId(), region: REGION, id: runId };
  const inner = dockerHost({
    image: IMAGE,
    fleet: FLEET,
    namePrefix: PREFIX,
    mountRoot: `/mnt/pda/${FLEET}`,
    app: join(REPO, "test/fixtures/docker-app.ts"),
    appRoot: REPO,
    runArgs: ["--heartbeat-ms=1000", "--lease-expiry-ms=600000", "--lease-margin-ms=0"],
    env: { PDA_TEST_OUT: "/var/tmp/pda-out", NODE_NO_WARNINGS: "1" },
    dockerArgs: ["--mount", `type=bind,source=${outDir},target=/var/tmp/pda-out`],
    stopTimeoutMs: 5_000,
  });
  // The ledger gets each container's name before `docker create` runs.
  const driver: HostDriver & { describe: typeof inner.describe } = {
    start: (r, token, attempt) => {
      ledger.container(`${PREFIX}${r.id}-${diskKey(r)}-g${attempt?.attempt}`, "t13 instance");
      return inner.start(r, token, attempt);
    },
    status: (h) => inner.status(h),
    stop: (h) => inner.stop(h),
    describe: (h) => inner.describe(h),
  };
  const opts: EnsureOptions = { control: disk as never, leaseExpiryMs: LEASE_MS, stonithTimeoutMs: 30_000, tokenTtl: "2h", tokenPrefix: `${NAME_PREFIX}-`, create: { uid: 0, gid: 0 } };
  const events = (): AppEvent[] => {
    const file = join(outDir, `${runId}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as AppEvent);
  };
  const of = (generation: number) => events().filter((e) => e.generation === generation);
  const acked = (evs: AppEvent[]) => evs.filter((e) => e.ev === "tick").map((e) => e.n!);
  const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, everyMs = 250): Promise<T> => {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(everyMs)) {
      const v = await fn();
      if (v) return v;
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  /** Supervisor ticks every 2 s until one starts an instance. */
  const tickUntilStarted = async (host: HostDriver, what: string, timeoutMs = 120_000) => {
    const seen: string[] = [];
    const t0 = Date.now();
    const r = await waitFor(what, async () => {
      const x = await ensureRunning(ref, host, opts);
      seen.push(`${Date.now() - t0}:${x.action}${x.action === "started" ? `/${x.reason}` : ""}`);
      if (x.action === "started") {
        tokens.push(x.token.identifier);
        ledger.token(x.token.identifier, x.token.nickname, `t13 ${what}`);
      }
      return x.action === "started" ? (x as Extract<EnsureResult, { action: "started" }>) : null;
    }, timeoutMs, 2_000);
    return { r, ticks: seen, decidedMs: Date.now() - t0 };
  };
  const name = (h: HostHandle) => String(h.name);
  const mountsDuring: string[][] = [];

  // ---- 1. A, a refused second container, latency ------------------------------------------------------------------------
  const a = await tickUntilStarted(driver, "start on A");
  const hA = a.r.handle;
  if (a.r.created) ledger.subdir(`runs/${runId}/`, "t13 run directory (created by ensureRunning, owned by root)");
  results.startA = { reason: a.r.reason, created: a.r.created, startMs: a.r.startMs, handle: hA };
  assert.equal(a.r.reason, "none");
  assert.equal(await driver.status(hA), "running");
  const inspectA = docker(["inspect", "--format", "{{json .Config.Env}}\t{{json .Config.Cmd}}\t{{json .HostConfig.SecurityOpt}}\t{{json .HostConfig.CapAdd}}", name(hA)]).stdout.trim();
  results.configA = { inspect: inspectA, mentionsToken: /ARCHIL_MOUNT_TOKEN|ARCHIL_API_KEY/.test(inspectA) };
  assert.ok(!/ARCHIL_MOUNT_TOKEN|ARCHIL_API_KEY/.test(inspectA), "no token or key in the container's configuration");
  await waitFor("A to commit 12 ticks", () => acked(of(1)).length >= 12, 180_000);
  const probesA = of(1).find((e) => e.ev === "probes");
  results.instanceA = { opened: of(1).find((e) => e.ev === "opened"), probes: probesA };
  mountsDuring.push(hostArchilMounts());

  const second = await (async () => {
    const t = await (await import("../../src/claim.ts")).mintMountToken(disk as never, { run: { id: runId, attempt: 99 }, prefix: `${NAME_PREFIX}-`, ttl: "1h" });
    tokens.push(t.identifier);
    ledger.token(t.identifier, t.nickname, "t13 second container (refused)");
    const h = await driver.start(ref, t.token, { attempt: 99 });
    const info = await waitFor("the second container to exit", async () => {
      const d = await driver.describe(h);
      return d && d.status !== "running" ? d : null;
    }, 60_000, 500);
    const logs = docker(["logs", name(h)]).stderr.split("\n").filter((l) => l.includes("open failed")).join(" ").slice(0, 400);
    await driver.stop(h);
    return { info, logs };
  })();
  results.secondContainer = second;
  assert.equal(second.info.exitCode, 76, `a second container's mount of the held run is refused (76), got ${JSON.stringify(second.info)}`);

  // ---- 2. power off A -------------------------------------------------------------------------------------------------
  const ackedA = acked(of(1));
  const tKill = Date.now();
  const kill = docker(["kill", name(hA)]);
  ledger.event("t13 docker kill A", { name: name(hA), rc: kill.status });
  const b = await tickUntilStarted(driver, "takeover on B");
  const hB = b.r.handle;
  results.takeoverB = { reason: b.r.reason, revoked: b.r.revoked, startMs: b.r.startMs, killToStartedMs: Date.now() - tKill, ticks: b.ticks, killedA: await driver.describe(hA) };
  assert.equal(b.r.reason, "orphaned");
  const oB = await waitFor("B to open", () => of(2).find((e) => e.ev === "opened"), 120_000);
  await waitFor("B to tick", () => acked(of(2)).length > 0, 120_000);
  results.instanceB = { opened: oB, killToOpenedMs: oB.t - tKill, killToFirstTickMs: of(2).find((e) => e.ev === "tick")!.t - tKill, ackedOnA: ackedA.length, lastAckedOnA: Math.max(...ackedA) };
  assert.equal(oB.duplicates, 0, "no tick committed twice");
  assert.ok(oB.resumedFrom! >= Math.max(...ackedA), `B resumed from ${oB.resumedFrom}, A had acknowledged ${Math.max(...ackedA)}`);
  mountsDuring.push(hostArchilMounts());

  // ---- 3. freeze B where the supervisor's driver cannot reach it --------------------------------------------------------
  await waitFor("B to commit 8 ticks", () => acked(of(2)).length >= 8, 120_000);
  const pause = docker(["pause", name(hB)]);
  const tFreeze = Date.now();
  ledger.event("t13 docker pause B", { name: name(hB), rc: pause.status });
  const ackedB = acked(of(2));
  const blind: HostDriver = { start: (r, t, at) => driver.start(r, t, at), status: async () => "unknown", stop: async () => {} };
  const c = await tickUntilStarted(blind, "takeover on C");
  const hC = c.r.handle;
  results.takeoverC = { reason: c.r.reason, revoked: c.r.revoked, stonith: c.r.stonith, startMs: c.r.startMs, freezeToStartedMs: Date.now() - tFreeze, ticks: c.ticks };
  const tStartedC = Date.now();
  assert.equal(c.r.reason, "lease-expired");
  assert.deepEqual(c.r.stonith, { outcome: "unreachable", status: "unknown" });
  const oC = await waitFor("C to open", () => of(3).find((e) => e.ev === "opened"), 120_000);
  await waitFor("C to tick", () => acked(of(3)).length > 0, 120_000);
  results.instanceC = { opened: oC, freezeToOpenedMs: oC.t - tFreeze, startedToOpenedMs: oC.t - tStartedC };
  assert.equal(oC.duplicates, 0);
  assert.ok(oC.resumedFrom! >= Math.max(...ackedB), `C resumed from ${oC.resumedFrom}, B had acknowledged ${Math.max(...ackedB)}`);
  const beforeThaw = events().length;
  const tThaw = Date.now();
  docker(["unpause", name(hB)]);
  ledger.event("t13 docker unpause B", { name: name(hB) });
  const endB = await waitFor("thawed B to exit", async () => {
    const d = await driver.describe(hB);
    return d && d.status !== "running" ? d : null;
  }, 120_000, 200);
  const thawedMs = Date.now() - tThaw;
  await sleep(2_000);
  const afterThawB = events().slice(beforeThaw).filter((e) => e.generation === 2);
  results.thawB = { end: endB, thawToExitObservedMs: thawedMs, eventsFromBAfterThaw: afterThawB, lastLoggedTickOfB: Math.max(...acked(of(2))), logs: docker(["logs", "--tail", "5", name(hB)]).stderr.trim().split("\n").slice(-3) };
  assert.equal(endB.exitCode, 75, `the thawed instance exits 75 (got ${JSON.stringify(endB)})`);
  assert.equal(afterThawB.filter((e) => e.ev === "tick").length, 0, "the thawed instance commits nothing more");
  assert.equal(await driver.status(hB), "failed");

  // ---- 4. freeze C with the real driver: STONITH stops the paused container ---------------------------------------------
  await waitFor("C to commit 6 ticks", () => acked(of(3)).length >= 6, 120_000);
  docker(["pause", name(hC)]);
  const tFreezeC = Date.now();
  ledger.event("t13 docker pause C", { name: name(hC) });
  const ackedC = acked(of(3));
  const d = await tickUntilStarted(driver, "takeover on D");
  const hD = d.r.handle;
  results.takeoverD = { reason: d.r.reason, revoked: d.r.revoked, stonith: d.r.stonith, startMs: d.r.startMs, freezeToStartedMs: Date.now() - tFreezeC, ticks: d.ticks, cAfter: await driver.status(hC), delegationsAfter: (await delegationsOn(runId)).map((x) => ({ isOrphaned: x.isOrphaned, isPending: x.isPending })) };
  assert.equal(d.r.reason, "lease-expired");
  assert.equal((d.r.stonith as { outcome: string }).outcome, "stopped", JSON.stringify(d.r.stonith));
  assert.equal(await driver.status(hC), "gone", "STONITH removed the paused container");
  const oD = await waitFor("D to open", () => of(4).find((e) => e.ev === "opened"), 120_000);
  await waitFor("D to tick", () => acked(of(4)).length > 0, 120_000);
  assert.equal(oD.duplicates, 0);
  assert.ok(oD.resumedFrom! >= Math.max(...ackedC), `D resumed from ${oD.resumedFrom}, C had acknowledged ${Math.max(...ackedC)}`);
  mountsDuring.push(hostArchilMounts());

  // ---- 5. stop D (drain), then E wakes and reads the whole store --------------------------------------------------------
  await waitFor("D to commit 4 ticks", () => acked(of(4)).length >= 4, 120_000);
  // The driver's stop is `docker stop -t`, then `docker rm -f`; the first half by hand here, to read D's log before it goes.
  const tStop = Date.now();
  const stopped = docker(["stop", "-t", "5", name(hD)], { timeoutMs: 60_000 });
  const logsD = docker(["logs", name(hD)]).stderr.split("\n").filter(Boolean).slice(-4);
  const exitD = await driver.describe(hD);
  const delegationsAfterD = (await delegationsOn(runId)).map((x) => ({ isOrphaned: x.isOrphaned, isPending: x.isPending }));
  await driver.stop(hD);
  const runJson = await readRunStatus(disk as never, runId);
  results.stopD = { ms: Date.now() - tStop, dockerStop: { rc: stopped.status, ms: Math.round(stopped.ms) }, exit: exitD, logs: logsD, delegationsAfter: delegationsAfterD, status: await driver.status(hD), runJson: runJson && { status: runJson.status, generation: runJson.generation, detail: runJson.detail, sealedSeq: runJson.sealedSeq } };
  assert.equal(runJson?.status, "sleeping");
  assert.equal(exitD?.exitCode, 0, "the drained instance exits 0");
  assert.deepEqual(delegationsAfterD, [], "the drain checked the delegation in");
  const e = await tickUntilStarted(driver, "wake E");
  const hE = e.r.handle;
  const oE = await waitFor("E to open", () => of(5).find((x) => x.ev === "opened"), 120_000);
  results.instanceE = { reason: e.r.reason, woke: e.r.woke, revoked: e.r.revoked, opened: oE };
  assert.equal(oE.duplicates, 0, "no tick in the store twice");
  assert.ok((oE.byGeneration?.["2"] ?? 0) <= Math.max(...acked(of(2))) + 1, `B's rows end at its last logged tick (one more may have been in flight at the freeze): ${JSON.stringify(oE.byGeneration)}`);
  await driver.stop(hE);

  // ---- every instance: what its commands could reach ---------------------------------------------------------------------
  const probes = events().filter((x) => x.ev === "probes").map((x) => ({ generation: x.generation, uid: x.uid, ...(x.probes as object) }));
  results.probes = probes;
  for (const p of probes as Record<string, unknown>[]) {
    assert.equal(p.uid, 0, "the instance runs as root in its container");
    assert.equal(p.commandUid, "1500", "commands run as the run user");
    assert.deepEqual(p.writeToolOwner, { dir: "1500:1500", sub: "1500:1500", file: "1500:1500" }, "what pi's write tool creates belongs to the run user");
    assert.equal(p.appendToWritten, "ok");
    assert.match(String(p.daemonEnviron), /^denied/, "a command cannot read the archil daemon's environment");
    assert.match(String(p.writeStore), /rc=1/);
    assert.match(String(p.appendRunJson), /rc=[12]/);
    assert.match(String(p.removeRunJson), /rc=1/);
    // No capability reaches a command: the container's SYS_ADMIN stays with its root.
    const caps = Object.fromEntries(String(p.caps).split(";").filter(Boolean).map((l) => l.trim().split(/:\s*/)));
    for (const set of ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"]) assert.equal(caps[set], "0000000000000000", `${set} of a command: ${p.caps}`);
    assert.doesNotMatch(String(p.mount), /rc=0/, "a command cannot mount");
    assert.doesNotMatch(String(p.unshareMount), /rc=0/, "a command cannot make a mount namespace");
    assert.doesNotMatch(String(p.unshareUser), /inner=0/, "a user namespace of its own gives no mount in the container's namespaces");
    assert.doesNotMatch(String(p.nsenter), /rc=0/, "nor enter PID 1's namespaces");
    assert.equal(p.protectedHardlinks, "1", "fs.protected_hardlinks is on");
    assert.doesNotMatch(String(p.linkStore), /rc=0/, "a command cannot hard-link the store into work/");
    assert.doesNotMatch(String(p.linkRunJson), /rc=0/, "nor run.json");
  }
  const lat = events().filter((x) => x.ev === "tick" && typeof x.commitMs === "number").map((x) => x.commitMs!).sort((x, y) => x - y);
  results.commitLatencyMs = lat.length ? { n: lat.length, p50: lat[Math.floor(lat.length / 2)], p95: lat[Math.floor(lat.length * 0.95)], max: lat.at(-1) } : null;
  results.hostMountsDuring = mountsDuring;
  assert.ok(mountsDuring.every((m) => m.length === 0), "no Archil mount on the host at any point");
  results.passed = true;
});
