// Live supervisor and local host suite on the shared scratch disk (a hung host, the cgroup and in-place restart,
// `supervise --check`, live STONITH and racing supervisors). Supervisors run as separate CLI processes (they hold the
// API key; instances never do); instances run as systemd transient units through localHost. Mount roots with separate
// FUSE clients on this box (/mnt/pda/p5/a, b, c) stand in for hosts A, B and C. Everything lives under runs/p5-<stamp>-*/,
// /mnt/pda/p5/ and units named pda-p5-*; every token user, subdirectory, mount and unit is recorded in P5-STATE.json
// and removed in `after`, also on failure. Measurements go to <ledger>-live-results.json next to the ledger.
// The three tests that wait out fixed windows (the token refresh, the backoff) are in supervise-slow.live.test.ts; the
// harness both share is _p5.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDisk } from "disk";
import { LIVE, RUN_OWNER } from "./_archil.ts";
import { ledger } from "./_p5-ledger.ts";
import { ARCHIL_SCOPED, createRunDir, findDelegations, mintMountToken } from "../../src/claim.ts";
import { deleteRunTree, type HostHandle } from "../../src/supervise.ts";
import { A, alive, archilMounts, B, BASE, C, daemonOf, disk, eventOf, events, fuseScope, handles, instance, newRun, noteLine, openSteps, OUT, parseLines, results, s3, SEAL_APP, sh, show, sleep, STAMP, stopInstance, stopped, superviseArgs, superviseLoop, superviseOnce, supervisorEnv, ticksOf, tokens, uidOf, waitFor } from "./_p5.ts";

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
  await createRunDir(disk, id, RUN_OWNER);
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

// ---- the token janitor -------------------------------------------------------------------------------------------

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
  await disk.putObject(`runs/${bad}/run.json`, JSON.stringify({ run: bad, status: "zombie", generation: 1, heartbeatAt: null, holder: null }), { ...RUN_OWNER, mode: 0o644 });
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
