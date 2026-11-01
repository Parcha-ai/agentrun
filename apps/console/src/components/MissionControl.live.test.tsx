import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { rangeFrom } from "@/lib/mission";

// The page asks GET /v2/stats for the range picked (30 days first), and again for another range or one agent; an older
// server's answer, with no analytics, shows the page with no picker.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const group = { runs: 1, completed: 1, failed: 0, runs_with_metrics: 1, tokens: 1000, cost_usd: 0.01, unknown_cost_runs: 0 };
const stats = (analytics: boolean) => ({
  agents: 1, runs: { total: 1, active: 0, needs_input: 0, failed: 0, status_unknown: 0 }, per_agent: [{ agent_id: "calc", name: "Calc", runs: 1 }],
  cost: { usd: 0.01, basis: "estimate", unknown_runs: 0 }, archived: { agents: 0, runs: 0 },
  ...(analytics ? { analytics: {
    filter: { from: null, to: null, agent: null },
    totals: { ...group, input: 500, cache_read: 300, cache_write: 0, output: 200, requests: 2, unmetered: 0 },
    time: { ended_runs: 1, wall_ms: 60_000, active_runs: 0, active_ms: 0 },
    by_harness_effort: [{ harness: "pi", effort: null, ...group }], by_day: [{ day: new Date().toISOString().slice(0, 10), ...group }], by_source: [{ source: "live", ...group }], tools: [],
  } } : {}),
});

async function open(analytics: boolean) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    if (u.pathname === "/v2/stats") asked.push(u.search);
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (u.pathname === "/v2/stats") return json(200, stats(analytics));
    if (u.pathname === "/v2/runs" || u.pathname === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
  });
  location.hash = "";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const wait = async (ok: () => boolean) => { const end = Date.now() + 4000; while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); expect(ok()).toBe(true); };
  await wait(() => !!host.textContent?.includes("Total cost"));
  return { host, asked, wait };
}

describe("Mission Control's range, against the server", () => {
  it("asks for the last 30 days first, then 7 days, then all, then one agent's runs", async () => {
    const { host, asked, wait } = await open(true);
    const from = (search: string) => new URLSearchParams(search).get("from");
    expect(from(asked[0]!)).toBe(rangeFrom("30d"));
    const radio = (label: string) => [...host.querySelectorAll("[role=radio]")].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => { radio("7 days").click(); });
    await wait(() => asked.length === 2);
    expect(from(asked[1]!)).toBe(rangeFrom("7d"));
    await act(async () => { radio("All").click(); });
    await wait(() => asked.length === 3);
    expect(asked[2]).toBe("");
    const select = host.querySelector("select[aria-label='Agent']") as HTMLSelectElement;
    await act(async () => { select.value = "calc"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await wait(() => asked.length === 4);
    expect(asked[3]).toBe("?agent=calc");
  });

  it("an older server's answer, with no analytics, shows the page with no picker", async () => {
    const { host } = await open(false);
    expect(host.querySelector("[role=radiogroup]")).toBeNull();
    expect(host.querySelector("[aria-label='Analytics']")).toBeNull();
  });
});
