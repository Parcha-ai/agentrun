// Live run suite on the shared scratch disk (fence, host loss, self-fence, a mount taken away under a live instance). Each instance is a separate process
// (test/live/_instance.ts) holding only a single-use mount token; mounts under different roots are separate FUSE
// clients standing in for hosts, and kill -9 of an instance with its FUSE daemon is a host loss. Every
// token user, run directory and mount is recorded in P4-STATE.json and released in `after`, also on failure.
// Measurements go to P4-live-results.json next to the ledger.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { acquire, type Claim } from "../../src/claim.ts";
import { STORE_FILE } from "../../src/run.ts";
import { parseRunRecord, type RunRecord } from "../../src/status.ts";
import { openArchilStore } from "../../src/store.ts";
import { alive, ctx, killQuietly, waitGone } from "../_run-support.ts";
import { LIVE, REGION, scratchDiskId } from "./_archil.ts";
import { archilMounts, BASE, cleanMount, cleanupAll, control, daemonPid, LEDGER, ledger, newRun, prepareBase, ref, revokeRun, token } from "./_p4.ts";

const ROOT_A = `${BASE}/a`;
const ROOT_B = `${BASE}/b`;
const ROOT_C = `${BASE}/c`;
const RESULTS = join(dirname(LEDGER), "P4-live-results.json");
const WORK = join(process.env.TMPDIR ?? "/tmp", `p4-live-${Date.now().toString(36)}`);
const results: Record<string, unknown> = { at: new Date().toISOString() };
const children = new Set<Instance>();
const r1 = (x: number) => Math.round(x * 10) / 10;

type Event = Record<string, unknown> & { ev: string; writer: string; t: number };

