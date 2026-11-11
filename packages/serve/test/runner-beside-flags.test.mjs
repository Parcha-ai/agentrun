// The runner beside the server holds what the server's own flags say (runner/beside.ts besideRunnerOptions, cli.ts):
// --max-runs is the most runs it holds at once (the same number the capabilities report), the rest waiting queued; and
// --drain-timeout is how long its close lets a turn in flight finish, its outcome journaled once and never sent again.
// Each loop here holds its one turn until the test lets it end, and a claim the runner could make is seen by its polls
// (onBeat), so nothing waits on time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { maxRunsOf } from "../dist/host.js";
import { readFile } from "node:fs/promises";
import { besideRunnerOptions, besideStopping, DRAIN_TIMEOUT } from "../dist/runner/beside.js";
import { durationMs } from "../dist/print.js";
import { DEADLINE_MARGIN_MS } from "../dist/stop-signals.js";
import { RUNNER_DRAIN_TIMEOUT, runnerArgs, runnerHolds } from "../dist/runner/main.js";
import { RUNNER_LEASE_MS, RUNNER_STOP_MARGIN_MS, runnerCloseBoundMs, startRunner } from "../dist/runner/runner.js";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 20 };
const ROOT = 1;
/** Every callback the event loop holds now has run, so close()'s first steps (it awaits no store call here) are done. */
const settled = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

/** Loops whose one turn is held until `finishTurn()`: then it commits its answer and ends. A stop ends it interrupted. */
function heldTurns() {
  const loops = [];
  let going = 0;
  let most = 0;
  const createLoop = (deps) => {
    let finishTurn;
    const answered = new Promise((resolve) => (finishTurn = resolve));
    let stopNow;
    const stopped = new Promise((resolve) => (stopNow = resolve));
    const loop = {
      deps,
      claim: null,
      stopCalls: [],
      finishTurn: () => finishTurn(),
      async start(claim) {
        loop.claim = claim;
        most = Math.max(most, ++going);
        try {
          const how = await Promise.race([answered.then(() => "answered"), stopped.then(() => "stop")]);
          if (how === "stop") return { state: "interrupted" };
          const journal = deps.journal(claim);
          const id = await journal.mintId();
          journal.stage({ run: { state: "ended" }, effect: id });
          await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: { id, conversationId: ROOT, kind: "message" } }], BACKGROUND_CONTEXT);
          return { state: "ended" };
        } finally {
          going--;
        }
      },
      async command() {
        return { taken: true };
      },
      async stop(reason) {
        loop.stopCalls.push(reason);
        stopNow();
      },
    };
    loops.push(loop);
    return loop;
  };
  return { loops, createLoop, most: () => most };
}

/** A runner over its own store, from the server's flags as the CLI start makes it, with `ids` queued. */
async function besideRunner(t, flags, ids) {
  const { server, runners: [store] } = await stores();
  for (const id of ids) await queue(server, id);
  const record = recorder();
  const turns = heldTurns();
  const events = [];
  let beats = 0;
  const runner = startRunner({ store: observed(store, record), createLoop: turns.createLoop, name: "runner-a", onEvent: (event) => events.push(event), onBeat: () => void beats++, ...besideRunnerOptions(flags, {}), ...TIMING });
  t.after(() => {
    for (const loop of turns.loops) loop.finishTurn();
    return runner.close();
  });
  return { server, runner, turns, events, record, beats: () => beats };
}

test("the server's flags are the beside runner's: --max-runs its loops, as the capabilities count them, and --drain-timeout its drain", () => {
  assert.deepEqual(besideRunnerOptions({ maxRuns: 2, drainTimeout: "6s" }, {}), { loops: 2, drainMs: 6_000 });
  assert.deepEqual(besideRunnerOptions({}, { AGENTRUN_MAX_RUNS: "3" }), { loops: 3, drainMs: 30_000 }, "AGENTRUN_MAX_RUNS, and the documented 30s drain");
  assert.equal(DRAIN_TIMEOUT, "30s");
  assert.equal(besideRunnerOptions({}, {}).loops, maxRunsOf({}), "with neither, as many as the host holds: the capabilities' own number");
  assert.equal(besideRunnerOptions({ drainTimeout: "0s" }, {}).drainMs, 0);
});

