import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CostChart, CostPerRun, HOW } from "./CostPerRun";
import SAMPLE from "./CostPerRun.sample.json";
import { ClientError, type Client } from "@/lib/client";
import { blocksOf, blockSizeOf, level, nearest, niceTop, pct, plotted, rollingMean, runTicks, timesOf, usd, windowOf, yTicksOf, yTopOf } from "@/lib/costPerRun";
import type { CostRun, LearningCost, Promotion } from "@/lib/v2";

// The cost per run chart (GET /v2/agents/{id}/learning/cost): the invented invoice-sorter agent's 80 runs, its cost
// falling from about $0.89 by hand to about $0.13 once its learned workflow takes over at run 21.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sample = SAMPLE as unknown as LearningCost;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

function draw(data: LearningCost, on = true, width = 900, promotions: Promotion[] = []) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(CostChart, { data, on, width, promotions })));
  return host;
}
const text = (host: HTMLElement) => host.textContent ?? "";
const run = (n: number, path: CostRun["path"], total: number | null): CostRun => ({ n, run_id: `run_${n}`, started_at: new Date(Date.UTC(2026, 9, 1, n)).toISOString(), path, workflow: path === "agent" ? null : "sort", learned_revision: "a".repeat(40), cost_usd: total, learning_usd: total === null ? null : 0, total_usd: total });
const series = (runs: CostRun[], summary: Partial<LearningCost["summary"]> = {}): LearningCost => ({ agent: "a", runs, total_runs: runs.length, unknown_cost_runs: runs.filter((r) => r.total_usd === null).length, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, times_cheaper: null, hand_backs: null, ...summary }, workflows: [] });

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

describe("the ratio format", () => {
  it("says a tenth under 10x and a whole number from 10x, one format for the headline card and the chart", () => {
    expect([timesOf(7), timesOf(7.4), timesOf(6.953), timesOf(9.94), timesOf(9.96), timesOf(10), timesOf(12.4), timesOf(0.5), timesOf(104.6)]).toEqual(["7.0x", "7.4x", "7.0x", "9.9x", "10x", "10x", "12x", "0.5x", "105x"]);
  });
  it("rounds once: 10.46 is 10x, not 11x", () => {
    expect([timesOf(10.46), timesOf(9.96), timesOf(7.04)]).toEqual(["10x", "10x", "7.0x"]);
  });
});