/** One instance process and its event stream. */
class Instance {
  readonly child: ChildProcess;
  readonly events: Event[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly mountpoint: string;
  stderr = "";
  /** When the process exited (Date.now()), 0 while it runs. */
  exitedAt = 0;
  #waiters: Array<() => void> = [];

  constructor(options: { id: string; root: string; writer: string; token: string; lease?: object; blockHeartbeat?: boolean; execLog: string }) {
    this.mountpoint = join(options.root, "runs", options.id);
    this.child = spawn(process.execPath, ["test/live/_instance.ts"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        LANG: "C.UTF-8",
        TMPDIR: process.env.TMPDIR!,
        PDA_P4_TOKEN: options.token,
        PDA_P4_DISK: scratchDiskId(),
        PDA_P4_REGION: REGION,
        PDA_P4_RUN: options.id,
        PDA_P4_MOUNT_ROOT: options.root,
        PDA_P4_WRITER: options.writer,
        PDA_P4_EXECLOG: options.execLog,
        ...(options.lease ? { PDA_P4_LEASE: JSON.stringify(options.lease) } : {}),
        ...(options.blockHeartbeat ? { PDA_P4_BLOCK_HEARTBEAT: "1" } : {}),
      },
    });
    children.add(this);
    this.child.stdin!.on("error", () => undefined);
    this.child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (this.stderr += chunk));
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      this.events.push(JSON.parse(line) as Event);
      for (const wake of this.#waiters.splice(0)) wake();
    });
    this.exited = new Promise((resolve) =>
      this.child.once("exit", (code, signal) => {
        this.exitedAt = Date.now();
        children.delete(this);
        for (const wake of this.#waiters.splice(0)) wake();
        resolve({ code, signal });
      }),
    );
  }

  get pid(): number {
    return this.child.pid!;
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin!.write(`${JSON.stringify(command)}\n`);
  }

  /** The first event from index `from` on that matches; rejects if the process exits or `ms` passes first. */
  async waitFor(match: (event: Event) => boolean, options: { from?: number; ms?: number } = {}): Promise<Event> {
    const deadline = Date.now() + (options.ms ?? 120_000);
    for (;;) {
      const hit = this.events.slice(options.from ?? 0).find(match);
      if (hit) return hit;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`instance exited (${this.child.exitCode ?? this.child.signalCode}) first; stderr: ${this.stderr.slice(-800)}; last: ${JSON.stringify(this.events.at(-1))}`);
      }
      if (Date.now() > deadline) throw new Error(`timed out; last event ${JSON.stringify(this.events.at(-1))}; stderr ${this.stderr.slice(-800)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        this.#waiters.push(() => (clearTimeout(timer), resolve()));
      });
    }
  }

  async opened(): Promise<Event> {
    const event = await this.waitFor((e) => e.ev === "open" || e.ev === "open-failed");
    const target = `${scratchDiskId()}:/runs/${basename(this.mountpoint)}`;
    if (event.ev === "open") ledger.mount(this.mountpoint, target);
    // A refusal after the claim was taken released it (unmounted), unless someone else on this host holds the run.
    const held = event.code === "OWNER_LOCK_HELD" || event.code === "STORE_BUSY";
    if (event.ev === "open-failed" && (event.steps as Record<string, number>).acquire !== undefined && !held) {
      ledger.mount(this.mountpoint, target);
      ledger.unmounted(this.mountpoint, `archil (the instance released its claim after ${String(event.code)})`);
    }
    return event;
  }

  async released(): Promise<Event> {
    const event = await this.waitFor((e) => e.ev === "released");
    await this.exited;
    ledger.unmounted(this.mountpoint, "archil (release)");
    return event;
  }

  async mark(n: number): Promise<Event> {
    const from = this.events.length;
    this.send({ op: "mark", n });
    return this.waitFor((e) => e.ev === "marked" && e.n === n, { from });
  }

  async list(): Promise<{ marks: Array<{ n: number; writer: string }>; toolResults: string[]; integrity: string; seq: number }> {
    const from = this.events.length;
    this.send({ op: "list" });
    return (await this.waitFor((e) => e.ev === "list", { from })) as never;
  }
}

async function start(options: Omit<ConstructorParameters<typeof Instance>[0], "token"> & { token?: string }): Promise<Instance> {
  return new Instance({ ...options, token: options.token ?? (await token(`${options.writer}`)) });
}

function readExecLog(file: string): Array<{ writer: string; n: number }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Polls until process `pid` (any user's) is gone or a zombie; true if it went within `ms`. */
async function procGone(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    let stat = "";
    try {
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return true;
    }
    if (/^\d+ \(.*\) Z/.test(stat)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** `ls -A` of a directory: what is on the local disk under a mountpoint once its mount is gone. */
function lsA(dir: string): string[] {
  const r = spawnSync("ls", ["-A", dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split("\n").filter(Boolean);
}

/**
 * An instance with a command running, whose mount `takeAway` then removes. The instance must exit 75 at its next
 * heartbeat (CLAIM_UNMOUNTED), its command must die, and nothing may appear on the local disk under the mountpoint.
 */
async function mountTakenAway(name: string, takeAway: (mountpoint: string, daemon: number) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const id = await newRun(name);
  const execLog = join(WORK, `exec-${id}.jsonl`);
  const lease = { heartbeatMs: 1_000, expiryMs: 10_000, marginMs: 2_000, checkMs: 100 };
  const a = await start({ id, root: ROOT_A, writer: "A", lease, execLog });
  assert.equal((await a.opened()).ev, "open");
  for (let n = 1; n <= 3; n++) await a.mark(n);
  a.send({ op: "sleeper" });
  const sleeper = (await a.waitFor((e) => e.ev === "sleeper")).pid as number;
  const daemon = daemonPid(a.mountpoint);
  const mounted = lsA(a.mountpoint);
  assert.ok(["owner.lock", "run.json", "store", "work"].every((f) => mounted.includes(f)), `the mount as the instance holds it: ${mounted.join(" ")}`);
  const takenAt = Date.now();
  const how = await takeAway(a.mountpoint, daemon);
  const exit = await a.exited;
  const exitAfterMs = a.exitedAt - takenAt;
  const listedAtExit = archilMounts().includes(a.mountpoint);
  assert.equal(exit.code, 75, a.stderr);
  assert.match(a.stderr, /fenced \(CLAIM_UNMOUNTED\)/);
  assert.ok(exitAfterMs <= lease.heartbeatMs + 1_500, `exit ${exitAfterMs} ms after the mount was taken away; the next heartbeat is at most ${lease.heartbeatMs} ms away`);
  assert.ok(await waitGone(sleeper), "the command died");
  const daemonExitedOnItsOwn = await procGone(daemon, 15_000);
  if (!daemonExitedOnItsOwn) {
    spawnSync("sudo", ["-n", "kill", "-KILL", String(daemon)]);
    ledger.event("killed a detached mount's daemon", { mountpoint: a.mountpoint, daemon, gone: await procGone(daemon, 5_000) });
  }
  const listedAfter = archilMounts().includes(a.mountpoint);
  if (listedAfter) {
    // A dead mount hides the directory under it: take it off without removing the directory, to look at the local disk.
    const r = spawnSync("sudo", ["-n", "fusermount", "-u", a.mountpoint], { encoding: "utf8" });
    if (archilMounts().includes(a.mountpoint)) ledger.event("fusermount -u left a dead mount listed", { mountpoint: a.mountpoint, stderr: r.stderr.slice(0, 200), cleanedBy: await cleanMount(a.mountpoint) });
    else ledger.unmounted(a.mountpoint, "fusermount -u by the test (a dead mount stayed listed)");
  } else if (how.takenAwayBy !== "umount -l") ledger.unmounted(a.mountpoint, `left the mount table after ${String(how.takenAwayBy)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const local = lsA(a.mountpoint);
  assert.deepEqual(local, [], "nothing on the local disk under the mountpoint");
  const record = await runJsonOverS3(id);
  assert.equal(record.status, "running");
  assert.ok(Date.parse(record.heartbeatAt!) <= takenAt, "every heartbeat on the disk began before the mount was taken away");
  return { lease, mounted, ...how, listedAtExit, listedAfter, exitAfterMs, fence: /fenced \(([A-Z_]+)\)/.exec(a.stderr)?.[1], local, daemonExitedOnItsOwn, lastHeartbeatBeforeMs: takenAt - Date.parse(record.heartbeatAt!) };
}

async function runJsonOverS3(id: string): Promise<RunRecord> {
  return parseRunRecord(new TextDecoder().decode(await (await control()).getObject(`runs/${id}/run.json`)));
}

/** A short claim from the parent (a third client), for snapshots and independent reads; released by `use`'s end. */
async function withClaim<T>(id: string, purpose: string, use: (claim: Claim) => Promise<T>): Promise<T> {
  const claim = await acquire({ ref: ref(id), token: await token(purpose), mountRoot: ROOT_C });
  ledger.mount(claim.root, `${scratchDiskId()}:/runs/${id}`);
  try {
    return await use(claim);
  } finally {
    const { via } = await claim.release();
    ledger.unmounted(claim.root, via);
  }
}

before(() => {
  if (!LIVE) return;
  prepareBase();
  mkdirSync(WORK, { recursive: true, mode: 0o755 });
});

after(async () => {
  if (!LIVE) return;
  for (const instance of children) instance.child.kill("SIGKILL");
  await Promise.all([...children].map((i) => i.exited));
  results.cleanup = await cleanupAll();
  rmSync(WORK, { recursive: true, force: true });
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
});

test("the owner lock on a mount: a second instance on the same host is refused 76 and the first keeps committing", { skip: !LIVE }, async () => {
  const id = await newRun("lock");
  const execLog = join(WORK, `exec-${id}.jsonl`);
  const a = await start({ id, root: ROOT_A, writer: "A", execLog });
  assert.equal((await a.opened()).ev, "open");
  await a.mark(1);
  const second = await start({ id, root: ROOT_A, writer: "A2", token: "spent", execLog });
  const refused = await second.opened();
  assert.equal(refused.ev, "open-failed");
  assert.deepEqual([refused.code, refused.exitCode], ["OWNER_LOCK_HELD", 76]);
  assert.equal((await second.exited).code, 76);
  await a.mark(2);
  a.send({ op: "sleeper" });
  const sleeper = (await a.waitFor((e) => e.ev === "sleeper")).pid as number;
  a.send({ op: "release" });
  const released = await a.released();
  assert.equal((released.record as RunRecord).status, "paused");
  assert.ok(await waitGone(sleeper), "release killed the command, so the mount was not busy");
  results.ownerLock = { refused: refused.code, exitCode: refused.exitCode, stepsBeforeRefusal: refused.steps, releaseWithCommandMs: released.releaseMs };
});

test("T4 fence: an instance stopped and taken over exits 75 at its next commit; no tool executes after its failed intent", { skip: !LIVE, timeout: 600_000 }, async () => {
  const id = await newRun("fence");
  const execLog = join(WORK, `exec-${id}.jsonl`);
  // A long heartbeat keeps run.json out of the way: the store's commit is what meets the fence here.
  const quiet = { heartbeatMs: 120_000, expiryMs: 600_000, marginMs: 15_000 };
  const a = await start({ id, root: ROOT_A, writer: "A", lease: quiet, execLog });
  const openA = await a.opened();
  assert.equal(openA.ev, "open", JSON.stringify(openA));
  a.send({ op: "sleeper" });
  const sleeper = (await a.waitFor((e) => e.ev === "sleeper")).pid as number;
  for (const n of [1, 2, 3]) await a.mark(n);
  a.send({ op: "turn", n: 1 });
  await a.waitFor((e) => e.ev === "turned" && e.n === 1);
  assert.deepEqual(readExecLog(execLog).map((x) => [x.writer, x.n]), [["A", 1]], "the tool runs and logs its execute()");
  a.send({ op: "turn", n: 2, gate: true });
  await a.waitFor((e) => e.ev === "gated" && e.n === 2);
  process.kill(a.pid, "SIGSTOP");

  const t0 = performance.now();
  const revoked = await revokeRun(id);
  const revokeMs = performance.now() - t0;
  assert.equal(revoked, 1);
  const b = await start({ id, root: ROOT_B, writer: "B", execLog });
  const openB = await b.opened();
  assert.equal(openB.ev, "open", JSON.stringify(openB));
  const openBMs = performance.now() - t0;
  await b.mark(100);
  const firstCommitMs = performance.now() - t0;
  b.send({ op: "idle" });
  await b.waitFor((e) => e.ev === "idle");

  process.kill(a.pid, "SIGCONT");
  const tCont = performance.now();
  a.send({ op: "go" });
  const exitA = await a.exited;
  const fenceMs = performance.now() - tCont;
  assert.equal(exitA.code, 75, a.stderr);
  assert.match(a.stderr, /fenced \(STORE_FENCED\): store fenced by SQLite result code 1034/);
  assert.ok(a.events.some((e) => e.ev === "going"), "A resumed and opened its gate");
  assert.ok(await waitGone(sleeper), "A's command died with the fence");

  const executed = readExecLog(execLog);
  assert.deepEqual(executed.map((x) => [x.writer, x.n]), [["A", 1], ["B", 2]], `call 2 ran once, on B; A never executed it after its intent failed. A: ${JSON.stringify(a.events)} B: ${JSON.stringify(b.events)}`);

  const listed = await b.list();
  assert.equal(listed.integrity, "ok");
  assert.deepEqual(listed.marks.map((m) => [m.writer, m.n]), [["B", 100], ["A", 3], ["A", 2], ["A", 1]]);
  assert.deepEqual(listed.toolResults.map((r) => /marked \d+ by \w+/.exec(r)?.[0]).reverse(), ["marked 1 by A", "marked 2 by B"], listed.toolResults.join("\n"));
  b.send({ op: "release" });
  const sealed = (await b.released()).record as RunRecord;
  assert.equal(sealed.generation, 2);
  assert.ok(sealed.sealedSeq !== null);
  assert.equal(await cleanMount(a.mountpoint), "archil", "the fenced client's mount still unmounts cleanly");

  // An independent reader after the release: the store B sealed is intact and holds none of A's later rows.
  const independent = await withClaim(id, "fence-read", async (claim) => {
    const store = await openArchilStore(join(claim.store, STORE_FILE));
    try {
      const integrity = await store.database.get<{ integrity_check: string }>("PRAGMA integrity_check");
      const page = await store.storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1000, undefined, ctx);
      const marks = page.items.filter((e) => e.kind === "p4.mark").map((e) => e.data as { writer: string; n: number });
      return { integrity: integrity?.integrity_check, entries: page.items.length, marks: marks.map((m) => `${m.writer}${m.n}`) };
    } finally {
      await store.storage.close(ctx);
    }
  });
  assert.equal(independent.integrity, "ok");
  assert.deepEqual(independent.marks.sort(), ["A1", "A2", "A3", "B100"]);
  results.t4 = {
    revokeMs: r1(revokeMs),
    newInstanceOpenMs: r1(openBMs),
    newInstanceSteps: openB.steps,
    takeoverToFirstCommitMs: r1(firstCommitMs),
    sigcontToExit75Ms: r1(fenceMs),
    stoppedFor: r1(tCont - t0),
    executed,
    independentRead: independent,
  };
});

