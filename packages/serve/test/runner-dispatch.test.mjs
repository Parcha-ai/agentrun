// The runner's dispatch loop (runner/dispatch.ts): at the claim it reads the run's launch, picks the harness its body
// names, and runs the run on that harness's loop. Commands and a stop handed over before the inner loop is chosen are
// buffered and replayed through it; a launch whose harness this runner does not run, or whose body cannot be read, fails
// the run in words. Tested with fake inner loops, so the dispatch's own behaviour is read apart from any harness.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDispatchLoop } from "../dist/runner/dispatch.js";

const CLAIM = { runId: "run-1", runner: "runner-a", epoch: 1, until: 0, from: "queued" };
const deps = { journal: () => ({}), flush: async () => {}, signal: new AbortController().signal };
const piBody = { place: { mode: "runner" }, harness: "pi" };
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** A fake inner loop that records what it was handed, and ends on command. */
function fakeLoop(end = { state: "ended" }) {
  const log = [];
  let finish;
  const started = new Promise((resolve) => (finish = resolve));
  let gotDeps;
  const loop = {
    start(claim) {
      log.push(["start", claim.runId]);
      return started.then(() => end);
    },
    async command(command) {
      log.push(["command", command.id, command.kind]);
      return { taken: true };
    },
    async stop(reason) {
      log.push(["stop", reason.kind]);
      finish(end);
    },
  };
  return { factory: (d) => ((gotDeps = d), loop), log, finish: () => finish(end), depsOf: () => gotDeps };
}

test("dispatch picks the harness the launch names and runs the run on its loop", async () => {
  const inner = fakeLoop();
  const dispatch = createDispatchLoop({
    launchOf: async (runId) => (assert.equal(runId, "run-1"), { body: piBody }),
    resolve: (harness, launch) => (assert.equal(harness, "pi"), assert.deepEqual(launch.place, { mode: "runner" }), inner.factory),
  })(deps);
  const run = dispatch.start(CLAIM);
  inner.finish();
  assert.deepEqual(await run, { state: "ended" });
  assert.deepEqual(inner.log, [["start", "run-1"]]);
  // The inner loop runs on the dispatch's own LoopDeps, so the runner's fence, flush and signal reach it unchanged.
  assert.equal(inner.depsOf(), deps);
});

test("the default harness (pi) is chosen when the launch body names none", async () => {
  const inner = fakeLoop();
  let picked;
  const dispatch = createDispatchLoop({
    launchOf: async () => ({ body: { place: { mode: "runner" } } }),
    resolve: (harness) => ((picked = harness), inner.factory),
  })(deps);
  const run = dispatch.start(CLAIM);
  inner.finish();
  await run;
  assert.equal(picked, "pi");
});

test("a command handed over before the inner loop is chosen is buffered and replayed through it", async () => {
  const inner = fakeLoop();
  const gate = defer();
  const dispatch = createDispatchLoop({
    launchOf: async () => (await gate.promise, { body: piBody }),
    resolve: () => inner.factory,
  })(deps);
  const run = dispatch.start(CLAIM);
  // The command reaches the dispatch while the launch read is still in flight: taken, held until the loop is chosen.
  assert.deepEqual(await dispatch.command({ id: 7, kind: "steer", body: { text: "hi" } }), { taken: true });
  assert.deepEqual(inner.log, []);
  gate.resolve();
  await new Promise((r) => setTimeout(r, 10));
  inner.finish();
  await run;
  assert.deepEqual(inner.log, [["start", "run-1"], ["command", 7, "steer"]]);
});

test("a stop handed over before the inner loop is chosen reaches it once chosen, and stop resolves", async () => {
  const inner = fakeLoop({ state: "stopped" });
  const gate = defer();
  const dispatch = createDispatchLoop({
    launchOf: async () => (await gate.promise, { body: piBody }),
    resolve: () => inner.factory,
  })(deps);
  const run = dispatch.start(CLAIM);
  const stopped = dispatch.stop({ kind: "command", commandId: 9 });
  gate.resolve();
  await stopped;
  await run;
  assert.ok(inner.log.some((entry) => entry[0] === "stop" && entry[1] === "command"), `the inner loop was stopped: ${JSON.stringify(inner.log)}`);
});

test("a command after the inner loop is chosen goes straight to it", async () => {
  const inner = fakeLoop();
  const dispatch = createDispatchLoop({ launchOf: async () => ({ body: piBody }), resolve: () => inner.factory })(deps);
  const run = dispatch.start(CLAIM);
  await new Promise((r) => setTimeout(r, 5));
  await dispatch.command({ id: 3, kind: "steer", body: {} });
  inner.finish();
  await run;
  assert.deepEqual(inner.log, [["start", "run-1"], ["command", 3, "steer"]]);
});

test("a launch naming a harness this runner does not run fails the run in words", async () => {
  const dispatch = createDispatchLoop({
    launchOf: async () => ({ body: { place: { mode: "runner" }, harness: "codex" } }),
    resolve: () => undefined,
  })(deps);
  await assert.rejects(dispatch.start(CLAIM), /does not run the harness "codex"/);
});

test("a launch body the store cannot read as one fails the run in words", async () => {
  const dispatch = createDispatchLoop({
    launchOf: async () => ({ body: { not: "a launch" } }),
    resolve: () => assert.fail("resolve must not be reached for an unreadable launch"),
  })(deps);
  await assert.rejects(dispatch.start(CLAIM), /launch record could not be read/);
});

test("a run with no launch record fails the run in words (store.runs.launch throws)", async () => {
  class StoreLaunchMissing extends Error {}
  const dispatch = createDispatchLoop({
    launchOf: async () => {
      throw new StoreLaunchMissing("run run-1 has no launch record");
    },
    resolve: () => assert.fail("resolve must not be reached when the launch is missing"),
  })(deps);
  await assert.rejects(dispatch.start(CLAIM), /no launch record/);
});
