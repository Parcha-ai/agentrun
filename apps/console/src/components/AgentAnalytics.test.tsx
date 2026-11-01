import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsTab } from "./AgentAnalytics";
import { ANALYTICS, statsWith } from "./AgentAnalytics.sample";
import { agentFixture } from "@/fixtures";
import { createClient } from "@/lib/client";
import type { Analytics } from "@/lib/mission";

// The agent page's Analytics tab: one agent's GET /v2/stats analytics over a range, drawn as Mission Control draws the
// server's (MissionAnalytics). Coverage is said, unmetered requests are named, and a cost nobody knows is never $0.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

/** The tab over a server that answers `answer(from)` (the analytics' own filter says the `from` it was asked for). */
async function open(answer: (from?: string) => Analytics | undefined = () => ANALYTICS) {
  const asked: string[] = [];
  const v2 = {
    statsOver: async ({ from, agent: of }: { from?: string; agent?: string }) => {
      asked.push(`${of} ${from ?? "all"}`);
      const a = answer(from);
      return statsWith(a && { ...a, filter: { ...a.filter, from: from ?? null } });
    },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  act(() => root!.render(createElement(AnalyticsTab, { agent: agentFixture("invoice-checker"), v2: v2 as never, now: () => NOW })));
  await settle();
  const tile = (label: string) => [...host.querySelectorAll("li")].find((li) => li.firstElementChild?.textContent === label);
  const rows = (heading: string) => [...([...host.querySelectorAll("section")].find((s) => s.querySelector("h3")?.textContent === heading)?.querySelectorAll("tbody tr") ?? [])].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  const pick = async (range: string) => { await act(async () => { host.querySelector<HTMLInputElement>(`[aria-label="Range"] input[value="${range}"]`)!.click(); }); await settle(); };
  const days = (chart: string) => [...host.querySelectorAll(`[aria-label="${chart}"] [role="listitem"]`)].map((d) => d.getAttribute("aria-label"));
  return { host, asked, tile, rows, pick, days };
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
    expect(tab.tile("Tokens")?.textContent).toBe("Tokens1.3M83% of input cached · 50K outputtokens from 5 of 8 runs2 requests unmetered: in no token sum");
    expect(tab.tile("Run time")?.textContent).toBe("Run time2.5 hwall time of 7 ended runs1.5 h active, over 4 runs");
    expect(tab.tile("Success rate")?.textContent).toBe("Success rate71%5 completed · 2 failed or escalated");
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
    expect(tab.rows("Top tools")).toEqual([["read", "30", "0", "0%"], ["shell", "12", "4", "33%"], ["fetch", "3", "1", "33%"]]);
    const runs = tab.days("Runs per day");
    expect(runs.length).toBe(30);
    expect(runs[0]).toBe("2026-09-16: 0 runs, 0 completed · 0 failed · 0 other");
    expect(runs.at(-7)).toBe("2026-10-09: 3 runs, 2 completed · 1 failed · 0 other");
    expect(tab.days("Tokens per day").at(-1)).toBe("2026-10-15: 0 tokens, tokens from 0 of 2 runs");
    await tab.pick("7d");
    expect(tab.days("Runs per day").length).toBe(7);
  });

  it("says when the agent has no runs in the range, and when the analytics can't be read", async () => {
    const empty = await open(() => ({ ...ANALYTICS, totals: { ...ANALYTICS.totals, runs: 0, completed: 0, failed: 0, runs_with_metrics: 0 }, by_day: [], by_harness_effort: [], tools: [] }));
    expect(empty.host.textContent).toContain("No runs of this agent in this range.");
    act(() => root?.unmount());
    const none = await open(() => undefined);
    expect(none.host.querySelector('[role="alert"]')?.textContent).toBe("The analytics could not be read: this server gives no analytics");
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
