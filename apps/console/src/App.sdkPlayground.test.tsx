import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });

it("shows the SDK backend's run handoff without requesting a managed model key or dispatching a managed run", async () => {
  const agent = { agent_id: "sdk", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
    definition: { name: "SDK backend", version: 1, tools: [], skills: [], sdk: { runtime: "codex-sdk" } } };
  const starts: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "https://console.example.test").pathname;
    if (init?.method === "POST") starts.push(path);
    const body = path === "/v2/auth/session" ? { password_set: true, signed_in: true }
      : path === "/v2/capabilities" ? { models: { ready: false, source: "providers", needs: "key" }, harnesses: [], tools: [], features: {} }
      : path === "/v2/agents" ? { agents: [agent], next_cursor: null }
      : path.endsWith("/revisions") ? { revisions: [], next_cursor: null } : { runs: [], next_cursor: null };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  location.hash = "#/playground?agent=sdk";
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(host.textContent).toContain("Your backend");
  expect(host.querySelector('[aria-label="Run agent options"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="No model"]')).toBeNull();
  expect([...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Send request")).toBe(false);
  expect(starts).toEqual([]);
});
