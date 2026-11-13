import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CostChart, CostPerRun, HOW } from "./CostPerRun";
import SAMPLE from "./CostPerRun.sample.json";
import { ClientError, type Client } from "@/lib/client";
import { level, nearest, niceTop, plotted, rollingMean, runTicks, usd, windowOf, yTopOf } from "@/lib/costPerRun";
import type { CostRun, LearningCost } from "@/lib/v2";

// The cost per run chart (GET /v2/agents/{id}/learning/cost): the invented invoice-sorter agent's 80 runs, its cost
// falling from about $0.89 by hand to about $0.13 once its learned workflow takes over at run 21.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sample = SAMPLE as unknown as LearningCost;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

function draw(data: LearningCost, on = true) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(CostChart, { data, on, width: 900 })));
  return host;
}
const text = (host: HTMLElement) => host.textContent ?? "";
const run = (n: number, path: CostRun["path"], total: number | null): CostRun => ({ n, run_id: `run_${n}`, started_at: new Date(Date.UTC(2026, 9, 1, n)).toISOString(), path, workflow: path === "agent" ? null : "sort", learned_revision: "a".repeat(40), cost_usd: total, learning_usd: total === null ? null : 0, total_usd: total });
const series = (runs: CostRun[], summary: Partial<LearningCost["summary"]> = {}): LearningCost => ({ agent: "a", runs, total_runs: runs.length, unknown_cost_runs: runs.filter((r) => r.total_usd === null).length, summary: { takeover: null, before: null, after: null, times_cheaper: null, ...summary }, workflows: [] });

describe("the chart's arithmetic", () => {
  it("plots only runs whose all-in cost is known", () => {
    expect(plotted(sample.runs)).toHaveLength(79);
    expect(plotted(sample.runs).some((r) => r.n === 44)).toBe(false);
  });
  it("draws a trailing mean, fewer runs at the start", () => {
    const points = plotted([run(1, "agent", 1), run(2, "agent", 3), run(3, "agent", 5), run(4, "workflow", 1)]);
    expect(rollingMean(points, 3)).toEqual([1, 2, 3, 3]);
  });
  it("sizes the window from 3 to 25 runs", () => {
    expect([windowOf(2), windowOf(80), windowOf(300), windowOf(10_000)]).toEqual([3, 5, 20, 25]);
  });
  it("puts the y axis' top over the 95th percentile, and counts the runs above it", () => {
    const points = plotted(sample.runs);
    const { top, above } = yTopOf(points, rollingMean(points, 5), sample.summary.before!.mean_usd);
    expect(top).toBeLessThan(2.4);
    expect(above).toBe(1);
    expect(niceTop(0.97)).toBe(1);
    expect(niceTop(1.2)).toBe(2);
    expect(niceTop(0.21)).toBe(0.25);
  });
  it("ticks whole runs and finds the run nearest a point", () => {
    expect(runTicks(1, 80, 7)).toEqual([1, 20, 40, 60, 80]);
    expect(runTicks(3, 3)).toEqual([3]);
    expect(nearest(plotted(sample.runs), 44.2)).toBe(43);
  });
  it("says a dollar figure with two to four places under a dollar", () => {
    expect([usd(0), usd(0.5), usd(0.1405), usd(0.00004), usd(2.399)]).toEqual(["$0", "$0.50", "$0.1405", "<$0.0001", "$2.40"]);
    expect([level(0.889921), level(0.127661), level(0.0123), level(1.5)]).toEqual(["$0.890", "$0.128", "$0.0123", "$1.50"]);
  });
});

