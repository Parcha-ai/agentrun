import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsTab } from "./AgentAnalytics";
import { ANALYTICS, statsWith } from "./AgentAnalytics.sample";
import { agentFixture } from "@/fixtures";
import { ClientError, createClient } from "@/lib/client";
import type { Analytics, Stats } from "@/lib/mission";
import type { Run, TimelinePage } from "@/lib/v2";

// The agent page's Analytics tab: one agent's GET /v2/stats analytics over a range, drawn as Mission Control draws the
// server's (MissionAnalytics). Coverage is said, unmetered requests are named, and a cost nobody knows is never $0.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

/** The tab over a server that answers `answer(from)` (the analytics' own filter says the `from` it was asked for).
 *  `first`: the page's own first answer, which the tab opens on. `runs`: the agent's runs (none by default), whose
 *  timelines `timeline` answers. `unknown(n)`: the served runs.status_unknown of the nth stats answer (0 by default). */
type Extra = { first?: Stats; runs?: Run[]; byStatus?: Partial<Record<string, Run[]>>; timeline?: (id: string, o: { after?: number }) => Promise<TimelinePage>; unknown?: (n: number) => number };
async function open(answer: (from?: string) => Analytics = () => ANALYTICS, { first, runs = [], byStatus, timeline, unknown = () => 0 }: Extra = {}) {
  const asked: string[] = [];
  const runsAsked: string[] = [];
  const followed: string[] = [];
  let n = 0;
  const v2 = {
    statsOver: async ({ from, agent: of }: { from?: string; agent?: string }) => {
      asked.push(`${of} ${from ?? "all"}`);
      const a = answer(from);
      const s = statsWith({ ...a, filter: { ...a.filter, from: from ?? null } });
      return { ...s, runs: { ...s.runs, status_unknown: unknown(n++) } };
    },
    listAgentRuns: async (_id: string, _limit: number, _cursor: string | null, filter?: { status?: string }) => {
      runsAsked.push(filter?.status ?? "any");
      return { runs: byStatus ? byStatus[filter?.status ?? ""] ?? [] : filter?.status ? runs.filter((r) => r.status === filter.status) : runs, next_cursor: null };
    },
    getTimeline: async (id: string, o: { after?: number } = {}) => { if (o.after === undefined) followed.push(id); return (timeline ?? (async () => new Promise<TimelinePage>(() => {})))(id, o); },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  act(() => root!.render(createElement(AnalyticsTab, { agent: agentFixture("invoice-checker"), v2: v2 as never, now: () => NOW, ...(first ? { stats: first } : {}) })));
  await settle();
  const tile = (label: string) => [...host.querySelectorAll("li")].find((li) => li.firstElementChild?.textContent === label);
  const rows = (heading: string) => [...([...host.querySelectorAll("section")].find((s) => s.querySelector("h3")?.textContent === heading)?.querySelectorAll("tbody tr") ?? [])].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  const pick = async (range: string) => { await act(async () => { host.querySelector<HTMLInputElement>(`[aria-label="Range"] input[value="${range}"]`)!.click(); }); await settle(); };
  const days = (chart: string) => [...host.querySelectorAll(`[aria-label="${chart}"] [role="listitem"]`)].map((d) => d.getAttribute("aria-label"));
  return { host, asked, runsAsked, followed, tile, rows, pick, days, settle };
}

describe("AnalyticsTab", () => {
  it("asks for this agent's analytics over the last 30 UTC days, and the range picker sets from: 7 days, then every run", async () => {
    const tab = await open();
    expect(tab.asked).toEqual(["invoice-checker 2026-09-16T00:00:00.000Z"]);
    expect(tab.host.querySelector<HTMLInputElement>('[aria-label="Range"] input:checked')?.value).toBe("30d");
    await tab.pick("7d");
    await tab.pick("all");
    expect(tab.asked).toEqual(["invoice-checker 2026-09-16T00:00:00.000Z", "invoice-checker 2026-10-09T00:00:00.000Z", "invoice-checker all"]);
    expect(tab.host.querySelector<HTMLInputElement>('[aria-label="Range"] input:checked')?.value).toBe("all");
  });

  it("shows tokens with the cached share, output, coverage and unmetered requests; run time; success; and the cost with the runs it leaves out", async () => {
    const tab = await open();
    expect(tab.tile("Tokens")?.textContent).toBe("Tokens1.3M83% of input cached · 50K outputtokens from 5 of 8 runs2 requests with no token count");
    expect(tab.tile("Run time")?.textContent).toBe("Run time2.5 hwall time of 7 ended runs1.5 h active, over 4 runs");
    expect(tab.tile("Success rate")?.textContent).toBe("Success rate71%5 completed · 2 failed");
    expect(tab.tile("Cost")?.textContent).toBe("Cost$0.75 est.3 runs unknown");
    act(() => root?.unmount());
    // Every run covered and metered: nothing is said about either.
    const covered = await open(() => ({ ...ANALYTICS, totals: { ...ANALYTICS.totals, runs_with_metrics: 8, unmetered: 0 } }));
    expect(covered.tile("Tokens")?.textContent).toBe("Tokens1.3M83% of input cached · 50K output");
  });

  it("never reads a cost nobody knows as $0: by effort, a group with no metrics says whose tokens it holds and its cost is Unknown", async () => {
    const tab = await open();
    expect(tab.rows("Success by harness and effort")).toEqual([
      ["pi", "unset", "3", "50%", "0tokens from 0 of 3 runs", "Unknown"],
      ["pi", "high", "5", "80%", "1.3M", "$0.75 est."],
    ]);
    act(() => root?.unmount());
    const none = await open(() => ({ ...ANALYTICS, totals: { ...ANALYTICS.totals, cost_usd: null, unknown_cost_runs: 8 }, by_harness_effort: [ANALYTICS.by_harness_effort[0]!], by_day: [] }));
    expect(none.tile("Cost")?.textContent).toBe("CostUnknown");
    expect(none.host.textContent).not.toContain("$0");
  });

  it("lists the top tools with their error rates, and draws a column per day over the range, each named for hover and focus", async () => {
    const tab = await open();
    expect(tab.rows("Top tools")).toEqual([["Read files", "30", "0", "0%"], ["Run commands", "12", "4", "33%"], ["Fetch web pages", "3", "1", "33%"]]);
    const runs = tab.days("Runs per day");
    expect(runs.length).toBe(30);
    expect(runs[0]).toBe("2026-09-16: 0 runs, 0 completed · 0 failed · 0 other");
    expect(runs.at(-7)).toBe("2026-10-09: 3 runs, 2 completed · 1 failed · 0 other");
    expect(tab.days("Tokens per day").at(-1)).toBe("2026-10-15: 0 tokens, tokens from 0 of 2 runs");
    await tab.pick("7d");
    expect(tab.days("Runs per day").length).toBe(7);
  });

  it("latest wins: 30 days, then 7, then 30 again before the 7-day answer comes: the late answer never replaces the 30-day one", async () => {
    let release!: (s: unknown) => void;
    const reads: (string | undefined)[] = [];
    const v2 = {
      statsOver: ({ from }: { from?: string }) => {
        reads.push(from);
        // The first 30-day read answers at once; the 7-day read waits until the test lets it answer.
        if (reads.length === 1) return Promise.resolve(statsWith(ANALYTICS));
        return new Promise((r) => (release = r));
      },
      listAgentRuns: async () => ({ runs: [], next_cursor: null }),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    act(() => root!.render(createElement(AnalyticsTab, { agent: agentFixture("invoice-checker"), v2: v2 as never, now: () => NOW })));
    await settle();
    const tokens = () => [...host.querySelectorAll("li")].find((li) => li.firstElementChild?.textContent === "Tokens")?.children[1]?.textContent;
    expect(tokens()).toBe("1.3M");
    const pick = async (range: string) => { await act(async () => { host.querySelector<HTMLInputElement>(`[aria-label="Range"] input[value="${range}"]`)!.click(); }); await settle(); };
    await pick("7d");
    await pick("30d");
    // The 7-day answer comes last, with other figures: it is dropped.
    await act(async () => { release(statsWith({ ...ANALYTICS, totals: { ...ANALYTICS.totals, tokens: 7_000 } })); });
    await settle();
    expect(tokens()).toBe("1.3M");
    expect(host.querySelector<HTMLInputElement>('[aria-label="Range"] input:checked')?.value).toBe("30d");
    expect(reads).toHaveLength(2);
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("says when the agent has no runs in the range", async () => {
    const empty = await open(() => ({ ...ANALYTICS, totals: { ...ANALYTICS.totals, runs: 0, completed: 0, failed: 0, runs_with_metrics: 0 }, by_day: [], by_harness_effort: [], tools: [] }));
    expect(empty.host.textContent).toContain("No runs of this agent in this range.");
  });
});

describe("the client's statsOver for one agent", () => {
  it("sends agent= with from when a range sets one", async () => {
    const urls: string[] = [];
    const v2 = createClient({ fetch: (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify(statsWith(ANALYTICS)), { headers: { "content-type": "application/json" } }); }) as typeof fetch });
    expect((await v2.statsOver({ from: "2026-10-09T00:00:00.000Z", agent: "invoice-checker" })).analytics?.totals.runs).toBe(8);
    await v2.statsOver({ agent: "invoice-checker" });
    expect(urls).toEqual(["/v2/stats?from=2026-10-09T00%3A00%3A00.000Z&agent=invoice-checker", "/v2/stats?agent=invoice-checker"]);
  });
});

describe("AnalyticsTab, a failed read", () => {
  it("says the server's refusal as code and message, and another failure by its message", async () => {
    const refused = await open(() => { throw new ClientError(503, "store_busy", "the store is busy", true); });
    expect(refused.host.querySelector('[role="alert"]')?.textContent).toBe("The analytics could not be read: store_busy: the store is busy");
    act(() => root?.unmount());
    const failed = await open(() => { throw new TypeError("Failed to fetch"); });
    expect(failed.host.querySelector('[role="alert"]')?.textContent).toBe("The analytics could not be read: Failed to fetch");
  });
});

// The tab is read again whenever what it shows may have moved: when it opens, when a run of this agent that was going
// changes status (followed on its timeline, as the Runs tab follows its latest run), and, a bounded number of times,
// while the server says a run's end is not in its store yet.
describe("AnalyticsTab, read again", () => {
  it("reads again when it opens, even on the page's first answer: a run that ended since shows, with no reload", async () => {
    const before = { ...ANALYTICS, totals: { ...ANALYTICS.totals, runs: 2, completed: 1 } };
    const tab = await open(() => ANALYTICS, { first: statsWith(before) });
    expect(tab.asked).toEqual(["invoice-checker 2026-09-16T00:00:00.000Z"]);
    expect(tab.tile("Success rate")?.textContent).toContain("5 completed");
  });

  it("reads again when a run of this agent that was going ends, followed on its timeline as the Runs tab follows one", async () => {
    const run = (id: string, status: string, state: string) => ({ run_id: id, agent_id: "invoice-checker", agent_version: 1, revision: "rv1", kind: "agentic", status, state, title: id, created_at: "2026-10-15T11:00:00Z", ended_at: null, result: null, error: null, cost: null, archived_at: null }) as unknown as Run;
    let release!: () => void;
    const ended = new Promise<void>((r) => (release = r));
    const page = (status: string, state: string, final: boolean, next: number) => ({ rows: [], drop: [], reset: false, next_after: next, final, has_more: false, status, state, unchanged: false, poll_after_ms: 0 }) as unknown as TimelinePage;
    const tab = await open(() => ANALYTICS, { runs: [run("r-live", "working", "working"), run("r-done", "completed", "idle")], timeline: async (id, o) => {
      if (id !== "r-live") throw new Error(`only the live run is followed, not ${id}`);
      if (o.after === undefined) return page("working", "working", false, 1);
      await ended;
      return page("completed", "idle", true, 2);
    } });
    expect(tab.asked).toHaveLength(1);
    await act(async () => { release(); });
    for (let i = 0; i < 20 && tab.asked.length < 2; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(tab.asked).toHaveLength(2);
  });

  it("while the server says a run's end is not in its store yet (runs.status_unknown above 0) it reads again, at most three times in all", async () => {
    const settles = await open(() => ANALYTICS, { unknown: (n) => (n === 0 ? 1 : 0) });
    for (let i = 0; i < 40 && settles.asked.length < 2; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(settles.asked).toHaveLength(2);
    act(() => root?.unmount());
    const never = await open(() => ANALYTICS, { unknown: () => 1 });
    for (let i = 0; i < 60 && never.asked.length < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(never.asked).toHaveLength(3);
    expect(never.tile("Success rate")?.textContent).toContain("5 completed");
  });

  it("follows the agent's runs that are going whatever their age: it asks for them by status, not among the newest 50", async () => {
    const run = (id: string, status: string, state: string) => ({ run_id: id, agent_id: "invoice-checker", agent_version: 1, revision: "rv1", kind: "agentic", status, state, title: id, created_at: "2026-10-01T11:00:00Z", ended_at: null, result: null, error: null, cost: null, archived_at: null }) as unknown as Run;
    const tab = await open(() => ANALYTICS, { byStatus: { input_required: [run("r-old-waiting", "input_required", "waiting")], any: [] } });
    expect([...tab.runsAsked].sort()).toEqual(["input_required", "paused", "queued", "working"]);
    expect(tab.followed).toEqual(["r-old-waiting"]);
  });

  it("a range left and come back to before its answer settled reads it again: its unsettled answer is never taken as done", async () => {
    // The 30-day answer says a run's end is not in the store yet; the 7-day read never answers; back on 30 days the
    // tab reads it again rather than keep the unsettled answer.
    const reads: (string | undefined)[] = [];
    const v2 = {
      statsOver: ({ from }: { from?: string }) => {
        reads.push(from);
        if (reads.length === 2) return new Promise(() => {});
        const s = statsWith(ANALYTICS);
        return Promise.resolve({ ...s, runs: { ...s.runs, status_unknown: reads.length === 1 ? 1 : 0 } });
      },
      listAgentRuns: async () => ({ runs: [], next_cursor: null }),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    act(() => root!.render(createElement(AnalyticsTab, { agent: agentFixture("invoice-checker"), v2: v2 as never, now: () => NOW })));
    await settle();
    const pick = async (range: string) => { await act(async () => { host.querySelector<HTMLInputElement>(`[aria-label="Range"] input[value="${range}"]`)!.click(); }); await settle(); };
    await pick("7d");
    await pick("30d");
    for (let i = 0; i < 40 && reads.length < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(reads).toEqual(["2026-09-16T00:00:00.000Z", "2026-10-09T00:00:00.000Z", "2026-09-16T00:00:00.000Z"]);
    await settle();
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("a tab closed while its answer is unsettled reads no more", async () => {
    const tab = await open(() => ANALYTICS, { unknown: () => 1 });
    expect(tab.asked).toHaveLength(1);
    act(() => root?.unmount());
    root = undefined;
    await act(async () => { await new Promise((r) => setTimeout(r, 1500)); });
    expect(tab.asked).toHaveLength(1);
  });

  it("an unsettled answer that replaced a settled one is never taken for the range on screen: back on 30 days, 30 days is read again", async () => {
    // 30 days settles; 7 days answers unsettled (its retries then never answer); back on 30 days the figures on screen
    // are 7 days', so 30 days is read again rather than kept as if it were shown.
    const reads: (string | undefined)[] = [];
    const v2 = {
      statsOver: ({ from }: { from?: string }) => {
        reads.push(from);
        const s = statsWith(ANALYTICS);
        if (reads.length === 1) return Promise.resolve(s);
        if (reads.length === 2) return Promise.resolve({ ...s, runs: { ...s.runs, status_unknown: 1 } });
        if (from === "2026-10-09T00:00:00.000Z") return new Promise(() => {});
        return Promise.resolve(s);
      },
      listAgentRuns: async () => ({ runs: [], next_cursor: null }),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    act(() => root!.render(createElement(AnalyticsTab, { agent: agentFixture("invoice-checker"), v2: v2 as never, now: () => NOW })));
    await settle();
    const pick = async (range: string) => { await act(async () => { host.querySelector<HTMLInputElement>(`[aria-label="Range"] input[value="${range}"]`)!.click(); }); await settle(); };
    await pick("7d");
    await pick("30d");
    await settle();
    expect(reads.filter((f) => f === "2026-09-16T00:00:00.000Z")).toHaveLength(2);
  });
});
