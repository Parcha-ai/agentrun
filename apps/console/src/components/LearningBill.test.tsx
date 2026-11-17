import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLine, BillChart, LearningBill, ServingWorkflow } from "./LearningBill";
import { BILL, hour } from "@/lib/learningBill.fixture";
import type { AuditRow, Bill, CostRun, LearningCost, Promotion, Serving } from "@/lib/v2";

// The Learning tab's bill (GET /v2/agents/{id}/learning/cost `bill`): two lines on one dollar axis, the cumulative
// booked bill and the agent for all of it, a legend naming both, the break-even marker (or "not yet" with the gap), a
// table of every point; the audit line over the hold window and all time with each hold at its run; the serving
// workflow's nodes with their tiers and code checks, and the check it was promoted on. Booked figures only.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
function draw(element: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(element));
  return host;
}

const DIGEST = "d".repeat(16);
const RUNS: CostRun[] = Array.from({ length: 9 }, (_, i) => ({ n: i + 1, run_id: `run-${i + 1}`, started_at: hour(i + 1), path: i < 3 ? "agent" : "workflow", workflow: i < 3 ? null : "answer", learned_revision: null, cost_usd: 1, cost_upper_bound: false, learning_usd: 0, total_usd: 1 }));
const PROMOTED: Promotion = { workflow: "answer", digest: DIGEST, at: hour(4), decided: "promote", reason: "checked", check: { compile_after: 20, agree_min: 0.9, alone_min: 0.8, attempt: 1, n: 10, agreed: 9, alone: 9 } };
const HELD: Promotion = { workflow: "answer", digest: "e".repeat(16), at: hour(6.5), decided: "hold", reason: "audits", audit: { window: 20, disagree: 3, rows: 12, disagreements: [] } };
const SERVING: Serving[] = [{ workflow: "answer", digest: DIGEST, replaying: null, state: "serving", check: { n: 10, agreed: 9, alone: 9, attempt: 1 }, audit: { window: 20, disagree: 3, rows: 12, disagreed: 1 }, audits_off: null, not_auditable: 0 }];
const AUDITS: AuditRow[] = Array.from({ length: 15 }, (_, i) => ({ run: `run-${i}`, shadow_run: `audit.run-${i}`, workflow: "answer", digest: DIGEST, promoted_at: hour(4), source: "shadow", agreed: i !== 3 && i !== 9, served_cost: 0.1, shadow_cost: 0.4, at: hour(5) }));
const TEXT = JSON.stringify({ v: 2, name: "answer", root: { node: "chain", steps: [
  { node: "extract", label: "target", tier: "fast" },
  { node: "decide", label: "verdict" },
  { node: "escalate", label: "unclear", when: { predicate: "field_equals", path: "verdict.kind", value: "unclear" } },
] } });
const cost = (bill: Bill): LearningCost => ({ agent: "a", runs: RUNS, total_runs: 9, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, after_state: "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null }, workflows: [], bill });
const NO_EQUAL_CACHE = /equal|cache/i;

describe("the bill chart", () => {
  it("draws the booked bill and the agent for all of it on one dollar axis, a legend, the break-even marker and a table", () => {
    const host = draw(createElement(BillChart, { bill: BILL, width: 900 }));
    expect(host.querySelector("[data-testid=bill-actual]")?.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+){8}$/);
    expect(host.querySelector("[data-testid=bill-agent]")?.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+){8}$/);
    expect(host.querySelectorAll("[data-testid=bill-y-axis]")).toHaveLength(1);
    const legend = host.querySelector("[data-testid=bill-legend]")!.textContent;
    expect(legend).toContain("Your bill, booked");
    expect(legend).toContain("The agent for all of it");
    expect(host.querySelector("[data-testid=bill-break-even]")?.textContent).toContain("Break-even, run 5");
    expect(host.textContent).toContain("Break-even at run 5");
    const rows = host.querySelectorAll("details table tbody tr");
    expect(rows).toHaveLength(9);
    expect(rows[4]!.textContent).toBe("5run-5$4.90$5.00");
    expect(host.textContent).not.toMatch(NO_EQUAL_CACHE);
  });
  it("says not yet, with the gap, and draws no marker while the bill is over the line", () => {
    const host = draw(createElement(BillChart, { bill: { ...BILL, points: BILL.points.slice(0, 4), break_even: null, gap_usd: 0.5, booked_usd: 4.5 }, width: 400 }));
    expect(host.querySelector("[data-testid=bill-break-even]")).toBeNull();
    expect(host.textContent).toContain("Not yet: $0.50 over the agent for all of it at run 4");
  });
  it("draws one line when nothing priced was run by the agent alone", () => {
    const host = draw(createElement(BillChart, { bill: { ...BILL, baseline: null, promoted: null, break_even: null, gap_usd: null, points: BILL.points.map((p) => ({ ...p, agent_usd: null })) }, width: 600 }));
    expect(host.querySelector("[data-testid=bill-actual]")).not.toBeNull();
    expect(host.querySelector("[data-testid=bill-agent]")).toBeNull();
    expect(host.querySelector("[data-testid=bill-legend]")).toBeNull();
  });
});

