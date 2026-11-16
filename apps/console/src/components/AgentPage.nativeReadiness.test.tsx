import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Agent } from "@/lib/agentForm";
import { createClient } from "@/lib/client";
import type { NativeBinding } from "@/lib/native";
import { AgentPage } from "./AgentPage";
import { statsWith } from "./AgentAnalytics.sample";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.useRealTimers(); });

const native: NativeBinding = { runtime: "codex", project: "/workspace/app", selector: { kind: "profile", name: "review" }, machine_id: "workstation", version: "0.167.2", model: "gpt-5", fingerprint: "abc", configuration: [], skills: [], mcp_servers: [], state: "ready", issues: [], connected: true, verified_at: "2026-11-12T00:00:00Z", capabilities: { launch: true, notes: true, skills: true, workflows: false, approval: "native", usage: true }, remote: { connector_id: "remote-1", target_id: "target-1" } };
const agent: Agent = { agent_id: "reviewer", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: { version: 1, name: "Reviewer", tools: [], skills: [], learning: false, native } };
const offline: NativeBinding = { ...native, state: "needs_attention", capabilities: { ...native.capabilities, launch: false }, issues: ["The source machine is offline."] };

async function open(initial: NativeBinding | Error) {
  vi.useFakeTimers();
  let status = initial;
  const calls: { path: string; method: string }[] = [];
  const v2 = createClient({ fetch: (async (url, init) => {
    const path = new URL(String(url), "https://console.example.test").pathname;
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    let answer: unknown;
    if (path === "/v2/agents/reviewer") answer = agent;
    else if (path === "/v2/stats") answer = statsWith();
    else if (path === "/v2/agents/reviewer/runs") answer = { runs: [], next_cursor: null };
    else if (path === "/v2/agents/reviewer/native") { if (status instanceof Error) throw status; answer = { native: status }; }
    else if (path === "/v2/agents/reviewer/native/verify") { status = native; answer = { native }; }
    else throw new Error(`Unexpected ${method} ${path}`);
    return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json", etag: "r1" } });
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(StrictMode, null, createElement(AgentPage, { agentId: agent.agent_id, v2, go: () => {}, learning: "on" }))));
  const run = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Run agent")!;
  const learning = () => host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  return { host, calls, run, learning, status: (next: NativeBinding | Error) => { status = next; } };
}

it("refreshes actual agent-page controls on the readiness timer and focus without changing the saved binding", async () => {
  const saved = JSON.stringify(agent);
  const page = await open(offline);
  expect(page.host.textContent).toContain("The source machine is offline.");
  expect(page.run().disabled).toBe(true);
  expect(page.learning().disabled).toBe(true);
  page.status(native);
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(page.run().disabled).toBe(false);
  expect(page.learning().disabled).toBe(false);
  page.status(offline);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(page.run().disabled).toBe(true);
  expect(page.learning().disabled).toBe(true);
  expect(JSON.stringify(agent)).toBe(saved);
  expect(page.calls.every(({ method }) => method === "GET")).toBe(true);
});

it("fails closed on a current readiness read error and recovers on the next successful poll", async () => {
  const page = await open(new Error("Worker status unavailable"));
  expect(page.host.textContent).toContain("Connection status could not be read: Worker status unavailable");
  expect(page.run().disabled).toBe(true);
  page.status(native);
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(page.run().disabled).toBe(false);
  expect(page.host.textContent).not.toContain("Worker status unavailable");
});

it("refreshes runtime readiness after verification even when the agent revision does not change", async () => {
  const page = await open(offline);
  expect(page.run().disabled).toBe(true);
  const reads = () => page.calls.filter(({ path }) => path.endsWith("/native")).length;
  const before = reads();
  const verify = [...page.host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Verify connection")!;
  await act(async () => verify.click());
  expect(page.calls).toContainEqual({ path: "/v2/agents/reviewer/native/verify", method: "POST" });
  expect(reads()).toBeGreaterThan(before);
  expect(page.run().disabled).toBe(false);
  expect(page.learning().disabled).toBe(false);
  expect(agent.revision).toBe("r1");
});