test("T5 host loss: kill -9 an instance and its FUSE daemon together, revoke, resume on the other mount; nothing acknowledged is lost (10 rounds)", { skip: !LIVE, timeout: 900_000 }, async () => {
  const id = await newRun("hostloss");
  const execLog = join(WORK, `exec-${id}.jsonl`);
  const acked = new Set<number>();
  const rounds: Array<Record<string, number>> = [];
  let root = ROOT_A;
  let current = await start({ id, root, writer: "w0", execLog });
  assert.equal((await current.opened()).ev, "open");
  let from = 1;
  for (let round = 0; round < 10; round++) {
    const burst = { from, count: 400 };
    const mark = current.events.length;
    current.send({ op: "marks", ...burst });
    const killAfter = 20 + 7 * round;
    await current.waitFor((e) => e.ev === "marked" && (e.n as number) >= from + killAfter - 1, { from: mark });
    const daemon = daemonPid(current.mountpoint);
    const tKill = performance.now();
    spawnSync("sudo", ["-n", "kill", "-9", String(daemon), String(current.pid)]);
    await current.exited;
    const ackedThisRound = current.events.slice(mark).filter((e) => e.ev === "marked").map((e) => e.n as number);
    for (const n of ackedThisRound) acked.add(n);
    from += burst.count;
    await revokeRun(id);
    const via = await cleanMount(current.mountpoint);
    root = root === ROOT_A ? ROOT_B : ROOT_A;
    current = await start({ id, root, writer: `w${round + 1}`, execLog });
    const opened = await current.opened();
    assert.equal(opened.ev, "open", JSON.stringify(opened));
    const resumedMs = performance.now() - tKill;
    const listed = await current.list();
    const present = new Set(listed.marks.map((m) => m.n));
    const missing = [...acked].filter((n) => !present.has(n));
    assert.deepEqual(missing, [], `round ${round}: acknowledged commits missing after the host loss`);
    assert.equal(listed.integrity, "ok");
    const committedNotAcked = listed.marks.filter((m) => m.n >= burst.from && m.n < burst.from + burst.count && !acked.has(m.n)).length;
    rounds.push({ round, acked: ackedThisRound.length, committedNotAcked, present: present.size, killToOpenMs: r1(resumedMs), deadMountByFusermount: via === "fusermount" ? 1 : 0, generation: opened.generation as number });
  }
  current.send({ op: "release" });
  await current.released();
  results.t5 = { rounds, ackedTotal: acked.size, lost: 0 };
});

