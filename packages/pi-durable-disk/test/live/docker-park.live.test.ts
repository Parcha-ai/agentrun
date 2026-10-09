// Sleep parking through dockerHost, supervised by the CLI (`pi-durable-disk supervise --host docker --every 5s
// --park-threshold 45s`, a process of its own). The instances are containers of $PDA_DOCKER_IMAGE running
// test/fixtures/docker-park-app.ts: every open submits "flaky", the model errors once, and pi's retry waits 90 s, longer
// than the threshold.
//   1. g1 parks: it writes run.json `sleeping` with `wakeAt` (the retry's deadline), releases the run and exits 0.
//   2. Until wakeAt the supervisor reports `sleeping` and starts nothing: g1's container stays exited 0, never restarted
//      (restart policy `no`), and the run has no other container.
//   3. At wakeAt the supervisor starts g2; pi's timer retries there and the model answers "recovered".
// Then the loop stops and g2 stops through the driver (it drains and releases). Containers are named pda-<fleet>-park-*,
// labeled pda.fleet=<fleet>, and in the ledger before the supervisor can create them. Results go to docker-park.json
// next to the ledger ($PDA_DOCKER_PARK names another file).
//   PDA_LIVE=1 PDA_LIVE_DISK=dsk-... ARCHIL_API_KEY=... npm run test:live:docker
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeMountToken, revoke, type ControlApi, type RunRef } from "../../src/claim.ts";
import { diskKey, dockerHost } from "../../src/hosts/docker.ts";
import { readRunStatus, type HostHandle } from "../../src/supervise.ts";
import { KEY_ENV, LIVE as ARCHIL_LIVE, REGION, scratchDisk, scratchDiskId } from "./_archil.ts";
import { deletePrefix, delegationsOn, docker, fleetContainers, FLEET, IMAGE, LEDGER, ledger, NAME_PREFIX, removeContainer } from "./_docker.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO, "src/cli.ts");
const PREFIX = `${NAME_PREFIX}-park-`;
const OUT = process.env.PDA_DOCKER_PARK ?? join(dirname(LEDGER), "docker-park.json");
const LIVE = ARCHIL_LIVE && process.env.PDA_LIVE_DOCKER === "1";
const RETRY_MS = 90_000;
const THRESHOLD = "45s";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = { at: new Date().toISOString(), image: IMAGE, retryMs: RETRY_MS, threshold: THRESHOLD };
const tokens = new Set<string>();
let runId = "";
let outDir = "";
let loop: ChildProcess | undefined;

type Line = Record<string, unknown> & { seenAt: number; action?: string; handle?: HostHandle; token?: { identifier: string; nickname: string }; woke?: boolean };
type AppLine = { ev: string; t: number; generation?: number; field?: string; value?: number; text?: string };
type Seen = { status: string; exitCode: number; restartCount: number; policy: string; startedAt: string };

/** A container's state, restart count and restart policy, or null when it does not exist. */
function seen(name: string): Seen | null {
  const r = docker(["inspect", "--type", "container", "--format", "{{json .State}}\t{{.RestartCount}}\t{{.HostConfig.RestartPolicy.Name}}", name]);
  if (r.status !== 0) return null;
  const [state, count, policy] = r.stdout.trim().split("\t");
  const s = JSON.parse(state!) as { Status: string; ExitCode: number; StartedAt: string };
  return { status: s.Status, exitCode: s.ExitCode, restartCount: Number(count), policy: policy ?? "", startedAt: s.StartedAt };
}

