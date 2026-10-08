// Sleep parking and drain without Archil: the classification and the deadline reader on synthetic inspections, then
// Rivet's lifecycle cases (rivet-dev/agents, packages/pi/tests/durable-actor.test.ts) as specs on a real pi Harness over
// a local "disk", each incarnation a fresh Harness on the same store.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessInspection, SubmissionId, TaskInspection } from "@earendil-works/pi-durable";
import { Harness } from "@earendil-works/pi-durable";
import { serveUntilDone } from "../src/cli.ts";
import { busyState, drain, leaseParkTarget, recordWake, waitDeadline, watchParking } from "../src/park.ts";
import { openRunLease, STORE_FILE } from "../src/run.ts";
import { openArchilStore } from "../src/store.ts";
import { parseRunRecord, RUN_JSON, type RunRecord } from "../src/status.ts";
import { ensureRunning } from "../src/supervise.ts";
import { InProcessHost, JobTask, lifecycleApp, LocalDisk, newCounters, openOn, sleep, until } from "./_lifecycle.ts";
import { ctx, localClaimDir } from "./_run-support.ts";

const REF = { disk: "dsk-local", region: "local", id: "park-1" };
const FENCE_APP = fileURLToPath(new URL("./fixtures/park-fence.ts", import.meta.url));
const runJson = (disk: LocalDisk): RunRecord => parseRunRecord(readFileSync(join(disk.path(`runs/${REF.id}`), RUN_JSON), "utf8"));

function task(kind: string, checkpoint?: unknown, recordStatus = "running"): TaskInspection {
  return {
    record: { id: 1, kind: "pi.generation", state: { status: recordStatus, checkpoint } } as never,
    state: (kind === "blocked" ? { kind, reason: "missing_task" } : kind === "waiting" ? { kind, on: [] } : { kind }) as never,
  };
}
const inspection = (tasks: TaskInspection[], extra: Partial<HarnessInspection> = {}): HarnessInspection => ({ scheduling: "running", tasks, submissions: [], ...extra });

describe("the deadline reader and the classification", () => {
  it("reads until in pi's retry phase and pollAt in its poll phase, and nothing else", () => {
    assert.equal(waitDeadline({ phase: "retry", attempt: 1, until: 5_000 }), 5_000);
    assert.equal(waitDeadline({ phase: "poll", attempt: 1, pollAt: 7_000, handle: {} }), 7_000);
    for (const other of [{ phase: "request", until: 5 }, { phase: "retry" }, { phase: "retry", until: "5" }, { phase: "poll", pollAt: Number.NaN }, null, [], "retry", 3, undefined]) {
      assert.equal(waitDeadline(other as never), undefined, JSON.stringify(other));
    }
  });

  it("a running or ready task keeps the instance up unless it only sleeps past the threshold; the nearest deadline wins", () => {
    const now = 1_000;
    assert.deepEqual(busyState(inspection([task("running", { phase: "request" })]), now, 100), { kind: "busy" });
    assert.deepEqual(busyState(inspection([task("ready", { phase: "prepare" })]), now, 100), { kind: "busy" });
    assert.deepEqual(busyState(inspection([task("running", { phase: "retry", until: 1_100 })]), now, 100), { kind: "busy" }, "a wait no longer than the threshold");
    assert.deepEqual(busyState(inspection([task("running", { phase: "retry", until: 1_101 })]), now, 100), { kind: "waiting", until: 1_101 });
    assert.deepEqual(
      busyState(inspection([task("running", { phase: "retry", until: 9_000 }), task("ready", { phase: "poll", pollAt: 5_000 })]), now, 100),
      { kind: "waiting", until: 5_000 },
    );
    assert.deepEqual(busyState(inspection([task("running", { phase: "retry", until: 9_000 }), task("running", { phase: "tools" })]), now, 100), { kind: "busy" });
  });

  it("waiting, completing and blocked tasks do not keep it up; unknown states, a closing Harness and orphan submissions do", () => {
    assert.deepEqual(busyState(inspection([task("waiting"), task("completing"), task("blocked")]), 0, 100), { kind: "idle" });
    assert.deepEqual(busyState(inspection([]), 0, 100), { kind: "idle" });
    assert.deepEqual(busyState(inspection([task("sleeping", { phase: "retry", until: 9e9 })]), 0, 100), { kind: "busy" }, "a state a later pi adds");
    assert.deepEqual(busyState(inspection([], { scheduling: "closing" }), 0, 100), { kind: "busy" });
    assert.deepEqual(busyState(inspection([], { submissions: [{ id: 1 as SubmissionId, conversationId: 0, type: "input", status: "queued" }] as never }), 0, 100), { kind: "busy" });
  });
});

