// The supervise suite's three fixed-window tests: each waits out a window that is the property itself (the archil
// client's 5 min token refresh; five minutes of backoff), so together they take about 17 minutes whatever the load. The
// live disk check runs them only with `--slow` (`ci.ts all --slow`); everything else about the supervisor is in
// supervise.live.test.ts. Same harness, mount roots and ledger (P5-STATE.json); measurements go to
// P5-slow-live-results.json next to the ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIVE, scratchDiskId } from "./_archil.ts";
import { ledger, LEDGER } from "./_p5-ledger.ts";
import { ARCHIL_SCOPED, findDelegations } from "../../src/claim.ts";
import type { HostHandle } from "../../src/supervise.ts";
import { A, alive, archilMounts, B, daemonOf, disk, eventOf, events, fuseScope, instance, journalExit, newRun, OUT, results, s3, show, sleep, stopInstance, superviseLoop, superviseOnce, ticksOf, tokens, waitFor, writeResultsTo } from "./_p5.ts";

writeResultsTo(join(dirname(LEDGER), "P5-slow-live-results.json"));

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
