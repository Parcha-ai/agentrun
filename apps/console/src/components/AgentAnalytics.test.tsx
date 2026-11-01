import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsTab } from "./AgentAnalytics";
import { agentFixture } from "@/fixtures";
import type { Analytics } from "@/lib/analytics";
import { ANALYTICS } from "@/lib/analytics.sample";
import { createClient } from "@/lib/client";

// The agent page's Analytics tab: one agent's GET /v2/stats analytics over a range. Coverage is said, unmetered requests
// are named, and a cost or a token count nobody knows reads as unknown, never as 0.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

async function open(answer: (from?: string) => Analytics | undefined = () => ANALYTICS) {
  const asked: (string | undefined)[] = [];
  const v2 = { agentStats: async (id: string, from?: string) => { asked.push(`${id} ${from ?? "all"}`); const analytics = answer(from); return analytics ? { analytics } : {}; } };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  act(() => root!.render(createElement(AnalyticsTab, { agent: agentFixture("invoice-checker"), v2: v2 as never, now: () => NOW })));
  await settle();
  const tile = (label: string) => [...host.querySelectorAll('ul[aria-label="Totals"] li')].find((li) => li.firstElementChild?.textContent === label);
  const rows = (heading: string) => [...([...host.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === heading)?.querySelectorAll("tbody tr") ?? [])].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  const pick = async (label: string) => { await act(async () => { [...host.querySelectorAll('[aria-label="Range"] button')].find((b) => b.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); await settle(); };
  return { host, asked, tile, rows, pick };
}

describe("AnalyticsTab", () => {
  it("reads this agent's analytics over the last 30 UTC days, and the range picker sets from: 7 days, then every run", async () => {
    const tab = await open();
    expect(tab.asked).toEqual(["invoice-checker 2026-09-16T00:00:00.000Z"]);
    expect(tab.host.querySelector('[aria-pressed="true"]')?.textContent).toBe("30 days");
    await tab.pick("7 days");
    await tab.pick("All");
    expect(tab.asked).toEqual(["invoice-checker 2026-09-16T00:00:00.000Z", "invoice-checker 2026-10-09T00:00:00.000Z", "invoice-checker all"]);
    expect(tab.host.querySelector('[aria-pressed="true"]')?.textContent).toBe("All");
  });

  it("shows tokens with the cached share and output, wall and active hours, runs with success, and the cost with the runs it leaves out", async () => {
    const tab = await open();
    expect(tab.tile("Tokens")?.textContent).toBe("Tokens1.3M83% cached · 50K output");
    expect(tab.tile("Wall time")?.textContent).toBe("Wall time2.5 h1.5 h active (4 of 7 runs)");
    expect(tab.tile("Runs")?.textContent).toBe("Runs871% success");
    expect(tab.tile("Cost")?.textContent).toBe("Cost$0.75 est.3 runs unknown");
  });

  it("says plainly when runs have no metrics and when requests are unmetered, and says nothing when every run is covered", async () => {
    const tab = await open();
    const notes = [...tab.host.querySelectorAll('[role="note"]')].map((n) => n.textContent);
    expect(notes).toEqual([
      "Tokens come from 5 of 8 runs: 3 have no metrics (running, or ended without them) and are in no token count.",
      "2 of 40 model requests reported no token counts (cut before the end, or not measured): they are in no token count.",
    ]);
    act(() => root?.unmount());
    const covered = await open(() => ({ ...ANALYTICS, totals: { ...ANALYTICS.totals, runs_with_metrics: 8, unmetered: 0 } }));
    expect(covered.host.querySelectorAll('[role="note"]').length).toBe(0);
  });

  it("never reads an unknown cost or unknown tokens as 0: a group with no metrics says Unknown, and so does a cost nobody knows", async () => {
    const tab = await open();
    expect(tab.rows("By effort")).toEqual([
      ["unset", "3", "50%", "Unknown", "Unknown"],
      ["high", "5", "80%", "1.3M", "$0.75 est."],
    ]);
    act(() => root?.unmount());
    const none = await open(() => ({ ...ANALYTICS, totals: { ...ANALYTICS.totals, runs_with_metrics: 0, tokens: 0, cost_usd: null, unknown_cost_runs: 8 }, by_harness_effort: [ANALYTICS.by_harness_effort[0]!], by_day: [] }));
    expect(none.tile("Tokens")?.textContent).toBe("TokensUnknown");
    expect(none.tile("Cost")?.textContent).toBe("CostUnknown");
    expect(none.host.textContent).not.toContain("$0");
    expect([...none.host.querySelectorAll('[role="note"]')][0]?.textContent).toBe("No run here has metrics yet (8 runs): token counts are unknown, not zero.");
  });

  it("lists the top tools with their error rates, and draws runs per day with a column per day, each named for hover, focus and the table", async () => {
    const tab = await open();
    expect(tab.rows("Top tools")).toEqual([["read", "30", "0", "0%"], ["shell", "12", "4", "33%"], ["fetch", "3", "1", "33%"]]);
    const days = [...tab.host.querySelectorAll('[aria-label="Runs per day"] [role="img"]')];
    expect(days.length).toBe(30);
    expect(days[days.length - 1].getAttribute("aria-label")).toBe("Oct 15: 2 runs, 1 completed, 0 failed, Unknown tokens");
    expect(days[days.length - 7].getAttribute("aria-label")).toBe("Oct 9: 3 runs, 2 completed, 1 failed, 600K tokens");
    await act(async () => { (days[days.length - 7] as unknown as HTMLElement).dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
    expect(tab.host.querySelector('[aria-live="polite"]')?.textContent).toBe("3 runs Oct 9 · 2 completed · 1 failed · 600K tokens");
    const table = tab.rows("Runs per day, last 30 days");
    expect(table.length).toBe(30);
    expect(table[0]).toEqual(["Sep 16", "0", "0", "0", "0"]);
    await tab.pick("7 days");
    expect(tab.host.querySelectorAll('[aria-label="Runs per day"] [role="img"]').length).toBe(7);
  });

  it("says when the agent has no runs in the range, and when the analytics can't be read", async () => {
    const empty = await open(() => ({ ...ANALYTICS, totals: { ...ANALYTICS.totals, runs: 0, completed: 0, failed: 0, runs_with_metrics: 0 }, by_day: [], by_harness_effort: [], tools: [] }));
    expect(empty.host.textContent).toContain("No runs of this agent in this range.");
    act(() => root?.unmount());
    const none = await open(() => undefined);
    expect(none.host.querySelector('[role="alert"]')?.textContent).toBe("The analytics could not be read: this server gives no analytics");
  });
});

describe("the client's agentStats", () => {
  it("asks GET /v2/stats for one agent, with from when a range sets one", async () => {
    const urls: string[] = [];
    const v2 = createClient({ fetch: (async (url: string) => { urls.push(String(url)); return new Response(JSON.stringify({ analytics: ANALYTICS }), { headers: { "content-type": "application/json" } }); }) as typeof fetch });
    expect((await v2.agentStats("invoice-checker", "2026-10-09T00:00:00.000Z")).analytics?.totals.runs).toBe(8);
    await v2.agentStats("invoice-checker");
    expect(urls).toEqual(["/v2/stats?agent=invoice-checker&from=2026-10-09T00%3A00%3A00.000Z", "/v2/stats?agent=invoice-checker"]);
  });
});
