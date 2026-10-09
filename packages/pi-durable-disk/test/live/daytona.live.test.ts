// Driver conformance for daytonaHost: a real instance (the e2e app: faux model, a `sleep 600` command
// through pi's bash tool, a tick commit every 500 ms) in Daytona box A; A powered off mid-run (SIGKILL of the whole box);
// the supervisor (this process: the instances are remote) revokes and resumes on box B with every acknowledged tick;
// B frozen (instance and FUSE daemon SIGSTOPped) where the driver cannot reach it; revoke, resume on box C; B thawed
// exits 75 and is not restarted; then C partitioned (all egress blocked) and stopped by STONITH through the real driver,
// resumed on box D. Every box comes from Daytona's public `daytona-medium` snapshot with the runtime installed at boot,
// is labeled pda-fleet=p9, is in the ledger (P9-STATE.json) before its create returns, and is deleted, also on failure.
//   PDA_LIVE=1 DAYTONA_API_KEY=... ARCHIL_API_KEY=... PDA_LIVE_DISK=dsk-... node --test test/live/daytona.live.test.ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { removeMountToken, revoke, type ControlApi, type RunRef } from "../../src/claim.ts";
import { daytonaHost, LABEL_FLEET, sweepSandboxes, type SandboxInfo } from "../../src/hosts/daytona.ts";
import { ensureRunning, readRunStatus, type EnsureOptions, type EnsureResult, type HostDriver, type HostHandle } from "../../src/supervise.ts";
import { REGION, scratchDisk, scratchDiskId } from "./_archil.ts";
import { statePath } from "./_paths.ts";
import {
  APP_OUT,
  ARCHIL_WRAPPER,
  blockEgress,
  confirmGone,
  deletePrefix,
  FLEET,
  guardedClient,
  journalTokenLines,
  ledger,
  MOUNT_ROOT,
  NAME_PREFIX,
  NODE,
  PACKAGE_DIR,
  PDA_ID,
  prepareBox,
  sh,
} from "./_p9.ts";

const LIVE = process.env.PDA_LIVE === "1" && Boolean(process.env.DAYTONA_API_KEY) && Boolean(process.env.ARCHIL_API_KEY);
const T13_OUT = statePath("PDA_P9_T13", "P9-T13.json");
const LEASE_MS = 6_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const since = new Date(Date.now() - 1000).toISOString().replace("T", " ").slice(0, 19);
const results: Record<string, unknown> = { at: new Date().toISOString(), leaseMs: LEASE_MS };
const tokens: string[] = [];
let runId = "";

type AppEvent = { ev: string; t: number; generation: number; pid: number; n?: number; commandPid?: number; sudoExit?: number; resumedFrom?: number; ticks?: number; duplicates?: number; instanceStdin?: string };

after(async () => {
  if (!LIVE) return;
  const client = guardedClient();
  const cleanup: Record<string, unknown> = {};
  cleanup.sweep = await sweepSandboxes(client, { [LABEL_FLEET]: FLEET }).catch((e: unknown) => ({ error: (e as Error).message }));
  cleanup.stillAlive = await confirmGone(client, 180_000);
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  for (const t of tokens) await removeMountToken(control, t).then(() => ledger.tokenRemoved(t), (e: unknown) => ((cleanup.tokenErrors ??= []) as unknown[]).push(String(e)));
  if (runId) {
    cleanup.revoked = await revoke(control, runId).then((held) => held.length, (e: unknown) => ({ error: (e as Error).message }));
    const del = await deletePrefix(disk as never, `runs/${runId}/`).catch((e: unknown) => ({ error: (e as Error).message }));
    ledger.subdirDeleted(`runs/${runId}/`, JSON.stringify(del));
    cleanup.prefix = del;
  }
  cleanup.labeledAfter = (await client.list({ [LABEL_FLEET]: FLEET })).map((b) => ({ id: b.id, state: b.state }));
  cleanup.journalTokenLines = journalTokenLines(since);
  cleanup.daytonaSpendUsd = Math.round(ledger.spend() * 10000) / 10000;
  results.cleanup = cleanup;
  writeFileSync(T13_OUT, `${JSON.stringify(results, null, 2)}\n`);
});

