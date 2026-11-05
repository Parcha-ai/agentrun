import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

// The agent page's Latest run box: "Open the run" is the main way into the run, so it is a button like the page's Edit,
// bordered and square, with the same class, not small grey text on the date's row.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

describe("the agent page's Latest run", () => {
  it("offers Open the run as a button with the Edit button's class", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const calc = { agent_id: "calc", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] } };
    const run = { run_id: "r1", agent_id: "calc", agent_version: 1, revision: "r1", kind: "agentic", status: "completed", state: "idle", title: "What is two and two?", created_at: "2026-10-30T06:00:00Z", ended_at: "2026-10-30T06:00:03Z", result: { final_answer: "4" }, error: null, cost: null, archived_at: null };
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url, "http://serve.test").pathname;
      if (path === "/v2/auth/session") return json(200, { password_set: true, signed_in: true });
      if (path === "/v2/capabilities") return json(200, { harnesses: [{ id: "pi", available: true }], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (path === "/v2/agents") return json(200, { agents: [calc], next_cursor: null });
      if (path === "/v2/agents/calc") return json(200, calc);
      if (path === "/v2/agents/calc/runs" || path === "/v2/runs") return json(200, { runs: [run], next_cursor: null });
      if (path === "/v2/agents/calc/revisions") return json(200, { revisions: [], next_cursor: null });
      if (path === "/v2/runs/r1") return json(200, run);
      if (path === "/v2/runs/r1/timeline") return json(200, { run_id: "r1", status: "completed", state: "idle", rows: [], drop: [], reset: true, unchanged: false, final: true, has_more: false, next_after: 1 });
      return json(404, { error: { code: "not_found", message: path, retryable: false } });
    });
    location.hash = "#/agents/calc";
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(App)));
    const open = () => [...host.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Open the run");
    const end = Date.now() + 4000;
    while (!open() && Date.now() < end) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    const edit = [...host.querySelectorAll("header button")].find((b) => b.textContent?.trim() === "Edit");
    expect(open()?.getAttribute("href")).toBe("#/runs/r1");
    expect(edit).toBeTruthy();
    expect(open()!.className.split(" ").sort()).toEqual(edit!.className.split(" ").sort());
  });
});