test("T14 self-fence: heartbeats blocked while commits flow; commands die and the instance exits 75 by the deadline", { skip: !LIVE, timeout: 300_000 }, async () => {
  const id = await newRun("selffence");
  const execLog = join(WORK, `exec-${id}.jsonl`);
  const lease = { heartbeatMs: 1_000, expiryMs: 6_000, marginMs: 2_000, checkMs: 100 };
  const a = await start({ id, root: ROOT_A, writer: "A", lease, blockHeartbeat: true, execLog });
  const opened = await a.opened();
  assert.equal(opened.ev, "open");
  a.send({ op: "sleeper" });
  const sleeper = (await a.waitFor((e) => e.ev === "sleeper")).pid as number;
  let n = 0;
  const ticker = setInterval(() => a.child.exitCode === null && a.send({ op: "mark", n: ++n }), 200);
  const exit = await a.exited;
  const exitAt = Date.now();
  clearInterval(ticker);
  assert.equal(exit.code, 75, a.stderr);
  assert.match(a.stderr, /fenced \(LEASE_LAPSED\)/);
  const marked = a.events.filter((e) => e.ev === "marked");
  assert.ok(marked.length >= 10, `commits kept flowing while heartbeats were blocked (${marked.length})`);
  assert.ok(await waitGone(sleeper), "the command died");
  const sinceOpen = exitAt - (opened.t as number);
  assert.ok(sinceOpen >= 3_500 && sinceOpen <= 6_000, `exit ${sinceOpen} ms after open; the self-fence is 4000 ms after the last heartbeat started`);
  const record = await runJsonOverS3(id);
  assert.equal(record.heartbeatAt, (opened.record as RunRecord).heartbeatAt, "no heartbeat after the block");
  const via = await cleanMount(a.mountpoint);
  results.t14SelfFence = { lease, exitAfterOpenMs: sinceOpen, commitsWhileBlocked: marked.length, lastCommitBeforeExitMs: exitAt - (marked.at(-1)!.t as number), mountCleanedBy: via };
});

