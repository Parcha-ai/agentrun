import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "@/App";
import { agentFixture } from "@/fixtures";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import type { Client } from "@/lib/client";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";
import type { NativeBinding } from "@/lib/native";
import { AgentPage, agentHash } from "./AgentPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
let root: Root | undefined;
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  document.body.innerHTML = ""; localStorage.clear(); vi.unstubAllGlobals();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else Reflect.deleteProperty(navigator, "clipboard");
  location.hash = "";
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const managed: Agent = { ...SERVED_AGENT, agent_id: "inspect/a + b", kind: "agentic", revision: "r2", revisions: 2, archived_at: null,
  definition: { version: 2, name: "Inspector", instructions: "Current instructions.", harness: "pi", skills: [], tools: [] } };
const native: NativeBinding = {
  runtime: "claude-code", machine_id: "source-machine", project: "/workspace/project", selector: { kind: "project" }, state: "ready",
  version: "1.0.0", model: "claude-test", fingerprint: "editor-route-fixture", configuration: [], skills: [], mcp_servers: [], issues: [],
  connected: true, verified_at: "2026-11-12T00:00:00Z",
  capabilities: { launch: true, learning: true, workflows: false, approval: "native", usage: true },
};
const revisions = (agent: Agent) => [
  { revision: "r2", version: 2, created_at: "2026-11-12T00:00:00Z", current: agent.revision === "r2", note: "Current revision", definition: managed.definition },
  { revision: "r1", version: 1, created_at: "2026-11-11T00:00:00Z", current: agent.revision === "r1", note: "Earlier revision", definition: { ...managed.definition, version: 1, instructions: "Earlier instructions." } },
];
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const settle = async () => { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); }); };
async function until(ok: () => boolean) {
  const end = Date.now() + 4000;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(ok()).toBe(true);
}
async function openApp(archived = false) {
  let current: Agent = { ...managed, archived_at: archived ? "2026-11-13T00:00:00Z" : null };
  const writes: { method: string; path: string; body: unknown }[] = [];
  const path = `/v2/agents/${encodeURIComponent(current.agent_id)}`;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const at = new URL(url, "http://serve.test").pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, path: at, body: JSON.parse(String(init?.body)) });
      if (method === "POST" && at === `${path}/current`) {
        expect(archived).toBe(false);
        expect(writes.at(-1)?.body).toEqual({ revision: "r1" });
        current = { ...current, revision: "r1", definition: revisions(current)[1].definition };
        return json(current);
      }
      return json({ error: { code: "unexpected_write", message: at, retryable: false } }, 400);
    }
    if (at === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    if (at === "/v2/capabilities") return json({ models: { source: "providers", ready: true }, harnesses: [{ id: "pi", available: true }], tools: [], features: { messages: { steer: false, answer: true, follow_up: true, steer_workflow_runs: false } } });
    if (at === "/v2/agents") return json({ agents: [current], next_cursor: null });
    if (at === path) return json(current);
    if (at === `${path}/revisions`) return json({ revisions: revisions(current), next_cursor: null });
    if (at === `${path}/runs` || at === "/v2/runs") return json({ runs: [], next_cursor: null });
    if (at === "/v2/computers") return json({ kinds: [] });
    if (at === "/v2/settings/tools") return json({});
    return json({ error: { code: "not_found", message: at, retryable: false } }, 404);
  });
  location.hash = agentHash(current.agent_id, "versions");
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  await until(() => !!host.querySelector('section[aria-label="Agent versions"] table'));
  return { host, writes, path };
}

