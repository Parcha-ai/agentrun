import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { AgentRequest } from "./AgentRequest";
import { AgentPage } from "./AgentPage";
import type { Agent } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import type { Client } from "@/lib/client";
import type { NativeBinding } from "@/lib/native";
import { CODING_AGENT_PREFERENCE } from "@/lib/codingAgentLinks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const origin = "https://console.example.test";
const caps = { harnesses: [{ id: "pi", available: true }], tools: [], thinking: [] };
const managed: Agent = { ...SERVED_AGENT, agent_id: "support/a", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Support", instructions: "Answer carefully.", harness: "pi", tools: [], skills: [] } };
const nativeBinding: NativeBinding = {
  runtime: "claude-code", machine_id: "source-machine", project: "/workspace/project", selector: { kind: "project" }, state: "ready",
  version: "1.0.0", model: "claude-test", fingerprint: "handoff-fixture", configuration: [], skills: [], mcp_servers: [],
  issues: [], connected: true, verified_at: "2026-11-12T00:00:00Z",
  capabilities: { launch: true, learning: true, workflows: false, approval: "native", usage: true },
};
const native: Agent = { ...managed, definition: { ...managed.definition, native: nativeBinding } };
const sourceAgents = [
  { name: "native", agent: native, expected: "Edit the original native setup" },
  ...(["claude-agent-sdk", "codex-sdk", "eve"] as const).map(runtime => ({ name: runtime, agent: { ...managed, definition: { ...managed.definition, sdk: { runtime } } }, expected: runtime === "eve" ? "using Vercel eve" : runtime === "claude-agent-sdk" ? "using Claude Agent SDK" : "using Codex SDK" })),
];
let root: Root | undefined;
let host: HTMLDivElement;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const copied = vi.fn(async (_prompt: string) => {});
const write = vi.fn(async () => { throw new Error("Copying a handoff must not mutate or run an agent"); });
const client = (agent: Agent, etag: string | null = null): Client => ({
  getAgent: async () => ({ agent, etag }), statsOver: async () => { throw new Error("Statistics not requested by this fixture"); },
  listAgentRuns: async () => ({ runs: [], next_cursor: null }), createAgent: write, updateDefinition: write, startRun: write,
} as unknown as Client);
async function mount(element: ReactElement) {
  localStorage.setItem(CODING_AGENT_PREFERENCE, "other");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copied } });
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(element));
}
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.trim() === label)!;
const requestJson = () => [...host.querySelectorAll("label")].find(label => label.querySelector("span")?.textContent === "Request JSON")!.querySelector<HTMLTextAreaElement>("textarea")!;
const click = async (label: string) => { await act(async () => button(label).click()); };
const type = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
async function copy(label = "Use your agent") {
  expect(button(label).disabled).toBe(false);
  await click(label);
  expect(copied).toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  return copied.mock.calls.at(-1)![0];
}
function sourceEdit(prompt: string, expected: string) {
  expect(prompt).toContain(expected); expect(prompt).toContain(JSON.stringify(managed.agent_id));
  expect(prompt).not.toContain("agents_revise"); expect(prompt).not.toContain("Prepared request:");
  expect(prompt).not.toContain("Current form draft"); expect(prompt).not.toContain("If-Match:");
  expect(prompt).toContain("Never print credentials");
}
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; localStorage.clear(); if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard); else Reflect.deleteProperty(navigator, "clipboard"); vi.clearAllMocks(); });