describe("the audit line", () => {
  it("says agreement over the hold window and all time, and each hold at its run", () => {
    const host = draw(createElement(AuditLine, { serving: SERVING, audits: AUDITS, promotions: [PROMOTED, HELD], bill: BILL, runs: RUNS }));
    const text = host.textContent!;
    expect(text).toContain("answer");
    expect(text).toContain("Last 12 audits: 11 agreed");
    expect(text).toContain("hold at 3 disagreeing of the newest 20");
    expect(text).toContain("All time: 13 of 15 agreed");
    expect(text).toContain("Held at run 7");
  });
});

describe("the serving workflow", () => {
  it("lists its nodes with their tiers and code checks, and the check it was promoted on", () => {
    const host = draw(createElement(ServingWorkflow, { workflow: "answer", text: TEXT, record: PROMOTED }));
    const rows = [...host.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows).toEqual([
      ["target", "extract", "fast", "-"],
      ["verdict", "decide", "agent model", "-"],
      ["unclear", "escalate", "-", "when verdict.kind = \"unclear\""],
    ]);
    expect(host.textContent).toContain("Checked on 10 inputs: 9 answered alone (bar 80%), 9 of them agreed (bar 90%)");
  });
});

describe("in the tab", () => {
  it("reads the audits and the serving revision's text, and shows the bill, the audit line and the serving workflow", async () => {
    const calls: string[] = [];
    const v2 = {
      learningAudits: async (id: string) => { calls.push(`audits ${id}`); return { agent: id, audits: AUDITS }; },
      learnedWorkflowRevisions: async (id: string, name: string) => { calls.push(`revisions ${id} ${name}`); return { name, revisions: [{ commit: "c1", at: hour(3), by: { run: "run-3" }, reason: "compiled", text: TEXT, digest: DIGEST }], total: 1, truncated: false }; },
    };
    const host = draw(createElement(LearningBill, { v2: v2 as never, agentId: "a", cost: cost(BILL), promotions: [PROMOTED, HELD], serving: SERVING, width: 900 }));
    await settle();
    expect(calls).toEqual(["audits a", "revisions a answer"]);
    expect(host.querySelector("[data-testid=bill-actual]")).not.toBeNull();
    expect(host.querySelector("[data-testid=bill-agent]")).not.toBeNull();
    expect(host.querySelector("[data-testid=bill-break-even]")).not.toBeNull();
    expect(host.textContent).toContain("All time: 13 of 15 agreed");
    expect(host.textContent).toContain("agent model");
    expect(host.textContent).not.toMatch(NO_EQUAL_CACHE);
  });
  it("shows nothing before the bill has a point", async () => {
    const host = draw(createElement(LearningBill, { v2: {} as never, agentId: "a", cost: cost({ ...BILL, points: [] }), promotions: [], serving: [] }));
    await settle();
    expect(host.textContent).toBe("");
  });
});
