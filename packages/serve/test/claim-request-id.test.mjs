// What the computer package's dial relies on from serve: two claims of one run never share a computer's create request,
// so never its name. A dial machine's token and its hub socket go by that name (hosted/provider.ts #inTurn, #converge),
// and a mint replaces the name's token, so two processes creating under one name would cut each other's machine. Each
// claim takes the run's next epoch in the store, and every create of a claim (its computer, and each sandbox made after
// a loss) carries that epoch in its request. Claimed through the real store: a claim whose lease ran out while its
// runner may still be creating, then another runner's claim, and a released claim, then the next.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computerNameFor } from "@parcha/agentrun-computer";
import { claimRequestId, lostRequestId } from "../dist/workspace/computer-for-claim.js";
import { queued, storeOn } from "./store-helpers.mjs";

/** Every create request a claim's computer may be made under: its own, and the first sandboxes made after a loss. */
const requestsOf = (claim) => [claimRequestId(claim), ...[1, 2, 3].map((times) => lostRequestId(claim, times))];

/** No request, and no computer name, of claim `a` is one of claim `b`'s. */
function apart(a, b, how) {
  assert.notEqual(a.epoch, b.epoch, `${how}: the claims hold different epochs`);
  const ours = requestsOf(a);
  const theirs = requestsOf(b);
  for (const id of ours) assert.ok(!theirs.includes(id), `${how}: request ${id} is both claims' (${JSON.stringify(theirs)})`);
  const names = new Set(theirs.map(computerNameFor));
  for (const id of ours) assert.ok(!names.has(computerNameFor(id)), `${how}: ${computerNameFor(id)} (request ${id}) is both claims' computer name`);
  // Within one claim, too, each create has a request of its own.
  assert.equal(new Set(ours).size, ours.length, `${how}: one claim's requests are distinct: ${JSON.stringify(ours)}`);
}

test("two claims of one run never share a computer create request or name: a claim whose lease ran out and the next runner's claim, and a released claim and the next", async (t) => {
  const leaseMs = 30_000;
  const { store, clock } = await storeOn(t);
  await queued(store, "run-1");
  const first = await store.claim("run-1", "runner-a", { leaseMs });
  assert.ok(first, "runner-a claims the run");
  // runner-a's lease runs out while it may still be creating its computer; runner-b claims the run.
  clock.now += leaseMs + 1;
  const second = await store.claim("run-1", "runner-b", { leaseMs });
  assert.ok(second, "runner-b claims the run once runner-a's lease ran out");
  assert.equal(second.epoch, first.epoch + 1, "the claim takes the run's next epoch");
  apart(first, second, "a lapsed claim and the next");

  await store.release(second);
  const third = await store.claim("run-1", "runner-a", { leaseMs });
  assert.ok(third, "runner-a claims the released run again");
  // A release moves the epoch too, so a claim held past its release is fenced; the next claim takes the epoch after.
  assert.ok(third.epoch > second.epoch, `the claim after a release takes a later epoch (${second.epoch}, then ${third.epoch})`);
  apart(second, third, "a released claim and the next");
  apart(first, third, "the first claim and the third");
});
