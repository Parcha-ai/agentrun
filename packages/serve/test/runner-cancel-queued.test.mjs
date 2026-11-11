// A run stopped or cancelled while it is still queued sends nothing. Its first claim reads the untaken stop and ends the
// run there, with no loop: no input reaches the model and nothing is billed. The run ends stopped, in the stop's words
// ("cancelled" for a cancel).
// The interleave is held, not slept. Once a claim's loop has started, every read of the run's command rows waits until
// the model has been asked. So a claim that starts the loop before it applies the stop always sends the input first, and
// the test fails on it.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeOpenSessions, piAdapterSpec, scriptedOrigin } from "./conformance-pi-adapter.mjs";
import { queue, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(closeOpenSessions);

/** `store`, with each read of command rows held, once `held()` says so, until `released()`. */
function holding(store, held, released) {
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "commands" && prop !== "commandsOf") return typeof value === "function" ? value.bind(target) : value;
      return async (...args) => {
        if (held()) await until(released, "the model was asked", 30_000);
        return value.apply(target, args);
      };
    },
  });
}

for (const [kind, lost] of [["cancel", false], ["stop", false], ["cancel", true]]) {
  const when = lost ? "the claim after a first claim that was lost before it wrote anything (its runner gone, its lease run out)" : "its first claim";
  test(`a run given a ${kind} while queued ends at ${when}: no loop starts, no input reaches the model, and it ends stopped as ${kind === "cancel" ? "cancelled" : "stopped by a person"}`, { timeout: 60_000 }, async (t) => {
    const opened = await stores({ runners: 1 });
    await queue(opened.server, "run-1");
    const row = await opened.server.command("run-1", { kind });
    if (lost) {
      // A runner claimed the run (it now reads running) and was gone before it wrote anything: its lease runs out on the
      // store's clock, and the next claim takes the run over from running, its stop still untried.
      await opened.runners[0].claim("run-1", "runner-gone", { leaseMs: 1_000 });
      opened.clock.skewMs += 5_000;
    }
    const requests = [];
    const script = [{ say: "Hello." }];
    const loop = createAdapterLoop(piAdapterSpec({ script, tools: {}, hooks: quiet }, { fetch: scriptedOrigin(script, requests) }));
    const starts = [];
    const counted = (deps) => {
      const made = loop(deps);
      const start = made.start.bind(made);
      made.start = (claim) => (starts.push(claim.runId), start(claim));
      return made;
    };
    const store = holding(opened.runners[0], () => starts.length > 0, () => requests.length > 0);
    const runner = startRunner({ store, createLoop: counted, name: "runner-a", ...TIMING });
    t.after(() => runner.close());
    const ended = await until(async () => {
      const run = await opened.server.runs.get("run-1");
      return run.state === "stopped" && run.runner === null && run;
    }, "the run ends stopped", 30_000);
    assert.equal(ended.summary, kind === "cancel" ? "cancelled" : "stopped by a person");
    assert.equal(requests.length, 0, "no request reached the model");
    assert.deepEqual(starts, [], "the claim started no loop: it only ended the run");
    const taken = (await opened.server.commands("run-1", 0)).find((one) => one.id === row.id);
    assert.ok(taken.takenAt !== null && taken.refused === null, `the ${kind} row was taken: ${JSON.stringify(taken)}`);
  });
}