describe("rendered handoffs follow the loaded agent's execution binding", () => {
  for (const runtime of ["codex", "claude-code"] as const) {
    it(`keeps ${runtime} learning connections in their original CLI`, async () => {
      const agent: Agent = { ...managed, definition: { ...managed.definition, cli_learning: { runtime, connection_id: "connection-a", project: "/workspace/project" }, learning: true } };
      await mount(createElement(AgentPage, { v2: client(agent), agentId: agent.agent_id, go: vi.fn(), learning: "on" }));
      expect(host.textContent).toContain("Your CLI");
      expect(host.textContent).toContain("Reported per run");
      expect(button("Detailed editor")).toBeUndefined();
      const edit = await copy("Edit agent");
      expect(edit).toContain("Edit the original CLI setup");
      expect(edit).not.toContain("agents_revise");
      const run = await copy("Run agent");
      expect(run).toContain("Keep using the original CLI");
      expect(run).toContain("Do not use the managed runs API");
      expect(write).not.toHaveBeenCalled();
    });
  }
  for (const { name, agent, expected } of sourceAgents) {
    it(`AgentEditor copies original-source guidance for ${name}`, async () => {
      await mount(createElement(AgentEditor, { agent, caps, onSave: write }));
      type(host.querySelector("textarea")!, "Requested change; not executable source.");
      sourceEdit(await copy(), expected);
    });
    it(`AgentRequest copies ${name} guidance without an edited definition or ETag, and JSON cannot replace its identity`, async () => {
      await mount(createElement(AgentRequest, { v2: client(agent), origin, operation: "edit-agent", agentId: agent.agent_id }));
      sourceEdit(await copy(), expected);
      await click("JSON");
      const input = requestJson();
      const body = JSON.parse(input.value);
      delete body.definition.native; delete body.definition.sdk;
      body.definition.harness = "pi"; body.definition.instructions = "Try a managed-looking draft.";
      type(input, JSON.stringify(body));
      // The first copy temporarily changes the action label to Copied. The changed draft must not change its source prompt.
      const action = host.querySelector<HTMLButtonElement>('[aria-label="Use your agent options"] button')!;
      expect(action.disabled).toBe(false); await act(async () => action.click());
      sourceEdit(copied.mock.calls.at(-1)![0], expected); expect(write).not.toHaveBeenCalled();
    });
  }
  it("keeps a managed editor's current draft and explicit revision guidance", async () => {
    await mount(createElement(AgentEditor, { agent: managed, caps, onSave: write }));
    type(host.querySelector("textarea")!, "Keep this requested change.");
    const prompt = await copy(); expect(prompt).toContain("agents_revise"); expect(prompt).toContain("Current form draft"); expect(prompt).toContain("Keep this requested change.");
  });
  it("keeps managed prepared JSON and exact If-Match even if editable JSON invents an SDK binding", async () => {
    await mount(createElement(AgentRequest, { v2: client(managed, '"r1"'), origin, operation: "edit-agent", agentId: managed.agent_id }));
    await click("JSON"); const input = requestJson();
    const body = JSON.parse(input.value); body.definition.instructions = "Changed."; body.definition.sdk = { runtime: "codex-sdk" }; type(input, JSON.stringify(body));
    const prompt = await copy(); expect(prompt).toContain(`Prepared request: PUT ${origin}/v2/agents/support%2Fa/definition`); expect(prompt).toContain('If-Match: "r1"');
    expect(prompt).toContain('"instructions": "Changed."'); expect(prompt).toContain('"runtime": "codex-sdk"'); expect(prompt).toContain("agents_revise"); expect(prompt).not.toContain("locate its original application entrypoint");
  });
  it("keeps the new-agent builder handoff and its form data", async () => {
    await mount(createElement(AgentEditor, { agent: null, caps, onSave: write }));
    const prompt = await copy(); expect(prompt).toContain("Help me build an agent"); expect(prompt).toContain("Current form draft");
  });
  it("keeps a valid new-agent request as a managed create handoff without sending it", async () => {
    await mount(createElement(AgentRequest, { v2: client(managed), origin, operation: "create-agent", draft: JSON.stringify({ definition: managed.definition }) }));
    const prompt = await copy(); expect(prompt).toContain("Help me build an agent"); expect(prompt).toContain(`Prepared request: POST ${origin}/v2/agents`);
    expect(prompt).toContain('"instructions": "Answer carefully."'); expect(prompt).not.toContain("If-Match:");
  });
  for (const runtime of ["claude-agent-sdk", "codex-sdk", "eve"] as const) {
    it(`AgentPage runs ${runtime} through its backend without dispatching on copy`, async () => {
      const agent = { ...managed, definition: { ...managed.definition, sdk: { runtime } } };
      await mount(createElement(AgentPage, { v2: client(agent), agentId: agent.agent_id, go: write }));
      const prompt = await copy("Run agent"); expect(prompt).toContain(runtime === "eve" ? "using Vercel eve" : runtime === "claude-agent-sdk" ? "using Claude Agent SDK" : "using Codex SDK");
      expect(prompt).toContain(runtime === "eve" ? "existing eve project and normal invocation" : "application's existing job entrypoint");
      expect(prompt).toContain("Do not launch it with AgentRun's managed run API");
      if (runtime === "eve") { expect(prompt).toContain("eve's own controls"); expect(prompt).not.toContain("flushLearning()"); }
      else expect(prompt).toContain("flushLearning()");
    });
  }
  it("AgentPage runs a managed agent from its run box: the bar has no Run hand-off, the box hands it over on its second line (GRE-4832)", async () => {
    await mount(createElement(AgentPage, { v2: client(managed), agentId: managed.agent_id, go: write }));
    expect(host.querySelector('[aria-label="Run agent options"]')).toBeNull();
    const box = host.querySelector("[data-run-here]")!;
    expect([...box.querySelectorAll("button")].some((b) => /Run with your coding agent/.test(b.textContent ?? ""))).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  for (const [name, agent] of [["native", native]] as const) {
    it(`AgentPage retains ${name} run guidance`, async () => {
      await mount(createElement(AgentPage, { v2: client(agent), agentId: agent.agent_id, go: write }));
      const prompt = await copy("Run agent"); expect(prompt).toContain("Start once, follow its progress"); expect(prompt).toContain("native sign-in"); expect(prompt).toContain("do not promise a dollar limit");
      expect(prompt).not.toContain("application's existing job entrypoint");
    });
  }
  it("does not offer the new Run handoff for an archived SDK agent", async () => {
    const agent = { ...managed, archived_at: "2026-01-01T00:00:00Z", definition: { ...managed.definition, sdk: { runtime: "codex-sdk" as const } } };
    await mount(createElement(AgentPage, { v2: client(agent), agentId: agent.agent_id, go: write }));
    expect(host.querySelector('[aria-label="Run agent options"]')).toBeNull(); expect(copied).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
});
