import { describe, expect, it } from "vitest";
import { auditLinesOf, billWords, checkWords, holdsOf, nodeRowsOf } from "./learningBill";
import { BILL, hour } from "./learningBill.fixture";
import type { AuditRow, Bill, CostRun, Promotion, Serving } from "./v2";

// The Learning tab's bill, audit line and serving workflow, as words and rows (lib/learningBill.ts): the server's bill
// (GET /v2/agents/{id}/learning/cost `bill`) read as a person reads it, each hold at the run it bore on, the audit
// line over the hold window and all time, and the serving workflow's nodes with their tiers and code checks.

const job = (n: number, path: CostRun["path"] = "agent"): CostRun => ({ n, run_id: `run-${n}`, started_at: hour(n), path, workflow: path === "agent" ? null : "answer", learned_revision: null, cost_usd: 1, cost_upper_bound: false, learning_usd: 0, total_usd: 1 });
const RUNS: CostRun[] = [job(1), job(2), job(3), job(4, "workflow"), job(5, "workflow"), job(6, "handed_back"), job(7, "workflow"), job(8, "workflow"), job(9, "workflow")];
const notYet: Bill = { ...BILL, points: BILL.points.slice(0, 4), break_even: null, gap_usd: 0.5, booked_usd: 4.5 };
const never: Bill = { ...BILL, promoted: null, break_even: null, gap_usd: 0, points: BILL.points.slice(0, 3).map((p) => ({ ...p, agent_usd: p.actual_usd })) };
const record = (decided: Promotion["decided"], h: number, extra: Partial<Promotion> = {}): Promotion => ({ workflow: "answer", digest: "d".repeat(16), at: hour(h), decided, reason: decided, ...extra });

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

describe("holds at the run they bore on", () => {
  it("places each hold at the first run that started from it, and one past the last run after it", () => {
    const records = [record("replaying", 3), record("promote", 4), record("hold", 6.5, { audit: { window: 20, disagree: 3, rows: 12, disagreements: [] } }), record("hold", 12, { check: { compile_after: 20, agree_min: 0.9, alone_min: 0.8, attempt: 2, n: 10, agreed: 5, alone: 6 } })];
    expect(holdsOf(records, BILL, RUNS)).toEqual([
      { workflow: "answer", at: hour(6.5), n: 7, by: "audit" },
      { workflow: "answer", at: hour(12), n: null, by: "check" },
    ]);
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
});

describe("the serving workflow's nodes", () => {
  const until = { predicate: "not", of: { predicate: "field_equals", path: "check.ok", value: true } };
  const doc = { v: 2, name: "answer", root: { node: "chain", steps: [
    { node: "extract", label: "target", tier: "fast", state: { content: "{content}" } },
    { node: "call", label: "fetch", via: "tool", tool: "web_fetch", args: { url: "{target.url}" } },
    { node: "loop", label: "repick", maxIters: 2, until, body: { node: "decide", label: "answer", state: { facts: "{facts}" } } },
    { node: "escalate", label: "unclear", when: { predicate: "field_equals", path: "answer.verdict", value: "unclear" } },
  ] } };
  it("lists each node with its tier (fast, or the agent's model) and the checks it runs in code, nested ones under their parent", () => {
    expect(nodeRowsOf(doc)).toEqual([
      { path: "0", kind: "extract", label: "target", tier: "fast", checks: [] },
      { path: "1", kind: "call", label: "fetch", tier: null, checks: [] },
      { path: "2", kind: "loop", label: "repick", tier: null, checks: ["until not check.ok = true"] },
      { path: "2.body", kind: "decide", label: "answer", tier: "agent model", checks: [] },
      { path: "3", kind: "escalate", label: "unclear", tier: null, checks: ["when answer.verdict = \"unclear\""] },
    ]);
  });
  it("reads nothing from a text that is no workflow", () => {
    expect(nodeRowsOf(null)).toEqual([]);
    expect(nodeRowsOf({ root: "x" })).toEqual([]);
  });
  it("says the check it was promoted on, with the bars it was held to", () => {
    expect(checkWords(record("promote", 4, { check: { compile_after: 20, agree_min: 0.9, alone_min: 0.8, attempt: 1, n: 10, agreed: 9, alone: 9 } }))).toBe("Checked on 10 inputs: 9 answered alone (bar 80%), 9 of them agreed (bar 90%) · inputs from the newest 20 runs · first check");
    expect(checkWords(record("promote", 4))).toBe("Promoted with no check behind it");
  });
});