test("T14 watchdog: the FUSE daemon freezes during a commit; the watchdog kills the command by the deadline while the instance is stuck; at the thaw it exits 75", { skip: !LIVE, timeout: 300_000 }, async () => {
  const id = await newRun("watchdog");
  const execLog = join(WORK, `exec-${id}.jsonl`);
  const lease = { heartbeatMs: 1_000, expiryMs: 6_000, marginMs: 1_500, checkMs: 100 };
  const a = await start({ id, root: ROOT_A, writer: "A", lease, execLog });
  assert.equal((await a.opened()).ev, "open");
  a.send({ op: "sleeper" });
  const sleeper = (await a.waitFor((e) => e.ev === "sleeper")).pid as number;
  const daemon = daemonPid(a.mountpoint);
  const from = a.events.length;
  a.send({ op: "marks", from: 1, count: 1_000_000 });
  await a.waitFor((e) => e.ev === "marked" && (e.n as number) >= 20, { from });
  const frozenAt = Date.now();
  spawnSync("sudo", ["-n", "kill", "-STOP", String(daemon)]);
  let observed: Record<string, unknown>;
  try {
    while (alive(sleeper) && Date.now() - frozenAt < 15_000) await new Promise((resolve) => setTimeout(resolve, 20));
    const deadAt = Date.now();
    const stuck = a.child.exitCode === null && a.child.signalCode === null;
    const wchan = readFileSync(`/proc/${a.pid}/wchan`, "utf8");
    const acks = a.events.filter((e) => e.ev === "marked");
    const record = await runJsonOverS3(id);
    const deadline = Date.parse(record.heartbeatAt!) + lease.expiryMs - lease.marginMs;
    observed = { freezeToDeathMs: deadAt - frozenAt, killAfterDeadlineMs: deadAt - deadline, wchan, lastAckBeforeFreezeMs: frozenAt - (acks.at(-1)!.t as number), acksAfterFreeze: acks.filter((e) => (e.t as number) > frozenAt + 200).length };
    assert.equal(alive(sleeper), false, `the command outlived the self-fence: ${JSON.stringify(observed)}`);
    assert.equal(stuck, true, "the instance was still stuck in the FUSE request when its command died");
    assert.equal(observed.acksAfterFreeze, 0, "no commit completed during the freeze");
    assert.ok((observed.killAfterDeadlineMs as number) >= 0 && (observed.killAfterDeadlineMs as number) < 1_000, JSON.stringify(observed));
  } finally {
    spawnSync("sudo", ["-n", "kill", "-CONT", String(daemon)]);
    // On a failed assertion the instance still fences at the thaw; never leave its command holding the mount.
    await Promise.race([a.exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    killQuietly(sleeper);
  }
  const thawedAt = Date.now();
  const exit = await a.exited;
  const exitAfterThawMs = Date.now() - thawedAt;
  assert.equal(exit.code, 75, a.stderr);
  assert.match(a.stderr, /fenced \(LEASE_LAPSED\).*seen by the watchdog/);
  const via = await cleanMount(a.mountpoint);
  results.t14Watchdog = { lease, ...observed, exitAfterThawMs, mountCleanedBy: via };
});

test("T14 seal: release, rewind the store by one commit, reopen: refused STORE_BEHIND_SEAL and marked failed", { skip: !LIVE, timeout: 300_000 }, async () => {
  const id = await newRun("seal");
  const execLog = join(WORK, `exec-${id}.jsonl`);
  const snapshot = join(WORK, `store-${id}`);
  const a = await start({ id, root: ROOT_A, writer: "A", execLog });
  assert.equal((await a.opened()).ev, "open");
  for (let n = 1; n <= 5; n++) await a.mark(n);
  a.send({ op: "release" });
  const s1 = ((await a.released()).record as RunRecord).sealedSeq!;
  assert.equal((await runJsonOverS3(id)).sealedSeq, s1, "the seal is visible to the supervisor over S3");

  await withClaim(id, "seal-snapshot", async (claim) => {
    mkdirSync(snapshot, { recursive: true });
    for (const f of readdirSync(claim.store)) copyFileSync(join(claim.store, f), join(snapshot, f));
  });

  const b = await start({ id, root: ROOT_B, writer: "B", execLog });
  assert.equal((await b.opened()).ev, "open");
  await b.mark(6);
  b.send({ op: "release" });
  const s2 = ((await b.released()).record as RunRecord).sealedSeq!;
  assert.equal(s2, s1 + 1, "the second incarnation made exactly one commit");

  await withClaim(id, "seal-rewind", async (claim) => {
    for (const f of readdirSync(claim.store)) rmSync(join(claim.store, f));
    for (const f of readdirSync(snapshot)) copyFileSync(join(snapshot, f), join(claim.store, f));
  });

  const refusals: unknown[] = [];
  for (const [writer, root] of [["C", ROOT_A], ["D", ROOT_B]] as const) {
    const c = await start({ id, root, writer, execLog });
    const refused = await c.opened();
    assert.equal(refused.ev, "open-failed");
    assert.deepEqual([refused.code, refused.exitCode], ["STORE_BEHIND_SEAL", 65]);
    assert.equal((await c.exited).code, 65);
    const record = await runJsonOverS3(id);
    assert.equal(record.status, "failed");
    assert.equal(record.sealedSeq, s2, "the seal is kept as evidence");
    assert.deepEqual(record.detail, { code: "STORE_BEHIND_SEAL", sealedSeq: s2, head: s1 });
    assert.deepEqual(await (await control()).listDelegations().then((all) => all.filter((d) => d.path?.includes(id))), [], "the refused instance released its claim");
    refusals.push({ writer, steps: refused.steps, record: { status: record.status, generation: record.generation } });
  }
  results.t14Seal = { s1, s2, refusals };
});

test("P4c lazy unmount: the mount is lazily unmounted under a live instance; it exits 75 at its next heartbeat and nothing lands on the local disk under the mountpoint", { skip: !LIVE, timeout: 300_000 }, async () => {
  results.p4cLazyUnmount = await mountTakenAway("lazy", async (mountpoint) => {
    const r = spawnSync("sudo", ["-n", "umount", "-l", mountpoint], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    ledger.unmounted(mountpoint, "umount -l by the test (the detached mount lives until its last descriptor closes)");
    assert.equal(archilMounts().includes(mountpoint), false, "the mount left the table at once");
    return { takenAwayBy: "umount -l" };
  });
});

for (const signal of ["KILL", "TERM"] as const) {
  test(`P4c daemon death (SIG${signal}): the FUSE daemon dies under a live instance (dead, or unmounted by its client); it exits 75 at its next heartbeat and nothing lands on the local disk`, { skip: !LIVE, timeout: 300_000 }, async () => {
    results[`p4cDaemon${signal}`] = await mountTakenAway(`daemon-${signal.toLowerCase()}`, async (_mountpoint, daemon) => {
      const r = spawnSync("sudo", ["-n", "kill", `-${signal}`, String(daemon)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return { takenAwayBy: `SIG${signal} to the FUSE daemon` };
    });
  });
}
