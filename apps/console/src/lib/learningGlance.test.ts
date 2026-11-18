import { describe, expect, it } from "vitest";
import { agreedWords, agreementOf, auditsOf, auditWords, glanceOf, headlineOf, intervalWords, logAxis, placeApart, revisionsOf, shareOf } from "./learningGlance";
import { AUDITS, COST, FIRST, PROMOTIONS, SECOND, WORKFLOW } from "./learningTab.fixture";
import type { LearningCost } from "./v2";

// The Learning tab's headline figures and the cost against agreement chart's points: shares of the server's counts
// with the interval their sample leaves, and never a figure the server did not give.

const revisions = (audits: Parameters<typeof revisionsOf>[3] = AUDITS) => revisionsOf(COST, PROMOTIONS.promotions, PROMOTIONS.serving, audits);
const summary = (over: Partial<LearningCost["summary"]>): LearningCost => ({ ...COST, summary: { ...COST.summary, ...over } });

describe("a share and its interval", () => {
  it("gives the 95% Wilson score interval of a share, which holds the share and stays within 0 to 1", () => {
    const s = shareOf(28, 29)!;
    expect(s.share).toBeCloseTo(0.9655, 4);
    expect(s.lo).toBeCloseTo(0.8283, 3);
    expect(s.hi).toBeCloseTo(0.9939, 3);
    expect(intervalWords(s)).toBe("83% to 99%");
  });
  it("keeps the interval's end at the share when every answer agreed or none did, never past 0 or 100%", () => {
    expect(shareOf(7, 7)).toMatchObject({ share: 1, hi: 1 });
    expect(shareOf(7, 7)!.lo).toBeCloseTo(0.6457, 3);
    expect(shareOf(0, 10)).toMatchObject({ share: 0, lo: 0 });
    expect(shareOf(0, 10)!.hi).toBeCloseTo(0.2775, 3);
  });
  it("is no share of no rows: nothing is said as 0%", () => {
    expect(shareOf(0, 0)).toBeNull();
  });
});

