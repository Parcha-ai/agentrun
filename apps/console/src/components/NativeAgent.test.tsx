import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { createClient } from "@/lib/client";
import type { Agent } from "@/lib/agentForm";
import type { NativeBinding } from "@/lib/native";
import { NativeAgent } from "./NativeAgent";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const native: NativeBinding = { runtime: "codex", project: "/workspace/app", selector: { kind: "profile", name: "review" }, machine_id: "workstation", version: "0.167.2", model: "gpt-5", fingerprint: "abc", configuration: [], skills: [], mcp_servers: [], state: "ready", issues: [], connected: true, verified_at: "2026-11-12T00:00:00Z", capabilities: { launch: true, notes: true, skills: true, workflows: false, approval: "native", usage: true } };
const agent: Agent = { agent_id: "reviewer", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reviewer", tools: [], skills: [], learning: false, native } };
it("explains native learning costs before enabling notes-only learning, turns learning fully off, and disconnects without deleting history", async () => {
  let current = agent;
  const calls: { path: string; method: string; body: any }[] = [];
  const v2 = createClient({ fetch: (async (url, init) => {
    const path = new URL(String(url), "https://console.example.test").pathname;
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ path, method, body });
    let answer: unknown = current;
    if (method === "PUT") { current = { ...current, definition: body.definition }; answer = current; }
    if (path.endsWith("/verify")) answer = { native };
    if (path.endsWith("/disconnect")) answer = { native: { ...native, connected: false } };
    return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json", etag: "r1" } });
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const render = () => root.render(createElement(NativeAgent, { agent: current, v2, learning: "on", onAgent: (saved) => { current = saved; render(); }, onChanged: async () => {} }));
  await act(async () => render());
  expect(host.textContent).toContain("Self-improving: Off");
  expect(host.textContent).toContain("neither supplies nor creates AgentRun learning");
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(document.body.textContent).toContain("additional native model usage");
  expect(calls).toEqual([]);
  await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Enable self-improvement")!.click());
  expect(calls.filter((c) => c.method === "PUT")[0]?.body.definition.learning).toBe("notes");
  expect(current.definition.native).toEqual(native);
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(calls.filter((c) => c.method === "PUT")[1]?.body.definition.learning).toBe(false);
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Disconnect")!.click());
  expect(calls.at(-1)?.path).toBe("/v2/agents/reviewer/native/disconnect");
  expect(host.textContent).toContain("Disconnected");
  expect(host.textContent).toContain("Original files and run history are preserved");
});

it("keeps verification and learning ahead of counted closed skill/MCP/configuration disclosures", async () => {
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  const large = { ...agent, definition: { ...agent.definition, native: { ...native, skills: Array.from({ length: 250 }, (_, index) => `global-skill-${index}`), mcp_servers: ["docs", "search"], configuration: [{ path: "/workspace/app/.codex/config.toml", sha256: "abc" }] } } };
  await act(async () => root.render(createElement(NativeAgent, { agent: large, v2: {} as never, learning: "on", onAgent: () => {}, onChanged: async () => {} })));
  const skills = [...host.querySelectorAll("details")].find((element) => element.querySelector("summary")?.textContent === "Skills · 250 detected")!;
  expect(skills).toBeDefined();
  expect(skills.open).toBe(false);
  expect([...host.querySelectorAll("details")].some((element) => element.querySelector("summary")?.textContent === "MCP servers · 2 configured")).toBe(true);
  const verify = [...host.querySelectorAll("button")].find((element) => element.textContent === "Verify connection")!;
  expect(verify.compareDocumentPosition(skills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(host.querySelector('[role="switch"]')!.compareDocumentPosition(skills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const expandedText = host.cloneNode(true) as HTMLElement;
  expandedText.querySelectorAll("details").forEach((element) => element.remove());
  expect(expandedText.textContent).not.toContain("global-skill-0");
});
