// The held state's cost per pi.live advance is constant: the loop hands the runner's ticker the newest value as it
// comes, and the held state (the partial answer's text joined, the running tools listed) is computed once per tick, not
// on every advance. Computed per advance, an answer streamed in n parts costs n(n+1)/2 part reads, for each of a runner's
// loops, on the event loop. Read here as the parts a 10,000-advance stream reads before one tick.
import assert from "node:assert/strict";
import { test } from "node:test";

const { heldReporter } = await import("../dist/runner/loop.js");

test("a pi.live advance costs constant work: a 10,000-part partial is read once, at the tick, not on every advance", () => {
  let reads = 0;
  const parts = [];
  const value = { tools: [], generation: { message: { content: parts } } };
  const reported = [];
  const report = heldReporter((held) => reported.push(held));
  for (let i = 0; i < 10_000; i++) {
    parts.push({ type: "text", get text() { reads += 1; return "x"; } });
    report(value);
  }
  const beforeTick = reads;
  // The tick: the newest report, read once.
  const newest = reported.at(-1);
  const held = typeof newest === "function" ? newest() : newest;
  assert.equal(held?.partial?.text.length, 10_000, "the tick reads the whole partial");
  assert.ok(beforeTick === 0, `no part was read before the tick (read ${beforeTick} times over 10,000 advances)`);
  assert.ok(reads <= 10_000, `the tick read each part once (${reads} reads)`);
});
