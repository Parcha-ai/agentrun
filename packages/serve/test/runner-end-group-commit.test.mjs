// The runner knows a run is ending from the commit that lands its final patch (runner.ts fenced: `ended`), so a renew
// answered Fenced by that end's own epoch bump is never a lost claim. In a group commit the store keeps batches in order
// up to the first it refuses: the end's batch can land while a sibling batch after it is refused. The end still landed
// (its patch rides its own batch), so the runner is ending: it renews the run no more, and says no claim-lost.
// The runner's timers and clock are node:test's mocked ones: the renew interval passes once, between the end's commit and
// the loop's return, by the test's own step, and any renew it starts is waited for by count, never by time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID as ROOT } from "@earendil-works/pi-durable";
import { queue, stores } from "./runner-support.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const TIMING = { leaseMs: 60_000, renewEveryMs: 50, stopMarginMs: 5_000, pollMs: 20, commandPollMs: 30 };

test("a group commit whose end batch lands and whose sibling is refused: the run is ending, so no renew is Fenced into a claim-lost", async (t) => {
  const opened = await stores({ runners: 1 });
  await queue(opened.server, "run-1");
  // The runner's renews, counted as they start and as they return.
  const renews = { started: 0, returned: 0, settled: [] };
  const inner = opened.runners[0];
  const store = new Proxy(inner, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "renewMany") return value.bind(target);
      return async (...args) => {
        renews.started += 1;
        try {
          return await value.apply(target, args);
        } finally {
          renews.returned += 1;
          for (const wake of renews.settled.splice(0)) wake();
        }
      };
    },
  });
  const seen = {};
  const createLoop = (deps) => ({
    async start(claim) {
      const journal = deps.journal(claim);
      const first = await journal.mintId();
      await journal.commit([[{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: { id: first, conversationId: ROOT, kind: "message" } }]], () => {}, BACKGROUND_CONTEXT);
      const end = await journal.mintId();
      journal.stage({ run: { state: "ended" }, effect: end });
      // Batch 0: the end, with its patch. Batch 1: an entry under an id the run already wrote, which the store refuses.
      seen.result = await journal.commit([
        [{ type: "entry", value: { id: end, conversationId: ROOT, kind: "agentrun.end", data: { state: "ended" } } }],
        [{ type: "entry", value: { id: first, conversationId: ROOT, kind: "message" } }],
      ], () => {}, BACKGROUND_CONTEXT);
      // The renew interval passes, the run's end landed and its loop not yet returned: a renew started now is Fenced (the
      // end moved the epoch on). Waited for until it returns, if one started.
      t.mock.timers.tick(TIMING.renewEveryMs);
      while (renews.returned < renews.started) await new Promise((resolve) => renews.settled.push(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      seen.renews = renews.started;
      // Real timers again for the runner's release and close.
      t.mock.timers.reset();
      return { state: "ended" };
    },
    async command() {
      return { refused: "no commands here" };
    },
    async stop() {},
  });
  const events = [];
  let released = () => {};
  const releasedNow = new Promise((resolve) => (released = resolve));
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
  const runner = startRunner({ store, createLoop, name: "runner-a", ...TIMING, onEvent: (event) => (events.push(event), (event.type === "released" || event.type === "claim-lost") && released()) });
  t.after(() => runner.close());
  // The runner says released once the loop returned (by then the timers are real again), or claim-lost, which fails below.
  await releasedNow;
  assert.deepEqual(events.filter((event) => event.type === "claim-lost"), [], `no claim-lost for a run whose end landed: ${JSON.stringify(events)}`);
  const row = await opened.server.runs.get("run-1");
  assert.deepEqual([row.state, row.runner], ["ended", null], "the run ended and was released");
  assert.equal(seen.result?.stored, 1, `the end's batch landed and its sibling was refused: ${JSON.stringify(seen.result)}`);
  assert.deepEqual(events.filter((event) => event.type === "claim-lost"), [], `no claim-lost for a run whose end landed: ${JSON.stringify(events)}`);
  assert.equal(seen.renews, 0, "a run whose end landed is renewed no more");
});