describe("Rivet's lifecycle cases on a claim", () => {
  it("a long retry wait parks the run with its wake written before the release, and the wake at the deadline finishes the run", async () => {
    const disk = new LocalDisk("park-wake");
    const counters = newCounters();
    const app = lifecycleApp(counters, { retryMs: 1_500 });
    try {
      const first = await openOn(disk, REF, app);
      const parking = watchParking(first, { thresholdMs: 500 });
      const conversation = await first.harness.root(ctx, { agent: app.agent });
      const submission = await conversation.submit({ type: "input", content: "flaky" }, ctx);
      const parked = await parking.parked;
      const claim = disk.claims[0]!;
      assert.equal(counters.requests, 1);
      assert.ok(parked.wakeAt !== null && parked.wakeAt > Date.now(), "the wake is the retry's deadline");
      const record = runJson(disk);
      assert.equal(record.status, "sleeping");
      assert.equal(Date.parse(record.wakeAt!), parked.wakeAt);
      assert.ok(record.sealedSeq !== null, "the release sealed it");
      assert.ok(claim.log.indexOf("run.json sleeping") >= 0 && claim.log.indexOf("run.json sleeping") < claim.log.indexOf("release"), `wake before release: ${claim.log.join(", ")}`);
      assert.equal(disk.delegations.length, 0);

      // The supervisor leaves it until its wakeAt, then starts it; pi's own timer sleeps what is left of the wait.
      let second: Awaited<ReturnType<typeof openOn>> | undefined;
      const host = new InProcessHost(async (ref) => void (second = await openOn(disk, ref, lifecycleApp(counters, { retryMs: 1_500 }))));
      const early = await ensureRunning(REF, host, { control: disk, now: () => parked.wakeAt! - 1 });
      assert.equal(early.action, "sleeping");
      const due = await ensureRunning(REF, host, { control: disk, now: () => parked.wakeAt! });
      assert.equal(due.action === "started" && due.woke, true);
      const settled = await (await second!.harness.submission(submission.id, ctx))!.wait(ctx);
      assert.equal(settled.status, "done");
      assert.ok(Date.now() >= parked.wakeAt!, "the retried request waited for the deadline");
      assert.equal(counters.requests, 2);
      assert.equal(second!.generation, 2);
      const { messages } = await (await second!.harness.root(ctx)).context(ctx);
      assert.deepEqual(messages.at(-1)?.role === "assistant" ? messages.at(-1)!.content : null, [{ type: "text", text: "recovered" }]);
      await second!.release();
    } finally {
      disk.remove();
    }
  });

  it("a long retry wait whose wake cannot be recorded keeps the instance up until the run finishes", async () => {
    const disk = new LocalDisk("park-nowake");
    const counters = newCounters();
    const app = lifecycleApp(counters, { retryMs: 1_200 });
    const logs: string[] = [];
    try {
      const run = await openOn(disk, REF, app);
      const parking = watchParking(run, { thresholdMs: 300, wake: async () => Promise.reject(new Error("the scheduler refused")), log: (e) => void logs.push(e) });
      const conversation = await run.harness.root(ctx, { agent: app.agent });
      const submission = await conversation.submit({ type: "input", content: "flaky" }, ctx);
      const settled = await submission.wait(ctx);
      assert.equal(settled.status, "done");
      assert.equal(counters.requests, 2, "pi's own timer ended the wait on this instance");
      assert.ok(logs.includes("wake not recorded; staying up through the wait"), logs.join(", "));
      assert.equal(disk.claims[0]!.log.includes("release"), false);
      assert.equal(runJson(disk).status, "running");
      assert.equal(run.generation, 1);
      assert.equal(await Promise.race([parking.parked.then(() => "parked"), sleep(50).then(() => "up")]), "up");
      await parking.stop();
      await run.release();
    } finally {
      disk.remove();
    }
  });

  it("a wake whose run.json write fails is a fence: exit 75 without a release, and the next incarnation finishes the wait", async () => {
    const disk = new LocalDisk("park-fence");
    try {
      const root = disk.path(`runs/${REF.id}`);
      mkdirSync(root, { recursive: true });
      const child = spawnSync(process.execPath, [FENCE_APP, root], { encoding: "utf8", timeout: 20_000, env: { ...process.env } });
      assert.equal(child.status, 75, child.stderr);
      assert.match(child.stderr, /fenced \(FENCED\): writing .*run\.json failed/);
      const lines = child.stdout.trim().split("\n").map((l) => JSON.parse(l) as { submission?: number; released?: boolean });
      assert.equal(lines.some((l) => l.released), false, "a fenced run is never released or sealed");
      const submission = lines.find((l) => l.submission !== undefined)!.submission as SubmissionId;
      const record = runJson(disk);
      assert.equal(record.status, "running", "the failed write never renamed over run.json");
      assert.equal(record.sealedSeq, null);
      // The supervisor starts it again after the lease; the store kept the wait.
      const counters = { ...newCounters(), flaky: 1 };
      const second = await openOn(disk, REF, lifecycleApp(counters, { retryMs: 1_200 }));
      assert.equal((await (await second.harness.submission(submission, ctx))!.wait(ctx)).status, "done");
      assert.equal(counters.requests, 1, "only the retried request ran here");
      assert.equal(second.generation, 2);
      await second.release();
    } finally {
      disk.remove();
    }
  });

  it("a task whose definition is gone is reported blocked and does not keep the instance up; a running one does", async () => {
    const disk = new LocalDisk("park-blocked");
    const counters = newCounters();
    const app = lifecycleApp(counters);
    try {
      const first = await openOn(disk, REF, app);
      const root = await first.harness.root(ctx, { agent: app.agent });
      await first.harness.commit((tx) => tx.createTask(JobTask, {}, { ownership: { kind: "conversation" }, conversationId: root.id }), ctx);
      const busy = watchParking(first, { thresholdMs: 100, idleMs: 50 });
      await sleep(300);
      assert.equal(disk.claims[0]!.log.includes("release"), false, "a running task keeps it up");
      assert.equal((await first.harness.inspect(ctx)).tasks[0]?.state.kind, "running");
      await busy.stop();
      await first.release();

      const logs: { event: string; detail: Record<string, unknown> }[] = [];
      const second = await openOn(disk, REF, lifecycleApp(counters, { jobs: false }));
      const inspected = await second.harness.inspect(ctx);
      assert.deepEqual(inspected.tasks.map((t) => [t.record.kind, t.state.kind]), [["app.job", "blocked"]]);
      const parked = await watchParking(second, { thresholdMs: 100, idleMs: 50, log: (event, detail) => void logs.push({ event, detail }) }).parked;
      assert.deepEqual(parked, { wakeAt: null, blocked: 1 });
      assert.equal(logs[0]?.event, "blocked task does not keep the instance up");
      assert.equal(logs[0]?.detail.kind, "app.job");
      const record = runJson(disk);
      assert.equal(record.status, "sleeping");
      assert.equal(record.wakeAt, null);
      // Idle: no timer wakes it; a request (demand) does.
      const host = new InProcessHost(async (ref) => void (await openOn(disk, ref, lifecycleApp(counters)).then((r) => r.release())));
      assert.equal((await ensureRunning(REF, host, { control: disk })).action, "sleeping");
      assert.equal((await ensureRunning(REF, host, { control: disk, demand: true })).action, "started");
    } finally {
      disk.remove();
    }
  });

  it("a run stopped at the drain deadline resumes: safe tools rerun, unsafe tools report the interruption", async () => {
    const disk = new LocalDisk("park-drain");
    const counters = newCounters();
    const app = lifecycleApp(counters);
    try {
      const first = await openOn(disk, REF, app);
      const conversation = await first.harness.root(ctx, { agent: app.agent });
      const submission = await conversation.submit({ type: "input", content: "use both tools" }, ctx);
      await until("both tools running", () => counters.safe === 1 && counters.unsafe === 1);
      const t0 = Date.now();
      const state = await drain(first, { deadline: t0 + 300 });
      assert.deepEqual(state, { kind: "busy" });
      assert.ok(Date.now() - t0 >= 290, `the drain waited for its deadline (${Date.now() - t0} ms)`);
      await recordWake(first, Date.now());
      await first.release();

      const second = await openOn(disk, REF, lifecycleApp(counters));
      const settled = await (await second.harness.submission(submission.id, ctx))!.wait(ctx);
      assert.equal(settled.status, "done");
      assert.deepEqual({ safe: counters.safe, unsafe: counters.unsafe }, { safe: 2, unsafe: 1 });
      const { messages } = await (await second.harness.root(ctx)).context(ctx);
      const results = messages.filter((m) => m.role === "toolResult");
      const safe = results.find((m) => m.role === "toolResult" && m.toolName === "safe_tool");
      const unsafe = results.find((m) => m.role === "toolResult" && m.toolName === "unsafe_tool");
      assert.equal(safe?.role === "toolResult" && safe.isError, false);
      assert.equal(unsafe?.role === "toolResult" && unsafe.isError, true);
      assert.match(JSON.stringify(unsafe?.content), /interrupted/);
      const finished = messages.filter((m) => m.role === "assistant" && m.content.some((b) => b.type === "text" && b.text === "finished"));
      assert.equal(finished.length, 1);
      await second.release();
    } finally {
      disk.remove();
    }
  });
});

