// A command row that reaches a run's loop after that loop's claim has ended (#2200). The runner's dispatch buffers a row
// handed over before it has chosen the run's harness loop (an approval's answer, a message) and replays it once the loop
// is chosen. That replay ran in a promise nothing caught: when the chosen loop ended before it was ready (a lease that
// lapsed, a session that would not open under load), the adapter loop read its closed Harness, which threw "Session is
// closed", and the unhandled rejection took the runner's process down with every claim it held.
//
// Here: the adapter loop never reads a closed Harness, and answers such a row `later` (left untaken for the run's next
// claim, so nobody's words are lost); the dispatch's replay never throws, whatever its inner loop does; and the runner's
// process logs a rejection nothing handled and keeps serving. No sleeps: each wait is on the event it names.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, stores } from "./runner-support.mjs";

const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { unhandledRejectionLogger } = await import("../dist/runner/main.js");

const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

const answer = (id, approval) => ({ id, runId: "run-1", kind: "approve", body: { approval }, createdAt: 0, takenAt: null, refused: null, tries: 0 });
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** Every unhandled rejection while `body` runs and a turn of the event loop after it: none is the bar. */
async function noUnhandled(body) {
  const seen = [];
  const onRejection = (reason) => seen.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const value = await body();
    await new Promise((resolve) => setImmediate(resolve));
    return { value, seen };
  } finally {
    process.off("unhandledRejection", onRejection);
  }
}

test("an answer to an adapter loop whose claim ended before it was ready (its session never opened) is left for the run's next claim, never read from the closed Harness", { timeout: 60_000 }, async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  const store = opened.runners[0];
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 60_000 });
  // The Harness opens; then the session's open fails (a slow open under load, a lapsed lease): the loop ends, closing
  // its Harness, before it was ever ready.
  const base = piAdapterSpec({ script: [{ say: "never asked" }], tools: {}, hooks: quiet });
  const spec = async (c, run) => {
    const given = await base(c, run);
    return { ...given, adapter: { ...given.adapter, open: async () => { throw new Error("the session did not open in time"); } } };
  };
  const loop = createAdapterLoop(spec)({ journal: (c) => store.journal(c), flush: async () => store.flush?.(), signal: new AbortController().signal });
  await loop.start(claim).catch(() => undefined);
  const { value: outcome, seen } = await noUnhandled(() => loop.command(answer(1, "call-1")));
  assert.deepEqual(seen, [], "nothing rejected unhandled");
  assert.ok(outcome && "later" in outcome, `the answer is left untaken for the next claim (the runner writes only a refusal), never refused or thrown: ${JSON.stringify(outcome)}`);
});

test("the dispatch's replay of a row buffered before its loop was chosen never throws: an inner loop whose command() rejects lets the run end, and its delivered resolves", { timeout: 30_000 }, async () => {
  const launched = defer();
  const startCalled = defer();
  const finish = defer();
  let innerDeps;
  const inner = {
    start() {
      startCalled.resolve();
      return finish.promise.then(() => ({ state: "interrupted" }));
    },
    async command() {
      throw new Error("Session is closed");
    },
    async stop() {
      finish.resolve();
    },
  };
  const dispatch = createDispatchLoop({
    launchOf: async () => (await launched.promise, { body: { place: { mode: "runner" }, harness: "pi" } }),
    resolve: () => (deps) => ((innerDeps = deps), inner),
  })({ journal: () => ({}), flush: async () => {}, signal: new AbortController().signal });
  const { value, seen } = await noUnhandled(async () => {
    const run = dispatch.start({ runId: "run-1", runner: "runner-a", epoch: 1, until: 0, from: "running" });
    // Handed over before the launch read chose the loop: buffered, and the dispatch says it holds it.
    assert.deepEqual(await dispatch.command(answer(7, "call-1")), { taken: true });
    launched.resolve();
    await startCalled.promise;
    // The replay settles whatever the inner loop did with the row: the loop's delivered resolves after it.
    await innerDeps.delivered;
    finish.resolve();
    return run;
  });
  assert.deepEqual(seen, [], "the replay's rejection reached no unhandled handler");
  assert.deepEqual(value, { state: "interrupted" });
});

test("the runner process's last-resort handler logs a rejection nothing handled, in the runner's name, and returns", () => {
  const lines = [];
  const handle = unhandledRejectionLogger("runner-a", (line) => lines.push(line));
  handle(new Error("Session is closed"));
  handle("a plain reason");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^agentrun-serve runner: Runner runner-a: a promise rejected with no handler \(logged; the runner goes on\): Error: Session is closed/);
  assert.match(lines[1], /: a plain reason\n$/);
});
