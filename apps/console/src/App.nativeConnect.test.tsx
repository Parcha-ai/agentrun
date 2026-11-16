import { expect, it } from "vitest";
import { route } from "./App";
it("opens the native connection flow from its own address rather than treating connect as an agent id", () => {
  expect(route("#/agents/connect")).toEqual({ section: "agents", nativeConnect: true });
  expect(route("#/agents/connect?source=remote")).toEqual({ section: "agents", nativeConnect: true, connectionSource: "remote" });
  expect(route("#/agents/connect?source=observe")).toEqual({ section: "agents", nativeConnect: true, connectionSource: "observe" });
  expect(route("#/observations/session%2Fa")).toEqual({ section: "agents", observation: "session/a" });
  expect(route("#/agents/connect/runs")).toEqual({ section: "agents", agent: "connect", tab: "runs" });
});

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, vi } from "vitest";
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); location.hash = ""; });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it("runs a verified native connection without requesting a managed model key or promising spend-cap enforcement", async () => {
  const { App } = await import("./App");
  const native = { runtime: "codex", project: "/workspace/app", selector: { kind: "profile", name: "review" }, machine_id: "source", version: "0.167.2", model: "native-model", fingerprint: "abc", configuration: [], skills: [], mcp_servers: [], state: "ready", issues: [], connected: true, capabilities: { launch: true, notes: true, skills: true, workflows: false, approval: "native", usage: true } };
  const agent = { agent_id: "native", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { name: "Native", version: 1, tools: [], skills: [], native } };
  vi.stubGlobal("fetch", async (url: string) => {
    const path = new URL(url, "https://console.example.test").pathname;
    const body = path === "/v2/auth/session" ? { password_set: true, signed_in: true }
      : path === "/v2/capabilities" ? { models: { ready: false, source: "providers", needs: "key" }, harnesses: [], tools: [], features: {} }
      : path === "/v2/agents" ? { agents: [agent], next_cursor: null }
      : path.endsWith("/revisions") ? { revisions: [], next_cursor: null } : { runs: [], next_cursor: null };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  location.hash = "#/playground?agent=native";
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(App)));
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(host.textContent).not.toContain("No model yet");
  expect(host.textContent).toContain("Native spend caps are unavailable");
  expect(host.querySelector('[aria-label="Effort"]')).toBeNull();
  expect(host.textContent).not.toContain("Attach files");
  expect(host.querySelector('input[placeholder="e.g. 0.50"]')).toBeNull();
});
