// The run's end removes its pull request checkout (SpecHolds.endCheckout) after the run's own commands are stopped, never
// before: a background command still writing under repo/ would race the removal and leave files behind. A removal that
// fails is not kept as done: the release tries it again. Each step is a seam the test controls, so there is no sleep.
import assert from "node:assert/strict";
import test from "node:test";
import { SpecHolds } from "../dist/runner/spec-holds.js";

test("the checkout's removal comes after the tools' end (the run's background commands are stopped first), and the release ends neither twice", async () => {
  const order = [];
  let commandStopped;
  const stopped = new Promise((resolve) => (commandStopped = resolve));
  const holds = new SpecHolds();
  holds.hold({
    tools: { end: async () => { await stopped; order.push("tools"); } },
    checkout: { end: async () => { order.push("checkout"); } },
  });
  const ending = holds.endCheckout();
  // The tools' end has not finished (a command still running): the removal has not begun.
  await Promise.resolve();
  assert.deepEqual(order, [], "the removal waits for the commands to stop");
  commandStopped();
  await ending;
  assert.deepEqual(order, ["tools", "checkout"]);
  await holds.release();
  assert.deepEqual(order, ["tools", "checkout"], "the release finds both done");
});

test("a removal that failed is tried again by the release, and a removal that held is not", async () => {
  const logged = [];
  let calls = 0;
  const holds = new SpecHolds();
  holds.logTo((line) => logged.push(line));
  holds.hold({
    tools: { end: async () => {} },
    checkout: { end: async () => { if (++calls === 1) throw new Error("directory not empty"); } },
  });
  await holds.endCheckout();
  assert.equal(calls, 1);
  assert.ok(logged.some((line) => /directory not empty/.test(line)), "the failure is logged");
  await holds.release();
  assert.equal(calls, 2, "the release removed what the end could not");
  await holds.endCheckout();
  assert.equal(calls, 2, "a removal that held is done");
});