describe("AgentPage detailed editor navigation", () => {
  it("opens the existing detailed editor visibly from Versions and makes a selected saved revision current only on request", async () => {
    const { host, writes, path } = await openApp();
    expect(button(host, "Choose coding agent for Edit agent")).toBeTruthy();
    const versions = host.querySelector<HTMLElement>('section[aria-label="Agent versions"]')!;
    expect(button(versions, "Make current")).toBeUndefined();
    await act(async () => button(versions, "View configuration for version 1")!.click());
    expect(versions.querySelector("pre")?.textContent).toContain("Earlier instructions.");
    expect(versions.querySelector("input, textarea")).toBeNull();
    expect(writes).toEqual([]);
    const edit = button(host, "Detailed editor");
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    await until(() => !!host.querySelector("#agent-name"));
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/edit");
    expect(writes).toEqual([]);
    const history = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.querySelector("span.caps")?.textContent?.trim() === "History");
    expect(history).toBeTruthy();
    await act(async () => history!.click());
    const makeCurrent = button(host, "Make current");
    expect(makeCurrent?.disabled).toBe(false);
    await act(async () => makeCurrent!.click());
    await until(() => !!host.querySelector('[aria-label="About this agent"]')?.textContent?.includes("rev 1 current"));
    expect(writes).toEqual([{ method: "POST", path: `${path}/current`, body: { revision: "r1" } }]);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Earlier instructions.");
  });

  it("retains detailed-editor access for an archived managed agent without offering Run or performing a write", async () => {
    const { host, writes } = await openApp(true);
    expect(button(host, "Choose coding agent for Run agent")).toBeUndefined();
    const edit = button(host, "Detailed editor");
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    await until(() => !!button(host, "Unarchive"));
    expect(location.hash).toBe("#/agents/inspect%2Fa%20%2B%20b/edit");
    expect(writes).toEqual([]);
  });

  for (const [name, binding, expected] of [
    ["native", { native }, "Edit the original native setup"],
    ["claude-agent-sdk", { sdk: { runtime: "claude-agent-sdk" as const } }, "using Claude Agent SDK"],
    ["codex-sdk", { sdk: { runtime: "codex-sdk" as const } }, "using Codex SDK"],
  ] as const) {
    it(`keeps ${name} editing source-owned and its Versions view read-only`, async () => {
      const agent = { ...managed, definition: { ...managed.definition, ...binding } };
      const writes = vi.fn(async () => { throw new Error("Inspecting or copying must not dispatch"); });
      const copied = vi.fn(async (_text: string) => {});
      const go = vi.fn();
      const v2 = { getAgent: async () => ({ agent, etag: null }), statsOver: async () => { throw new Error("No analytics"); }, listAgentRuns: async () => ({ runs: [], next_cursor: null }), listRevisions: async () => ({ revisions: [{ ...revisions(agent)[0], definition: agent.definition }], next_cursor: null }), updateDefinition: writes, setCurrent: writes, startRun: writes } as unknown as Client;
      localStorage.setItem(CODING_AGENT_PREFERENCE, "other");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
      const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
      await act(async () => root!.render(createElement(AgentPage, { v2, agentId: agent.agent_id, go, tab: "versions" })));
      await settle();
      expect(button(host, "Detailed editor")).toBeUndefined();
      expect(button(host, "Make current")).toBeUndefined();
      expect(button(host, "Choose coding agent for Edit agent")).toBeTruthy();
      await act(async () => button(host, "View configuration for version 2")!.click());
      expect(host.querySelector('section[aria-label="Agent versions"] pre')?.textContent).toBe(JSON.stringify(agent.definition, null, 2));
      await act(async () => button(host, "Edit agent")!.click());
      expect(copied.mock.calls.at(-1)?.[0]).toContain(expected);
      expect(copied.mock.calls.at(-1)?.[0]).toContain(JSON.stringify(agent.agent_id));
      expect(copied.mock.calls.at(-1)?.[0]).not.toContain("agents_revise");
      expect(writes).not.toHaveBeenCalled(); expect(go).not.toHaveBeenCalled();
    });
  }

  it("opens a managed workflow's detailed editor through the supplied navigation callback", async () => {
    const agent = agentFixture("lead-scorer");
    const go = vi.fn();
    const v2 = { getAgent: async () => ({ agent, etag: null }), statsOver: async () => { throw new Error("No analytics"); }, listAgentRuns: async () => ({ runs: [], next_cursor: null }) } as unknown as Client;
    const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
    await act(async () => root!.render(createElement(AgentPage, { v2, agentId: agent.agent_id, go })));
    await settle();
    const edit = button(host, "Detailed editor");
    expect(edit).toBeTruthy();
    await act(async () => edit!.click());
    expect(go).toHaveBeenCalledExactlyOnceWith("#/agents/lead-scorer/edit");
  });
});
