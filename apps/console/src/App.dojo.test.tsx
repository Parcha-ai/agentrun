import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("App Learning Dojo", () => {
  it("opens actual learning without a provider key and keeps the learning link on the same agent", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = new URL(url, "https://console.example.test");
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if (u.pathname === "/v2/auth/session") return json({ password_set: true, signed_in: true });
      if (u.pathname === "/v2/setup/import") return json({ offer: false });
      if (u.pathname === "/v2/capabilities") return json({ harnesses: [], models: { ready: false, needs: "key" }, features: { learning: "on", messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
      if (u.pathname === "/v2/agents") return json({ agents: u.searchParams.has("archived") ? [] : [{ agent_id: "support agent", kind: "agentic", revision: "1", revisions: 1, archived_at: null, definition: { version: 1, name: "Support agent", learning: true, tools: [], skills: [] } }], next_cursor: null });
      if (u.pathname === "/v2/agents/support%20agent/learning") return json({ agent: "support agent", main: null, index: "", notes: { items: [], total: 0, next_cursor: null }, skills: [], workflows: [], log: { items: [], total: 0, next_cursor: null }, counts: { merged: 3, dropped: { empty: 1 }, in_progress: 0 } });
      return json({ error: { code: "not_found", message: "No route", retryable: false } }, 404);
    });
    location.hash = "#/dojo";
    const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
    act(() => root!.render(createElement(App)));
    for (let i = 0; i < 40 && !host.textContent?.includes("3 runs kept learning"); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(host.querySelector("h1")?.textContent).toBe("Learning Dojo");
    expect(host.querySelector('nav [aria-current="page"]')?.textContent?.trim()).toBe("Learning Dojo");
    expect(host.textContent).toContain("3 runs kept learning");
    expect(host.querySelector('a[href="#/agents/support%20agent/learning"]')).not.toBeNull();
    expect(host.textContent).not.toMatch(/Add a model key|Generate key|Demo/);
    expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
    expect(calls).not.toContain("GET /v2/runs");
  });
});
