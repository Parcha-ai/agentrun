import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { rangeFrom } from "@/lib/mission";
import { pick } from "@/test/picker";

// The page asks GET /v2/stats for the range picked (30 days first), and again for another range or one agent.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const group = { runs: 1, completed: 1, failed: 0, needs_review: 0, runs_with_metrics: 1, tokens: 1000, cost_usd: 0.01, unknown_cost_runs: 0 };
const stats = () => ({
  agents: 1, runs: { total: 1, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 }, per_agent: [{ agent_id: "calc", name: "Calc", runs: 1 }],
  cost: { usd: 0.01, basis: "estimate", unknown_runs: 0 }, archived: { agents: 0, runs: 0 },
  analytics: {
    filter: { from: null, to: null, agent: null },
    totals: { ...group, input: 500, cache_read: 300, cache_write: 0, output: 200, requests: 2, unmetered: 0 },
    time: { ended_runs: 1, wall_ms: 60_000, active_runs: 0, active_ms: 0 },
    by_harness_effort: [{ harness: "pi", effort: null, ...group }], by_day: [{ day: new Date().toISOString().slice(0, 10), ...group }], by_source: [{ source: "live", ...group }], tools: [],
  },
});

async function open() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    if (u.pathname === "/v2/stats") asked.push(u.search);
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (u.pathname === "/v2/stats") return json(200, stats());
    if (u.pathname === "/v2/runs" || u.pathname === "/v2/agents") return json(200, { runs: [], agents: [], next_cursor: null });
    return json(404, { error: { code: "not_found", message: u.pathname, retryable: false } });
  });
  location.hash = "";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  const wait = async (ok: () => boolean) => { const end = Date.now() + 4000; while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); }); expect(ok()).toBe(true); };
  await wait(() => !!host.textContent?.includes("Needs input"));
  return { host, asked, wait };
}

describe("Mission Control's range, against the server", () => {
  it("asks for the last 30 days first, then 7 days, then all, then one agent's runs", async () => {
    const { host, asked, wait } = await open();
    const from = (search: string) => new URLSearchParams(search).get("from");
    expect(from(asked[0]!)).toBe(rangeFrom("30d"));
    const radio = (id: string) => host.querySelector(`input[type=radio][value='${id}']`) as HTMLInputElement;
    await act(async () => { radio("7d").click(); });
    await wait(() => asked.length === 2);
    expect(from(asked[1]!)).toBe(rangeFrom("7d"));
    await act(async () => { radio("all").click(); });
    await wait(() => asked.length === 3);
    expect(asked[2]).toBe("");
    const select = host.querySelector("button[aria-haspopup=listbox][aria-label='Agent']") as HTMLButtonElement;
    await pick(select, "calc");
    await wait(() => asked.length === 4);
    expect(asked[3]).toBe("?agent=calc");
  });

});