test("a runner process of its own (`agentrun-serve runner`, beside a --no-runner server) holds the same: --loops, else AGENTRUN_MAX_RUNS, else what the host holds; --drain-timeout, else AGENTRUN_DRAIN_TIMEOUT, else the image's 6s", () => {
  assert.deepEqual(runnerArgs(["--data", "/d", "--drain-timeout", "8s"]), { dataDir: "/d", drainMs: 8_000 });
  assert.deepEqual(runnerArgs(["--data", "/d", "--drain-timeout=0s"]), { dataDir: "/d", drainMs: 0 });
  assert.throws(() => runnerArgs(["--data", "/d", "--drain-timeout", "soon"]), /--drain-timeout is a duration such as 6s/);
  assert.deepEqual(runnerHolds({ loops: 4, drainMs: 1_000 }, { AGENTRUN_MAX_RUNS: "2" }), { loops: 4, drainMs: 1_000 }, "its own flags first");
  assert.deepEqual(runnerHolds({}, { AGENTRUN_MAX_RUNS: "2" }), { loops: 2, drainMs: 6_000 }, "else the server's AGENTRUN_MAX_RUNS and the image's drain");
  assert.equal(RUNNER_DRAIN_TIMEOUT, "6s");
  assert.equal(runnerHolds({}, {}).loops, maxRunsOf({}), "with neither, as many as the host holds, as the server counts them");
  assert.throws(() => runnerHolds({}, { AGENTRUN_MAX_RUNS: "lots" }), /max runs is a positive integer/);
  assert.equal(runnerHolds({}, { AGENTRUN_DRAIN_TIMEOUT: "2s" }).drainMs, 2_000, "else AGENTRUN_DRAIN_TIMEOUT");
  assert.equal(runnerHolds({ drainMs: 0 }, { AGENTRUN_DRAIN_TIMEOUT: "2s" }).drainMs, 0, "--drain-timeout over the environment");
  assert.throws(() => runnerHolds({}, { AGENTRUN_DRAIN_TIMEOUT: "soon" }), /AGENTRUN_DRAIN_TIMEOUT is a duration such as 6s/);
});

test("the CLI's stop deadline covers the runner's whole close: its drain, then the stop of the loops left, from the runner's own lease and margin", () => {
  const stopWindow = RUNNER_LEASE_MS - RUNNER_STOP_MARGIN_MS;
  assert.equal(stopWindow, 25_000, "a loop that does not stop is given up 25 s after the drain");
  assert.equal(runnerCloseBoundMs(6_000), 6_000 + stopWindow);
  assert.deepEqual(besideStopping({ runs: 0, boundMs: 0 }, 1, 6_000), { runs: 1, boundMs: 31_000 }, "the image's 6 s drain: 31 s, then the stop's margin");
  assert.deepEqual(besideStopping({ runs: 2, boundMs: 90_000 }, 3, 30_000), { runs: 5, boundMs: 90_000 }, "a longer server bound stands");
  assert.equal(besideStopping({ runs: 0, boundMs: 0 }, 0, 0).boundMs, stopWindow, "with no drain, still the loops' stop");
  assert.ok(DEADLINE_MARGIN_MS > 0);
});

test("a runner of its own stops inside compose's stop grace: its default drain and the loops' stop after it", async () => {
  const compose = await readFile(new URL("../../../deploy/compose.yaml", import.meta.url), "utf8");
  const runner = /x-runner: &runner\n(?:  .*\n)*?  stop_grace_period: (\d+)s/.exec(compose);
  assert.ok(runner, "compose's runners name their stop_grace_period");
  const bound = runnerCloseBoundMs(durationMs(RUNNER_DRAIN_TIMEOUT));
  assert.equal(bound, 31_000, "6 + 25 = 31 s");
  assert.ok(bound < Number(runner[1]) * 1_000, `the runner's close (${bound} ms) is inside compose's ${runner[1]} s`);
});

