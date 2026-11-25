import { SERVED_AGENT } from "@/test/agent";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/lib/agentForm";
import type { Client } from "@/lib/client";
import type { NativeBinding } from "@/lib/native";
import { AgentPage } from "./AgentPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
const native: NativeBinding = {
  runtime: "claude-code", machine_id: "source-machine", project: "/workspace/project", selector: { kind: "project" }, state: "ready",
  version: "1.0.0", model: "claude-test", fingerprint: "connected-settings-fixture", configuration: [], skills: [], mcp_servers: [], issues: [],
  connected: true, verified_at: "2026-11-12T00:00:00Z",
  capabilities: { launch: true, learning: true, workflows: false, approval: "native", usage: true },
};
const connections = [
  ["native", { native }],
  ["claude-agent-sdk", { sdk: { runtime: "claude-agent-sdk" as const } }],
  ["codex-cli", { cli_learning: { runtime: "codex" as const, connection_id: "cli-fixture", project: "/workspace/project" } }],
  ["codex-sdk", { sdk: { runtime: "codex-sdk" as const } }],
] as const;
const button = (host: HTMLElement, name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(control => (control.getAttribute("aria-label") ?? control.textContent?.trim()) === name);
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function mount(binding: typeof connections[number][1], archived = false) {
  const agent: Agent = { ...SERVED_AGENT, agent_id: "connected/a + b", kind: "agentic", revision: "r2", revisions: 2,
    archived_at: archived ? "2026-11-13T00:00:00Z" : null,
    definition: { version: 2, name: "Connected agent", instructions: "Owned by the source.", tools: [], skills: [], ...binding } };
  const getAgent = vi.fn(async () => ({ agent, etag: null }));
  const archiveAgent = vi.fn<(...args: string[]) => Promise<Agent>>();
  const unarchiveAgent = vi.fn<(...args: string[]) => Promise<Agent>>();
  const managedWrite = vi.fn(async () => { throw new Error("Connected settings cannot edit a managed revision"); });
  const renderEditor = vi.fn(() => createElement("p", null, "Unexpected managed editor"));
  const v2 = { getAgent, archiveAgent, unarchiveAgent, updateDefinition: managedWrite, setCurrent: managedWrite, startRun: managedWrite,
    statsOver: async () => { throw new Error("No analytics"); }, listAgentRuns: async () => ({ runs: [], next_cursor: null }),
  } as unknown as Client;
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(AgentPage, { v2, agentId: agent.agent_id, go: vi.fn(), tab: "settings", renderEditor })));
  await settle();
  const panel = host.querySelector<HTMLElement>('[role="region"][aria-label="Agent settings"]')!;
  expect(panel).toBeTruthy();
  return { host, panel, agent, getAgent, archiveAgent, unarchiveAgent, managedWrite, renderEditor };
}