/** This run's containers in the fleet, any state. */
const runContainers = () =>
  docker(["ps", "-a", "--filter", `label=pda.fleet=${FLEET}`, "--filter", `label=pda.run=${runId}`, "--format", "{{.Names}}"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean);

after(async () => {
  if (!LIVE) return;
  const cleanup: Record<string, unknown> = {};
  if (loop && loop.exitCode === null) {
    loop.kill("SIGTERM");
    await new Promise((r) => (loop!.exitCode !== null ? r(null) : loop!.once("exit", r)));
  }
  for (const name of fleetContainers().filter((n) => n.startsWith(PREFIX))) removeContainer(name);
  cleanup.containersLeft = fleetContainers().filter((n) => n.startsWith(PREFIX));
  const control = (await scratchDisk()) as unknown as ControlApi;
  for (const t of tokens) await removeMountToken(control, t).then(() => ledger.tokenRemoved(t), (e: unknown) => ((cleanup.tokenErrors ??= []) as unknown[]).push(String(e)));
  if (runId) {
    cleanup.revoked = await revoke(control, runId).then((held) => held.length, (e: unknown) => ({ error: (e as Error).message }));
    cleanup.prefix = await deletePrefix(`runs/${runId}/`).catch((e: unknown) => ({ error: (e as Error).message }));
  }
  cleanup.hostMounts = readFileSync("/proc/mounts", "utf8").split("\n").filter((l) => l.includes("fuse.archil") && l.includes(runId || "-"));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  results.cleanup = cleanup;
  writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
});

test("parking through dockerHost: g1 exits 0 and stays exited while the run sleeps; the supervisor starts g2 at wakeAt and the answer arrives", { skip: !LIVE, timeout: 10 * 60_000 }, async () => {
  const disk = await scratchDisk();
  const stamp = Date.now().toString(36);
  runId = `${FLEET}-park-${stamp}`;
  outDir = join(process.env.TMPDIR ?? "/tmp", `${FLEET}-park-out-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  chmodSync(outDir, 0o755);
  const ref: RunRef = { disk: scratchDiskId(), region: REGION, id: runId };
  const nameOf = (g: number) => `${PREFIX}${runId}-${diskKey(ref)}-g${g}`;
  for (const g of [1, 2, 3]) ledger.container(nameOf(g), "parking instance (the supervise loop creates it)");
  ledger.subdir(`runs/${runId}/`, "parking run directory (supervise --create, owned by root)");

  const lines: Line[] = [];
  const args = [
    CLI, "supervise", "--disk", ref.disk, "--region", ref.region, "--id", runId, "--api-key-env", KEY_ENV,
    "--token-prefix", `${NAME_PREFIX}-`, "--token-ttl", "2h", "--every", "5s", "--create",
    "--host", "docker", "--image", IMAGE, "--fleet", FLEET, "--name-prefix", PREFIX, "--mount-root", `/mnt/pda/${FLEET}`,
    "--app", join(REPO, "test/fixtures/docker-park-app.ts"), "--app-root", REPO, "--park-threshold", THRESHOLD, "--stop-timeout", "10s",
    "--env", "PDA_TEST_OUT=/var/tmp/pda-out", "--env", `PDA_TEST_RETRY_MS=${RETRY_MS}`, "--env", "NODE_NO_WARNINGS=1",
    "--docker-arg=--mount", `--docker-arg=type=bind,source=${outDir},target=/var/tmp/pda-out`, "--run-arg=--heartbeat-ms=1000",
  ];
  loop = spawn(process.execPath, args, { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, [KEY_ENV]: process.env[KEY_ENV]! }, stdio: ["ignore", "pipe", "pipe"] });
  ledger.event("park supervise loop started", { pid: loop.pid, run: runId });
  let buf = "";
  loop.stdout!.setEncoding("utf8").on("data", (c: string) => {
    buf += c;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.startsWith("{")) continue;
      const line = { ...(JSON.parse(l) as Record<string, unknown>), seenAt: Date.now() } as Line;
      if (line.action === "started" && line.token) {
        tokens.add(line.token.identifier);
        ledger.token(line.token.identifier, line.token.nickname, "parking start (supervise loop)");
      }
      lines.push(line);
    }
  });
  let stderr = "";
  loop.stderr!.setEncoding("utf8").on("data", (c: string) => void (stderr = (stderr + c).slice(-4000)));

  const appLines = (): AppLine[] => {
    const file = join(outDir, `${runId}.jsonl`);
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as AppLine) : [];
  };
  const requests = () => appLines().filter((l) => l.ev === "count" && l.field === "requests").at(-1)?.value ?? 0;
  const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, everyMs = 500): Promise<T> => {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(everyMs)) {
      const v = await fn();
      if (v) return v;
      if (loop!.exitCode !== null) throw new Error(`the supervise loop exited ${loop!.exitCode}: ${stderr}`);
    }
    throw new Error(`timed out waiting for ${what}; supervisor: ${JSON.stringify(lines.slice(-3))}`);
  };

  // ---- 1. g1 starts, the request fails once, g1 parks ------------------------------------------------------------------
  const first = await waitFor("g1's start", () => lines.find((l) => l.action === "started"), 120_000);
  const g1 = String(first.handle!.name);
  assert.equal(g1, nameOf(1));
  await waitFor("the failed request", () => requests() >= 1, 120_000);
  const erroredAt = appLines().find((l) => l.ev === "count" && l.field === "requests")!.t;
  const parked = await waitFor("g1 to park and exit", () => {
    const s = seen(g1);
    return s?.status === "exited" ? s : null;
  }, 60_000);
  const parkedAt = Date.now();
  const cmd = JSON.parse(docker(["inspect", "--type", "container", "--format", "{{json .Config.Cmd}}", g1]).stdout) as string[];
  const flag = (f: string) => cmd[cmd.indexOf(f) + 1];
  const rec = (await readRunStatus(disk as never, runId))!;
  const wakeAt = Date.parse(rec.wakeAt!);
  results.park = { g1: parked, flags: { parkThreshold: flag("--park-threshold"), drainTimeout: flag("--drain-timeout") }, erroredToExitedMs: parkedAt - erroredAt, status: rec.status, wakeAt: rec.wakeAt, waitMs: wakeAt - erroredAt, delegations: (await delegationsOn(runId)).length };
  assert.deepEqual([flag("--park-threshold"), flag("--drain-timeout")], ["45000ms", "5000ms"], "supervise passed --park-threshold, and the drain is the stop timeout less its reserve");
  assert.deepEqual([parked.exitCode, parked.restartCount, parked.policy], [0, 0, "no"], "a parked instance exits 0, under no restart policy");
  assert.equal(rec.status, "sleeping");
  assert.ok(Math.abs(wakeAt - erroredAt - RETRY_MS) <= 3_000, `wakeAt is the retry's deadline (${wakeAt - erroredAt} ms after the error)`);
  assert.equal((await delegationsOn(runId)).length, 0, "the run is released");

  // ---- 2. nothing starts the run, or restarts g1, before wakeAt ---------------------------------------------------------
  const watch: { at: number; g1: Seen | null; others: string[] }[] = [];
  const second = await waitFor("g2's start", () => {
    watch.push({ at: Date.now(), g1: seen(g1), others: runContainers().filter((n) => n !== g1) });
    return lines.find((l) => l.action === "started" && l !== first);
  }, RETRY_MS + 60_000, 2_000);
  const before = watch.filter((w) => w.at < second.seenAt);
  const sleepingTicks = lines.filter((l) => l.action === "sleeping" && l.seenAt < second.seenAt).length;
  const g1Unchanged = before.every((w) => w.g1?.status === "exited" && w.g1.exitCode === 0 && w.g1.restartCount === 0 && w.g1.startedAt === parked.startedAt);
  // The supervisor creates g2 inside the tick that reports its start, so g2 may show up once wakeAt has passed.
  const othersBeforeWake = [...new Set(before.filter((w) => w.at < wakeAt).flatMap((w) => w.others))];
  const othersAfterWake = [...new Set(before.filter((w) => w.at >= wakeAt).flatMap((w) => w.others))];
  const g2Seen = before.find((w) => w.others.includes(nameOf(2)));
  results.wait = {
    samples: before.length,
    samplesBeforeWake: before.filter((w) => w.at < wakeAt).length,
    g1Unchanged,
    othersBeforeWake,
    othersAfterWake,
    g2SeenAfterWakeMs: g2Seen ? g2Seen.at - wakeAt : null,
    sleepingTicks,
    startedAfterWakeMs: second.seenAt - wakeAt,
    woke: second.woke,
    g2: second.handle?.name,
  };
  assert.ok(before.filter((w) => w.at < wakeAt).length >= 20, `g1 was watched through the wait (${before.length} samples)`);
  assert.ok(g1Unchanged, "g1 stayed exited 0, never restarted, until g2's start");
  assert.deepEqual(othersBeforeWake, [], "the run had no other container before its wake");
  assert.ok(othersAfterWake.every((n) => n === nameOf(2)), `after the wake only the supervisor's g2 (${othersAfterWake.join(", ")})`);
  assert.ok(sleepingTicks >= 10, `the supervisor left it sleeping (${sleepingTicks} ticks)`);
  assert.equal(second.woke, true);
  assert.ok(second.seenAt >= wakeAt, "not started before its wake");
  assert.equal(String(second.handle!.name), nameOf(2));

  // ---- 3. g2 retries at the deadline and answers -----------------------------------------------------------------------
  const answer = await waitFor("the answer", () => appLines().find((l) => l.ev === "answer"), 120_000);
  const opened2 = appLines().find((l) => l.ev === "opened" && l.generation === 2);
  const retriedAt = appLines().filter((l) => l.ev === "count" && l.field === "requests").at(-1)!.t;
  results.answer = { generation: answer.generation, text: answer.text, requests: requests(), openedAfterWakeMs: opened2 ? opened2.t - wakeAt : null, retriedAfterWakeMs: retriedAt - wakeAt };
  assert.deepEqual([answer.generation, answer.text, requests()], [2, "recovered", 2]);
  assert.ok(retriedAt >= wakeAt, "pi's timer held the retry until the deadline");

  // ---- stop: the loop, then g2 through the driver -----------------------------------------------------------------------
  loop.kill("SIGTERM");
  await new Promise((r) => (loop!.exitCode !== null ? r(null) : loop!.once("exit", r)));
  ledger.event("park supervise loop stopped", { pid: loop.pid });
  const g2 = String(second.handle!.name);
  const tail = () => docker(["logs", "--tail", "12", g2]).stderr.split("\n").filter(Boolean).map((l) => l.slice(0, 240));
  const beforeStop = { container: seen(g2), logs: tail() };
  const t0 = Date.now();
  await dockerHost({ fleet: FLEET, stopTimeoutMs: 10_000 }).stop(second.handle!);
  const delegationsAfter = (await delegationsOn(runId)).length;
  results.stop = { ms: Date.now() - t0, delegationsAfter, record: (await readRunStatus(disk as never, runId))?.status, beforeStop, containerAfter: seen(g2) };
  assert.equal(delegationsAfter, 0, "g2 drained and released");
  results.decisions = lines.map((l) => `${l.seenAt - first.seenAt}:${l.action ?? l.event}`);
});
