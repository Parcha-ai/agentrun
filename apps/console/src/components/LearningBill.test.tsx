import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLine, BillChart, LearningBill, ServingWorkflow } from "./LearningBill";
import { BILL, hour } from "@/lib/learningBill.fixture";
import type { AuditRow, Bill, CostRun, LearningCost, Serving } from "@/lib/v2";

// The Learning tab's bill (GET /v2/agents/{id}/learning/cost `bill`): two lines on one dollar axis, the cumulative
// booked bill and the agent for all of it, a legend naming both, the break-even marker (or "not yet" with the gap), a
// table of every point; the audit line over the hold window and all time (nothing of all time while the audits are
// read, and words that say so when their read failed) with each hold at the run the server placed it on (`bill.holds`);
// the serving workflow as the promotions read gives the champion (`serving[].champion`: its nodes with their tiers and
// code checks, and the check it was promoted on), kept while a replacement is checked. Booked figures only.
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
const CHECK = { compile_after: 20, agree_min: 0.9, alone_min: 0.8, attempt: 1 as const, n: 10, agreed: 9, alone: 9 };
/** The champion as the promotions read gives it (`champion`): its nodes with their tiers and checks, and its check. */
const CHAMPION: NonNullable<Serving["champion"]> = { digest: DIGEST, commit: "c".repeat(40), check: CHECK, nodes: [
  { path: "0", kind: "extract", label: "target", tier: "fast", checks: [] },
  { path: "1", kind: "decide", label: "verdict", tier: "agent", checks: [] },
  { path: "2", kind: "escalate", label: "unclear", tier: null, checks: [{ on: "when", predicate: { predicate: "field_equals", path: "verdict.kind", value: "unclear" } }] },
] };
const SERVING: Serving[] = [{ workflow: "answer", digest: DIGEST, replaying: null, state: "serving", check: { n: 10, agreed: 9, alone: 9, attempt: 1 }, audit: { window: 20, disagree: 3, rows: 12, disagreed: 1 }, audits_off: null, not_auditable: 0, champion: CHAMPION }];
/** A replacement checked while the champion still answers runs. */
const CHECKING: Serving[] = [{ ...SERVING[0]!, replaying: "e".repeat(16), state: "checking" }];
const AUDITS: AuditRow[] = Array.from({ length: 15 }, (_, i) => ({ run: `run-${i}`, shadow_run: `audit.run-${i}`, workflow: "answer", digest: DIGEST, promoted_at: hour(4), source: "shadow", agreed: i !== 3 && i !== 9, served_cost: 0.1, shadow_cost: 0.4, at: hour(5) }));
/** The bill with its holds as the server placed them, from the whole series. */
const HELD: Bill = { ...BILL, holds: [{ n: 7, at: hour(6.5), workflow: "answer", by: "audit", reason: "audits" }, { n: null, at: hour(12), workflow: "answer", by: "check", reason: "its draft failed its checks" }] };
const cost = (bill: Bill): LearningCost => ({ agent: "a", runs: RUNS, total_runs: 9, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, after_state: "no_served_runs", times_cheaper: null, hand_backs: null, withheld: null, replay: null }, workflows: [], bill });const NO_EQUAL_CACHE = /equal|cache/i;

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
  it("says agreement over the hold window and all time, and each hold at the run the server placed it on", () => {
    const host = draw(createElement(AuditLine, { serving: SERVING, audits: AUDITS, bill: HELD }));
    const text = host.textContent!;
    expect(text).toContain("answer");
    expect(text).toContain("Last 12 audits: 11 agreed");
    expect(text).toContain("hold at 3 disagreeing of the newest 20");
    expect(text).toContain("All time: 13 of 15 agreed");
    const holds = [...host.querySelectorAll("[data-testid=audit-holds] li")].map((li) => li.textContent);
    expect(holds).toHaveLength(2);
    expect(holds[0]).toMatch(/^Held at run 7 · answer · by its audits/);
    expect(holds[1]).toMatch(/^Held after run 9 · answer · by its check/);
  });
  it("says nothing of all time while the audits are read", () => {
    const host = draw(createElement(AuditLine, { serving: SERVING, audits: "loading", bill: BILL }));
    expect(host.textContent).toContain("Last 12 audits: 11 agreed");
    expect(host.textContent).not.toContain("All time");
    expect(host.textContent).not.toContain("0 of 0");
  });
  it("says the audits couldn't be read when their read failed, and shows no all-time figure", () => {
    const host = draw(createElement(AuditLine, { serving: SERVING, audits: "failed", bill: BILL }));
    expect(host.textContent).toContain("The audits couldn't be read");
    expect(host.textContent).not.toContain("All time");
    expect(host.textContent).not.toContain("0 of 0");
  });
});

describe("the serving workflow", () => {
  it("lists the champion's nodes as the API gives them, with their tiers and code checks, and the check it was promoted on", () => {
    const host = draw(createElement(ServingWorkflow, { workflow: "answer", champion: CHAMPION }));
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
  it("reads the audits alone (the serving workflow is the promotions read's), and shows the bill, the audit line and the serving workflow", async () => {
    const calls: string[] = [];
    const v2 = { learningAudits: async (id: string) => { calls.push(`audits ${id}`); return { agent: id, audits: AUDITS }; } };
    const host = draw(createElement(LearningBill, { v2: v2 as never, agentId: "a", cost: cost(HELD), serving: SERVING, width: 900 }));
    await settle();
    expect(calls).toEqual(["audits a"]);
    expect(host.querySelector("[data-testid=bill-actual]")).not.toBeNull();
    expect(host.querySelector("[data-testid=bill-agent]")).not.toBeNull();
    expect(host.querySelector("[data-testid=bill-break-even]")).not.toBeNull();
    expect(host.textContent).toContain("All time: 13 of 15 agreed");
    expect(host.textContent).toContain("Held at run 7");
    expect(host.textContent).toContain("agent model");
    expect(host.textContent).not.toMatch(NO_EQUAL_CACHE);
  });
  it("keeps the champion's details while a replacement is checked", async () => {
    const v2 = { learningAudits: async (id: string) => ({ agent: id, audits: AUDITS }) };
    const host = draw(createElement(LearningBill, { v2: v2 as never, agentId: "a", cost: cost(BILL), serving: CHECKING, width: 900 }));
    await settle();
    const card = host.querySelector("[data-testid=serving-workflow]");
    expect(card).not.toBeNull();
    expect(card!.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(card!.textContent).toContain("Checked on 10 inputs");
  });
  it("says the audits couldn't be read when their read fails, never 0 of 0", async () => {
    const v2 = { learningAudits: async () => { throw new Error("503"); } };
    const host = draw(createElement(LearningBill, { v2: v2 as never, agentId: "a", cost: cost(BILL), serving: SERVING, width: 900 }));
    await settle();
    expect(host.textContent).toContain("The audits couldn't be read");
    expect(host.textContent).not.toContain("0 of 0");
  });
  it("shows nothing before the bill has a point", async () => {
    const host = draw(createElement(LearningBill, { v2: {} as never, agentId: "a", cost: cost({ ...BILL, points: [] }), serving: [] }));
    await settle();
    expect(host.textContent).toBe("");
  });
});
