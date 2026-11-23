// A runner's close drains (RunnerOptions.drainMs), as a run's own process did on the server's stop (the run goes on until nothing needs it, up to the drain's deadline, then the rest is released interrupted). It
// stops claiming at once; each run it holds goes on to its own end (a turn in flight finishes, its outcome journaled), so
// a model request under way is never cut and paid again on the resume; past the bound, the rest are stopped for a
// shutdown where they can resume. A person's stop sent meanwhile still reaches its run. Each loop here holds its turn
// until the test lets it end, so nothing waits on time but the bound itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { sendCommand } from "../dist/runner/commands.js";
import { startRunner } from "../dist/runner/runner.js";
import { observed, queue, recorder, STEADY_LEASE, stores, until } from "./runner-support.mjs";

/** No poll after the first (which claims the queued run): close() then has no claim in flight to wait on. */
const TIMING = { ...STEADY_LEASE, pollMs: 600_000, commandPollMs: 20 };
const ROOT = 1;
/** Every callback the event loop holds now has run, so close()'s first steps (it awaits no store call here) are done. */
const settled = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

/** Loops whose one turn is held until `finishTurn()`: then it answers, its end (ended) in its commit. A stop ends it as a
 *  loop does: a person's stop row stopped (the row taken in that end), a shutdown or a lost claim interrupted. */
function heldTurns() {
  const loops = [];
  const createLoop = (deps) => {
    let finishTurn;
    const answered = new Promise((resolve) => (finishTurn = resolve));
    let stopNow;
    const stopped = new Promise((resolve) => (stopNow = resolve));
    const end = async (journal, staged) => {
      const id = await journal.mintId();
      journal.stage({ ...staged, effect: id, ...(staged.take ? { take: staged.take.map((command) => ({ command, effect: id })) } : {}) });
      await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: { id, conversationId: ROOT, kind: "message" } }], BACKGROUND_CONTEXT);
    };
    const loop = {
      deps,
      claim: null,
      stopCalls: [],
      finishTurn: () => finishTurn(),
      async start(claim) {
        loop.claim = claim;
        const journal = deps.journal(claim);
        const how = await Promise.race([answered.then(() => "answered"), stopped.then(() => "stop")]);
        if (how === "answered") {
          await end(journal, { run: { state: "ended" } });
          return { state: "ended" };
        }
        const reason = loop.stopCalls[0];
        if (reason.kind === "command") {
          await end(journal, { run: { state: "stopped" }, take: [reason.commandId] });
          return { state: "stopped" };
        }
        return { state: "interrupted" };
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
  return { loops, createLoop };
}

/** A runner over its own store with run-1 queued and claimed, its loop's turn in flight. */
async function holding(t, drainMs) {
  const { server, runners: [store] } = await stores();
  await queue(server, "run-1");
  const turns = heldTurns();
  const events = [];
  const runner = startRunner({ store: observed(store, recorder()), createLoop: turns.createLoop, name: "runner-a", onEvent: (event) => events.push(event), drainMs, ...TIMING });
  t.after(() => {
    for (const loop of turns.loops) loop.finishTurn();
    return runner.close();
  });
  const loop = await until(() => turns.loops[0]?.claim && turns.loops[0], "run-1 claimed, its turn in flight");
  await settled();
  return { server, runner, loop, events };
}

/** `closing`, or a failure naming `what` once `ms` pass first: a close that never resolves fails here, by its own bound. */
async function within(closing, ms, what) {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve("late"), ms)));
  const won = await Promise.race([closing.then(() => "closed"), late]);
  clearTimeout(timer);
  assert.equal(won, "closed", what);
}

test("a turn in flight when the runner closes finishes within the drain bound: its run ends as its own end, never cut for a shutdown", async (t) => {
  const { server, runner, loop, events } = await holding(t, 60_000);
  const closing = runner.close();
  await settled();
  assert.deepEqual(loop.stopCalls, [], "the close stops no loop while it drains");
  assert.equal(loop.deps.signal.aborted, false, "nor aborts its turn's calls");
  assert.deepEqual(runner.held().map((claim) => claim.runId), ["run-1"], "the run is still held while its turn goes on");
  loop.finishTurn();
  await within(closing, 20_000, "the close resolved once the turn ended");
  assert.deepEqual(loop.stopCalls, [], "no loop was stopped at all");
  assert.deepEqual(events.filter((event) => event.type === "released").map((event) => event.end), ["ended"], "the run was released at its own end");
  assert.equal((await server.runs.get("run-1")).state, "ended", "the run ended, its answer kept: not left running to resume");
});

test("a turn still in flight when the drain bound runs out is stopped there for a shutdown, and its run released to resume", async (t) => {
  const { server, runner, loop, events } = await holding(t, 200);
  await within(runner.close(), 20_000, "the close resolved at the drain's bound, not when the turn ends");
  assert.deepEqual(loop.stopCalls.map((reason) => reason.kind), ["shutdown"], "the loop was stopped for a shutdown");
  assert.deepEqual(events.filter((event) => event.type === "released").map((event) => event.end), ["interrupted"]);
  const row = await server.runs.get("run-1");
  assert.deepEqual([row.state, row.runner], ["running", null], "released still running, for the next claim to resume");
});

test("a drain says how long it took and what it handed back, and the store counts the hand-back (the runner's metrics, GET /v2/capacity)", async (t) => {
  const cut = await holding(t, 200);
  await within(cut.runner.close(), 20_000, "the close resolved at the drain's bound");
  const drained = cut.events.filter((event) => event.type === "drained");
  assert.equal(drained.length, 1, "said once");
  assert.deepEqual([drained[0].held, drained[0].left], [1, 1], "one run held, one still going at the bound");
  assert.ok(drained[0].ms >= 150 && drained[0].ms < 20_000, `the drain took about its bound: ${drained[0].ms} ms`);
  assert.deepEqual(cut.events.filter((event) => event.type === "handed-back").map(({ runId, cause }) => [runId, cause]), [["run-1", "drain"]], "handed back by the drain");
  assert.equal((await cut.server.runners.capacity(60_000)).handBacks, 1, "the store kept the hand-back");

  // A turn that finishes within the drain: nothing left, nothing handed back.
  const done = await holding(t, 60_000);
  const closing = done.runner.close();
  await settled();
  done.loop.finishTurn();
  await within(closing, 20_000, "the close resolved once the turn ended");
  assert.deepEqual(done.events.filter((event) => event.type === "drained").map(({ held, left }) => [held, left]), [[1, 0]]);
  assert.deepEqual(done.events.filter((event) => event.type === "handed-back"), [], "no hand-back: the run ended");
  assert.equal((await done.server.runners.capacity(60_000)).handBacks, 0);
});

test("a person's stop sent while the runner drains reaches its run at once: the run ends stopped, its row taken, the close not waiting out the bound", async (t) => {
  const { server, runner, loop, events } = await holding(t, 60_000);
  const closing = runner.close();
  await settled();
  const stop = await sendCommand(server, "run-1", { kind: "stop" });
  await until(() => loop.stopCalls.length > 0, "the stop row reached the loop while the runner drains");
  assert.deepEqual(loop.stopCalls, [{ kind: "command", commandId: stop.id }], "the stop is the person's, not a shutdown");
  await within(closing, 20_000, "the close resolved once the stopped run ended");
  assert.deepEqual(events.filter((event) => event.type === "released").map((event) => event.end), ["stopped"]);
  assert.equal((await server.runs.get("run-1")).state, "stopped");
});
