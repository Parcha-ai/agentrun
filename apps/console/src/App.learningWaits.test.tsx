import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

// Mission Control's Needs you lists each active agent whose learned items wait for the owner's OK, from GET /v2/agents
// (each agent's `learning.pending`): absent or 0 lists nothing, and an archived agent is not listed.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
vi.setConfig({ testTimeout: 20_000 });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } };
const agent = (id: string, name: string, extra: object = {}) => ({ agent_id: id, kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name, instructions: "Answer.", harness: "pi", skills: [], tools: [], learning: true }, ...extra });
const ACTIVE = [agent("qa-learn", "QA learn", { learning: { pending: 2 } }), agent("calc", "Calc", { learning: { pending: 0 } }), agent("off", "Learning off")];
const ARCHIVED = [agent("gone", "Gone", { archived_at: "2026-11-05T00:00:00Z", learning: { pending: 4 } })];
const STATS = {
  agents: 3, runs: { total: 1, active: 0, needs_input: 0, failed: 0, status_unknown: 0, needs_review: 0 },
  per_agent: [{ agent_id: "qa-learn", name: "QA learn", runs: 1 }], cost: { usd: null, basis: null, unknown_runs: 1 }, archived: { agents: 1, runs: 0 }, analytics: ANALYTICS,
};
const DONE = { run_id: "r1", agent_id: "qa-learn", agent_version: 1, revision: "r1", kind: "agentic", title: "Find the policy", status: "completed", state: "idle", created_at: "2026-11-05T00:30:00Z", ended_at: "2026-11-05T00:31:00Z", result: null, error: null, cost: null, archived_at: null };

function serve() {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, CAPS);
    if (u.pathname === "/v2/health") return json(200, { status: "ok" });
    if (u.pathname === "/v2/stats") return json(200, STATS);
    if (u.pathname === "/v2/agents") return json(200, { agents: u.searchParams.get("archived") === "true" ? ARCHIVED : ACTIVE, next_cursor: null });
    if (u.pathname === "/v2/runs") return json(200, { runs: u.searchParams.get("status") ? [] : [DONE], next_cursor: null });
    return json(404, { error: { code: "not_found", message: `no route ${u.pathname}`, retryable: false } });
  });
}
const wait = async (ok: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
};

describe("Mission Control's Needs you, learned items waiting", () => {
  it("lists the active agent whose items wait, linked to its Learning tab; not one at 0, without the field, or archived", async () => {
    serve();
    location.hash = "#/";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const needs = () => host.querySelector('section[aria-label="Needs you"]');
    await wait(() => !!needs()?.querySelector('a[href="#/agents/qa-learn/learning"]'), "Needs you with QA learn's waiting items");
    expect(needs()!.querySelector("h2")?.textContent).toBe("Needs you · 2");
    expect(needs()!.querySelector('a[href="#/agents/qa-learn/learning"]')!.closest("li")?.textContent).toContain("2 learned items wait for your OK");
    for (const id of ["calc", "off", "gone"]) expect(needs()!.querySelector(`a[href="#/agents/${id}/learning"]`), id).toBeNull();
  });
});