describe("each promoted revision as a point", () => {
  it("says a revision's agreement by its check's own count, its audits beside it and never added to it, and its cost over the runs it served", () => {
    const [first, second] = revisions();
    expect(first).toMatchObject({ workflow: WORKFLOW, digest: FIRST, label: "v1", state: "held", check: { agreed: 15, alone: 17, n: 20, agree_min: 0.8 }, audits: { agreed: 5, rows: 8, grades: 0 } });
    // The check's figure is the server's: agreed of alone, 15 of 17. The audits' 5 of 8 is its own share.
    expect(agreementOf(first!)).toMatchObject({ on: "check", agreed: 15, rows: 17 });
    expect(auditsOf(first!)).toMatchObject({ agreed: 5, rows: 8 });
    expect(intervalWords(auditsOf(first!)!)).toBe("31% to 86%");
    expect(first!.served!.runs).toBe(28);
    expect(second).toMatchObject({ digest: SECOND, label: "v2", state: "serving", audits: { agreed: 7, rows: 7, grades: 1 } });
    expect(agreementOf(second!)).toMatchObject({ on: "check", agreed: 21, rows: 22 });
    expect(intervalWords(agreementOf(second!)!)).toBe("78% to 99%");
    expect(agreedWords(agreementOf(second!)!)).toBe("21 of 22 checked answers");
    expect(auditWords(second!.audits!)).toBe("7 of 7 agreed, 1 your grade");
    expect(second!.served!.runs).toBe(31);
    // Every served run of the read is one revision's: the two means are of the summary's 59 served runs.
    expect(first!.served!.runs + second!.served!.runs).toBe(COST.summary.after!.runs);
  });
  it("says a revision with no check input behind it by its audit rows, and nothing with neither", () => {
    const [, second] = revisions();
    const approved = { ...second!, check: null };
    expect(agreementOf(approved)).toMatchObject({ on: "audits", agreed: 7, rows: 7 });
    expect(agreedWords(agreementOf(approved)!)).toBe("7 of 7 audited runs");
    expect(agreementOf({ check: null, audits: null })).toBeNull();
    expect(agreementOf({ check: null, audits: { agreed: 0, rows: 0, grades: 0 } })).toBeNull();
  });
  it("is one point a revision, however many records it has: a promotion and a hold of one digest are one", () => {
    expect(revisions().map((p) => p.digest)).toEqual([FIRST, SECOND]);
  });
  it("says a revision promoted again by its latest promotion's check and its audits since, and its standing by its latest decision", () => {
    // v1 was promoted, held by its audits, replayed and promoted again on a new check: 19 of 20 this time.
    const [promote, hold] = PROMOTIONS.promotions;
    const again = { ...promote!, at: "2026-10-27T00:00:00.000Z", check: { ...promote!.check!, n: 20, alone: 20, agreed: 19 } };
    const records = [promote!, hold!, again];
    const serves = [{ ...PROMOTIONS.serving[0]!, digest: FIRST }];
    const since = { ...AUDITS[0]!, run: "run-since", promoted_at: again.at, agreed: true };
    const [first] = revisionsOf(COST, records, serves, [...AUDITS, since]);
    expect(first).toMatchObject({ digest: FIRST, state: "serving", check: { agreed: 19, alone: 20 }, audits: { agreed: 1, rows: 1 } });
    // Promoted again and then held again: held is its latest decision.
    const heldAgain = { ...hold!, at: "2026-10-28T00:00:00.000Z" };
    expect(revisionsOf(COST, [...records, heldAgain], [{ ...serves[0]!, digest: null, state: "held" as const }], AUDITS)[0]).toMatchObject({ state: "held", check: { agreed: 19, alone: 20 } });
    // Still one point for the digest, in the place its first promotion gave it.
    expect(revisionsOf(COST, [...PROMOTIONS.promotions, again], PROMOTIONS.serving, AUDITS).map((p) => p.digest)).toEqual([FIRST, SECOND]);
  });
  it("counts the check alone while the audit ledger is unread or its read failed, never 0 audits", () => {
    for (const unread of ["loading", "failed"] as const) {
      const second = revisions(unread)[1]!;
      expect(second.audits).toBeNull();
      expect(auditsOf(second)).toBeNull();
      expect(agreementOf(second)).toMatchObject({ on: "check", agreed: 21, rows: 22 });
    }
  });
  it("leaves an audit with no verdict (skipped, parked) out of the count", () => {
    const parked = [...AUDITS, { ...AUDITS.at(-1)!, run: "run-parked", agreed: null, parked: true as const }];
    expect(revisions(parked)[1]!.audits).toMatchObject({ rows: 7 });
  });
  it("has no point for a revision that never served: one replaying or held before its promotion", () => {
    const replaying = [...PROMOTIONS.promotions, { ...PROMOTIONS.promotions[0]!, digest: "e".repeat(16), decided: "replaying" as const }];
    expect(revisionsOf(COST, replaying, PROMOTIONS.serving, AUDITS)).toHaveLength(2);
  });
  it("names the workflow before the number when the agent has more than one learned workflow", () => {
    const other = { ...PROMOTIONS.promotions[0]!, workflow: "file-receipt", digest: "f".repeat(16) };
    expect(revisionsOf(COST, [...PROMOTIONS.promotions, other], PROMOTIONS.serving, AUDITS).map((p) => p.label)).toEqual(["sort-invoice v1", "sort-invoice v2", "file-receipt v1"]);
  });
});

