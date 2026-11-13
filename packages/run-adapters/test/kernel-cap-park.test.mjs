// What a refusal does to the run, and what a raise does. A refusal for room parks the run, unsent, with what it needs (its
// pending figures and the raise its words name); a refusal no raise could fix fails it. A raise is a number above the
// run's cap beyond a float's tail; the same raise again is a retry that changes nothing, and resumes the run once. A
// parked run raised goes on with one follow-up in the server's words.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CapRefused, checkRaise, followUpOf, parkOf, takeRaises } from "../dist/kernel/cap/index.js";
import { capOn, modelRequest, SONNET } from "./kernel-cap-support.mjs";

const refusedFor = async (capUsd, spentUsd = 0) => capOn(capUsd, { mode: "strict", spentUsd }).cap.admit(modelRequest(SONNET, 10_000, 4_096)).catch((error) => error);

test("a refusal for room parks the run unsent, with pending (least, raise) in the refusal's words and no error", async () => {
  const refusal = await refusedFor(0.05, 0.01);
  assert.ok(refusal instanceof CapRefused && !refusal.forGood);
  const park = parkOf(refusal, 0.05);
  assert.equal(park.outcome, "parked");
  assert.equal(park.error, undefined);
  assert.deepEqual(park.pending, { kind: "budget", cap_usd: 0.05, spent_usd: 0.01, needs_usd: 0.05286, least_cap_usd: 0.07, suggested_cap_usd: 1, bound_usd: microUp(refusal.figures.boundUsd ?? 0) });
  assert.equal(park.words, refusal.message.replace(/^spend_cap_reached \(out of budget\): /, ""));
});

const microUp = (usd) => Math.ceil(usd * 1e6 - 1e-9) / 1e6 + 0;

test("a park's pending names the refused step's bound (bound_usd), to a millionth rounded up; 0 when the refusal names none", () => {
  const withBound = new CapRefused("spend_cap_reached (out of budget): Not sent: the next step needs more", { forGood: false, spentUsd: 0.1, figures: { spentUsd: 0.1, needsUsd: 0.2, leastCapUsd: 0.31, boundUsd: 0.0123451 } });
  assert.equal(parkOf(withBound, 0.25).pending.bound_usd, 0.012346, "the refusal's boundUsd, rounded up to a millionth");
  const without = new CapRefused("spend_cap_reached (out of budget): Not sent: the next step needs more", { forGood: false, spentUsd: 0.1, figures: { spentUsd: 0.1, needsUsd: 0.2, leastCapUsd: 0.31 } });
  assert.equal(parkOf(without, 0.25).pending.bound_usd, 0, "none named: 0");
});

test("a park emits the refusal as a pause event, not an error", async () => {
  const park = parkOf(await refusedFor(0.05), 0.05);
  assert.equal(park.event.kind, "pause");
  assert.match(park.event.text, /^Not sent: the next step needs at least \$0\.06/);
});

test("a parked run's next step stays refused until the cap is raised, then goes", async () => {
  let capUsd = 0.05;
  const { cap } = capOn(() => capUsd, { mode: "strict" });
  await assert.rejects(cap.admit(modelRequest(SONNET, 10_000, 4_096)), CapRefused);
  await assert.rejects(cap.admit(modelRequest(SONNET, 10_000, 4_096)), CapRefused, "no message moves it");
  capUsd = 0.1;
  await cap.admit(modelRequest(SONNET, 10_000, 4_096));
});

test("a refusal for good fails the run, never parks it", async () => {
  const forGood = await capOn(1).cap.admit(modelRequest({ ...SONNET, outputCeiling: null }, 10)).catch((error) => error);
  const park = parkOf(forGood, 1);
  assert.equal(park.outcome, "failed");
  assert.equal(park.error, forGood.message);
  assert.equal(park.pending, undefined);
  // For good, whatever figures it carries: no raise could send it.
  const withFigures = new CapRefused("spend_cap_reached: Not sent: no output ceiling", { forGood: true, spentUsd: 0.1, figures: { spentUsd: 0.1, needsUsd: 0.2, leastCapUsd: 0.31 } });
  assert.equal(parkOf(withFigures, 1).outcome, "failed");
});

test("a raise is checked: a number above the run's cap; none for a run with no cap or an ended run", () => {
  assert.match(checkRaise({ capUsd: undefined }, 5).refused, /no cap to raise/);
  assert.match(checkRaise({ capUsd: 1, final: true }, 5).refused, /ended/);
  assert.match(checkRaise({ capUsd: 1 }, Number.NaN).refused, /a number/);
  assert.match(checkRaise({ capUsd: 1 }, 0.5).refused, /A cap is only raised: name more than the run's \$1\./);
  assert.deepEqual(checkRaise({ capUsd: 1, pause: "p1" }, 2), { raised: true, resumes: true, pause: "p1" });
  assert.deepEqual(checkRaise({ capUsd: 1 }, 2), { raised: true, resumes: false }, "a working run holds it from its next paid step");
});

test("a cap a hair above the run's is no raise; a retry differing by a float's tail answers as the first", () => {
  assert.match(checkRaise({ capUsd: 1 }, 1 + 1e-12).refused, /only raised/);
  const after = { capUsd: 2, pause: undefined, lastRaise: { to: 2, pause: "p1" } };
  assert.deepEqual(checkRaise(after, 2 + 1e-12), { retry: true, resumed: true });
});

test("two raise commands resume once: the second is no raise", () => {
  const taken = takeRaises({ capUsd: 1, pause: "p1" }, [{ id: 1, usd: 2 }, { id: 2, usd: 2 }]);
  assert.equal(taken.capUsd, 2);
  assert.equal(taken.followUps, 1);
  assert.deepEqual(taken.results.map((r) => [r.id, r.raised ?? false, r.retry ?? false]), [[1, true, false], [2, false, true]]);
});

test("two raises before the run is claimed resume once, at the later cap", () => {
  const taken = takeRaises({ capUsd: 1, pause: "p1" }, [{ id: 1, usd: 2 }, { id: 2, usd: 3 }]);
  assert.equal(taken.capUsd, 3);
  assert.equal(taken.followUps, 1);
  assert.equal(taken.followUp.text, "The cap was raised to $3; continue the task.");
});

test("a retry of a raise after the run parked again under it is no raise: resumed false, still parked", () => {
  const parkedAgain = { capUsd: 2, pause: "p2", lastRaise: { to: 2, pause: "p1" } };
  assert.deepEqual(checkRaise(parkedAgain, 2), { retry: true, resumed: false });
});

test("a raise command not yet taken sends its follow-up once on the next claim; the same raise again changes nothing", () => {
  const first = takeRaises({ capUsd: 1, pause: "p1" }, [{ id: 7, usd: 5 }]);
  assert.equal(first.followUps, 1);
  const again = takeRaises({ capUsd: 5, lastRaise: { to: 5, pause: "p1" } }, [{ id: 8, usd: 5 }]);
  assert.equal(again.followUps, 0);
  assert.equal(again.capUsd, 5);
});

test("a parked run raised goes on: one follow-up in the server's words, under the new cap", () => {
  assert.deepEqual(followUpOf(1), { text: "The cap was raised to $1; continue the task.", author: "server", reason: "cap_raised" });
});

test("pending figures are to a millionth of a dollar", async () => {
  const park = parkOf(await refusedFor(0.05, 0.0123456789), 0.05);
  assert.equal(park.pending.spent_usd, 0.012346);
});
