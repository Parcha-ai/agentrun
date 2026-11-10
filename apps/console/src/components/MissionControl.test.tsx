import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Analytics, cachedShare, compact, costLine, duration, missionFrom, type MissionView, outcomes, rangeFrom, type Stats, successRate, trendDays } from "@/lib/mission";
import { MissionControl } from "./MissionControl";
import type { Run } from "@/lib/v2";
import { pick } from "@/test/picker";

const run = (id: string, status: Run["status"], state: Run["state"], title: string): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0,
  run_id: id, agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status, state, title, created_at: "2026-10-30T03:00:00Z",
  ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
});
// GET /v2/stats's `analytics`: tokens, time, success, cost, by harness and effort, per day and by tool, over the range
// picked. A partial figure says what it holds; an unknown cost never reads $0.
const g = (runs: number, completed: number, failed: number, withMetrics: number, tokens: number, cost: number | null, unknown = 0, review = 0) =>
  ({ runs, completed, failed, needs_review: review, runs_with_metrics: withMetrics, tokens, cost_usd: cost, unknown_cost_runs: unknown });
const NOW = Date.UTC(2026, 10, 1, 15);
const analytics = (over: Partial<Analytics> = {}): Analytics => ({
  filter: { from: "2026-10-03T00:00:00.000Z", to: null, agent: null },
  totals: { ...g(12, 9, 2, 12, 1_284_000, 1.234), input: 200_000, cache_read: 600_000, cache_write: 200_000, output: 284_000, requests: 40, unmetered: 0 },
  time: { ended_runs: 11, wall_ms: 5_400_000, active_runs: 0, active_ms: 0 },
  by_harness_effort: [{ harness: "codex", effort: "high", ...g(4, 3, 1, 4, 800_000, 0.9) }, { harness: "pi", effort: null, ...g(8, 6, 1, 8, 484_000, 0.334) }],
  by_day: [{ day: "2026-10-30", ...g(5, 4, 1, 5, 500_000, 0.5) }, { day: "2026-11-01", ...g(7, 5, 1, 7, 784_000, 0.734) }],
  by_source: [{ source: "live", ...g(12, 9, 2, 12, 1_284_000, 1.234) }],
  tools: [{ tool: "web_fetch", label: "Read web pages", calls: 40, errors: 4 }, { tool: "bash", label: "Run commands", calls: 12, errors: 0 }],
  ...over,
});
const view: MissionView = {
  agents: 2,
  runs: { total: 7, active: 1, needsInput: 2, failed: 1, statusUnknown: 0, needsReview: 0 },
  perAgent: [{ agentId: "calc", name: "Calc", runs: 5 }, { agentId: "notes", name: "Meeting notes", runs: 2 }],
  cost: { usd: 0.0043, basis: "estimate", unknownRuns: 2 },
  recent: [run("run-1", "completed", "idle", "What is six times seven?"), run("run-2", "working", "working", "Summarize the standup")],
  analytics: analytics(),
};

// Mission Control: the console's first page. Counts, cost said honestly, runs per agent and the latest runs, linked.
describe("MissionControl", () => {
  it("shows the agents, the runs and how many are active, waiting on a person, or failed", () => {
    const html = renderToStaticMarkup(createElement(MissionControl, { view }));
    for (const s of ["Mission Control", ">2<", ">7<", "Active", "Needs input", "Failed"]) expect(html).toContain(s);
  });
  it("links each recent run to its page, and each agent to its page's Runs tab", () => {
    const html = renderToStaticMarkup(createElement(MissionControl, { view }));
    expect(html).toContain('href="#/runs/run-1"');
    expect(html).toContain('href="#/runs/run-2"');
    expect(html).toContain('href="#/agents/calc/runs"');
  });
  it("renders a store with nothing in it, without error", () => {
    const none = analytics({ totals: { ...g(0, 0, 0, 0, 0, null), input: 0, cache_read: 0, cache_write: 0, output: 0, requests: 0, unmetered: 0 }, time: { ended_runs: 0, wall_ms: 0, active_runs: 0, active_ms: 0 }, by_harness_effort: [], by_day: [], by_source: [], tools: [] });
    const empty: MissionView = { agents: 0, runs: { total: 0, active: 0, needsInput: 0, failed: 0, statusUnknown: 0, needsReview: 0 }, perAgent: [], cost: { usd: null, basis: null, unknownRuns: 0 }, recent: [], analytics: none };
    const html = renderToStaticMarkup(createElement(MissionControl, { view: empty }));
    expect(html).toContain("No agents yet");
    expect(html).toContain("No runs yet");
    expect(html).not.toMatch(/\$0(\.0+)?\b/);
  });
});

