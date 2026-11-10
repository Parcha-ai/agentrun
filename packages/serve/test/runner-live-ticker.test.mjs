// A runner's live view (runner/live-ticker.ts): each loop reports its run's held state (the tools running now, with
// their streamed output; a partial answer), and the ticker writes the changed states to the store's run_live once a
// tick. The runner process (runner/main.ts startRunnerProcess) wraps its loops in the ticker, so a run on a production
// runner shows what it is doing while it does it; the ticker is closed after the runner's own close, so a run still
// going keeps its live view until its loop ends. A loop whose claim is lost (its signal aborted) writes no more of it:
// the store fences a write by its run's epoch and live lease, but a claim lost for its renews is lost before its lease
// runs out, and the old runner's ticker must not write past it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxLoops, until } from "./runner-support.mjs";

const { startRunnerProcess } = await import("../dist/runner/main.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { withLiveTicker } = await import("../dist/runner/live-ticker.js");
const { openSqliteStore } = await import("../dist/store/index.js");

function dataDir(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-live-ticker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** The server's store over `dir`, with run-1 queued. */
async function serverWithRun(t, dir) {
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(() => server.close().catch(() => {}));
  await server.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Answer." } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  return server;
}
/** A running bash's slot with `output` streamed so far: the held state a loop reports. */
const held = (output) => ({ tools: [{ callId: "call-1", name: "bash", output }] });
const liveRow = async (server) => (await server.live.read(["run-1"]))[0];

test("a run on the runner process writes its live row while its tool runs: the tool's streamed chunk is there before the tool ends", async (t) => {
  const dir = dataDir(t);
  const server = await serverWithRun(t, dir);
  // The faux loop reports its running bash's first chunk, then waits for the test's release before it goes on to its end:
  // the chunk must be in the store's live row before the test lets it end. No sleep orders this.
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const faux = fauxLoops({ turns: 1, turnMs: 5 });
  const createLoop = (deps) => {
    const inner = faux.createLoop(deps);
    return {
      ...inner,
      start: async (claim) => {
        // Past the chunk, more than the tail the live view holds back while output streams (as long as the widest form of
        // the longest secret the runner's environment holds): the chunk shows whatever the environment holds.
        deps.live?.(() => held(`first-chunk\n${"y".repeat(3_000)}`));
        await released;
        return inner.start(claim);
      },
    };
  };
  const runner = await startRunnerProcess({ dataDir: dir, name: "runner-a", createLoop });
  let closed = false;
  t.after(async () => {
    release();
    if (!closed) await runner.close();
  });
  let seen;
  try {
    await until(async () => (seen = (await liveRow(server))?.state)?.tools?.[0]?.output?.includes("first-chunk"), "the running bash's chunk in the run's live row", 15_000);
  } finally {
    release();
  }
  assert.deepEqual([seen.tools[0].callId, seen.tools[0].name, seen.tools[0].output.startsWith("first-chunk\nyyy")], ["call-1", "bash", true]);
  await until(async () => (await server.runs.get("run-1")).state === "ended" && (await server.runs.get("run-1")).runner === null, "the run ends and is released");
  assert.equal(await liveRow(server), undefined, "its live row goes when its loop ends");
  await runner.close();
  closed = true;
});

/** `store` with each live row it puts counted (its run and when), and each drop (`drops`, when given). */
function countingPuts(store, puts, drops = []) {
  return new Proxy(store, {
    get(target, key) {
      if (key === "live") {
        const live = target.live;
        return {
          ...live, read: live.read.bind(live),
          drop: async (claim) => { drops.push({ runId: claim.runId, at: Date.now() }); return live.drop(claim); },
          put: async (rows) => { for (const row of rows) puts.push({ runId: row.claim.runId, at: Date.now() }); return live.put(rows); },
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a draining runner keeps writing a run's live view until its loop ends", async (t) => {
  const dir = dataDir(t);
  const server = await serverWithRun(t, dir);
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(() => store.close().catch(() => {}));
  const puts = [];
  // The loop reports a fresh chunk every 20 ms until the test lets it end: a turn in flight the drain lets finish.
  let release = () => {};
  let reporting;
  const createLoop = (deps) => ({
    start: async () => {
      let n = 0;
      reporting = setInterval(() => deps.live?.(() => held(`chunk ${(n += 1)}\n`)), 20);
      await new Promise((resolve) => (release = resolve));
      clearInterval(reporting);
      return { state: "interrupted" };
    },
    command: async () => ({ refused: "this loop takes no commands" }),
    stop: async () => release(),
  });
  const runner = startRunner({ store: countingPuts(store, puts), createLoop, name: "runner-a", leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30, drainMs: 10_000 });
  t.after(async () => {
    clearInterval(reporting);
    release();
    await runner.close().catch(() => {});
  });
  await until(async () => (await liveRow(server))?.state?.tools?.length === 1, "the run's live row while it runs", 15_000);
  // The runner closes: it claims nothing more and lets the run go on to its own end (the drain).
  const closingAt = Date.now();
  const closing = runner.close();
  // While it drains, the run's live view is still written: a put after the close began, the loop not yet ended.
  await until(() => puts.some((put) => put.runId === "run-1" && put.at > closingAt), "a live row put while the runner drains", 10_000);
  release();
  await closing;
});

test("a killed runner writes no more of its runs' live view, though its loops still report (a crash: nothing let go)", async (t) => {
  const dir = dataDir(t);
  const server = await serverWithRun(t, dir);
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(() => store.close().catch(() => {}));
  const puts = [];
  const drops = [];
  // The loop reports a fresh chunk every 20 ms, counted, and never ends on its own: kill() stops nothing of it.
  let reports = 0;
  let reporting;
  let release = () => {};
  let loopEnded = false;
  const createLoop = (deps) => ({
    start: async () => {
      reporting = setInterval(() => { reports += 1; deps.live?.(() => held(`chunk ${reports}\n`)); }, 20);
      await new Promise((resolve) => (release = resolve));
      clearInterval(reporting);
      loopEnded = true;
      return { state: "interrupted" };
    },
    command: async () => ({ refused: "this loop takes no commands" }),
    stop: async () => release(),
  });
  const runner = startRunner({ store: countingPuts(store, puts, drops), createLoop, live: { tickMs: 20 }, name: "runner-a", leaseMs: 60_000, renewEveryMs: 1_000, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 });
  t.after(() => {
    clearInterval(reporting);
    release();
  });
  await until(async () => (await liveRow(server))?.state?.tools?.length === 1, "the run's live row while it runs", 15_000);
  runner.kill();
  const killedAt = Date.now();
  // Ten more reports after the kill: the 20 ms tick had ten chances to put one.
  const after = reports;
  await until(() => reports >= after + 10, "the loop went on reporting after the kill");
  const late = puts.filter((put) => put.at > killedAt);
  assert.deepEqual(late, [], `no live row put after the kill: ${late.length} put`);
  // The loop the crash left going ends later: its end writes no drop either (the ticker's end-of-loop step runs as its
  // start() resolves, so two event-loop turns after the end cover it).
  release();
  await until(() => loopEnded, "the loop ended");
  for (let turn = 0; turn < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const lateDrops = drops.filter((drop) => drop.at > killedAt);
  assert.deepEqual(lateDrops, [], `no live row dropped after the kill: ${lateDrops.length} dropped`);
});

test("a runner that loses its claim writes no more of the run's live view, though its loop still reports while it stops", async (t) => {
  const dir = dataDir(t);
  const server = await serverWithRun(t, dir);
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  t.after(() => store.close().catch(() => {}));
  // The runner's store: its renews fail once the test says so (a store locked past its busy timeout), so the claim is
  // lost for its renews, before its lease runs out; every live row it puts is counted, with when.
  let failing = false;
  const puts = [];
  const busy = () => Promise.reject(Object.assign(new Error("the store stayed locked past its busy timeout"), { name: "StoreBusy" }));
  const runnerStore = new Proxy(store, {
    get(target, key) {
      if (failing && (key === "renew" || key === "renewMany")) return busy;
      if (key === "live") {
        const live = target.live;
        return { ...live, read: live.read.bind(live), drop: live.drop.bind(live), put: async (rows) => { for (const row of rows) puts.push({ runId: row.claim.runId, at: Date.now() }); return live.put(rows); } };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // The loop reports a fresh chunk every 20 ms until it ends, and takes 400 ms to stop once told (a tool that finishes
  // its chunk before it honours the abort).
  let reporting;
  let stopping = false;
  let ended = () => {};
  let loopEnded = false;
  const createLoop = (deps) => ({
    start: async () => {
      let n = 0;
      reporting = setInterval(() => deps.live?.(() => held(`chunk ${(n += 1)}\n`)), 20);
      await new Promise((resolve) => (ended = resolve));
      clearInterval(reporting);
      loopEnded = true;
      return { state: "interrupted" };
    },
    command: async () => ({ refused: "this loop takes no commands" }),
    stop: async () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => ended(), 400);
    },
  });
  // The ticker wrapped here at a 20 ms tick (the runner's own is off: live false), so the window after the loss is ticked
  // many times over.
  const ticker = withLiveTicker(runnerStore, createLoop, { tickMs: 20 });
  const events = [];
  const runner = startRunner({ store: runnerStore, createLoop: ticker.createLoop, live: false, name: "runner-a", leaseMs: 5_000, renewEveryMs: 150, stopMarginMs: 1_000, pollMs: 20, commandPollMs: 30, onEvent: (event) => events.push({ ...event, at: Date.now() }) });
  t.after(async () => {
    clearInterval(reporting);
    ended();
    await runner.close().catch(() => {});
    await ticker.close().catch(() => {});
  });
  await until(async () => (await liveRow(server))?.state?.tools?.length === 1, "the run's live row while it runs", 15_000);
  failing = true;
  await until(() => events.some((event) => event.type === "claim-lost" && event.runId === "run-1"), "the claim was lost", 15_000);
  const lostAt = events.find((event) => event.type === "claim-lost").at;
  // The loop goes on reporting for 400 ms after the loss, until it ends; the ticker ticks every 20 ms in that time.
  await until(() => stopping && loopEnded, "the loop stopped and ended");
  const after = puts.filter((put) => put.runId === "run-1" && put.at > lostAt);
  assert.deepEqual(after, [], `no live row put for the run after its claim was lost: ${after.length} put`);
});