test("T13 on daytonaHost: power-off on A, resume on B; freeze B, resume on C, B exits 75 when thawed; partition C, STONITH, resume on D", { skip: !LIVE, timeout: 45 * 60_000 }, async () => {
  const client = guardedClient();
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const stamp = Date.now().toString(36);
  runId = `p9-t13-${stamp}`;
  const ref: RunRef = { disk: scratchDiskId(), region: REGION, id: runId };
  const prepared: Record<string, unknown>[] = [];
  const driver = daytonaHost({
    client,
    snapshot: "daytona-medium",
    target: process.env.DAYTONA_TARGET || "us",
    fleet: FLEET,
    namePrefix: NAME_PREFIX,
    labels: { "pda-p9": `t13-${stamp}` },
    mountRoot: MOUNT_ROOT,
    node: NODE,
    packageDir: PACKAGE_DIR,
    archil: ARCHIL_WRAPPER,
    user: "pda",
    runArgs: [`--app=${PACKAGE_DIR}/test/fixtures/e2e-app.ts`, "--heartbeat-ms=1000", "--lease-expiry-ms=600000", "--lease-margin-ms=0"],
    env: { PDA_TEST_OUT: APP_OUT },
    ttlMinutes: 90,
    startTimeoutMs: 300_000,
    stopTimeoutMs: 5_000,
    prepare: async (box) => void prepared.push({ box: box.id, ...(await prepareBox(client, box)) }),
  });
  const opts: EnsureOptions = { control: disk as never, leaseExpiryMs: LEASE_MS, stonithTimeoutMs: 30_000, tokenTtl: "2h", tokenPrefix: "pda-p9-", create: { uid: PDA_ID, gid: PDA_ID } };
  const boxOf = async (h: HostHandle) => {
    const b = await client.get(String(h.sandboxId));
    assert.ok(b, `box ${h.name} exists`);
    return b as SandboxInfo;
  };
  const events = async (h: HostHandle): Promise<AppEvent[]> => {
    const b = await client.get(String(h.sandboxId));
    if (!b || b.state !== "started") return [];
    const r = await client.exec(b, `cat ${APP_OUT}/${runId}.jsonl 2>/dev/null || true`, 20);
    return r.result.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as AppEvent);
  };
  const acked = (evs: AppEvent[]) => evs.filter((e) => e.ev === "tick").map((e) => e.n!);
  const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1_000): Promise<T> => {
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
  const envClean = async (h: HostHandle) => {
    const raw = (await client.get(String(h.sandboxId))) as SandboxInfo & { env?: Record<string, string> };
    return !Object.keys(raw.env ?? {}).some((k) => /ARCHIL|TOKEN|KEY/i.test(k));
  };
  /** Instance and FUSE daemon pids in a box, from the launcher's state and the mount's daemon. */
  const pids = async (h: HostHandle) => {
    const out = await sh(client, await boxOf(h), `sudo -n ${NODE} -e 'console.log(JSON.parse(require("fs").readFileSync("/run/pda/${h.name}.state","utf8")).instance)'; pgrep -f 'archil mount .*runs/${runId} ' | head -1`);
    const [instance, daemon] = out.trim().split("\n");
    return { instance: Number(instance), daemon: Number(daemon) };
  };
  const launcherState = async (h: HostHandle) => JSON.parse((await sh(client, await boxOf(h), `sudo -n ${NODE} ${PACKAGE_DIR}/src/hosts/daytona-launch.ts status ${h.name}`)).trim().split("\n").at(-1)!) as { status: string; state: { exit: number | null; phase: string; reason: string | null; spawned: number; restarts: number } };

  // ---- A: first start, then power-off mid-run --------------------------------------------------------------------------
  const a = await tickUntilStarted(driver, "start on A");
  results.startA = { reason: a.r.reason, created: a.r.created, startMs: a.r.startMs, handle: a.r.handle };
  const hA = a.r.handle;
  if (a.r.created) ledger.subdir(`runs/${runId}/`, "t13 run directory (created by ensureRunning)");
  assert.equal(a.r.reason, "none");
  assert.equal(await driver.status(hA), "running");
  const openedA = await waitFor("A to commit 8 ticks", async () => {
    const evs = await events(hA);
    return acked(evs).length >= 8 ? evs : null;
  }, 180_000, 2_000);
  const longA = openedA.find((e) => e.ev === "long-command")!;
  results.instanceA = { opened: openedA.find((e) => e.ev === "opened"), longCommand: longA, envClean: await envClean(hA) };
  assert.equal(longA.sudoExit, 1, "an agent command cannot use sudo (no_new_privs)");
  const ackedA = acked(await events(hA));
  const tKill = Date.now();
  await client.stop(String(hA.sandboxId), true);
  ledger.event("t13 power-off A", { box: hA.sandboxId });

  // ---- B: the next ticks find A's delegation orphaned, revoke, start B; B resumes from A's last acknowledged tick ---------
  const b = await tickUntilStarted(driver, "takeover on B");
  const hB = b.r.handle;
  results.takeoverB = { reason: b.r.reason, revoked: b.r.revoked, stonith: b.r.stonith, startMs: b.r.startMs, killToDecisionMs: Date.now() - tKill - b.r.startMs, ticks: b.ticks };
  assert.ok(b.r.reason === "orphaned" || b.r.reason === "lease-expired", `takeover reason ${b.r.reason}`);
  const openedB = await waitFor("B to open and tick", async () => {
    const evs = await events(hB);
    return evs.some((e) => e.ev === "tick") ? evs : null;
  }, 180_000, 1_000);
  const oB = openedB.find((e) => e.ev === "opened")!;
  results.instanceB = { opened: oB, killToFirstTickObservedMs: Date.now() - tKill, ackedOnABeforeKill: ackedA.length, lastAckedOnA: Math.max(...ackedA), envClean: await envClean(hB) };
  assert.equal(oB.generation, 2);
  assert.equal(oB.duplicates, 0, "no tick committed twice");
  assert.ok(oB.resumedFrom! >= Math.max(...ackedA), `B resumed from ${oB.resumedFrom}, A had acknowledged ${Math.max(...ackedA)}`);
  await waitFor("A deleted", async () => (await driver.status(hA)) === "gone", 60_000, 1_000);

  // ---- C: freeze B where the supervisor's driver cannot reach it; revoke; C resumes; B thawed exits 75 ----------------
  await waitFor("B to commit 6 more ticks", async () => (acked(await events(hB)).length >= 6 ? true : null), 120_000, 2_000);
  const pB = await pids(hB);
  const longB = (await events(hB)).find((e) => e.ev === "long-command")!;
  const ackedB = acked(await events(hB));
  await sh(client, await boxOf(hB), `sudo -n kill -STOP ${pB.instance} ${pB.daemon}`);
  const tFreeze = Date.now();
  const blind: HostDriver = { start: (r, t) => driver.start(r, t), status: async () => "unknown", stop: async () => {} };
  const c = await tickUntilStarted(blind, "takeover on C");
  const hC = c.r.handle;
  results.takeoverC = { reason: c.r.reason, revoked: c.r.revoked, stonith: c.r.stonith, startMs: c.r.startMs, freezeToDecisionMs: Date.now() - tFreeze - c.r.startMs, ticks: c.ticks, frozen: pB };
  assert.equal(c.r.reason, "lease-expired");
  assert.deepEqual(c.r.stonith, { outcome: "unreachable", status: "unknown" });
  const openedC = await waitFor("C to open and tick", async () => {
    const evs = await events(hC);
    return evs.some((e) => e.ev === "tick") ? evs : null;
  }, 180_000, 1_000);
  const oC = openedC.find((e) => e.ev === "opened")!;
  assert.equal(oC.generation, 3);
  assert.equal(oC.duplicates, 0);
  assert.ok(oC.resumedFrom! >= Math.max(...ackedB), `C resumed from ${oC.resumedFrom}, B had acknowledged ${Math.max(...ackedB)}`);
  const stateAtThaw = await launcherState(hB);
  const tCont = Date.now();
  await sh(client, await boxOf(hB), `sudo -n kill -CONT ${pB.daemon} ${pB.instance}`);
  const endB = await waitFor("frozen B to exit", async () => {
    const s = await launcherState(hB);
    return s.status !== "running" ? s : null;
  }, 120_000, 500);
  const longBAlive = (await sh(client, await boxOf(hB), `kill -0 ${longB.commandPid} 2>/dev/null && echo alive || echo dead`)).trim();
  await sleep(3_000);
  const afterB = await launcherState(hB);
  results.thawB = { stateAtThaw: stateAtThaw.state, end: endB, sigcontToEndObservedMs: Date.now() - tCont, restartsAfter: afterB.state.restarts, longCommand: { pid: longB.commandPid, afterExit: longBAlive }, driverStatus: await driver.status(hB), instanceC: { opened: oC, envClean: await envClean(hC) } };
  assert.equal(endB.state.exit, 75, `the thawed instance exits 75 (got ${endB.state.exit}: ${endB.state.reason})`);
  assert.equal(afterB.state.spawned, 1, "and is not restarted");
  assert.equal(await driver.status(hB), "failed");
  await driver.stop(hB);
  await waitFor("B deleted", async () => (await driver.status(hB)) === "gone", 60_000, 1_000);

  // ---- D: partition C (all egress blocked), the real driver's STONITH deletes it, revoke, D resumes --------------------
  await waitFor("C to commit 6 more ticks", async () => (acked(await events(hC)).length >= 6 ? true : null), 120_000, 2_000);
  const ackedC = acked(await events(hC));
  const blocked = await blockEgress(client, String(hC.sandboxId));
  const tPart = Date.now();
  results.partitionC = { networkBlockAll: { status: blocked.status } };
  let hD: HostHandle;
  if (blocked.status >= 200 && blocked.status < 300) {
    const d = await tickUntilStarted(driver, "takeover on D");
    hD = d.r.handle;
    results.takeoverD = { reason: d.r.reason, revoked: d.r.revoked, stonith: d.r.stonith, startMs: d.r.startMs, partitionToDecisionMs: Date.now() - tPart - d.r.startMs, ticks: d.ticks };
    assert.equal(d.r.reason, "lease-expired");
    assert.equal((d.r.stonith as { outcome: string }).outcome, "stopped", JSON.stringify(d.r.stonith));
    await waitFor("STONITH to have deleted the partitioned box", async () => (await driver.status(hC)) === "gone", 60_000, 1_000);
  } else {
    results.partitionC = { ...(results.partitionC as object), skipped: "network settings refused; STONITH on a reachable box instead" };
    const d = await tickUntilStarted(driver, "takeover on D", 30_000).catch(() => null);
    assert.equal(d, null, "a healthy C is not taken over");
    await driver.stop(hC);
    const d2 = await tickUntilStarted(driver, "start on D");
    hD = d2.r.handle;
  }
  const openedD = await waitFor("D to open and tick", async () => {
    const evs = await events(hD);
    return evs.some((e) => e.ev === "tick") ? evs : null;
  }, 180_000, 1_000);
  const oD = openedD.find((e) => e.ev === "opened")!;
  results.instanceD = { opened: oD, lastAckedOnC: Math.max(...ackedC), envClean: await envClean(hD) };
  assert.equal(oD.generation, 4);
  assert.equal(oD.duplicates, 0);
  assert.ok(oD.resumedFrom! >= Math.max(...ackedC));

  // ---- end: stop D through the driver (drain, then delete) -----------------------------------------------------------
  const tStop = Date.now();
  await driver.stop(hD);
  results.stopD = { ms: Date.now() - tStop, status: await driver.status(hD), runJson: await readRunStatus(disk as never, runId).then((r) => r && { status: r.status, generation: r.generation, detail: r.detail }) };
  results.prepare = prepared;
  results.passed = true;
});