describe("connected agent Settings archive lifecycle", () => {
  for (const [name, binding] of connections) {
    it(`archives and restores ${name} from Settings, retaining a committed change when refresh fails`, async () => {
      const { host, panel, agent, getAgent, archiveAgent, unarchiveAgent, managedWrite, renderEditor } = await mount(binding);
      const archive = button(panel, "Archive");
      expect(archive).toBeTruthy();
      expect(archive?.textContent?.trim()).toBe("");
      expect(archive?.getAttribute("title")).toBe("Archive");
      expect(panel.querySelector('[aria-label="About this agent"]')?.contains(archive!)).toBe(false);
      expect(panel.querySelector("header")?.lastElementChild).toBe(archive);
      expect(archive?.classList.contains("ml-auto")).toBe(true);
      const pending = deferred<Agent>();
      archiveAgent.mockReturnValueOnce(pending.promise);
      getAgent.mockRejectedValueOnce(new Error("Refresh unavailable"));
      await act(async () => { archive!.click(); archive!.click(); });
      expect(archiveAgent).toHaveBeenCalledExactlyOnceWith(agent.agent_id);
      expect(button(panel, "Archiving…")?.disabled).toBe(true);
      const archived = { ...agent, archived_at: "2026-11-13T00:00:00Z" };
      await act(async () => pending.resolve(archived));
      await settle();
      expect(button(panel, "Unarchive")?.disabled).toBe(false);
      expect(button(host, "Run agent")).toBeUndefined();
      expect(panel.textContent).toContain("Couldn't refresh this agent.");
      getAgent.mockResolvedValueOnce({ agent: archived, etag: null });
      await act(async () => button(panel, "Retry")!.click());
      await settle();
      expect(panel.textContent).not.toContain("Couldn't refresh this agent.");
      expect(button(panel, "Unarchive")).toBeTruthy();
      unarchiveAgent.mockResolvedValueOnce(agent);
      getAgent.mockResolvedValueOnce({ agent, etag: null });
      await act(async () => button(panel, "Unarchive")!.click());
      await settle();
      expect(unarchiveAgent).toHaveBeenCalledExactlyOnceWith(agent.agent_id);
      expect(button(panel, "Archive")?.disabled).toBe(false);
      expect(button(host, "Run agent")).toBeTruthy();
      expect(managedWrite).not.toHaveBeenCalled();
      expect(renderEditor).not.toHaveBeenCalled();
    });
  }

  for (const archived of [false, true]) {
    it(`keeps the ${archived ? "Unarchive" : "Archive"} action available after a failed mutation`, async () => {
      const { panel, agent, getAgent, archiveAgent, unarchiveAgent, managedWrite } = await mount(connections[0][1], archived);
      const action = archived ? "Unarchive" : "Archive";
      const mutation = archived ? unarchiveAgent : archiveAgent;
      mutation.mockRejectedValueOnce(new Error("The connection could not be updated."));
      expect(button(panel, action)).toBeTruthy();
      await act(async () => button(panel, action)!.click());
      await settle();
      expect(mutation).toHaveBeenCalledExactlyOnceWith(agent.agent_id);
      expect(panel.querySelector('[role="alert"]')?.textContent).toContain(`${action} did not finish`);
      expect(button(panel, action)?.disabled).toBe(false);
      expect(button(panel, archived ? "Archive" : "Unarchive")).toBeUndefined();
      expect(getAgent).toHaveBeenCalledTimes(1);
      expect(managedWrite).not.toHaveBeenCalled();
    });
  }

  it("preserves a newer refreshed revision when an older archive response finishes", async () => {
    const { host, panel, agent, getAgent, archiveAgent } = await mount(connections[0][1]);
    const pending = deferred<Agent>();
    archiveAgent.mockReturnValueOnce(pending.promise);
    await act(async () => button(panel, "Archive")!.click());
    const newer: Agent = { ...agent, revision: "r3", revisions: 3, definition: { ...agent.definition, version: 3, name: "Newer connected agent" } };
    getAgent.mockResolvedValueOnce({ agent: newer, etag: null });
    await act(async () => button(host, "Refresh agent")!.click());
    await settle();
    expect(host.querySelector('header[aria-label="Agent toolbar"] nav[aria-label="Breadcrumb"] a')?.textContent).toBe("Newer connected agent");
    getAgent.mockRejectedValueOnce(new Error("Refresh unavailable"));
    await act(async () => pending.resolve({ ...agent, archived_at: "2026-11-13T00:00:00Z" }));
    await settle();
    expect(host.querySelector('header[aria-label="Agent toolbar"] nav[aria-label="Breadcrumb"] a')?.textContent).toBe("Newer connected agent");
    expect(panel.querySelector('[aria-label="About this agent"]')?.textContent).toContain("3 revisions");
    expect(button(panel, "Unarchive")?.disabled).toBe(false);
    expect(panel.textContent).toContain("Couldn't refresh this agent.");
    expect(archiveAgent).toHaveBeenCalledExactlyOnceWith(agent.agent_id);
  });
});