describe("parking a Harness the host owns over openRunLease", () => {
  it("the wake goes through the lease's setStatus, and the release closes the host's Harness and then the lease", async () => {
    const disk = new LocalDisk("park-lease");
    const counters = newCounters();
    const app = lifecycleApp(counters, { retryMs: 1_500 });
    try {
      const lease = await openRunLease(REF, { mountToken: "unused", acquire: async () => disk.acquire(REF), claimDir: localClaimDir, onFenced: () => {} });
      const store = await openArchilStore(join(lease.claim.store, STORE_FILE), "exclusive", { onFenced: (error) => void lease.fence(error) });
      await lease.checkSeal(store);
      const harness = await Harness.open(lease.observe(store.storage), { models: app.models, registry: app.registry, settings: app.settings }, ctx);
      await lease.live();
      harness.resume();
      const parking = watchParking(leaseParkTarget(lease, harness), { thresholdMs: 500 });
      const conversation = await harness.root(ctx, { agent: app.agent });
      const submission = await conversation.submit({ type: "input", content: "flaky" }, ctx);
      const parked = await parking.parked;
      const record = runJson(disk);
      assert.deepEqual([record.status, Date.parse(record.wakeAt!)], ["sleeping", parked.wakeAt]);
      assert.equal(record.sealedSeq !== null, true, "the lease sealed what the observed commits reached");
      assert.equal(disk.delegations.length, 0);
      await assert.rejects(harness.inspect(ctx), "the host's Harness is closed");

      const second = await openOn(disk, REF, lifecycleApp(counters, { retryMs: 1_500 }));
      assert.equal((await (await second.harness.submission(submission.id, ctx))!.wait(ctx)).status, "done");
      assert.equal(counters.requests, 2);
      await second.release();
    } finally {
      disk.remove();
    }
  });
});