test("--max-runs 2 with 4 runs queued: the runner holds 2 at once, the other 2 wait queued, then run as places free", async (t) => {
  const { server, runner, turns, events, beats } = await besideRunner(t, { maxRuns: 2 }, ["run-1", "run-2", "run-3", "run-4"]);
  await until(() => turns.loops.filter((loop) => loop.claim).length === 2, "two runs claimed");
  // Polls go on while the runner is full: had it a place, the next of them would claim a waiting run.
  const seen = beats();
  await until(() => beats() >= seen + 3, "three more polls");
  assert.equal(turns.loops.length, 2, "no third loop while 2 are held");
  assert.equal(runner.held().length, 2);
  const held = new Set(runner.held().map((claim) => claim.runId));
  const waiting = ["run-1", "run-2", "run-3", "run-4"].filter((id) => !held.has(id));
  for (const id of waiting) assert.equal((await server.runs.get(id)).state, "queued", `${id} waits queued`);
  // Each end frees a place, which a waiting run takes.
  for (const loop of [...turns.loops]) loop.finishTurn();
  await until(() => turns.loops.length === 4 && turns.loops.every((loop) => loop.claim), "the waiting two claimed once places freed");
  for (const loop of turns.loops) loop.finishTurn();
  await until(() => events.filter((event) => event.type === "released").length === 4, "all four released");
  assert.equal(turns.most(), 2, "never more than 2 runs going at once");
  for (const id of ["run-1", "run-2", "run-3", "run-4"]) assert.equal((await server.runs.get(id)).state, "ended", `${id} ran to its end`);
});

test("with a drain, a close during a turn in flight lets the turn finish: its outcome journaled once, the run never claimed again", async (t) => {
  const { server, runner, turns, events, record } = await besideRunner(t, { drainTimeout: "60s" }, ["run-1"]);
  const loop = await until(() => turns.loops[0]?.claim && turns.loops[0], "run-1 claimed, its turn in flight");
  await settled();
  const closing = runner.close();
  await settled();
  assert.deepEqual(loop.stopCalls, [], "the close stops no loop while it drains");
  assert.equal(loop.deps.signal.aborted, false, "nor aborts its turn");
  loop.finishTurn();
  await closing;
  assert.deepEqual(loop.stopCalls, [], "the turn ended on its own");
  assert.deepEqual(events.filter((event) => event.type === "released").map((event) => event.end), ["ended"]);
  assert.equal(record.commits.filter((commit) => commit.runId === "run-1").length, 1, "the turn's outcome journaled once");
  assert.equal(record.claims.filter((claim) => claim.runId === "run-1").length, 1, "claimed once: nothing to resume, nothing sent again");
  assert.equal((await server.runs.get("run-1")).state, "ended");
});

test("with --drain-timeout 0s, a close stops the turn in flight at once for a shutdown, its run left to resume", async (t) => {
  const { server, runner, turns, events, record } = await besideRunner(t, { drainTimeout: "0s" }, ["run-1"]);
  const loop = await until(() => turns.loops[0]?.claim && turns.loops[0], "run-1 claimed, its turn in flight");
  await settled();
  await runner.close();
  assert.deepEqual(loop.stopCalls.map((reason) => reason.kind), ["shutdown"], "stopped at once for a shutdown");
  assert.deepEqual(events.filter((event) => event.type === "released").map((event) => event.end), ["interrupted"]);
  assert.ok(!record.ops.includes("ended run-1"), "no answer journaled");
  const row = await server.runs.get("run-1");
  assert.deepEqual([row.state, row.runner], ["running", null], "released still running, for the next claim to resume");
});