describe("the tab at a glance", () => {
  it("says the server's ratio and the serving revision's agreement, and nothing before a takeover", () => {
    const g = glanceOf(COST, revisions())!;
    expect(g.revision!.digest).toBe(SECOND);
    expect(g.serves).toBe(true);
    expect(headlineOf(g)).toBe("7.7x cheaper a run, agreeing with the agent on 21 of 22 checked answers.");
    expect(g.alone).toMatchObject({ agreed: 56, rows: 59 });
    expect(g.even).toEqual({ n: COST.bill.break_even!.n });
    expect(glanceOf(summary({ takeover: null }), [])).toBeNull();
  });
  it("never says cheaper for a ratio at or under 1, and works no ratio out when the server gave none", () => {
    const rev = revisions();
    expect(headlineOf(glanceOf(summary({ times_cheaper: 0.8, before: { runs: 20, mean_usd: 0.1 }, after: { runs: 59, mean_usd: 0.125 } }), rev)!)).toBe("Not cheaper yet: 1.3x the cost a run, agreeing with the agent on 21 of 22 checked answers.");
    expect(headlineOf(glanceOf(summary({ times_cheaper: 1 }), rev)!)).toBe("The same cost a run, agreeing with the agent on 21 of 22 checked answers.");
    // Under 20 served runs the server gives no ratio: the two levels are said, never their quotient.
    const early = headlineOf(glanceOf(summary({ times_cheaper: null, after: { runs: 4, mean_usd: 0.12 } }), rev)!);
    expect(early).toBe("$0.120 a run instead of $0.890, agreeing with the agent on 21 of 22 checked answers.");
    expect(early).not.toMatch(/\dx/);
  });
  it("says the agent takes the runs when the revision is held, or the money rule stopped it running first", () => {
    const held = { ...PROMOTIONS.serving[0]!, digest: null, state: "held" as const };
    const first = revisionsOf(COST, PROMOTIONS.promotions.slice(0, 2), [held], AUDITS);
    expect(headlineOf(glanceOf(COST, first)!)).toBe("7.7x cheaper a run. Held now: the agent takes the runs.");
    const stopped: LearningCost = { ...COST, workflows: [{ workflow: WORKFLOW, digest: SECOND, state: "needs_revision", served: { runs: 20, mean_usd: 0.9 }, by_hand: { runs: 20, mean_usd: 0.89 }, unknown_cost_runs: 0 }] };
    expect(glanceOf(stopped, revisions())!.serves).toBe(false);
    expect(headlineOf(glanceOf(stopped, revisions())!)).toBe("7.7x cheaper a run. Not serving now: the agent takes the runs.");
  });
  it("says how far over the agent the bill stands when it has not broken even", () => {
    const over: LearningCost = { ...COST, bill: { ...COST.bill, break_even: null, gap_usd: 1.25 } };
    expect(glanceOf(over, revisions())!.even).toEqual({ gap_usd: 1.25 });
  });
});

describe("the dollar axis", () => {
  it("holds every value with room on both sides and ticks at 1, 2 and 5 of each power of ten inside it", () => {
    const axis = logAxis([0.106, 0.128, 0.89]);
    expect(axis.lo).toBeLessThan(0.106);
    expect(axis.hi).toBeGreaterThan(0.89);
    expect(axis.ticks).toEqual([0.1, 0.2, 0.5, 1]);
  });
  it("still has an axis with no positive value", () => {
    expect(logAxis([0]).ticks.length).toBeGreaterThan(1);
  });
});

describe("marks that would sit on each other", () => {
  it("moves places closer than the gap apart about their middle, in their order, and leaves the rest and a fixed place alone", () => {
    // Two revisions 4px apart, an agent's mark far right, a third revision on its own.
    const { at, moved } = placeApart([{ x: 600, fixed: true }, { x: 102 }, { x: 98 }, { x: 300 }], 36, 60, 700);
    expect(moved).toBe(true);
    expect(at[0]).toBe(600);
    expect(at[3]).toBe(300);
    // The pair's middle stays at 100, 36px between them, the cheaper one still on the left.
    expect([at[2], at[1]]).toEqual([82, 118]);
  });
  it("joins two spread pairs that would then touch, so every final gap holds", () => {
    const { at } = placeApart([{ x: 100 }, { x: 101 }, { x: 137 }, { x: 138 }], 36, 0, 700);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(36 - 1e-6);
    // The four stand about their common middle, 119.
    expect((at[0]! + at[3]!) / 2).toBeCloseTo(119, 6);
  });
  it("shrinks the gap when the line is too short for every place, so none leaves it", () => {
    const { at } = placeApart(Array.from({ length: 8 }, (_, i) => ({ x: 100 + i })), 36, 60, 280);
    expect(Math.min(...at)).toBeGreaterThanOrEqual(60);
    expect(Math.max(...at)).toBeLessThanOrEqual(280 + 1e-6);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeCloseTo(220 / 7, 6);
  });
  it("keeps a moved run on the plot, and says nothing moved when every place has room", () => {
    expect(placeApart([{ x: 62 }, { x: 64 }, { x: 66 }], 36, 60, 700).at).toEqual([60, 96, 132]);
    expect(placeApart([{ x: 100 }, { x: 200 }], 36, 60, 700)).toEqual({ at: [100, 200], moved: false });
  });
});
