// A workflow step's waits for a raise, at the mechanism (budget.ts budgetWaits):
//  - a model node's failure takes a refusal kept with no path of its own only while that node runs alone;
//  - a map's items wait at paths of their own, each with its own held time;
//  - a paused process lets go only once every step in flight is waiting, a step whose nested decision waits counting as
//    one waiting step.
// The decisions' cap and a raise's cases run on the runner (workflow-decision-money.test.mjs).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { budgetWaits, CapStop } from "../dist/budget.js";

test("a model node's failure takes a refusal kept with no path of its own only while that node runs alone", (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "cap-stop-alone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const waits = budgetWaits(root, { cap: 1, spent: () => 0, add: () => undefined }, { letGo: () => undefined });
  waits.record({ words: "Not sent: what the run has spent is unknown, so its cap of $1 cannot be kept: the run is out of budget.", room: false, capUsd: 1 }, undefined);
  assert.deepEqual([waits.stopped("/root/steps/1", false) instanceof CapStop, waits.stopped("/root/steps/1", true) instanceof CapStop], [false, true]);
});

test("a map's items wait for a raise at paths of their own: holding item 0 leaves item 1's held time at 0, and item 0's wait ending never stops item 1's clock", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "item-held-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const waits = budgetWaits(root, { cap: 1, spent: () => 0, add: () => undefined }, { letGo: () => undefined });
  const refusal = { words: "Not sent: the call could cost up to $2. Raise the cap to at least $2 to continue.", room: true, capUsd: 1 };
  const [zero, one] = ["/root/steps/0/items/0/body", "/root/steps/0/items/1/body"];
  const first = new AbortController();
  const second = new AbortController();
  const held0 = waits.wait(refusal, first.signal, { label: "fetch", path: zero });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual([waits.held(one), waits.held(zero) >= 300], [0, true], "item 0 held, item 1 untouched");
  const held1 = waits.wait(refusal, second.signal, { label: "fetch", path: one });
  await new Promise((resolve) => setTimeout(resolve, 100));
  first.abort();
  await held0;
  const before = waits.held(one);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(waits.held(one) >= before + 300, `item 1's clock runs on after item 0's wait ended: ${before} then ${waits.held(one)}`);
  second.abort();
  await held1;
});

test("a step whose nested decision waits for a raise counts once, as waiting: the paused process lets go after the hold, as with no nesting", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "nested-wait-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let gone = 0;
  const waits = budgetWaits(root, { cap: 1, spent: () => 0, add: () => undefined }, { holdMs: 100, letGo: () => void (gone += 1) });
  const refusal = { words: "Not sent: the decision could cost up to $2. Raise the cap to at least $2 to continue.", room: true, capUsd: 1 };
  const stop = new AbortController();
  // A model node (the outer step) whose verification decision (a step of its own, run inside it) waits for a raise.
  const decision = waits.step(async () => waits.wait(refusal, stop.signal, { label: "review", path: "/root/steps/0/verify" }));
  const node = waits.step(async () => decision());
  const running = node();
  for (const end = Date.now() + 2_000; gone === 0 && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 50));
  stop.abort();
  await running;
  assert.equal(gone, 1, "let go once the hold had passed");
});

test("a step still working beside one that waits keeps the process: nothing lets go while work is under way (a pin)", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "busy-beside-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let gone = 0;
  const waits = budgetWaits(root, { cap: 1, spent: () => 0, add: () => undefined }, { holdMs: 100, letGo: () => void (gone += 1) });
  const refusal = { words: "Not sent.", room: true, capUsd: 1 };
  const stop = new AbortController();
  let release;
  const busy = waits.step(() => new Promise((resolve) => (release = resolve)));
  const waiting = waits.step(async () => waits.wait(refusal, stop.signal, { label: "a", path: "/root/steps/1" }));
  const both = [busy(), waiting()];
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(gone, 0);
  stop.abort();
  release();
  await Promise.all(both);
});

