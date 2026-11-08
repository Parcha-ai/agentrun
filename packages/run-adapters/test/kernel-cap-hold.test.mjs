// What the kernel cap holds while a request or a paid call is under way: each one's own figure (a model request's at its
// output and input bound, a paid call's at its quote or allowance), counted beside what was spent until it settles, so
// two that fit alone cannot pass the cap together, on every harness and for every priced tool.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapRefused } from "../dist/kernel/cap/index.js";
import { capOn, modelRequest, SONNET, toolRequest, usd } from "./kernel-cap-support.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-12, `${message ?? ""} ${actual} vs ${expected}`);
// 10,000 tokens in ($0.0375) and 2,000 out ($0.03): $0.0675 at worst; its least (1,024 out) is $0.05286.
const tenK = (extra) => modelRequest(SONNET, 10_000, 2_000, extra);

test("a request in flight holds its worst case: a second one beside it is refused, and goes once the first answered", async () => {
  const { cap } = capOn(0.1, { mode: "strict" });
  const first = tenK();
  await cap.admit(first);
  near(cap.heldUsd(), usd(10_000, 3.75) + usd(2_000, 15));
  await assert.rejects(cap.admit(tenK()), CapRefused, "$0.0325 left cannot buy the second's least");
  await cap.settle(first.id, { end: "answered", usd: 0.02 });
  assert.equal(cap.heldUsd(), 0);
  await cap.admit(tenK());
});

test("a paid call under way holds its price: a model request that fits only without it is refused, and goes once the call is charged", async () => {
  const { cap } = capOn(0.1, { mode: "strict" });
  const call = toolRequest("monid_run", 0.06);
  await cap.admit(call);
  await assert.rejects(cap.admit(tenK()), CapRefused);
  await cap.settle(call.id, { end: "charged", usd: 0.01 });
  near(cap.spentUsd(), 0.01);
  await cap.admit(tenK());
});

test("each request in flight holds its own input bound: two that fit alone cannot pass the cap together", async () => {
  // 20,000 in and 1,024 out: $0.09036 each, under a $0.15 cap alone, past it together.
  const { cap } = capOn(0.15, { mode: "strict" });
  await cap.admit(modelRequest(SONNET, 20_000, 1_024));
  await assert.rejects(cap.admit(modelRequest(SONNET, 20_000, 1_024)), CapRefused);
});

test("side requests sent side by side each hold and settle their own id and bound", async () => {
  const { cap } = capOn(10, { mode: "strict" });
  const one = await cap.admit(modelRequest(SONNET, 1_000, 500, { side: true, id: "side-1" }));
  const two = await cap.admit(modelRequest(SONNET, 3_000, 500, { side: true, id: "side-2" }));
  near(cap.heldUsd(), one.heldUsd + two.heldUsd);
  await cap.settle("side-1", { end: "answered", usd: 0.001 });
  near(cap.heldUsd(), two.heldUsd, "only side-1's hold went");
});

test("a Parallel search under way holds its fee: a request that fits only without it waits until it charged", async () => {
  const { cap: probe } = capOn(10);
  const least = probe.leastUsd(tenK());
  const { cap } = capOn(least + 0.004);
  const search = toolRequest("parallel_search", 0.005, { basis: "its most fee" });
  await cap.admit(search);
  await assert.rejects(cap.admit(tenK()), CapRefused);
  await cap.settle(search.id, { end: "charged", usd: 0 });
  await cap.admit(tenK());
});

test("a page's one Parallel extract holds $0.001 while under way; its later parts hold nothing", async () => {
  const { cap } = capOn(1);
  await cap.admit(toolRequest("parallel_extract", 0.001));
  await cap.admit(toolRequest("parallel_extract", 0, { basis: "a later part of the same page" }));
  near(cap.heldUsd(), 0.001);
});
