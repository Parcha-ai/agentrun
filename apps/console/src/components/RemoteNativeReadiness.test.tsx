import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { Agent } from "@/lib/agentForm";
import type { NativeBinding } from "@/lib/native";
import { AgentsList } from "./AgentsList";
import { Playground } from "./Playground";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; localStorage.clear(); });
const native: NativeBinding = { runtime: "codex", project: "/workspace/app", selector: { kind: "project" }, machine_id: "source", version: "0.167.2", model: "native-model", fingerprint: "abc", configuration: [], skills: [], mcp_servers: [], state: "ready", issues: [], connected: true, remote: { connector_id: "remote-1", target_id: "target-1" }, capabilities: { launch: true, notes: true, skills: true, workflows: false, approval: "native", usage: true } };
const base: Agent = { agent_id: "reviewer", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reviewer", tools: [], skills: [], native } };

for (const state of ["online", "offline", "unknown"] as const) it(`uses ${state} runtime status for remote list/playground run actions while preserving the saved binding`, async () => {
  const agent: Agent = { ...base, ...(state === "unknown" ? {} : { native_status: state === "online" ? native : { ...native, state: "needs_attention" as const, capabilities: { ...native.capabilities, launch: false }, issues: ["Source worker is offline"] } }) };
  const original = JSON.stringify(agent.definition);
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(AgentsList, { agents: [agent] })));
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Run Reviewer"]')!.disabled).toBe(state !== "online");
  expect(host.textContent?.includes("Ready to run")).toBe(state === "online");
  await act(async () => root.render(createElement(Playground, { agents: [agent], efforts: [], origin: "https://console.example.test", onSend: async () => ({ status: 201, ms: 1, body: {} }) })));
  const input = host.querySelector("textarea")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Review this change."); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect([...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Send request"))!.disabled).toBe(state !== "online");
  expect(JSON.stringify(agent.definition)).toBe(original);
});