describe("CostChart", () => {
  it("shows the drop: the levels before and after, the takeover, and how many times cheaper", () => {
    const host = draw(sample);
    expect(text(host)).toContain("$0.890 a run before learning, $0.128 after takeover: 7x cheaper");
    expect(text(host)).toContain("Workflow took over, run 21");
    expect(text(host)).toContain("After takeover $0.128 · 7x cheaper");
    expect(text(host)).toContain("Before learning $0.890");
    expect(text(host)).toContain("Rolling mean of 5 runs");
    expect(text(host)).toContain("1 run costs more than");
    expect(text(host)).toContain("1 run's cost is not known: left out.");
  });
  it("names each path in the legend with its runs, and colours its dots by a chart token", () => {
    const host = draw(sample);
    const legend = host.querySelector("figcaption")!.textContent!;
    expect(legend).toContain("By the agent 19");
    expect(legend).toContain("Handed back 5");
    expect(legend).toContain("Learned workflow 56");
    const dots = [...host.querySelectorAll("svg[aria-hidden] circle")].filter((c) => c.getAttribute("r") === "3");
    expect(dots).toHaveLength(79);
    expect(new Set(dots.map((c) => c.getAttribute("class")))).toEqual(new Set(["fill-chart-agent", "fill-chart-handed-back", "fill-chart-workflow"]));
  });
  it("shows a run's readout as the arrow keys step to it, and a table of every run", () => {
    const host = draw(sample);
    const plot = host.querySelector<HTMLElement>("[tabindex='0']")!;
    act(() => { plot.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
    act(() => { for (let i = 0; i < 20; i++) plot.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    const live = host.querySelector("[aria-live]")!.textContent!;
    expect(live).toMatch(/^Run 21, \$0\.\d+ all-in, Learned workflow: sort-invoice, Learned revision [0-9a-f]{7}$/);
    const rows = host.querySelectorAll("details tbody tr");
    expect(rows).toHaveLength(80);
    expect(rows[43]!.textContent).toContain("unknown");
  });
  it("leaves the times-cheaper figure out under 20 runs after the takeover, and says when it comes", () => {
    const runs = [...Array.from({ length: 10 }, (_, i) => run(i + 1, "agent", 1)), ...Array.from({ length: 5 }, (_, i) => run(i + 11, "workflow", 0.1))];
    const host = draw(series(runs, { takeover: { n: 11, run_id: "run_11" }, before: { runs: 10, mean_usd: 1 }, after: { runs: 5, mean_usd: 0.1 } }));
    expect(text(host)).not.toMatch(/\dx cheaper/);
    expect(text(host)).toContain("5 runs since the workflow took over: how many times cheaper it is shows after 20.");
  });
  it("says what to do when no workflow has taken over: keep going with learning on, turn it on when off", () => {
    const runs = Array.from({ length: 6 }, (_, i) => run(i + 1, "agent", 0.8));
    const on = draw(series(runs, { before: { runs: 6, mean_usd: 0.8 } }));
    expect(text(on)).toContain("No learned workflow has finished a run alone yet.");
    act(() => root!.unmount()); document.body.innerHTML = "";
    const off = draw(series(runs, { before: { runs: 6, mean_usd: 0.8 } }), false);
    expect(text(off)).toContain(HOW);
  });
  it("draws no plot under two runs, and says what is needed", () => {
    const host = draw(series([]));
    expect(host.querySelector("svg[aria-hidden] path")).toBeNull();
    expect(text(host)).toContain("No run with a known cost yet.");
    expect(text(host)).toContain("run the same job about 20 times");
  });
  it("keeps the level after the takeover when the takeover is older than the runs read, without its marker", () => {
    const host = draw({ ...sample, runs: sample.runs.slice(40), total_runs: 80 });
    expect(text(host)).toContain("After takeover $0.128 · 7x cheaper");
    expect(text(host)).not.toContain("Workflow took over, run 21");
  });
  it("says a learned workflow that costs more than the agent by hand no longer runs first, with the two levels", () => {
    const host = draw({ ...sample, workflows: [{ workflow: "sort-invoice", digest: "0123456789abcdef", state: "needs_revision", served: { runs: 10, mean_usd: 0.95 }, by_hand: { runs: 19, mean_usd: 0.889921 } }] });
    expect(text(host)).toContain("sort-invoice no longer runs first: $0.950 a run over its last 10 runs, at or over $0.890 a run by hand. Its next run asks the agent for a new version, which runs first again.");
    act(() => root!.unmount()); document.body.innerHTML = "";
    expect(text(draw({ ...sample, workflows: [{ workflow: "sort-invoice", digest: "0123456789abcdef", state: "serving", served: { runs: 10, mean_usd: 0.1 }, by_hand: { runs: 19, mean_usd: 0.889921 } }] }))).not.toContain("no longer runs first");
  });
  it("says only the latest runs are drawn when the server sent fewer than there are", () => {
    const host = draw({ ...sample, total_runs: 1200 });
    expect(text(host)).toContain("The latest 80 of 1,200 runs.");
  });
});

describe("CostPerRun", () => {
  it("reads the agent's series, and a failed read is a problem card with Try again", async () => {
    const asked: string[] = [];
    let fail = true;
    const v2 = { learningCost: async (id: string, limit?: number) => { asked.push(`${id} ${limit}`); if (fail) throw new ClientError(500, "internal", "boom"); return sample; } } as unknown as Client;
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(createElement(CostPerRun, { v2, agentId: "invoice-sorter", on: true })));
    expect(host.querySelector("[role=alert]")!.textContent).toContain("The cost per run could not be read.");
    fail = false;
    await act(async () => { host.querySelector<HTMLButtonElement>("[role=alert] button")!.click(); });
    expect(asked).toEqual(["invoice-sorter 1000", "invoice-sorter 1000"]);
    expect(text(host)).toContain("Workflow took over, run 21");
  });
  it("shows nothing under the tab's empty state until two runs have a cost, then the chart", async () => {
    const empty: LearningCost = { agent: "a", runs: [], total_runs: 0, unknown_cost_runs: 0, summary: { takeover: null, before: null, after: null, times_cheaper: null }, workflows: [] };
    for (const [answer, shown] of [[empty, false], [sample, true]] as const) {
      const v2 = { learningCost: async () => answer } as unknown as Client;
      const host = document.body.appendChild(document.createElement("div"));
      root = createRoot(host);
      await act(async () => root!.render(createElement(CostPerRun, { v2, agentId: "a", on: true, quiet: true })));
      expect(!!host.querySelector('[data-testid="cost-per-run"]'), `shown for ${answer.runs.length} runs`).toBe(shown);
      act(() => root!.unmount()); root = undefined; document.body.innerHTML = "";
    }
  });
});