describe("the execution mix's arithmetic", () => {
  it("cuts every run, its cost known or not, one a column up to 20, then into blocks of 5 or more, about 20 blocks at most", () => {
    expect([blockSizeOf(3), blockSizeOf(20), blockSizeOf(21), blockSizeOf(80), blockSizeOf(400), blockSizeOf(1000)]).toEqual([1, 1, 5, 5, 20, 50]);
    const blocks = blocksOf(sample.runs, 5);
    expect(blocks).toHaveLength(16);
    expect(blocks[4]).toEqual({ from: 21, to: 25, runs: 5, counts: { agent: 1, handed_back: 1, workflow: 3, replay: 0 } });
    const mixed = blocksOf([run(1, "agent", 0.5), run(2, "replay", 0.1), run(3, "replay", 0.1)], 5);
    expect(mixed[0]!.counts).toEqual({ agent: 1, handed_back: 0, workflow: 0, replay: 2 });
    const short = blocksOf(sample.runs.slice(0, 7), 5);
    expect(short.map((b) => [b.from, b.to, b.runs])).toEqual([[1, 5, 5], [6, 7, 2]]);
    expect([pct(3, 5), pct(1, 3), pct(0, 0)]).toEqual(["60%", "33%", "0%"]);
  });
  // Review on #2644: a replay run counts in its block like any other path, never NaN.
  it("counts a replay run in its block", () => {
    const runs = sample.runs.slice(0, 3).map((r, i) => ({ ...r, path: i === 1 ? ("replay" as const) : r.path }));
    const [block] = blocksOf(runs, 3);
    expect(block!.counts.replay).toBe(1);
    expect(Object.values(block!.counts).reduce((a, b) => a + b, 0)).toBe(3);
  });
  it("steps the cost axis cleanly from 0 to its top: never a quarter of 5", () => {
    expect(yTicksOf(0.005)).toEqual([0, 0.001, 0.002, 0.003, 0.004, 0.005]);
    expect(yTicksOf(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(yTicksOf(0.25)).toEqual([0, 0.05, 0.1, 0.15, 0.2, 0.25]);
    expect(yTicksOf(2)).toEqual([0, 0.5, 1, 1.5, 2]);
  });
});

describe("CostChart", () => {
  it("shows the drop: the levels before and after, the takeover, and how many times cheaper", () => {
    const host = draw(sample);
    expect(text(host)).toContain("$0.890 a run before takeover, $0.128 all-in after: 7.0x cheaper · 5% handed back since");
    expect(text(host)).toContain("Workflow took over, run 21");
    expect(text(host)).toContain("After takeover $0.128 · 7.0x cheaper");
    expect(text(host)).toContain("Before takeover $0.890");
    expect(text(host)).toContain("Rolling mean of 5 runs");
    expect(text(host)).toContain("1 run costs more than");
    expect(text(host)).toContain("1 run's cost is not known: left out.");
  });
  it("the hand-back rate is the server's, over every run since the takeover, never the latest runs the chart read", () => {
    // The chart read only runs it answered alone; the summary counts the hand-backs before them.
    const host = draw(series([run(1, "agent", 0.9), run(2, "workflow", 0.1), run(3, "workflow", 0.1)], { takeover: { n: 2, run_id: "r2" }, before: { runs: 1, mean_usd: 0.9 }, after: { runs: 2, mean_usd: 0.1 }, hand_backs: { ran: 40, back: 10 } }));
    expect(text(host)).toContain("25% handed back since");
  });
  it("before any workflow has finished a run, the mix's last words say who did, not 0% by the workflow", () => {
    const host = draw(series([run(1, "agent", 0.002), run(2, "agent", 0.003), run(3, "handed_back", 0.002)]));
    const mix = host.querySelector('[data-testid="execution-mix"]')!;
    expect(mix.textContent).toContain("Last run: 100% handed back");
    expect(mix.textContent).not.toContain("by the learned workflow");
  });
  it("on a phone the level's words are short enough to clear the line's drop", () => {
    const host = draw(sample, true, 390);
    expect(text(host)).toContain("After $0.128 · 7.0x cheaper");
    expect(text(host)).not.toContain("After takeover $0.128");
  });
  it("carries the takeover marker down through the mix as one line on the left edge of the takeover's block, never a ring cutting a column", () => {
    const mix = draw(sample).querySelector<HTMLElement>('[data-testid="execution-mix"]')!;
    const marker = mix.querySelector('[data-testid="mix-takeover"]')!;
    const paths = [...marker.querySelectorAll("path")];
    expect(paths.map((p) => p.getAttribute("class"))).toEqual(["stroke-chart-workflow"]);
    // Runs 21 to 25 are a whole block starting at the takeover: its hover target begins where the line is.
    const targets = [...mix.querySelectorAll("svg g")].map((g) => g.querySelector("rect")).filter((r): r is SVGRectElement => !!r && r.getAttribute("fill-opacity") === "0");
    const edge = Number(targets[4]!.getAttribute("x"));
    expect(Number(/^M([\d.]+),/.exec(paths[0]!.getAttribute("d")!)![1])).toBeCloseTo(edge, 1);
  });
  it("tiles the mix in whole blocks on the run axis: every block as wide as the others, the last one alone shorter, no gap between", () => {
    const mix = draw(sample).querySelector<HTMLElement>('[data-testid="execution-mix"]')!;
    const targets = [...mix.querySelectorAll("svg g")].map((g) => g.querySelector("rect")).filter((r): r is SVGRectElement => !!r && r.getAttribute("fill-opacity") === "0");
    const spans = targets.map((r) => [Number(r.getAttribute("x")), Number(r.getAttribute("width"))] as const);
    expect(spans).toHaveLength(16);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeCloseTo(spans[i - 1]![0] + spans[i - 1]![1], 1);
    for (const [, w] of spans) expect(w).toBeCloseTo(spans[0]![1], 1);
  });
  it("gives a run whose cost is unknown its own column even when the last runs are unknown", () => {
    const host = draw(series([run(1, "agent", 0.5), run(2, "agent", 0.5), run(3, "agent", null), run(4, "handed_back", null), run(5, "workflow", null)]));
    const mix = host.querySelector<HTMLElement>('[data-testid="execution-mix"]')!;
    const xs = [...mix.querySelectorAll("svg g")].map((g) => g.querySelector("rect")).filter((r): r is SVGRectElement => !!r && r.getAttribute("fill-opacity") === "0").map((r) => Number(r.getAttribute("x")));
    expect(new Set(xs.map((v) => Math.round(v))).size).toBe(5);
  });
  it("says how many runs' path and cost are not known, left out, never drawn as the agent's at $0", () => {
    const host = draw({ ...sample, unknown_path_runs: 2 });
    expect(text(host)).toContain("2 runs' path and cost are not known: left out.");
    expect(text(draw({ ...sample, unknown_path_runs: 1 }))).toContain("1 run's path and cost are not known: left out.");
    expect(text(draw(sample))).not.toContain("path and cost are not known");
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
  it("draws the execution mix on the run axis: a column a block, a segment a path it took, the last block's share said", () => {
    const host = draw(sample);
    const mix = host.querySelector<HTMLElement>('[data-testid="execution-mix"]')!;
    expect(mix.textContent).toContain("Who finished each run, by 5");
    expect(mix.textContent).toContain("Last 5 runs: 100% by the learned workflow");
    const segments = [...mix.querySelectorAll("svg rect")].filter((r) => r.getAttribute("class")?.startsWith("fill-chart-"));
    expect(segments).toHaveLength(21);
    expect(mix.querySelector(".sr-only")!.textContent).toContain("Runs 21 to 25: by the agent 1, handed back 1, learned workflow 3");
    act(() => { mix.querySelectorAll("svg g")[4]!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
    expect(mix.querySelector(".shadow-float")!.textContent).toBe("Runs 21 to 25By the agent 1 (20%)Handed back 1 (20%)Learned workflow 3 (60%)");
  });
  it("draws a column a run up to 20 runs, each named as one run", () => {
    const runs = [...Array.from({ length: 4 }, (_, i) => run(i + 1, "agent", 0.002)), run(5, "handed_back", 0.003)];
    const mix = draw(series(runs, { before: { runs: 5, mean_usd: 0.002 } })).querySelector<HTMLElement>('[data-testid="execution-mix"]')!;
    expect(mix.textContent).toContain("Who finished each run");
    expect(mix.textContent).not.toContain(", by ");
    expect([...mix.querySelectorAll("svg rect")].filter((r) => r.getAttribute("class")?.startsWith("fill-chart-"))).toHaveLength(5);
    expect(mix.querySelector(".sr-only")!.textContent).toContain("Run 5: handed back 1");
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
  it("says how many runs were left out in the empty card too, when none has a known cost", () => {
    const host = draw({ ...series([]), total_runs: 3, unknown_cost_runs: 1, unknown_path_runs: 2 });
    expect(host.querySelector("svg[aria-hidden] path")).toBeNull();
    expect(text(host)).toContain("No run with a known cost yet.");
    expect(text(host)).toContain("2 runs' path and cost are not known: left out.");
    expect(text(host)).toContain("1 run's cost is not known: left out.");
  });
  it("draws the mix even when no run has a known cost: the chart says what is needed, the strip still shows who finished each run", () => {
    const host = draw(series([run(1, "agent", null), run(2, "workflow", null), run(3, "workflow", null)]));
    expect(text(host)).toContain("No run with a known cost yet.");
    expect(host.querySelector('[data-testid="execution-mix"]')).not.toBeNull();
  });
  it("keeps the level after the takeover when the takeover is older than the runs read, without its marker", () => {
    const host = draw({ ...sample, runs: sample.runs.slice(40), total_runs: 80 });
    expect(text(host)).toContain("After takeover $0.128 · 7.0x cheaper");
    expect(text(host)).not.toContain("Workflow took over, run 21");
  });
  it("says a learned workflow that costs more than the agent by hand no longer runs first, with the two levels", () => {
    const host = draw({ ...sample, workflows: [{ workflow: "sort-invoice", digest: "0123456789abcdef", state: "needs_revision", served: { runs: 10, mean_usd: 0.95 }, by_hand: { runs: 19, mean_usd: 0.889921 }, unknown_cost_runs: 0 }] });
    expect(text(host)).toContain("sort-invoice no longer runs first: $0.950 a run all-in over its last 10 runs, at or over $0.890 a run by hand. Its next run asks the agent for a new version, which runs first again.");
    act(() => root!.unmount()); document.body.innerHTML = "";
    expect(text(draw({ ...sample, workflows: [{ workflow: "sort-invoice", digest: "0123456789abcdef", state: "needs_revision", served: { runs: 10, mean_usd: 0.95 }, by_hand: { runs: 19, mean_usd: 0.889921 }, unknown_cost_runs: 2 }] }))).toContain("at or over $0.890 a run by hand. 2 runs of unknown cost left out. Its next run");
    act(() => root!.unmount()); document.body.innerHTML = "";
    expect(text(draw({ ...sample, workflows: [{ workflow: "sort-invoice", digest: "0123456789abcdef", state: "serving", served: { runs: 10, mean_usd: 0.1 }, by_hand: { runs: 19, mean_usd: 0.889921 }, unknown_cost_runs: 0 }] }))).not.toContain("no longer runs first");
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
    const empty: LearningCost = { agent: "a", runs: [], total_runs: 0, unknown_cost_runs: 0, unknown_path_runs: 0, summary: { takeover: null, before: null, after: null, times_cheaper: null, hand_backs: null }, workflows: [] };
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

describe("the loop on the cost chart", () => {
  const at = (n: number) => sample.runs.find((r) => r.n === n)!.started_at;
  const record = (over: Partial<Promotion>): Promotion => ({ workflow: "sort-invoice", digest: "a12596c0a12596c0", at: at(18), decided: "replaying", source: "replay", reason: "replaying on graded inputs", ...over } as Promotion);
  const promotions = [
    record({}),
    record({ decided: "promote", at: at(21), replay: { of: [], n: 20, agree: 19, agent_acc: 0.9, wf_acc: 0.95, delta: 0.05, handed_back: 2 } }),
    record({ decided: "promote", source: "refit", digest: "1a48d30c1a48d30c", at: at(51), refit: { from: "a12596c0a12596c0", guards: [{ node: "classify", was: 0.7, threshold: 0.8 }] } }),
  ];
  it("flags each promotion record on its run, lettered, with a key and a table", () => {
    const host = draw(sample, true, 900, promotions);
    expect([...host.querySelectorAll('[data-testid^="marker-"]:not([data-testid^="marker-key"]):not([data-testid="marker-table"])')].map((g) => g.getAttribute("data-testid"))).toEqual(["marker-revision", "marker-promote", "marker-refit"]);
    expect(host.querySelector('[data-testid="marker-key-promote"]')?.textContent).toBe("PPromoted 1");
    const rows = [...host.querySelectorAll('[data-testid="marker-table"] tbody tr')].map((r) => r.textContent);
    expect(rows[1]).toContain("21P Promotedsort-invoicea12596cReplay on 20 graded inputs: workflow 95% vs agent 90% (+5 pts), 2 handed back");
    expect(text(host)).toContain("Markers: New revision · run 18");
  });
  it("draws no marker lane without records", () => {
    const host = draw(sample);
    expect(host.querySelector('[data-testid="marker-promote"]')).toBeNull();
    expect(host.querySelector('[data-testid="marker-table"]')).toBeNull();
  });
  it("draws a replay run as a hollow ring out of the mean, and counts the unknown runs", () => {
    const runs = [run(1, "agent", 1), run(2, "agent", 1), run(3, "replay", 9), run(4, "workflow", 0.1), run(5, "agent", null)];
    const host = draw({ ...series(runs), unknown_path_runs: 2 });
    expect(host.querySelectorAll("circle.fill-none.stroke-muted-foreground")).toHaveLength(1);
    expect(text(host)).toContain("replay runs (hollow) left out");
    expect(text(host)).toContain("3 runs unknown");
    const path = host.querySelector("svg path.stroke-foreground[fill='none']")?.getAttribute("d") ?? "";
    expect(path.split(/[ML]/).filter(Boolean)).toHaveLength(3);
  });
});
