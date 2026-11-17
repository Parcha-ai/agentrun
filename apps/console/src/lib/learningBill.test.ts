import { describe, expect, it } from "vitest";
import { auditLinesOf, billWords, checkLineWords, checkWords, tierWords } from "./learningBill";
import { BILL, hour } from "./learningBill.fixture";
import type { AuditRow, Bill, Serving } from "./v2";

// The Learning tab's bill, audit line and serving workflow, as words and rows (lib/learningBill.ts): the server's bill
// (GET /v2/agents/{id}/learning/cost `bill`) read as a person reads it, the audit line over the hold window and all time
// (none while the ledger is unread), and the serving workflow's nodes (the promotions read's `champion`) in words.

const notYet: Bill = { ...BILL, points: BILL.points.slice(0, 4), break_even: null, gap_usd: 0.5, booked_usd: 4.5 };
const never: Bill = { ...BILL, promoted: null, break_even: null, gap_usd: 0, points: BILL.points.slice(0, 3).map((p) => ({ ...p, agent_usd: p.actual_usd })) };

describe("the bill in words", () => {
  it("says where it breaks even, against the agent for all of it", () => {
    expect(billWords(BILL)).toEqual({ headline: "Break-even at run 5: $7.00 booked over 9 runs, $9.00 had the agent done all of it", marker: 5 });
  });
  it("says not yet, with the gap, while the bill is over the line", () => {
    expect(billWords(notYet)).toEqual({ headline: "Not yet: $0.50 over the agent for all of it at run 4", marker: null });
  });
  it("says no learned workflow serves yet before a promotion", () => {
    expect(billWords(never).headline).toBe("No learned workflow serves yet: the bill is the agent's own, $3.00 over 3 runs");
    expect(billWords(never).marker).toBeNull();
  });
  it("names the runs on neither line", () => {
    expect(billWords({ ...BILL, withheld: 2 }).headline).toContain("2 runs of unknown cost on neither line");
  });
});


describe("the audit line", () => {
  const rows: AuditRow[] = Array.from({ length: 16 }, (_, i) => ({ run: `run-${i}`, shadow_run: `audit.run-${i}`, workflow: "answer", digest: "d".repeat(16), promoted_at: hour(4), source: "shadow", agreed: i === 3 || i === 9 ? false : i === 15 ? null : true, served_cost: 0.1, shadow_cost: 0.4, at: hour(5) }));
  const serving: Serving[] = [{ workflow: "answer", digest: "d".repeat(16), replaying: null, state: "serving", check: { n: 10, agreed: 9, alone: 9, attempt: 1 }, audit: { window: 20, disagree: 3, rows: 12, disagreed: 1 }, audits_off: null, not_auditable: 0 }];
  it("reads the hold window from the serving read and all time from the ledger, rows with no verdict left out", () => {
    expect(auditLinesOf(serving, rows)).toEqual([{ workflow: "answer", recent: { rows: 12, agreed: 11, window: 20, disagree: 3 }, all: { rows: 15, agreed: 13 }, off: null }]);
  });
  it("says why nothing is audited", () => {
    expect(auditLinesOf([{ ...serving[0]!, audit: null, audits_off: "audits off: send_email can write" }], [])).toEqual([{ workflow: "answer", recent: null, all: { rows: 0, agreed: 0 }, off: "audits off: send_email can write" }]);
  });
  it("has no all-time figure while the ledger is unread: never 0 of 0", () => {
    expect(auditLinesOf(serving, "loading")[0]!.all).toBeNull();
    expect(auditLinesOf(serving, "failed")[0]!.all).toBeNull();
  });
});

describe("the serving workflow's nodes, as the API gives them", () => {
  it("says each node's tier and its code checks in words", () => {
    expect(tierWords("fast")).toBe("fast");
    expect(tierWords("agent")).toBe("agent model");
    expect(tierWords(null)).toBe("-");
    expect(checkLineWords({ on: "until", predicate: { predicate: "not", of: { predicate: "field_equals", path: "check.ok", value: true } } })).toBe("until not check.ok = true");
    expect(checkLineWords({ on: "when", predicate: { predicate: "field_equals", path: "answer.verdict", value: "unclear" } })).toBe("when answer.verdict = \"unclear\"");
    expect(checkLineWords({ on: "when", predicate: { predicate: "or", of: [{ predicate: "exists", path: "a" }, { predicate: "field_equals", path: "b", value: 1 }] } })).toBe("when exists a or b = 1");
  });
  it("says the check it was promoted on, with the bars it was held to", () => {
    expect(checkWords({ compile_after: 20, agree_min: 0.9, alone_min: 0.8, attempt: 1, n: 10, agreed: 9, alone: 9 })).toBe("Checked on 10 inputs: 9 answered alone (bar 80%), 9 of them agreed (bar 90%) · inputs from the newest 20 runs · first check");
    expect(checkWords(null)).toBe("Promoted with no check behind it");
  });
});
