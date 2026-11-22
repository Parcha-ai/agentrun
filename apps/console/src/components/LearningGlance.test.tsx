import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CostAgreement } from "./CostAgreement";
import { LearningTab } from "./Learning";
import { LearningGlance } from "./LearningGlance";
import type { Client } from "@/lib/client";
import { revisionsOf } from "@/lib/learningGlance";
import { AGENT, AUDITS, COST, fixtureClient, PROMOTIONS, VIEW } from "@/lib/learningTab.fixture";
import type { LearningCost } from "@/lib/v2";

// The Learning tab at a glance and its cost against agreement chart, over the tab's invented reads
// (lib/learningTab.fixture.ts): a workflow that took over at run 21, was held by its audits and serves again.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const draw = (node: React.ReactElement) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
};
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const REVISIONS = revisionsOf(COST, PROMOTIONS.promotions, PROMOTIONS.serving, AUDITS);
const cell = (host: HTMLElement, id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

describe("LearningGlance", () => {
  it("says the headline and each figure with the count it stands on and a share's 95% interval", () => {
    const host = draw(createElement(LearningGlance, { cost: COST, revisions: REVISIONS }));
    expect(cell(host, "glance-headline")).toBe("7.7x cheaper a run, agreeing with the agent on 21 of 22 checked answers.");
    expect(cell(host, "glance-cost")).toBe("Cheaper a run7.7x$0.116 all-in over 59 served runs, $0.890 by the agent before");
    expect(cell(host, "glance-agreement")).toBe("Agrees with the agent95%80% needed to serve21 of 22 checked answers · 95% interval 78% to 99% · 80% needed to serve · audits since: 7 of 7 agreed, 1 your grade");
    expect(cell(host, "glance-alone")).toBe("Finished alone95%56 of 59 runs it ran first, 3 handed back to the agent · 95% interval 86% to 98%");
    expect(cell(host, "glance-even")).toMatch(/^Break-evenRun 24\$[\d.]+ booked over 80 runs, \$[\d.]+ had the agent done all of it$/);
  });
  it("shows nothing before a learned workflow has taken a run over", () => {
    const before: LearningCost = { ...COST, summary: { ...COST.summary, takeover: null } };
    expect(draw(createElement(LearningGlance, { cost: before, revisions: [] })).textContent).toBe("");
    act(() => root?.unmount());
    expect(draw(createElement(LearningGlance, { cost: null, revisions: [] })).textContent).toBe("");
  });
  it("still draws for a cost read with no bill: the break-even cell says so", () => {
    const { bill: _bill, ...older } = COST;
    const host = draw(createElement(LearningGlance, { cost: older as LearningCost, revisions: REVISIONS }));
    expect(cell(host, "glance-headline")).toBe("7.7x cheaper a run, agreeing with the agent on 21 of 22 checked answers.");
    expect(cell(host, "glance-even")).toBe("Break-evenNo billThe cost read gave no bill.");
  });
  it("draws the two cost levels as two equal slivers when a run cost nothing before takeover and nothing after", () => {
    const free: LearningCost = { ...COST, summary: { ...COST.summary, before: { runs: 20, mean_usd: 0 }, after: { ...COST.summary.after!, mean_usd: 0 }, times_cheaper: null } };
    const host = draw(createElement(LearningGlance, { cost: free, revisions: REVISIONS }));
    const bars = [...host.querySelectorAll('[data-testid="glance-levels"] rect')].map((r) => r.getAttribute("width"));
    expect(bars).toEqual(["1.00%", "1.00%"]);
    expect(cell(host, "glance-cost")).toBe("Cost a run$0$0 all-in over 59 served runs, $0 by the agent before");
  });
  it("says a figure is not there yet in words, never a 0% or a $0", () => {
    const bare: LearningCost = { ...COST, summary: { ...COST.summary, before: null, after: null, after_state: "cost_unknown", times_cheaper: null, hand_backs: null }, bill: { ...COST.bill, break_even: null, gap_usd: 2.5 } };
    const host = draw(createElement(LearningGlance, { cost: bare, revisions: [] }));
    expect(cell(host, "glance-cost")).toContain("Cost a runNo cost yet");
    expect(cell(host, "glance-agreement")).toContain("Not checked");
    expect(cell(host, "glance-alone")).toContain("No run yet");
    expect(cell(host, "glance-even")).toMatch(/Not yet\$2\.50 over the agent for all of it at run 80/);
    expect(host.textContent).not.toMatch(/\b0%|\$0\b/);
  });
});

describe("CostAgreement", () => {
  it("draws the agent and each revision that served with a verdict, joined in the order they served, with the bar to serve", () => {
    const host = draw(createElement(CostAgreement, { cost: COST, revisions: REVISIONS, width: 560 }));
    expect(host.querySelectorAll('[data-testid="agreement-agent"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="agreement-revision"]')).toHaveLength(2);
    // The walk: the agent, then v1, then v2, each left of the agent (cheaper).
    const walk = [...host.querySelector('[data-testid="agreement-walk"]')!.getAttribute("d")!.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
    expect(walk).toHaveLength(3);
    expect(walk[1]![0]).toBeLessThan(walk[0]![0]);
    expect(walk[2]![0]).toBeLessThan(walk[0]![0]);
    // v2 agreed more often on its check than v1 (21 of 22 against 15 of 17): higher on the plot (a smaller y).
    expect(walk[2]![1]).toBeLessThan(walk[1]![1]);
    expect(host.querySelector('[data-testid="agreement-needed"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cost-agreement"]')!.textContent).toContain("v2 serving: $0.106 a run, agreed on 21 of 22 checked answers (95%)");
    // Each revision's audits are a mark of their own beside its check's, never folded into it.
    expect(host.querySelectorAll('[data-testid="agreement-audits"]')).toHaveLength(2);
    // Only the revision that serves is a filled mark.
    expect([...host.querySelectorAll('[data-testid="agreement-revision"] circle')].map((c) => c.getAttribute("class"))).toEqual(["stroke-chart-workflow fill-card", "stroke-chart-workflow fill-chart-workflow"]);
  });
  it("reads a point out as the arrow keys step to it, and lists every revision in its table", () => {
    const host = draw(createElement(CostAgreement, { cost: COST, revisions: REVISIONS, width: 560 }));
    const plot = host.querySelector<HTMLElement>("[tabindex='0']")!;
    act(() => { plot.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    expect(host.querySelector("[aria-live]")!.textContent).toBe("v2 · c4e81f9 · serving. $0.106 a run, all-in, over 31 served runs. Agreed on 21 of 22 checked answers (95%), 95% interval 78% to 99%. Audits since: 7 of 7 agreed, 1 your grade (100%), 95% interval 65% to 100%");
    act(() => { plot.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    expect(host.querySelector("[aria-live]")!.textContent).toBe("The agent. $0.890 a run before takeover, over 20 runs. The reference: its own answers");
    const rows = [...host.querySelectorAll("details tbody tr")].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("v1a12596cheld28");
    expect(rows[0]).toContain("15 of 17 (88%)");
    expect(rows[0]).toContain("5 of 8 agreed (63%)31% to 86%");
  });
  it("draws two revisions that cost nearly the same side by side, never one on the other, and says so", () => {
    const host = draw(createElement(CostAgreement, { cost: COST, revisions: REVISIONS, width: 560 }));
    const xs = [...host.querySelectorAll('[data-testid="agreement-revision"] circle')].map((c) => Number(c.getAttribute("cx")));
    // v1 at $0.128 and v2 at $0.106 are about 28px apart on this axis: they are drawn 36px apart.
    expect(Math.abs(xs[1]! - xs[0]!)).toBeGreaterThanOrEqual(36 - 0.01);
    expect(xs[1]!).toBeLessThan(xs[0]!);
    expect(host.textContent).toContain("Revisions that cost nearly the same are drawn side by side");
  });
  it("keeps a long label's whole width on a narrow chart, never cut at an edge", () => {
    // Two workflows, so each label carries its workflow's name; the first is long and its point is far left.
    const named = [{ ...REVISIONS[1]!, workflow: "support-triage-priority", label: "support-triage-priority v1" }, { ...REVISIONS[0]!, label: "sort-invoice v1" }];
    const host = draw(createElement(CostAgreement, { cost: COST, revisions: named, width: 300 }));
    const labels = [...host.querySelectorAll("svg[aria-hidden] text")].filter((t) => /v1 \d+%$|^The agent/.test(t.textContent ?? ""));
    expect(labels).toHaveLength(3);
    for (const t of labels) {
      const wide = (t.textContent ?? "").length * 6.7, x = Number(t.getAttribute("x")), anchor = t.getAttribute("text-anchor");
      const [x0, x1] = anchor === "middle" ? [x - wide / 2, x + wide / 2] : anchor === "end" ? [x - wide, x] : [x, x + wide];
      expect(x0, t.textContent ?? "").toBeGreaterThanOrEqual(0);
      expect(x1, t.textContent ?? "").toBeLessThanOrEqual(300);
    }
  });
  it("moves the plot down under a tall stack of labels, so a crowd of revisions keeps every label on the chart", () => {
    // Four revisions of two workflows that cost nearly the same and all agreed on every checked answer: their long
    // labels touch each other, so they stack four high over the plot's top.
    const crowd = [0, 1, 2, 3].map((i) => ({ ...REVISIONS[1]!, workflow: i % 2 ? "support-triage-priority" : "sort-invoice-by-vendor", digest: `${i}`.repeat(12), label: `${i % 2 ? "support-triage-priority" : "sort-invoice-by-vendor"} v${i + 1}`, served: { runs: 20, mean_usd: 0.1 + i * 0.001 }, check: { agreed: 20, alone: 20, n: 20, agree_min: 0.8 }, audits: null }));
    const host = draw(createElement(CostAgreement, { cost: COST, revisions: crowd, width: 560 }));
    const svg = host.querySelector("svg[aria-hidden][width='560']")!;
    const labels = [...svg.querySelectorAll("text")].filter((t) => /v\d 100%$/.test(t.textContent ?? ""));
    expect(labels).toHaveLength(4);
    const ys = labels.map((t) => Number(t.getAttribute("y")));
    expect(new Set(ys).size).toBe(4);
    // A label's letters are 12px tall: its baseline that far under the chart's top keeps all of it drawn.
    for (const [i, at] of ys.entries()) expect(at, labels[i]!.textContent ?? "").toBeGreaterThanOrEqual(12);
    // The plot moved down by what the stack needs: the 100% line is under the lowest label, and the chart is taller.
    const full = [...svg.querySelectorAll("text")].find((t) => t.textContent === "100%")!;
    expect(Number(full.getAttribute("y"))).toBe(Math.max(...ys) + 10);
    expect(Number(svg.getAttribute("height"))).toBe(Number(full.getAttribute("y")) + 220 + 42);
  });
  it("leaves the agent off the log axis when a run cost it nothing before takeover, and still draws the revisions", () => {
    const free: LearningCost = { ...COST, summary: { ...COST.summary, before: { runs: 20, mean_usd: 0 } } };
    const host = draw(createElement(CostAgreement, { cost: free, revisions: REVISIONS, width: 560 }));
    expect(host.querySelector('[data-testid="agreement-agent"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="agreement-revision"]')).toHaveLength(2);
    // No coordinate of the plot is NaN or infinite.
    expect(host.querySelector("svg[aria-hidden]")!.outerHTML).not.toMatch(/NaN|Infinity/);
    expect(host.textContent).not.toContain("The agent, before takeover");
  });
  it("draws a revision with no check by its audits, with no bar to serve (the bar is the check's) and no second mark", () => {
    const approved = REVISIONS.map((p) => ({ ...p, check: null }));
    const host = draw(createElement(CostAgreement, { cost: COST, revisions: approved, width: 560 }));
    expect(host.querySelectorAll('[data-testid="agreement-revision"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="agreement-needed"]')).toBeNull();
    expect(host.querySelector('[data-testid="agreement-audits"]')).toBeNull();
    expect(host.querySelector('[data-testid="cost-agreement"]')!.textContent).toContain("v2 serving: $0.106 a run, agreed on 7 of 7 audited runs (100%)");
  });
  it("keeps the card and its table, open, when every revision's served runs cost $0: no plot, the checks and audits still read", () => {
    const free = REVISIONS.map((p) => ({ ...p, served: p.served ? { ...p.served, mean_usd: 0 } : null }));
    const host = draw(createElement(CostAgreement, { cost: COST, revisions: free, width: 560 }));
    const card = host.querySelector('[data-testid="cost-agreement"]')!;
    expect(card.textContent).toContain("No served run cost more than $0");
    expect(card.querySelector("svg")).toBeNull();
    expect(card.querySelector("details")!.hasAttribute("open")).toBe(true);
    const rows = [...card.querySelectorAll("details tbody tr")].map((r) => r.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("15 of 17 (88%)");
    expect(rows[0]).toContain("$0");
  });
  it("draws nothing until a revision has both a served run with a cost and a verdict", () => {
    const unchecked = REVISIONS.map((p) => ({ ...p, check: null, audits: null }));
    expect(draw(createElement(CostAgreement, { cost: COST, revisions: unchecked, width: 560 })).textContent).toBe("");
  });
});

describe("the Learning tab", () => {
  it("opens on the glance, shows the cost against agreement beside the bill, and reads the audit ledger once for all of them", async () => {
    const client = fixtureClient();
    let reads = 0;
    const v2 = { ...client, learningAudits: async () => { reads++; return client.learningAudits(); } };
    const host = draw(createElement(LearningTab, { agent: AGENT, v2: v2 as unknown as Client, server: "on" }));
    await settle();
    expect(cell(host, "glance-headline")).toBe("7.7x cheaper a run, agreeing with the agent on 21 of 22 checked answers.");
    const order = [...host.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"));
    expect(order.indexOf("learning-glance")).toBeLessThan(order.indexOf("loop-story"));
    expect(order.indexOf("cost-per-run")).toBeLessThan(order.indexOf("cost-agreement"));
    expect(host.querySelector('[data-testid="cost-agreement"]')).not.toBeNull();
    expect(cell(host, "learning-audits")).toContain("All time: 12 of 15 agreed");
    expect(reads).toBe(1);
  });
  it("stands the learned workflow in one row with the cost of a run, after it and before the bill, drawn at its newest revision", async () => {
    const host = draw(createElement(LearningTab, { agent: AGENT, v2: fixtureClient() as unknown as Client, server: "on" }));
    await settle();
    const row = host.querySelector('[data-testid="cost-and-workflow"] > div')!;
    const workflow = host.querySelector('section[aria-label="Learned workflow"]')!;
    expect([...row.children]).toEqual([host.querySelector('[data-testid="cost-per-run"]'), workflow]);
    expect(host.querySelectorAll('section[aria-label="Learned workflow"]').length).toBe(1);
    expect(row.compareDocumentPosition(host.querySelector('[data-testid="learning-bill"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(workflow.textContent).toContain("Revision 2 of 2");
    const graph = workflow.querySelector('svg[role="img"]')!;
    expect(graph.getAttribute("aria-label")).toBe("The workflow at revision 2 of 2, as a graph");
    expect(graph.textContent).toContain("find the vendor");
    expect(workflow.querySelector('[data-testid="standing"]')!.textContent).toContain("Serving");
  });
  it("leaves the cost of a run on a row of its own while no workflow is given to runs", async () => {
    const view = { ...VIEW, workflows: VIEW.workflows.map((w) => ({ ...w, status: "pending" as const })) };
    const host = draw(createElement(LearningTab, { agent: AGENT, v2: fixtureClient({ view }) as unknown as Client, server: "on" }));
    await settle();
    expect(host.querySelector('[data-testid="cost-per-run"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cost-and-workflow"]')).toBeNull();
    expect(host.querySelector('section[aria-label="Learned workflow"]')).toBeNull();
  });
  it("leaves the cost of a run on a row of its own for a CLI agent, whose tab has no replay", async () => {
    const cli = { ...AGENT, definition: { ...AGENT.definition, cli_learning: { runtime: "codex", connection_id: "connection", project: "/projects/example" } } } as typeof AGENT;
    const host = draw(createElement(LearningTab, { agent: cli, v2: fixtureClient({}) as unknown as Client, server: "on" }));
    await settle();
    expect(host.querySelector('[data-testid="cost-per-run"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cost-and-workflow"]')).toBeNull();
    expect(host.querySelector('section[aria-label="Learned workflow"]')).toBeNull();
  });
});
