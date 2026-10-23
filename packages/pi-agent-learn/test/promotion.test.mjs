// The promotion rules of the archived harness (src/workflow/promotion.ts and status.ts, with test/workflow_promotion.test.mjs),
// stated again here from what the rules mean: demote after the last N uses failed or escalated and restore the revision that
// was active before; never promote a demoted revision again; promote a trial after K clean uses that finished frozen.
import assert from "node:assert/strict";
import { test } from "node:test";
import { admitRevision, applyDecision, currentRevision, foldUses, LearnError, parseTrial, periodUses, PROMOTION_DEFAULTS, promotionDecision, renderTrial, thresholdsOf, TRIAL_LIMITS } from "../dist/index.js";

const sha = (c) => c.repeat(64);
const at = (h, m = 0) => `2026-10-16T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
const use = (run, digest, outcome, when) => ({ run, sha256: sha(digest), outcome, at: when });
const WHEN = [{ pointer: "/sku", op: "exists" }];
const admit = (trial, digest, hour, run = "author") => {
  const admitted = admitRevision(trial, { name: "audit", sha256: sha(digest), run, at: at(hour), when: WHEN });
  assert.equal(admitted.status, "admitted");
  return admitted.trial;
};
/** Revision `digest` admitted at `hour` and promoted by three clean uses of its own right after. */
const proven = (trial, digest, hour) => {
  const base = admit(trial, digest, hour);
  const folded = foldUses(base, [use("u1", digest, "frozen", at(hour, 1)), use("u2", digest, "frozen", at(hour, 2)), use("u3", digest, "frozen", at(hour, 3))]);
  assert.equal(folded.trial.status, "active");
  return folded.trial;
};
const statusOf = (trial) => Object.fromEntries(trial.revisions.map((r) => [r.sha256[0], r.status]));
const live = (trial) => trial.revisions.find((r) => r.status === "trial" || r.status === "active")?.sha256[0];
const outcomes = (...list) => list.map((outcome, i) => use(`r${i}`, "b", outcome, at(10, i)));

test("the defaults are three clean uses to promote and two bad ones to demote, and a host's thresholds replace them", () => {
  assert.deepEqual({ ...PROMOTION_DEFAULTS }, { promoteAfter: 3, demoteAfter: 2 });
  assert.deepEqual(thresholdsOf({ promoteAfter: 5 }), { promoteAfter: 5, demoteAfter: 2 });
  for (const bad of [0, -1, 1.5, TRIAL_LIMITS.threshold + 1, "3", NaN]) assert.throws(() => thresholdsOf({ promoteAfter: bad }), (e) => e instanceof LearnError && e.code === "invalid");
  assert.throws(() => thresholdsOf({ demoteAfter: 0 }), LearnError);
});

test("a new workflow is a trial; three clean uses by other runs in a row promote it, two do not", () => {
  const trial = admit(undefined, "a", 1);
  assert.deepEqual([trial.status, statusOf(trial)], ["trial", { a: "trial" }]);
  const two = foldUses(trial, [use("r1", "a", "frozen", at(2)), use("r2", "a", "frozen", at(3))]);
  assert.equal(two.trial.status, "trial");
  assert.equal(promotionDecision(two.trial).action, "hold");
  const three = foldUses(two.trial, [use("r3", "a", "frozen", at(4))]);
  assert.deepEqual([three.trial.status, three.applied.map((a) => a.decision.action)], ["active", ["promote"]]);
  assert.equal(three.trial.revisions[0].since, at(4), "the standing dates from the use that earned it");
});

test("an escalation or a failure between clean uses starts the count again", () => {
  for (const bad of ["escalated", "failed"]) {
    const trial = admit(undefined, "a", 1);
    const folded = foldUses(trial, [use("r1", "a", "frozen", at(2)), use("r2", "a", "frozen", at(3)), use("r3", "a", bad, at(4)), use("r4", "a", "frozen", at(5)), use("r5", "a", "frozen", at(6))]);
    assert.equal(folded.trial.status, "trial", `${bad}: two clean uses since is not three`);
    assert.equal(foldUses(folded.trial, [use("r6", "a", "frozen", at(7))]).trial.status, "active", `${bad}: the third clean use in a row promotes`);
  }
});

test("promotion needs the host's own number of clean uses", () => {
  const trial = admit(undefined, "a", 1);
  const uses = [use("r1", "a", "frozen", at(2)), use("r2", "a", "frozen", at(3))];
  assert.equal(foldUses(trial, uses, { thresholds: { promoteAfter: 2 } }).trial.status, "active");
  assert.equal(foldUses(trial, uses, { thresholds: { promoteAfter: 4 } }).trial.status, "trial");
});

test("the run that wrote a revision is no evidence for it, nor is a use of a revision the trial does not hold, nor a use folded twice", () => {
  const trial = admit(undefined, "a", 1, "writer");
  const uses = [use("writer", "a", "frozen", at(2)), use("writer", "a", "frozen", at(3)), use("writer", "a", "frozen", at(4)), use("r1", "z", "frozen", at(5)), use("r2", "a", "frozen", at(6))];
  const first = foldUses(trial, uses);
  assert.deepEqual(first.ignored.map((i) => [i.use.run, i.reason]), [["writer", "author"], ["writer", "author"], ["writer", "author"], ["r1", "unknown_revision"]]);
  assert.deepEqual([first.trial.status, first.trial.uses.length], ["trial", 1]);
  const again = foldUses(first.trial, [use("r2", "a", "frozen", at(6))]);
  assert.deepEqual([again.ignored.map((i) => i.reason), again.trial.uses.length], [["duplicate"], 1]);
});

test("two failed or escalated uses in a row demote the active revision and bring back the one that was active before; one, or a clean use between, does not", () => {
  let trial = proven(undefined, "a", 1);
  trial = proven(trial, "b", 5);
  assert.deepEqual(statusOf(trial), { a: "superseded", b: "active" });
  const fold = (...list) => foldUses(trial, outcomes(...list).map((u) => ({ ...u, at: at(12, Number(u.run.slice(1))) })));
  for (const pair of [["failed", "escalated"], ["escalated", "escalated"], ["failed", "failed"]]) {
    const folded = fold(...pair);
    assert.deepEqual([folded.trial.status, statusOf(folded.trial), live(folded.trial)], ["active", { a: "active", b: "demoted" }, "a"], pair.join(","));
    assert.deepEqual(folded.applied[0].decision.rollbackTo, sha("a"));
  }
  assert.equal(fold("failed", "frozen", "failed").trial.status, "active");
  assert.equal(live(fold("failed", "frozen", "failed").trial), "b", "a clean use between breaks the run of failures");
  assert.equal(live(fold("failed").trial), "b", "one failure is not two");
  assert.equal(promotionDecision(trial).action, "hold");
});

test("a trial demotes the same way, and the active revision it replaced comes back", () => {
  let trial = proven(undefined, "a", 1);
  trial = admit(trial, "b", 5);
  assert.deepEqual(statusOf(trial), { a: "superseded", b: "trial" });
  const folded = foldUses(trial, [use("r1", "b", "escalated", at(6)), use("r2", "b", "escalated", at(7))]);
  assert.deepEqual([folded.trial.status, statusOf(folded.trial)], ["active", { a: "active", b: "demoted" }]);
});

test("with nothing active before, a demotion leaves the name demoted and nothing live", () => {
  const trial = admit(undefined, "a", 1);
  const folded = foldUses(trial, [use("r1", "a", "failed", at(2)), use("r2", "a", "failed", at(3))]);
  assert.deepEqual([folded.trial.status, statusOf(folded.trial), live(folded.trial), folded.applied[0].decision.rollbackTo], ["demoted", { a: "demoted" }, undefined, null]);
  assert.equal(promotionDecision(folded.trial).action, "hold");
});

test("a revision that was only a trial when it was replaced is never restored by a later demotion", () => {
  let trial = admit(undefined, "a", 1);
  trial = admit(trial, "b", 2);
  assert.deepEqual(statusOf(trial), { a: "retired", b: "trial" });
  const folded = foldUses(trial, [use("r1", "b", "failed", at(3)), use("r2", "b", "failed", at(4))]);
  assert.deepEqual([folded.trial.status, statusOf(folded.trial)], ["demoted", { a: "retired", b: "demoted" }]);
});

test("a demoted revision is never promoted or tried again, whatever its uses; a changed document, a new digest, can be", () => {
  let trial = proven(undefined, "a", 1);
  trial = admit(trial, "b", 5);
  trial = foldUses(trial, [use("r1", "b", "failed", at(6)), use("r2", "b", "failed", at(7))]).trial;
  assert.equal(statusOf(trial).b, "demoted");
  const again = admitRevision(trial, { name: "audit", sha256: sha("b"), run: "later", at: at(8), when: WHEN });
  assert.deepEqual([again.status, again.reason], ["refused", "demoted"]);
  const clean = foldUses(trial, [use("r3", "b", "frozen", at(9)), use("r4", "b", "frozen", at(10)), use("r5", "b", "frozen", at(11)), use("r6", "b", "frozen", at(12))]);
  assert.deepEqual([statusOf(clean.trial).b, live(clean.trial)], ["demoted", "a"], "clean uses of a demoted revision change nothing");
  assert.throws(() => applyDecision(trial, { action: "promote", sha256: sha("b"), reason: "x" }, at(13)), (e) => e instanceof LearnError);
  const fresh = admitRevision(trial, { name: "audit", sha256: sha("c"), run: "later", at: at(14), when: WHEN });
  assert.equal(fresh.status, "admitted");
  assert.deepEqual(statusOf(fresh.trial), { a: "superseded", b: "demoted", c: "trial" });
});

test("a revision restored by a demotion is not demoted again for failures from before it was superseded, only for two since it came back", () => {
  let trial = admit(undefined, "a", 1);
  trial = foldUses(trial, [use("x1", "a", "frozen", at(1, 1)), use("x2", "a", "frozen", at(1, 2)), use("x3", "a", "frozen", at(1, 3))]).trial;
  trial = foldUses(trial, [use("x4", "a", "failed", at(1, 4))]).trial;
  assert.equal(live(trial), "a", "one failure does not demote it");
  trial = admit(trial, "b", 5);
  trial = foldUses(trial, [use("y1", "b", "failed", at(6)), use("y2", "b", "failed", at(7))]).trial;
  assert.deepEqual(statusOf(trial), { a: "active", b: "demoted" });
  const a = trial.revisions.find((r) => r.sha256 === sha("a"));
  assert.equal(a.since, at(7));
  assert.deepEqual(periodUses(trial, a), [], "its earlier uses are not in its period");
  assert.equal(promotionDecision(trial).action, "hold");
  const once = foldUses(trial, [use("z1", "a", "failed", at(8))]);
  assert.equal(live(once.trial), "a", "the failure before it was superseded plus one now are not two in its period");
  const twice = foldUses(once.trial, [use("z2", "a", "failed", at(9))]);
  assert.deepEqual([twice.trial.status, statusOf(twice.trial)], ["demoted", { a: "demoted", b: "demoted" }]);
});

test("a rollback never restores a revision the store can no longer load: it takes the next one back, or nothing, and says what it passed", () => {
  let trial = proven(undefined, "a", 1);
  trial = proven(trial, "b", 5);
  trial = proven(trial, "c", 9);
  assert.deepEqual(statusOf(trial), { a: "superseded", b: "superseded", c: "active" });
  const failing = { ...trial, uses: [...trial.uses, use("r1", "c", "failed", at(13)), use("r2", "c", "failed", at(14))] };
  const decide = (unrunnable) => promotionDecision(failing, { unrunnable: new Set(unrunnable.map(sha)) });
  assert.equal(decide([]).rollbackTo, sha("b"), "the most recently active");
  const skipB = decide(["b"]);
  assert.equal(skipB.rollbackTo, sha("a"));
  assert.deepEqual(skipB.skipped, [sha("b")]);
  assert.match(skipB.reason, new RegExp(`; skipped unrunnable ${sha("b").slice(0, 12)}$`));
  const none = decide(["a", "b"]);
  assert.deepEqual([none.action, none.rollbackTo, none.skipped], ["demote", null, [sha("b"), sha("a")]]);
  const olderOnly = decide(["a"]);
  assert.equal(olderOnly.rollbackTo, sha("b"));
  assert.deepEqual(olderOnly.skipped, [], "a stale revision older than the one the search lands on is never named");
});

test("the order uses happened in decides, not the order they are folded: clean, clean, clean, then two failures promotes and then demotes", () => {
  let trial = proven(undefined, "a", 1);
  trial = admit(trial, "b", 5);
  const batch = [
    use("r5", "b", "failed", at(9)), use("r1", "b", "frozen", at(6)), use("r4", "b", "escalated", at(8)),
    use("r2", "b", "frozen", at(7, 1)), use("r3", "b", "frozen", at(7, 30)),
  ];
  const folded = foldUses(trial, batch);
  assert.deepEqual(folded.applied.map((a) => [a.decision.action, a.at]), [["promote", at(7, 30)], ["demote", at(9)]]);
  assert.deepEqual(statusOf(folded.trial), { a: "active", b: "demoted" });
  assert.deepEqual(folded.trial.uses.filter((u) => u.sha256 === sha("b")).map((u) => u.run), ["r1", "r2", "r3", "r4", "r5"]);
});

test("a superseded revision keeps its preconditions and its skill's description, and a demotion gives them back with it", () => {
  let trial = proven(undefined, "a", 1);
  trial = { ...trial, when: WHEN };
  const other = [{ pointer: "/other", op: "exists" }];
  const admitted = admitRevision(trial, { name: "audit", sha256: sha("b"), run: "w", at: at(5), when: other, replacedDescription: "Look up a US company." });
  assert.equal(admitted.status, "admitted");
  trial = admitted.trial;
  const a = trial.revisions.find((r) => r.sha256 === sha("a"));
  assert.deepEqual([a.status, a.when, a.description], ["superseded", WHEN, "Look up a US company."]);
  assert.deepEqual(trial.when, other, "the live revision's own checks are the trial's");
  const folded = foldUses(trial, [use("r1", "b", "failed", at(6)), use("r2", "b", "failed", at(7))]);
  assert.deepEqual(folded.trial.when, WHEN, "the restored revision's checks are back");
  const back = folded.trial.revisions.find((r) => r.sha256 === sha("a"));
  assert.deepEqual([back.status, "when" in back, "description" in back], ["active", false, false], "what it kept while superseded is the trial's again");
  const none = admitRevision(trial, { name: "audit", sha256: sha("c"), run: "w", at: at(8), when: WHEN });
  assert.deepEqual(none.trial.revisions.find((r) => r.sha256 === sha("b")).status, "retired", "a trial replaced before it proved itself keeps nothing");
  assert.equal("description" in none.trial.revisions.find((r) => r.sha256 === sha("b")), false);
});

test("only the newest few superseded revisions can be restored: an older one is retired and can never come back", () => {
  let trial = proven(undefined, "a", 1);
  for (const [i, digest] of ["b", "c", "d", "e"].entries()) {
    const admitted = admitRevision(trial, { name: "audit", sha256: sha(digest), run: "w", at: at(5 + i * 4), when: WHEN, replacedDescription: `description ${i}` });
    trial = foldUses(admitted.trial, [use(`x${i}1`, digest, "frozen", at(6 + i * 4)), use(`x${i}2`, digest, "frozen", at(7 + i * 4)), use(`x${i}3`, digest, "frozen", at(8 + i * 4))]).trial;
  }
  assert.deepEqual(statusOf(trial), { a: "retired", b: "superseded", c: "superseded", d: "superseded", e: "active" });
  assert.equal("when" in trial.revisions[0], false, "the retired one let go of what it kept");
  const failed = foldUses(trial, [use("y1", "e", "failed", at(30)), use("y2", "e", "failed", at(31))]);
  assert.deepEqual([live(failed.trial), failed.applied[0].decision.rollbackTo], ["d", sha("d")]);
});

test("the order uses were folded in decides, not a clock: a receipt that arrives late counts toward the standing that followed", () => {
  const trial = admit(undefined, "a", 1);
  const first = foldUses(trial, [use("r1", "a", "frozen", at(2)), use("r2", "a", "frozen", at(3)), use("r3", "a", "frozen", at(5))]);
  assert.equal(first.trial.status, "active", "three clean uses were all there was, and they promote");
  const late = foldUses(first.trial, [use("r4", "a", "failed", at(4))]);
  assert.equal(late.trial.status, "active", "one failure, however early its time, is one failure in the standing it arrived in");
  assert.deepEqual(periodUses(late.trial, late.trial.revisions[0]).map((u) => u.run), ["r4"]);
  const second = foldUses(late.trial, [use("r5", "a", "failed", at(4, 30))]);
  assert.deepEqual([second.trial.status, second.applied.map((a) => a.decision.action)], ["demoted", ["demote"]], "a second one demotes");
});

test("one run is one use of a revision, however many cases it ran: three frozen cases in one run are one use, and three clean uses are three distinct runs", () => {
  const trial = admit(undefined, "a", 1);
  const cases = (run, ...outcomes) => outcomes.map((outcome, i) => use(run, "a", outcome, at(2, i)));
  const alone = foldUses(trial, cases("r1", "frozen", "frozen", "frozen"));
  assert.deepEqual([alone.trial.status, alone.trial.uses.length], ["trial", 1], "one run on three inputs does not promote it");
  assert.deepEqual(alone.ignored.map((i) => i.reason), ["same_run", "same_run"], "the other two cases are named, not dropped silently");
  const two = foldUses(trial, [...cases("r1", "frozen", "frozen", "frozen"), ...cases("r2", "frozen", "frozen")]);
  assert.deepEqual([two.trial.status, two.trial.uses.map((u) => u.run).sort()], ["trial", ["r1", "r2"]], "two runs are two uses, whatever they ran");
  const three = foldUses(trial, [...cases("r1", "frozen", "frozen"), ...cases("r2", "frozen"), ...cases("r3", "frozen", "frozen", "frozen")]);
  assert.deepEqual([three.trial.status, three.applied.map((a) => a.decision.action)], ["active", ["promote"]], "three distinct runs promote it");
  assert.equal(foldUses(trial, [...cases("r1", "frozen"), ...cases("r2", "frozen")], { thresholds: { promoteAfter: 2 } }).trial.status, "active", "K clean uses are K runs for the host's K too");
});

test("a run's worst case is its outcome: one bad case counts against the run, and failed outranks escalated outranks frozen", () => {
  const trial = admit(undefined, "a", 1);
  const outcomeOf = (...outcomes) => foldUses(trial, outcomes.map((o, i) => use("r1", "a", o, at(2, i)))).trial.uses.map((u) => u.outcome);
  assert.deepEqual(outcomeOf("frozen", "failed", "frozen"), ["failed"]);
  assert.deepEqual(outcomeOf("frozen", "escalated", "frozen"), ["escalated"]);
  assert.deepEqual(outcomeOf("escalated", "failed"), ["failed"]);
  assert.deepEqual(outcomeOf("failed", "frozen", "escalated"), ["failed"]);
  const clean = foldUses(trial, [use("r1", "a", "frozen", at(2)), use("r2", "a", "frozen", at(3))]).trial;
  const spoiled = foldUses(clean, [use("r3", "a", "frozen", at(4)), use("r3", "a", "escalated", at(5)), use("r3", "a", "frozen", at(6))]);
  assert.equal(spoiled.trial.status, "trial", "a run with one escalated case among clean ones is not a clean use");
  assert.equal(spoiled.trial.uses.at(-1).outcome, "escalated");
});

test("demotion looks at the last two runs, not the last two cases: one run failing twice is one failure, and two runs failing once each demote", () => {
  const active = proven(undefined, "a", 1);
  const cases = (run, n, outcome = "failed") => Array.from({ length: n }, (_, i) => use(run, "a", outcome, at(10, i)));
  const oneRun = foldUses(active, cases("r1", 3));
  assert.deepEqual([oneRun.trial.status, oneRun.applied], ["active", []], "three failed cases in one run are one failed use");
  const twoRuns = foldUses(oneRun.trial, [use("r2", "a", "escalated", at(11))]);
  assert.deepEqual([twoRuns.trial.status, twoRuns.applied.map((a) => a.decision.action)], ["demoted", ["demote"]], "a second run that failed or escalated demotes it");
  assert.equal(foldUses(active, [...cases("r1", 1), use("r2", "a", "frozen", at(11))]).trial.status, "active", "a clean run between two bad ones breaks the pair");
});

test("a run already folded for a revision is not folded again, and the author's own cases stay out however many there are", () => {
  const trial = admit(undefined, "a", 1, "writer");
  const first = foldUses(trial, [use("r1", "a", "frozen", at(2)), use("writer", "a", "frozen", at(2)), use("writer", "a", "frozen", at(3)), use("writer", "a", "frozen", at(4))]);
  assert.deepEqual(first.ignored.map((i) => [i.use.run, i.reason]), [["writer", "author"], ["writer", "author"], ["writer", "author"]]);
  assert.equal(first.trial.uses.length, 1);
  const again = foldUses(first.trial, [use("r1", "a", "frozen", at(2)), use("r1", "a", "failed", at(3))]);
  assert.deepEqual(again.ignored.map((i) => i.reason), ["duplicate", "duplicate"], "a second call for the same run and revision is a replay, whatever it says");
  assert.equal(again.trial.uses.length, 1);
});

test("the boundaries move when the oldest uses are dropped, so a standing still counts exactly its own uses", () => {
  let trial = admit(undefined, "a", 1);
  for (let i = 0; i < TRIAL_LIMITS.uses + 5; i += 1) trial = foldUses(trial, [use(`run-${i}`, "a", i % 2 ? "frozen" : "escalated", at(2, i % 60))]).trial;
  assert.equal(trial.uses.length, TRIAL_LIMITS.uses);
  assert.ok(trial.revisions[0].after <= trial.uses.length);
  assert.equal(trial.status, "trial", "alternating never gives three clean in a row or two bad");
  assert.deepEqual(parseTrial(renderTrial(trial), "audit"), trial);
});

test("only the newest uses are kept, and a long run of them never reaches the file cap", () => {
  let trial = proven(undefined, "a", 1);
  const batch = Array.from({ length: TRIAL_LIMITS.uses + 20 }, (_, i) => use(`run-${i}`, "a", "frozen", at(2 + Math.floor(i / 60), i % 60)));
  trial = foldUses(trial, batch).trial;
  assert.equal(trial.uses.length, TRIAL_LIMITS.uses);
  assert.equal(trial.uses.at(-1).run, `run-${batch.length - 1}`);
  assert.deepEqual(parseTrial(renderTrial(trial), "audit"), trial);
});

const digestOf = (i) => (i + 1).toString(16).padStart(64, "0");
const stamp = (i, k) => at(1 + Math.floor(i / 20), (i % 20) * 3 + k);
/** A stream that tries `n` revisions in turn, each admitted and then demoted by two failed uses from other runs. */
function churned(n) {
  let trial;
  for (let i = 0; i < n; i += 1) {
    const admitted = admitRevision(trial, { name: "audit", sha256: digestOf(i), run: "w", at: stamp(i, 0), when: WHEN });
    assert.equal(admitted.status, "admitted", `revision ${i}: ${admitted.detail ?? ""}`);
    const fail = (k) => ({ run: `x${i}-${k}`, sha256: digestOf(i), outcome: "failed", at: stamp(i, k) });
    trial = foldUses(admitted.trial, [fail(1), fail(2)]).trial;
    assert.equal(trial.revisions.find((r) => r.sha256 === digestOf(i)).status, "demoted");
  }
  return trial;
}

test("a stream that demotes as many revisions as a name holds can still admit a new one and promote it: retired and demoted revisions are no slots", () => {
  const trial = churned(TRIAL_LIMITS.revisions);
  assert.deepEqual([trial.status, trial.revisions.length], ["demoted", TRIAL_LIMITS.revisions]);
  const fresh = "f".repeat(64);
  const admitted = admitRevision(trial, { name: "audit", sha256: fresh, run: "w", at: at(9), when: WHEN });
  assert.equal(admitted.status, "admitted", admitted.detail);
  assert.ok(admitted.trial.revisions.length <= TRIAL_LIMITS.revisions);
  assert.ok((admitted.trial.refused ?? []).includes(digestOf(0)), "the oldest demoted digest is kept as a refusal");
  assert.deepEqual(parseTrial(renderTrial(admitted.trial), "audit"), admitted.trial, "the trial still renders and reads back");
  const clean = Array.from({ length: PROMOTION_DEFAULTS.promoteAfter }, (_, k) => ({ run: `c${k}`, sha256: fresh, outcome: "frozen", at: at(9, k + 1) }));
  const promoted = foldUses(admitted.trial, clean).trial;
  assert.deepEqual([promoted.status, promoted.revisions.find((r) => r.sha256 === fresh).status], ["active", "active"]);
});

test("a demoted digest saved again is refused, whether the trial still holds it or keeps it only as a refusal", () => {
  const fresh = "f".repeat(64);
  const admitted = admitRevision(churned(TRIAL_LIMITS.revisions), { name: "audit", sha256: fresh, run: "w", at: at(9), when: WHEN }).trial;
  assert.deepEqual(admitted.revisions.map((r) => r.sha256), [fresh], "every demoted revision left for the refusals");
  assert.equal(admitted.refused.length, TRIAL_LIMITS.revisions);
  const fail = (k) => ({ run: `z${k}`, sha256: fresh, outcome: "failed", at: at(10, k) });
  const demoted = foldUses(admitted, [fail(1), fail(2)]).trial;
  assert.equal(demoted.revisions[0].status, "demoted");
  for (const digest of [digestOf(0), digestOf(TRIAL_LIMITS.revisions - 1), fresh]) {
    const again = admitRevision(demoted, { name: "audit", sha256: digest, run: "w", at: at(11), when: WHEN });
    assert.deepEqual([again.status, again.reason], ["refused", "demoted"], digest);
  }
  // The next new revision moves the newly demoted one to the refusals too, and stays compact.
  const next = admitRevision(demoted, { name: "audit", sha256: "e".repeat(64), run: "w", at: at(12), when: WHEN });
  assert.equal(next.status, "admitted");
  assert.deepEqual([next.trial.revisions.map((r) => r.sha256), next.trial.refused.at(-1)], [["e".repeat(64)], fresh]);
  assert.deepEqual(parseTrial(renderTrial(next.trial), "audit"), next.trial);
});

test("a 400-revision stream of demotions always admits: a full refusals list loses its oldest digest and never refuses", () => {
  const n = 400;
  const trial = churned(n);
  assert.equal(trial.refused.length, TRIAL_LIMITS.refused);
  // The newest refusals, oldest first: every revision but the last (still held, demoted) moved there in turn.
  assert.deepEqual(trial.refused, Array.from({ length: TRIAL_LIMITS.refused }, (_, k) => digestOf(n - 1 - TRIAL_LIMITS.refused + k)));
  assert.deepEqual(trial.revisions.map((r) => [r.sha256, r.status]), [[digestOf(n - 1), "demoted"]]);
  assert.deepEqual(parseTrial(renderTrial(trial), "audit"), trial, "the trial still renders and reads back");
});

test("the newest refused digests stay refused when saved again; the oldest, once it left the list, is admitted again", () => {
  const n = 400;
  const trial = churned(n);
  for (let i = n - 1 - TRIAL_LIMITS.refused; i < n; i += 1) {
    const again = admitRevision(trial, { name: "audit", sha256: digestOf(i), run: "w", at: at(23), when: WHEN });
    assert.deepEqual([again.status, again.reason], ["refused", "demoted"], `revision ${i}`);
  }
  for (const i of [0, n - 2 - TRIAL_LIMITS.refused]) {
    const again = admitRevision(trial, { name: "audit", sha256: digestOf(i), run: "w", at: at(23), when: WHEN });
    assert.equal(again.status, "admitted", `revision ${i}, evicted: ${again.detail ?? ""}`);
    assert.equal(again.trial.revisions.at(-1).sha256, digestOf(i));
    assert.deepEqual(parseTrial(renderTrial(again.trial), "audit"), again.trial);
  }
});

test("a digest that leaves the refusals takes its kept uses with it: the trial reads back, the new trial's uses start after them", () => {
  // X gets one failed use (not demoted) and is retired by the next trial; retired trials follow with no use of their own,
  // so X's use is still among the kept uses when its digest leaves the full refusals list.
  const x = "c".repeat(64);
  let trial = admitRevision(undefined, { name: "audit", sha256: x, run: "w", at: at(1), when: WHEN }).trial;
  trial = foldUses(trial, [{ run: "x-1", sha256: x, outcome: "failed", at: at(1, 1) }]).trial;
  const tick = (i) => new Date(Date.UTC(2026, 9, 18) + i * 1000).toISOString();
  for (let i = 0; i < TRIAL_LIMITS.revisions + TRIAL_LIMITS.refused + 1; i += 1) {
    const admitted = admitRevision(trial, { name: "audit", sha256: digestOf(i), run: "w", at: tick(i), when: WHEN });
    assert.equal(admitted.status, "admitted", `revision ${i}: ${admitted.detail ?? ""}`);
    trial = admitted.trial;
    assert.deepEqual(parseTrial(renderTrial(trial), "audit"), trial, `revision ${i}: the trial reads back`);
  }
  assert.equal(trial.refused.includes(x), false, "X left the refusals");
  assert.equal(trial.uses.some((u) => u.sha256 === x), false, "and its use with it");
  assert.equal(trial.revisions.at(-1).after, trial.uses.length);
  const clean = Array.from({ length: PROMOTION_DEFAULTS.promoteAfter }, (_, k) => ({ run: `c${k}`, sha256: trial.revisions.at(-1).sha256, outcome: "frozen", at: at(9, k + 1) }));
  assert.equal(foldUses(trial, clean).trial.status, "active", "the live trial still earns its promotion");
});

test("eviction drops only the evicted digest's uses: the champion's and the live trial's uses stay, and every after counts only the uses kept", () => {
  // X gets one failed use and is retired; L is promoted on two clean uses (after 3) and stays superseded, restorable, while
  // retired trials fill the refusals with X oldest; the live trial T gets a use of its own; admitting N retires T and
  // evicts X. Only X's use may leave: a rule that drops the name's uses wholesale loses L's and T's.
  const [x, l, n] = ["c".repeat(64), "d".repeat(64), "e".repeat(64)];
  const tick = (i) => new Date(Date.UTC(2026, 9, 19) + i * 1000).toISOString();
  let k = 0;
  const admitted = (trial, sha256) => {
    const a = admitRevision(trial, { name: "audit", sha256, run: "w", at: tick(k++), when: WHEN });
    assert.equal(a.status, "admitted", a.detail);
    return a.trial;
  };
  const use = (run, sha256, outcome) => ({ run, sha256, outcome, at: tick(k++) });
  let trial = admitted(undefined, x);
  trial = foldUses(trial, [use("x-1", x, "failed")]).trial;
  trial = admitted(trial, l);
  trial = foldUses(trial, [use("l-1", l, "frozen"), use("l-2", l, "frozen")]).trial;
  assert.deepEqual([trial.status, trial.revisions.find((r) => r.sha256 === l).after], ["active", 3]);
  let i = 0;
  while ((trial.refused?.length ?? 0) < TRIAL_LIMITS.refused) trial = admitted(trial, digestOf(i++));
  assert.equal(trial.refused[0], x, "X is the oldest refusal");
  assert.equal(trial.revisions.find((r) => r.sha256 === l).status, "superseded");
  const t = trial.revisions.at(-1).sha256;
  trial = foldUses(trial, [use("t-1", t, "frozen")]).trial;
  assert.equal(currentRevision(trial).sha256, t, "T is still the live trial, with one use of its own");
  const next = admitted(trial, n);
  assert.equal(next.refused.includes(x), false, "X left the refusals");
  assert.deepEqual(next.uses.map((u) => [u.run, u.sha256]), [["l-1", l], ["l-2", l], ["t-1", t]], "only X's use left with it");
  assert.equal(next.refused.at(-1), t, "T, retired, keeps its digest among the refusals, and its use stays");
  assert.equal(next.revisions.find((r) => r.sha256 === l).after, 2, "L's after counts only the uses kept");
  assert.equal(next.revisions.find((r) => r.sha256 === n).after, 3, "the new trial's uses start after the kept ones");
  assert.deepEqual(parseTrial(renderTrial(next), "audit"), next);
});

test("a short stream's trial is exactly as before: no refusals until the name would hold more than the limit", () => {
  const trial = churned(TRIAL_LIMITS.revisions - 1);
  const admitted = admitRevision(trial, { name: "audit", sha256: "f".repeat(64), run: "w", at: at(9), when: WHEN }).trial;
  assert.equal(admitted.revisions.length, TRIAL_LIMITS.revisions);
  assert.equal("refused" in admitted, false);
});

test("the limit still binds on the revisions a name keeps live or restorable", () => {
  // Not a trial pi-agent-learn writes (it keeps at most a few superseded): one built to the bound, to show it holds.
  const revisions = Array.from({ length: TRIAL_LIMITS.revisions }, (_, i) => ({ sha256: digestOf(i), status: i === TRIAL_LIMITS.revisions - 1 ? "active" : "superseded", since: stamp(i, 0), run: "w", after: 0 }));
  const full = { name: "audit", status: "active", when: WHEN, revisions, uses: [] };
  const over = admitRevision(full, { name: "audit", sha256: "f".repeat(64), run: "w", at: at(9), when: WHEN });
  assert.deepEqual([over.status, over.reason], ["refused", "limit"]);
});

test("a decision that does not apply is refused, never half applied", () => {
  const trial = admit(undefined, "a", 1);
  assert.throws(() => applyDecision(trial, { action: "promote", sha256: sha("z"), reason: "x" }, at(2)), LearnError);
  assert.throws(() => applyDecision(trial, { action: "demote", sha256: sha("a"), rollbackTo: sha("z"), skipped: [], reason: "x" }, at(2)), LearnError);
  const active = proven(undefined, "a", 1);
  assert.throws(() => applyDecision(active, { action: "promote", sha256: sha("a"), reason: "x" }, at(9)), (e) => /only a trial/.test(e.message));
  assert.equal(applyDecision(trial, { action: "hold", reason: "x" }, at(2)), trial);
});
