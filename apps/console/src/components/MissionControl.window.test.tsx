import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MissionView } from "@/lib/mission";
import { MissionControl } from "./MissionControl";
import { NeedsYouStrip, type NeedsYouProps } from "./NeedsYouStrip";
import type { Run } from "@/lib/v2";

// A count among Mission Control's tiles and the list in Needs you beside it count the same runs, and say which:
// - Failed: GET /v2/stats `runs.failed` counts every failed run (imported ones too); Needs you lists the failures of the
//   last 24 h (a client filter of GET /v2/runs?status=failed, imported history left out). The tile counts what the list
//   lists, says the window, and links to all of them with the server's count.
// - Active: `runs.active` counts the queued, working and paused runs this server holds; Running now lists the working
//   ones (GET /v2/runs?status=working). Where they differ, the tile says how many are running now.
const analytics = { filter: { from: null, to: null, agent: null }, totals: { runs: 0, completed: 0, failed: 0, needs_review: 0, runs_with_metrics: 0, tokens: 0, cost_usd: 0, unknown_cost_runs: 0, input: 0, cache_read: 0, cache_write: 0, output: 0, requests: 0, unmetered: 0 }, time: { ended_runs: 0, wall_ms: 0, active_runs: 0, active_ms: 0 }, by_harness_effort: [], by_day: [], by_source: [], tools: [] } as unknown as MissionView["analytics"];
const view = (runs: Partial<MissionView["runs"]>): MissionView => ({
  agents: 2, runs: { total: 20, active: 0, needsInput: 0, failed: 10, statusUnknown: 0, needsReview: 0, ...runs },
  perAgent: [], cost: { usd: null, basis: null, unknownRuns: 0 }, recent: [], analytics,
});
const host = (el: ReturnType<typeof createElement>) => { const d = document.createElement("div"); d.innerHTML = renderToStaticMarkup(el); return d; };
const tile = (d: HTMLElement, label: RegExp) => [...d.querySelectorAll("li")].find((li) => label.test(li.querySelector("p")?.textContent ?? "")) as HTMLElement | undefined;

describe("Mission Control's tiles and Needs you count the same runs", () => {
  it("Failed counts the last 24 h's failures Needs you lists, says so, and links to all of them with the server's count", () => {
    const d = host(createElement(MissionControl, { view: view({ failed: 10 }), failed: 4 } as never));
    const t = tile(d, /^Failed/)!;
    expect(t.querySelector("p")?.textContent).toBe("Failed · last 24 h");
    expect(t.querySelectorAll("p")[1]?.textContent).toBe("4");
    expect(t.textContent).toContain("See all 10");
    expect(t.querySelector("a")?.getAttribute("href")).toBe("#/runs?status=failed");
  });

  it("Failed reads a dash while the failures are still being read, never the server's all-time count", () => {
    const t = tile(host(createElement(MissionControl, { view: view({ failed: 10 }), failed: null } as never)), /^Failed/)!;
    expect(t.querySelectorAll("p")[1]?.textContent).toBe("–");
  });

  it("Active says how many of its runs are running now, as Running now lists them, when that differs", () => {
    const three = tile(host(createElement(MissionControl, { view: view({ active: 3 }), live: 1 } as never)), /^Active/)!;
    expect(three.textContent).toContain("1 running now");
    const same = tile(host(createElement(MissionControl, { view: view({ active: 1 }), live: 1 } as never)), /^Active/)!;
    expect(same.textContent).not.toContain("running now");
  });

  it("Needs you's Failed says its window, and links to all the failed runs with the server's count", () => {
    const at = Date.now();
    const failed = [1, 2].map((i): Run => ({ run_id: `f${i}`, agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status: "failed", state: "idle", title: `Run ${i}`, created_at: new Date(at - 60_000).toISOString(), ended_at: new Date(at - 30_000).toISOString(), result: null, error: { code: "run_failed", message: `boom ${i}`, retryable: false }, cost: null, archived_at: null }));
    const p: NeedsYouProps = { asking: [], failed, live: [], agentName: (id) => id, onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null };
    const d = host(createElement(NeedsYouStrip, { ...p, failedAll: 10 } as never));
    const head = [...d.querySelectorAll("p")].find((x) => /^Failed/.test(x.textContent ?? ""))!;
    expect(head.querySelector("span")?.textContent).toBe("Failed in the last 24 h · 2");
    const all = head.querySelector('a[href="#/runs?status=failed"]');
    expect(all?.textContent).toBe("All 10 failed runs →");
  });
});