describe("parking around the rest of the instance", () => {
  it("a drain ends as soon as nothing runs, well before its deadline", async () => {
    const disk = new LocalDisk("park-drain-early");
    const counters = newCounters();
    const app = lifecycleApp(counters);
    try {
      const run = await openOn(disk, REF, app);
      const conversation = await run.harness.root(ctx, { agent: app.agent });
      await conversation.submit({ type: "input", content: "hello" }, ctx);
      const t0 = Date.now();
      assert.deepEqual(await drain(run, { deadline: t0 + 10_000 }), { kind: "idle" });
      assert.ok(Date.now() - t0 < 5_000);
      await run.release();
    } finally {
      disk.remove();
    }
  });

  it("an open request keeps it up; a park called off at the last check undoes its quiesce", async () => {
    const disk = new LocalDisk("park-awake");
    const counters = newCounters();
    const app = lifecycleApp(counters, { retryMs: 3_000 });
    try {
      const run = await openOn(disk, REF, app);
      let awake = true;
      let quiesced = 0;
      let undone = 0;
      let flipOnQuiesce = false;
      const parking = watchParking(run, {
        thresholdMs: 200,
        keepAwake: () => awake,
        quiesce: () => {
          quiesced++;
          if (flipOnQuiesce) awake = true;
          return () => void undone++;
        },
      });
      const conversation = await run.harness.root(ctx, { agent: app.agent });
      await conversation.submit({ type: "input", content: "flaky" }, ctx);
      await until("the retry wait", async () => (await run.harness.inspect(ctx)).tasks.some((t) => waitDeadline(t.record.state.checkpoint) !== undefined));
      await sleep(100);
      assert.equal(quiesced, 0, "no attempt while a request is open");
      // The request ends, but another one arrives just as the park stops admission.
      awake = false;
      flipOnQuiesce = true;
      parking.check();
      await until("the attempt", () => quiesced === 1);
      await sleep(50);
      assert.equal(undone, 1);
      assert.equal(disk.claims[0]!.log.includes("release"), false);
      flipOnQuiesce = false;
      awake = false;
      parking.check();
      const parked = await parking.parked;
      assert.ok(parked.wakeAt !== null);
      assert.equal(quiesced, 2);
      assert.equal(undone, 1, "a park that went through keeps admission closed");
    } finally {
      disk.remove();
    }
  });

  it("an idle run parks after its idle period, counted again from the end of the last open request", async () => {
    const disk = new LocalDisk("park-idle");
    try {
      const run = await openOn(disk, REF, lifecycleApp(newCounters()));
      let awake = false;
      const parking = watchParking(run, { thresholdMs: 60_000, idleMs: 300, keepAwake: () => awake });
      await sleep(100);
      // A request opens before the idle period ends and stays open past it.
      awake = true;
      await sleep(500);
      assert.equal(disk.claims[0]!.log.includes("release"), false, "an open request holds it past its idle period");
      awake = false;
      const freed = Date.now();
      parking.check();
      const parked = await parking.parked;
      assert.deepEqual(parked, { wakeAt: null, blocked: 0 });
      assert.ok(Date.now() - freed >= 290, `idle counted again from the request's end (${Date.now() - freed} ms)`);
      assert.equal(runJson(disk).wakeAt, null);
    } finally {
      disk.remove();
    }
  });

  it("an instance that parks exits 0, though the app's work rejects as the park's release closes the Harness under it", async () => {
    const disk = new LocalDisk("park-exit");
    const counters = newCounters();
    const app = lifecycleApp(counters, { retryMs: 1_500 });
    try {
      const run = await openOn(disk, REF, app);
      // An unmount that takes a while, as a real one does: the app's rejection lands well inside the release.
      const claim = disk.claims[0]!;
      const unmount = claim.release.bind(claim);
      (claim as { release: typeof unmount }).release = async () => (await sleep(200), unmount());
      const events: string[] = [];
      let appRejected = false;
      // The app keeps committing for the instance's life; once the Harness closes, its next commit rejects.
      const onOpen = async () => {
        const conversation = await run.harness.root(ctx, { agent: app.agent });
        await conversation.submit({ type: "input", content: "flaky" }, ctx);
        try {
          for (let n = 0; ; n++) {
            await conversation.commit(async (tx) => void (await tx.appendEntry(conversation.id, { kind: "app.tick", data: { n } })), ctx);
            await sleep(20);
          }
        } catch (error) {
          appRejected = true;
          throw error;
        }
      };
      const exit = await serveUntilDone(run, onOpen, "resume", (e) => void events.push(e), new EventEmitter(), { park: { thresholdMs: 500 } });
      assert.equal(exit, 0);
      assert.ok(events.includes("parked"), events.join(", "));
      assert.equal(events.includes("app failed"), false, "the rejection under the release is not an app failure");
      await until("the app's commit to reject", () => appRejected);
      assert.equal(runJson(disk).status, "sleeping");
      assert.equal(disk.delegations.length, 0);
    } finally {
      disk.remove();
    }
  });

  it("stop() during a park that already wrote its wake returns the park", async () => {
    const disk = new LocalDisk("park-stop");
    const counters = newCounters();
    const app = lifecycleApp(counters, { retryMs: 3_000 });
    try {
      const run = await openOn(disk, REF, app);
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let wrote = false;
      const parking = watchParking(run, {
        thresholdMs: 200,
        wake: async (r, at) => {
          await recordWake(r, at);
          wrote = true;
          await held;
        },
      });
      const conversation = await run.harness.root(ctx, { agent: app.agent });
      await conversation.submit({ type: "input", content: "flaky" }, ctx);
      await until("the wake", () => wrote);
      const stopped = parking.stop();
      release();
      const result = await stopped;
      assert.ok(result && result.wakeAt !== null);
      assert.equal(disk.delegations.length, 0);
    } finally {
      disk.remove();
    }
  });
});
