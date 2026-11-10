import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";
import { optionsOf, pick } from "@/test/picker";

// Mission Control with an agent picked over its analytics: every figure below the picker follows it. "Runs per agent"
// shows that agent's row alone and "Recent runs" that agent's runs alone, read from its own runs; with All agents both
// are as before. The picker itself still offers every agent.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
vi.setConfig({ testTimeout: 20_000 });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } };
const run = (id: string, agent: string, title: string) => ({ run_id: id, agent_id: agent, agent_version: 1, revision: "rv1", kind: "agentic", status: "completed", state: "idle", title, created_at: "2026-11-04T06:00:00Z", ended_at: "2026-11-04T06:00:05Z", result: null, error: null, cost: null, archived_at: null });
const NOTES = [run("n1", "notes", "Notes run one"), run("n2", "notes", "Notes run two")];
const CALC = [run("c1", "calc", "Calc run one")];
const STATS = {
  agents: 2, runs: { total: 3, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 },
  per_agent: [{ agent_id: "calc", name: "Calculator", runs: 1 }, { agent_id: "notes", name: "Notes hand", runs: 2 }],
  cost: { usd: null, basis: null, unknown_runs: 3 }, archived: { agents: 0, runs: 0 }, analytics: ANALYTICS,
};

function serve() {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://serve.test");
    asked.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, CAPS);
    if (u.pathname === "/v2/health") return json(200, { status: "ok" });
    if (u.pathname === "/v2/stats") return json(200, STATS);
    if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
    if (u.pathname === "/v2/runs") return json(200, { runs: u.searchParams.get("status") ? [] : [...NOTES, ...CALC], next_cursor: null });
    if (u.pathname === "/v2/agents/notes/runs") return json(200, { runs: NOTES, next_cursor: null });
    if (u.pathname === "/v2/agents/calc/runs") return json(200, { runs: CALC, next_cursor: null });
    return json(404, { error: { code: "not_found", message: `no route ${u.pathname}`, retryable: false } });
  });
  return asked;
}
function mount() {
  location.hash = "#/";
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(App)));
  return host;
}
const wait = async (ok: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
};
const section = (host: HTMLElement, title: string) => [...host.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === title) as HTMLElement | undefined;
const rows = (s: HTMLElement | undefined) => [...(s?.querySelectorAll("li") ?? [])].map((li) => li.textContent ?? "");
const pickAgent = async (host: HTMLElement, value: string) => {
  const select = host.querySelector('button[aria-haspopup=listbox][aria-label="Agent"]') as HTMLButtonElement;
  await pick(select, value);
};

describe("Mission Control's agent picker scopes every figure below it", () => {
  it("an agent picked: Runs per agent shows its row alone, Recent runs its runs alone (read from its own runs), and the picker still offers every agent", async () => {
    const asked = serve();
    const host = mount();
    await wait(() => !!host.querySelector('button[aria-haspopup=listbox][aria-label="Agent"]') && rows(section(host, "Recent runs")).length === 3, "Mission Control with its picker and all three recent runs");
    await pickAgent(host, "notes");
    await wait(() => asked.some((a) => a.startsWith("GET /v2/stats?") && a.includes("agent=notes")), "the stats are read for the agent picked");
    await wait(() => rows(section(host, "Recent runs")).length === 2, "Recent runs shows the agent's runs alone");
    expect(asked).toContain("GET /v2/agents/notes/runs?limit=10");
    const recent = rows(section(host, "Recent runs"));
    expect(recent.some((r) => r.includes("Notes run one"))).toBe(true);
    expect(recent.some((r) => r.includes("Calc run one"))).toBe(false);
    const perAgent = rows(section(host, "Runs per agent"));
    expect(perAgent).toHaveLength(1);
    expect(perAgent[0]).toContain("Notes hand");
    const options = (await optionsOf((host.querySelector('button[aria-haspopup=listbox][aria-label="Agent"]') as HTMLButtonElement))).map((o) => o.text);
    expect(options).toEqual(["All agents", "Calculator", "Notes hand"]);
  });

  it("All agents: Runs per agent and Recent runs list every agent, as before", async () => {
    const asked = serve();
    const host = mount();
    await wait(() => !!host.querySelector('button[aria-haspopup=listbox][aria-label="Agent"]') && rows(section(host, "Recent runs")).length === 3, "Mission Control with its picker and all three recent runs");
    await pickAgent(host, "notes");
    await wait(() => asked.some((a) => a.startsWith("GET /v2/stats?") && a.includes("agent=notes")), "the stats are read for the agent picked");
    await pickAgent(host, "");
    await wait(() => rows(section(host, "Recent runs")).length === 3 && rows(section(host, "Runs per agent")).length === 2, "back to every agent");
    expect(rows(section(host, "Runs per agent")).map((r) => r.replace(/\d+$/, ""))).toEqual(["Calculator", "Notes hand"]);
    expect(rows(section(host, "Recent runs")).some((r) => r.includes("Calc run one"))).toBe(true);
  });
});
