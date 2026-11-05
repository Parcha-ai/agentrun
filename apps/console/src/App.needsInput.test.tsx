import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { ANALYTICS } from "@/components/AgentAnalytics.sample";

// Mission Control's Needs input tile counts exactly what Needs you lists: the runs with a pending ask (any `pending`, a
// question today). A run the person stopped (input_required, idle, pending null) asks nothing: it is not counted, and it
// shows in Recent runs as Stopped, with "send a message to continue". The server's own needs_input counts both.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
vi.setConfig({ testTimeout: 20_000 });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const CAPS = { harnesses: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } };
const run = (id: string, title: string, extra: object) => ({ run_id: id, agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", title, created_at: "2026-11-05T00:30:00Z", ended_at: null, result: null, error: null, cost: null, archived_at: null, ...extra });
const ASKING = run("q1", "Which city do you mean", { status: "input_required", state: "waiting", pending: { kind: "question", question: "Which city do you mean?", asked_at: "2026-11-05T00:31:00Z" } });
const STOPPED = run("s1", "Write five files", { status: "input_required", state: "idle", pending: null });
const STATS = {
  agents: 1, runs: { total: 2, active: 0, needs_input: 2, failed: 0, status_unknown: 0, needs_review: 0 },
  per_agent: [{ agent_id: "calc", name: "Calculator", runs: 2 }], cost: { usd: null, basis: null, unknown_runs: 2 }, archived: { agents: 0, runs: 0 }, analytics: ANALYTICS,
};

function serve({ askingFails = false } = {}) {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(url, "http://serve.test");
    if (u.pathname === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
    if (u.pathname === "/v2/capabilities") return json(200, CAPS);
    if (u.pathname === "/v2/health") return json(200, { status: "ok" });
    if (u.pathname === "/v2/stats") return json(200, STATS);
    if (u.pathname === "/v2/agents") return json(200, { agents: [], next_cursor: null });
    if (u.pathname === "/v2/runs") {
      const status = u.searchParams.get("status");
      if (askingFails && status === "input_required") return json(500, { error: { code: "internal", message: "The store could not be read.", retryable: false } });
      return json(200, { runs: !status || status === "input_required" ? [STOPPED, ASKING] : [], next_cursor: null });
    }
    return json(404, { error: { code: "not_found", message: `no route ${u.pathname}`, retryable: false } });
  });
}
const wait = async (ok: () => boolean, what: string, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ok(), what).toBe(true);
};
const tile = (host: HTMLElement, label: string) => [...host.querySelectorAll("li")].find((li) => li.querySelector("p")?.textContent === label)?.querySelectorAll("p")[1]?.textContent;
const section = (host: HTMLElement, title: string) => [...host.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === title) as HTMLElement | undefined;

describe("Mission Control's Needs input", () => {
  it("one question waiting and one stopped run: the tile reads 1, Needs you lists 1, and the stopped run shows as Stopped in Recent runs", async () => {
    serve();
    location.hash = "#/";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    await wait(() => !!host.textContent?.includes("Which city do you mean?") && !!section(host, "Recent runs"), "Mission Control with its question and its recent runs");
    expect(tile(host, "Needs input")).toBe("1");
    // Needs you lists the one question, and nothing of the stopped run.
    expect(host.querySelectorAll('input[aria-label^="Answer "]').length).toBe(1);
    const stopped = [...(section(host, "Recent runs")?.querySelectorAll("li") ?? [])].find((li) => li.textContent?.includes("Write five files"));
    expect(stopped?.textContent).toContain("Stopped");
    expect(stopped?.textContent).toContain("send a message to continue");
  });

  it("a first read of the questions that fails leaves the tile unknown, never a definite 0", async () => {
    serve({ askingFails: true });
    location.hash = "#/";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    await wait(() => !!section(host, "Recent runs") && !!host.textContent?.includes("could not be read"), "Mission Control, with the questions' read failed");
    expect(tile(host, "Needs input")).toBe("–");
  });
});