describe("costLine: a total said honestly, never $0 for a cost not known", () => {
  it("is Unknown when no run's cost is known", () => {
    expect(costLine({ usd: null, basis: null, unknownRuns: 3 })).toBe("Unknown");
  });
  it("marks an estimate as est.", () => {
    expect(costLine({ usd: 1.5, basis: "estimate", unknownRuns: 0 })).toBe("$1.50 est.");
    expect(costLine({ usd: 0.0043, basis: "estimate", unknownRuns: 0 })).toBe("$0.0043 est.");
  });
  it("says how many runs aren't in the total", () => {
    expect(costLine({ usd: 0.0043, basis: "estimate", unknownRuns: 2 })).toBe("$0.0043 est. · 2 runs unknown");
    expect(costLine({ usd: 0.0043, basis: "estimate", unknownRuns: 1 })).toBe("$0.0043 est. · 1 run unknown");
  });
});

describe("missionFrom: GET /v2/stats and the latest runs, as the page shows them", () => {
  const stats = {
    agents: 2, runs: { total: 7, active: 1, needs_input: 2, failed: 1, status_unknown: 0, needs_review: 0 },
    per_agent: [{ agent_id: "calc", name: "Calc", runs: 5 }],
    cost: { usd: null, basis: null, unknown_runs: 7 }, archived: { agents: 1, runs: 3 }, learning: { runs: 0, merged: 0, dropped: {}, in_progress: 0 }, analytics: analytics(),
  } satisfies Stats;
  it("maps the server's fields, keeps an all-unknown cost null, and leaves archived out of the counts", () => {
    const v = missionFrom(stats, view.recent);
    expect(v).toEqual({
      agents: 2, runs: { total: 7, active: 1, needsInput: 2, failed: 1, statusUnknown: 0, needsReview: 0 }, perAgent: [{ agentId: "calc", name: "Calc", runs: 5 }],
      cost: { usd: null, basis: null, unknownRuns: 7 }, recent: view.recent, analytics: stats.analytics,
    });
    expect(costLine(v.cost)).toBe("Unknown");
  });
  it("reads the server's cost basis: an estimate says est.", () => {
    expect(costLine(missionFrom({ ...stats, cost: { usd: 1.5, basis: "estimate", unknown_runs: 0 } }, []).cost)).toBe("$1.50 est.");
  });
  it("keeps the runs whose state the server can't tell, and the page says how many", () => {
    const v = missionFrom({ ...stats, runs: { ...stats.runs, status_unknown: 3 } }, []);
    expect(v.runs.statusUnknown).toBe(3);
    expect(renderToStaticMarkup(createElement(MissionControl, { view: v }))).toContain("3 unknown");
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const withA = (a: Analytics): MissionView => ({ ...view, analytics: a });
const render = (v: MissionView, scope?: Parameters<typeof MissionControl>[0]["scope"]) => renderToStaticMarkup(createElement(MissionControl, { view: v, scope }));
const scope = { range: "30d" as const, onRange: () => {}, agent: null, onAgent: () => {} };

// The fixtures' days are fixed, so the page's clock is too: the trend and the heading count days back from today.
const atNow = () => { beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); }); afterEach(() => { vi.useRealTimers(); }); };

describe("MissionControl's analytics", () => {
  atNow();
  it("the heading names the range of the figures on screen, not a range picked whose answer is still on its way", () => {
    expect(render(withA(analytics()), { ...scope, range: "7d", refreshing: true })).toContain("Runs started in the last 30 days");
    expect(render(withA(analytics({ filter: { from: "2026-10-26T00:00:00.000Z", to: null, agent: "calc" } })), scope)).toContain("Runs started in the last 7 days, of Calc");
    expect(render(withA(analytics({ filter: { from: null, to: null, agent: null } })), scope)).toContain("All runs");
  });

  it("shows tokens with the cached share and output, run time, success rate and cost, by harness and effort, per day and by tool", () => {
    const html = render(withA(analytics()), scope);
    expect(html).toContain("Runs started in the last 30 days");
    for (const s of ["1.3M", "60% of input cached · 284K output", "1.5 h", "wall time of 11 ended runs", "82%", "9 completed · 2 failed", "$1.23 est."]) expect(html).toContain(s);
    expect(html).not.toContain("active, over");
    expect(html).not.toContain("tokens from");
    // By harness and effort: an unset effort says so; success and tokens per row.
    for (const s of [">codex<", ">high<", ">75%<", ">800K<", ">pi<", ">unset<", ">86%<"]) expect(html).toContain(s);
    // Top tools with their error rate, each by what a person calls it, the name it was called by its title.
    for (const s of ['title="web_fetch">Read web pages<', ">40<", ">4<", ">10%<", 'title="bash">Run commands<', ">0%<"]) expect(html).toContain(s);
    // The trend: a bar per day for 30 days, a readout for each, and the table view.
    expect(html).toContain('aria-label="Runs per day"');
    expect(html).toContain('aria-label="Tokens per day"');
    expect(html.match(/role="listitem"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("2026-10-30: 5 runs, 4 completed · 1 failed · 0 other");
    expect(html).toContain("<summary");
    // Live runs only: no source line.
    expect(html).not.toContain("Imported from");
  });

  it("says when tokens leave runs out, when requests were unmetered, and when runs were at work", () => {
    const a = analytics({ totals: { ...analytics().totals, runs_with_metrics: 9, unmetered: 2 }, time: { ended_runs: 11, wall_ms: 5_400_000, active_runs: 3, active_ms: 1_800_000 } });
    const html = render(withA(a), scope);
    expect(html).toContain("tokens from 9 of 12 runs");
    expect(html).toContain("2 requests with no token count");
    expect(html).toContain("30 min active, over 3 runs");
    const row = render(withA(analytics({ by_harness_effort: [{ harness: "pi", effort: null, ...g(5, 4, 1, 3, 1000, 0.1) }] })), scope);
    expect(row).toContain("tokens from 3 of 5 runs");
  });

  it("an unknown cost reads Unknown, never $0, and a partly known one says how many runs it leaves out", () => {
    const unknown: MissionView = { ...view, cost: { usd: null, basis: null, unknownRuns: 7 } };
    const none = render({ ...unknown, analytics: analytics({ totals: { ...analytics().totals, cost_usd: null, unknown_cost_runs: 12 }, by_harness_effort: [{ harness: "pi", effort: null, ...g(3, 3, 0, 3, 10, null, 3) }] }) }, scope);
    expect(none).toContain("Unknown");
    expect(none).not.toMatch(/\$0(\.0+)?\b/);
    const some = render(withA(analytics({ totals: { ...analytics().totals, cost_usd: 0.0061, unknown_cost_runs: 1 } })), scope);
    expect(some).toContain("$0.0061 est.");
    expect(some).toContain("1 run unknown");
  });

  it("a range with no runs says so in place of the trend, and imported runs are said beside live ones", () => {
    const empty = analytics({ totals: { ...g(0, 0, 0, 0, 0, null), input: 0, cache_read: 0, cache_write: 0, output: 0, requests: 0, unmetered: 0 }, time: { ended_runs: 0, wall_ms: 0, active_runs: 0, active_ms: 0 }, by_harness_effort: [], by_day: [], by_source: [], tools: [] });
    const html = render(withA(empty), scope);
    expect(html).toContain("No runs started in this range");
    expect(html).not.toContain('aria-label="Runs per day"');
    expect(html).toContain("No tool calls in runs with metrics");
    expect(html).toContain("—");
    const imported = render(withA(analytics({ by_source: [{ source: "live", ...g(9, 7, 1, 9, 1, 0) }, { source: "codex", ...g(3, 2, 1, 3, 1, null, 3) }] })), scope);
    expect(imported).toContain("Run here: 9 runs · Imported from codex: 3 runs");
  });

  it("the range picker is native radios (arrow keys, one Tab stop) that ask for another range, and the agent picker for one agent", async () => {
    const onRange = vi.fn(), onAgent = vi.fn();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => { root.render(createElement(MissionControl, { view: withA(analytics()), scope: { range: "30d", onRange, agent: null, onAgent } })); });
    const radio = (id: string) => host.querySelector(`input[type=radio][value='${id}']`) as HTMLInputElement;
    expect([radio("7d").checked, radio("30d").checked, radio("all").checked]).toEqual([false, true, false]);
    expect(new Set(["7d", "30d", "all"].map((id) => radio(id).name)).size).toBe(1);
    await act(async () => { radio("7d").click(); });
    await act(async () => { radio("all").click(); });
    expect(onRange.mock.calls).toEqual([["7d"], ["all"]]);
    const select = host.querySelector("button[aria-haspopup=listbox][aria-label='Agent']") as HTMLButtonElement;
    await pick(select, "calc");
    expect(onAgent).toHaveBeenCalledWith("calc");
    act(() => root.unmount());
  });
});

describe("the analytics helpers", () => {
  atNow();
  it("a range's from is the start of the UTC day it begins on: today and the days before it; All has none", () => {
    expect(rangeFrom("7d", NOW)).toBe("2026-10-26T00:00:00.000Z");
    expect(rangeFrom("30d", NOW)).toBe("2026-10-03T00:00:00.000Z");
    expect(rangeFrom("all", NOW)).toBeUndefined();
  });
  it("the trend's days run from the range's first day (at most 30 back) to today, a day with no run empty", () => {
    const by = analytics().by_day;
    const week = trendDays(by, "2026-10-26T00:00:00.000Z", NOW);
    expect(week.map((d) => d.day)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(week.map((d) => d.runs)).toEqual([0, 0, 0, 0, 5, 0, 7]);
    expect(trendDays(by, null, NOW)).toHaveLength(30);
    expect(trendDays([], "2026-10-26T00:00:00.000Z", NOW)).toEqual([]);
  });
  it("compacts numbers, says shares and durations", () => {
    expect([compact(1284), compact(12_900), compact(4_200_000), compact(100_000)]).toEqual(["1,284", "12.9K", "4.2M", "100K"]);
    expect([successRate({ completed: 0, failed: 0, needs_review: 0 }), cachedShare({ ...analytics().totals, input: 0, cache_read: 0, cache_write: 0 })]).toEqual([null, null]);
    expect([duration(5_400_000), duration(90_000), duration(4_000)]).toEqual(["1.5 h", "2 min", "4 s"]);
  });
});

// Escalated runs that wait for a person, counted apart (needs_review).
describe("runs that need review (needs_review)", () => {
  atNow();
  it("with the field: the outcomes say completed, failed and need review apart, and a run waiting for review is no success", () => {
    const g = { completed: 9, failed: 2, needs_review: 3 };
    expect(outcomes(g)).toBe("6 completed · 2 failed · 3 need review");
    expect(outcomes({ ...g, needs_review: 1 })).toBe("8 completed · 2 failed · 1 needs review");
    expect(outcomes({ ...g, needs_review: 0 })).toBe("9 completed · 2 failed");
    expect(successRate(g)).toBeCloseTo(6 / 11);
  });
  it("Mission Control says the runs that need review under Failed, never in it, and the analytics' outcomes apart", () => {
    const stats: Stats = { agents: 1, runs: { total: 8, active: 0, needs_input: 0, failed: 2, status_unknown: 0, needs_review: 3 }, per_agent: [], cost: { usd: null, basis: null, unknown_runs: 8 }, archived: { agents: 0, runs: 0 }, learning: { runs: 0, merged: 0, dropped: {}, in_progress: 0 }, analytics: analytics() };
    const v = missionFrom(stats, []);
    expect(v.runs.needsReview).toBe(3);
    const a = analytics({ totals: { ...analytics().totals, completed: 9, failed: 2, needs_review: 3 } });
    const html = render({ ...v, analytics: a }, scope);
    expect(html).toContain("3 need review");
    expect(html).toContain("6 completed · 2 failed · 3 need review");
    expect(html).not.toContain("failed or escalated");
  });
});

// Mission Control routes a person to what needs them: every count is a link to its list, and the latest runs say whose
// they are, how long they took and what they cost.
describe("MissionControl, the counts as links and the latest runs in full", () => {
  it("links each count to its list, filtered to it", () => {
    const html = render(view);
    for (const [label, href] of [["Agents", "#/agents"], ["Runs", "#/runs"], ["Needs input", "#/runs?status=input_required"], ["Failed", "#/runs?status=failed"]]) {
      expect(html, label).toMatch(new RegExp(`<a[^>]*href="${href.replace(/[?]/g, "\\?")}"[^>]*>(?:(?!</a>).)*${label}`));
    }
  });
  it("says the cost once, in the range's analytics, never again among the counts", () => {
    const html = render(view, scope);
    expect(html).not.toContain("Total cost");
    // One cost tile: the range's (the per-harness table's Cost column is a column, not a total).
    expect(html.match(/>Cost<\/p>/g)).toHaveLength(1);
  });
  it("leaves Active unlinked: it counts queued, working and paused runs, which no one list holds", () => {
    expect(render(view)).not.toContain('href="#/runs?status=working"');
  });
  it("shows each latest run's agent, how long it took, and its cost when known", () => {
    const done: Run = { ...run("run-9", "completed", "idle", "Check invoice INV-2291"), ended_at: "2026-10-30T03:00:42Z", cost: { usd: 0.0086, basis: "estimate", charge_state: null, cap_usd: null } };
    const html = render({ ...view, recent: [done, run("run-2", "working", "working", "Summarize the standup")] });
    expect(html).toContain("Check invoice INV-2291");
    expect(html).toContain("Calc");
    expect(html).toContain("42s");
    expect(html).toContain("$0.0086 est.");
    // A run still working has no duration yet, and an unknown cost is left out, never $0.
    expect(html).not.toContain("$0.0000");
  });
  it("shows a latest (ended) run's known cost and how many charges have no price, and an unknown cost with nothing known not at all", () => {
    const unknown = { usd: null, basis: "estimate" as const, charge_state: null, cap_usd: null };
    const stopped: Run = { ...run("run-9", "completed", "idle", "Check invoice INV-2291"), cost: { ...unknown, so_far_usd: 0.0123, unpriced: 1 } };
    const html = render({ ...view, recent: [stopped, { ...run("run-2", "completed", "idle", "Summarize the standup"), cost: unknown }] });
    expect(html).toContain("$0.0123 est. known · 1 not priced");
    expect(html).not.toContain("Unknown");
  });
  it("puts what needs you first, and before a first run of your own, the start-here panel in place of the counts", () => {
    const needs = createElement("section", { "aria-label": "Needs you" }, "the strip");
    const first = createElement("section", { "aria-label": "Start here" }, "the panel");
    const withNeeds = renderToStaticMarkup(createElement(MissionControl, { view, needsYou: needs }));
    expect(withNeeds.indexOf("the strip")).toBeLessThan(withNeeds.indexOf("Needs input"));
    const fresh = renderToStaticMarkup(createElement(MissionControl, { view, startHere: first }));
    expect(fresh).toContain("the panel");
    expect(fresh).not.toContain("Needs input");
    expect(fresh).not.toContain("Recent runs");
  });
});
