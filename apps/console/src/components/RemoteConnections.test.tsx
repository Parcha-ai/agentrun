import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createClient } from "@/lib/client";
import type { RemoteConnector } from "@/lib/connectors";
import { RemoteConnections } from "./RemoteConnections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const connector: RemoteConnector = {
  connector_id: "source/one", label: "Development laptop", status: "online", last_seen_at: "2026-11-12T20:00:00Z", created_at: "2026-11-12T19:00:00Z",
  capabilities: { observe: true, native_execution: true },
  targets: [{ target_id: "target-1", agent_id: "reviewer/one", name: "Review profile", runtime: "codex", machine_id: "source-machine", state: "ready", issues: [], capabilities: { launch: true, notes: true, skills: true, workflows: false, approval: "native", usage: true } }],
};
const buttons = (text: string) => [...document.querySelectorAll("button")].filter((button) => button.textContent === text);

it("reads remote source status, links imported agents and never invents online readiness", async () => {
  let current = connector;
  const v2 = createClient({ fetch: (async () => json({ connectors: [current] })) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(StrictMode, null, createElement(RemoteConnections, { v2 }))));
  expect(host.textContent).toContain("Development laptop");
  expect(host.textContent).toContain("Online");
  expect(host.textContent).toContain("Ready to run");
  expect(host.querySelector('a[href="#/agents/reviewer%2Fone"]')).not.toBeNull();
  current = { ...connector, status: "offline" };
  await act(async () => buttons("Refresh")[0]!.click());
  expect(host.textContent).toContain("The source worker is offline");
  expect(host.textContent).toContain("Worker unavailable");
  expect(host.textContent).not.toContain("Ready to run");
});

it("creates a one-use code only on request, keeps it out of handoffs/storage and clears it when closed", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const code = "test-only-one-use-enrollment";
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const v2 = createClient({ fetch: (async (url, init) => {
    const path = new URL(String(url), "https://console.example.test").pathname;
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return path.endsWith("/enrollment") ? json({ enrollment_token: code, expires_at: new Date(Date.now() + 600_000).toISOString(), workspace_id: "local" }) : json({ connectors: [] });
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(RemoteConnections, { v2 })));
  expect(calls).toEqual([{ path: "/v2/connectors", method: "GET", body: null }]);
  await act(async () => buttons("Create connection code")[0]!.click());
  expect(calls.at(-1)).toEqual({ path: "/v2/connectors/enrollment", method: "POST", body: { capabilities: { native_execution: true, history_import: false } } });
  expect(document.querySelector<HTMLInputElement>('input[readonly]')?.value).toBe(code);
  expect([...document.querySelectorAll("a")].some((link) => link.href.includes(code))).toBe(false);
  expect(Object.values(localStorage)).not.toContain(code);
  await act(async () => buttons("Copy connection code")[0]!.click());
  expect(writeText).toHaveBeenCalledWith(code);
  await act(async () => buttons("Done")[0]!.click());
  expect(document.querySelector('input[readonly]')).toBeNull();
  expect(document.body.textContent).not.toContain(code);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Choose coding agent for Connect agent"]')!.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === "Copy prompt")!.click());
  expect(writeText.mock.calls.at(-1)?.[0]).toContain("/skills/agentrun-serve/SKILL.md");
  expect(writeText.mock.calls.at(-1)?.[0]).not.toContain(code);
});

it.each([
  ["History only", { native_execution: false, history_import: true }],
  ["Both", { native_execution: true, history_import: true }],
] as const)("grants %s only when explicitly selected before creating a connection code", async (choice, capabilities) => {
  const bodies: unknown[] = [];
  const v2 = createClient({ fetch: (async (url, init) => {
    if (String(url).endsWith("/enrollment")) { bodies.push(JSON.parse(String(init?.body))); return json({ enrollment_token: "test-only-scope", expires_at: new Date(Date.now() + 600_000).toISOString(), workspace_id: "local" }); }
    return json({ connectors: [] });
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(RemoteConnections, { v2 })));
  const option = [...host.querySelectorAll("label")].find((label) => label.textContent === choice)!;
  await act(async () => option.click());
  expect(bodies).toHaveLength(0);
  await act(async () => buttons("Create connection code")[0]!.click());
  expect(bodies).toEqual([{ capabilities }]);
});

it("shows history-only sources as imported history without asking for an execution worker", async () => {
  const historical: RemoteConnector = { ...connector, status: "offline", capabilities: { observe: true, native_execution: false, history_import: true }, targets: connector.targets.map((target) => ({ ...target, history_only: true, state: "needs_attention", capabilities: { ...target.capabilities, launch: false } })) };
  const v2 = createClient({ fetch: (async () => json({ connectors: [historical] })) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(RemoteConnections, { v2 })));
  expect(host.textContent).toContain("History import only");
  expect(host.textContent).toContain("Imported history");
  expect(host.textContent).not.toContain("The source worker is offline");
  expect(host.textContent).not.toContain("Ready to run");
});

it("confirms revocation and encodes only the selected connector id", async () => {
  const calls: { path: string; method: string }[] = [];
  const v2 = createClient({ fetch: (async (url, init) => {
    const path = String(url), method = init?.method ?? "GET"; calls.push({ path, method });
    return method === "DELETE" ? json({ connector: { ...connector, status: "revoked" } }) : json({ connectors: [connector] });
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(RemoteConnections, { v2 })));
  await act(async () => buttons("Revoke access")[0]!.click());
  expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  expect(document.body.textContent).toContain("Agent definitions, past runs and saved learning stay available");
  await act(async () => buttons("Revoke access").at(-1)!.click());
  expect(calls.at(-1)).toEqual({ path: "/v2/connectors/source%2Fone", method: "DELETE" });
  expect(host.textContent).toContain("Revoked");
  expect(buttons("Revoke access")[0]?.disabled).toBe(true);
});

it("keeps a failed list read visible and supports retry without losing the destination", async () => {
  let attempt = 0;
  const v2 = createClient({ fetch: (async () => {
    if (++attempt === 1) throw new Error("Connection interrupted");
    return json({ connectors: [] });
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(RemoteConnections, { v2 })));
  expect(host.textContent).toContain("Remote machines could not be read");
  expect(host.textContent).toContain("Connection interrupted");
  await act(async () => buttons("Try again")[0]!.click());
  expect(host.textContent).toContain("No remote machines connected");
  expect(host.textContent).not.toContain("Connection interrupted");
});
