// A person's pause and a workflow's call nodes, at the wrappers the runner's workflow spec puts around them
// (workflow-spec.ts): pauseAtEffects holds a call node before its effect starts, outside the engine's recovery wrapper
// that admits the effect, so a paused call node is never admitted (main's pause.ts gate before a call's admission); and
// parkOnRefusal does not park at a model request made inside a call node's effect in flight (an `llm` call's), which
// the engine has admitted and would leave unknown (FROZEN_EFFECT_UNKNOWN). Through the real loop these wait on call
// nodes running on the runner (runner-wf-pause-calls.test.mjs, skipped until then).
import assert from "node:assert/strict";
import { test } from "node:test";

const spec = await import("../dist/runner/workflow-spec.js");
const fn = (name) => (typeof spec[name] === "function" ? spec[name] : () => assert.fail(`workflow-spec.ts ${name} is not there`));

/** A cap that passes everything through, as identityWorkflowCap does. */
const passing = { node: (f) => f, effect: (f) => f, judge: (f) => f };
/** The loop's hooks with a pause in force or not; `pauses` counts pause() calls. */
const hooksOf = (paused) => {
  const hooks = { pauses: 0, parks: 0, paused: () => paused, pause: () => void (hooks.pauses += 1), park: () => void (hooks.parks += 1) };
  return hooks;
};

test("a call node's effect while a pause is in force: never called, pause() fires, and it ends when the node's signal is aborted", async () => {
  const hooks = hooksOf(true);
  let called = 0;
  const effect = fn("pauseAtEffects")(passing, hooks, { count: 0 }).effect(async () => (called += 1, "ran"));
  const node = new AbortController();
  let settled = false;
  const running = effect({ signal: node.signal }).then(() => "resolved", () => "rejected").finally(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hooks.pauses, 1, "the run parks for the pause");
  assert.equal(called, 0, "the effect is never called: the engine never admits it");
  assert.equal(settled, false, "it waits on the node's signal");
  node.abort(new Error("parked"));
  assert.equal(await running, "rejected", "the abort ends it");
  assert.equal(called, 0);
});

test("with no pause in force the effect runs once, and pause() never fires", async () => {
  const hooks = hooksOf(false);
  let called = 0;
  const effect = fn("pauseAtEffects")(passing, hooks, { count: 0 }).effect(async () => (called += 1, "ran"));
  assert.equal(await effect({ signal: new AbortController().signal }), "ran");
  assert.equal(called, 1);
  assert.equal(hooks.pauses, 0);
});

test("a model request inside a call node's effect in flight is sent, not parked, though a pause arrived; one outside an effect parks", async () => {
  let paused = false;
  const hooks = { pauses: 0, paused: () => paused, pause: () => void (hooks.pauses += 1), park: () => {} };
  const flight = { count: 0 };
  const before = fn("parkOnRefusal")(async () => undefined, hooks, flight);
  const effect = fn("pauseAtEffects")(passing, hooks, flight).effect(async () => {
    // The pause lands while the call node's effect runs, and its `llm` request is asked next.
    paused = true;
    return before({ model: "m" });
  });
  const inside = await effect({ signal: new AbortController().signal });
  assert.equal(inside, undefined, "the in-flight effect's request is let through");
  assert.equal(hooks.pauses, 0, "no park inside the effect");
  const outside = await before({ model: "m" });
  assert.ok(outside && "refuse" in outside, `a model node's request parks: ${JSON.stringify(outside)}`);
  assert.equal(hooks.pauses, 1);
});
