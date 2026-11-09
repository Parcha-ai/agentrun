// A workflow's refused step waits for a raise where it stands, and the run parks once every step under way waits. Which
// step waits is named by its execution path (a model request's, by the provider session of its node's conversation),
// never by the async context that ran it: a scheduler may drain one node's turn in another's context. A wait whose mark is
// not written counts nothing. A refusal for good is a CapStop kept by its step's path, never an item's failure to a
// collecting map. A decision whose price cannot be read fails unsent as a connection error, never the cap's stop.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { CapRefused, CapStop, createStepWaits, DecisionPriceUnreadable, memoryMarks } from "../dist/kernel/cap/index.js";
import { capOn, SONNET } from "./kernel-cap-support.mjs";

const refusal = (words = "spend_cap_reached (out of budget): Not sent: raise the cap") => new CapRefused(words, { forGood: false, spentUsd: 0.1, figures: { spentUsd: 0.1, needsUsd: 0.05, leastCapUsd: 0.16 } });

test("a verify decision is its node's work by its execution path: waiting, the run lets go", async () => {
  const steps = createStepWaits();
  steps.working("node-1");
  // The decision runs in whatever context drained it; it names its node's path.
  const ambient = new AsyncLocalStorage();
  await ambient.run({ path: "node-elsewhere" }, () => steps.wait("node-1", refusal()));
  assert.equal(steps.allWaiting(), true);
  assert.deepEqual(steps.waitingFor(), ["node-1"]);
});

test("two items' decisions waiting in each other's context each count for their own item: the run lets go", async () => {
  const steps = createStepWaits();
  steps.working("map/0");
  steps.working("map/1");
  const ambient = new AsyncLocalStorage();
  await ambient.run({ path: "map/1" }, () => steps.wait("map/0", refusal()));
  assert.equal(steps.allWaiting(), false, "item 1 still works");
  await ambient.run({ path: "map/0" }, () => steps.wait("map/1", refusal()));
  assert.equal(steps.allWaiting(), true);
  assert.deepEqual(steps.waitingFor().sort(), ["map/0", "map/1"]);
});

test("a request of a known provider session waits for its own node whatever its async context says, and the pause names it", async () => {
  const steps = createStepWaits();
  steps.working("map/0");
  steps.working("map/1");
  steps.session("sess-item-1", "map/1");
  const ambient = new AsyncLocalStorage();
  await ambient.run({ path: "map/0" }, () => steps.wait(steps.pathOf({ session: "sess-item-1" }), refusal()));
  assert.deepEqual(steps.waitingFor(), ["map/1"]);
  assert.equal(steps.allWaiting(), false, "item 0 still works");
});

test("a wait whose mark is not written throws and counts no wait: a later pause beside its step, still working, never lets the run go", async () => {
  const marks = memoryMarks();
  const steps = createStepWaits({ marks });
  steps.working("node-1");
  steps.working("node-2");
  marks.failNext();
  await assert.rejects(steps.wait("node-1", refusal()), /could not be written/);
  await steps.wait("node-2", refusal());
  assert.equal(steps.allWaiting(), false, "node-1 is not counted as waiting");
});

test("a raise's resume, a step's end or its stop landing while its wait's mark is written leaves no waiting entry behind", async () => {
  for (const during of ["resume", "done", "stop"]) {
    let land;
    const marks = { write: () => new Promise((resolve) => (land = resolve)), read: async () => [] };
    const steps = createStepWaits({ marks });
    steps.working("node-1");
    const waiting = steps.wait("node-1", refusal());
    if (during === "resume") steps.resume();
    else if (during === "done") steps.done("node-1");
    else steps.stop("node-1", new CapRefused("spend_cap_reached: Not sent", { forGood: true, spentUsd: 0 }));
    land();
    assert.equal(await waiting, false, `${during} during the write: the wait says it was dropped`);
    assert.deepEqual(steps.waitingFor(), [], `${during} during the write`);
    if (during === "resume") assert.equal(steps.allWaiting(), false, "the resumed step is not parked again");
  }
});

test("a wait that is registered says so", async () => {
  const steps = createStepWaits();
  steps.working("node-1");
  assert.equal(await steps.wait("node-1", refusal()), true);
});

test("a refusal for good is kept by its step's path, and its failure is a CapStop no collecting map takes for an item's", () => {
  const steps = createStepWaits();
  steps.working("map/3");
  const stop = steps.stop("map/3", new CapRefused("spend_cap_reached: Not sent: no price", { forGood: true, spentUsd: 0 }));
  assert.ok(stop instanceof CapStop);
  assert.equal(stop.path, "map/3");
  assert.equal(steps.stopped("map/3"), stop);
  const itemFailure = (error) => !(error instanceof CapStop);
  assert.equal(itemFailure(stop), false);
});

test("a capped decision whose price is unreadable fails unsent as a connection error, never the cap's stop", async () => {
  const { cap } = capOn(1);
  const error = await cap.admit({ kind: "decision", id: "decide-1", model: "unreadable", inputTokens: 100, questions: 1 }).catch((caught) => caught);
  assert.ok(error instanceof DecisionPriceUnreadable, String(error));
  assert.equal(error instanceof CapRefused, false);
  assert.equal(error.connection, true);
  assert.equal(cap.heldUsd(), 0);
});

test("a capped decision with a price is held as a model request is: under strict, at its model's most output", async () => {
  const { cap } = capOn(1, { mode: "strict" });
  const admitted = await cap.admit({ kind: "decision", id: "decide-2", model: SONNET, inputTokens: 1_000, questions: 2 });
  assert.ok(Math.abs(admitted.heldUsd - ((1_000 * 3.75 + 64_000 * 15) / 1e6)) < 1e-12, String(admitted.heldUsd));
});
