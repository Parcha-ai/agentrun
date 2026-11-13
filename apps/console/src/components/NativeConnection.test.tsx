import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { createClient } from "@/lib/client";
import { NativeConnections } from "./NativeConnections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const target = { runtime: "claude-code", project: "/workspace/project", selector: { kind: "agent", name: "frontend" }, machine_id: "source-machine", version: "2.1.0", model: "sonnet", fingerprint: "abc", configuration: [{ path: ".claude/agents/frontend.md", sha256: "abc" }], skills: ["review"], mcp_servers: ["docs"], state: "needs_verification", issues: [], capabilities: { launch: true, notes: true, skills: true, workflows: false, approval: "native", usage: true } };

it("discovers on the server host without running, connects the selected native target, and preserves history import separately", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const v2 = createClient({ fetch: (async (url, init) => {
    const path = new URL(String(url), "https://console.example.test").pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ path, body });
    if (path === "/v2/native/discover") return json({ machine_id: "source-machine", targets: [target] });
    if (path === "/v2/native/connect") return json({ agent: { agent_id: "frontend" }, native: { ...target, connected: true } });
    throw new Error(path);
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(NativeConnections, { v2, go: () => {} })));
  expect(calls).toEqual([]);
  expect(host.textContent).toContain("cannot scan your laptop");
  expect(host.textContent).toContain("import history");
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Project on server host"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "/workspace/project"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Discover")!.click());
  expect(calls).toEqual([{ path: "/v2/native/discover", body: { project: "/workspace/project" } }]);
  expect(host.textContent).toContain("Needs verification");
  expect(host.textContent).not.toContain("Ready to run");
  expect(host.textContent).toContain("source-machine");
  expect(host.textContent).toContain("sonnet");
  await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "Connect selected")!.click());
  expect(calls[1]).toEqual({ path: "/v2/native/connect", body: { project: "/workspace/project", runtime: "claude-code", selector: { kind: "agent", name: "frontend" } } });
  expect(host.querySelector('a[href="#/agents/frontend"]')).not.toBeNull();
  expect(calls.some((c) => c.path.endsWith("/runs"))).toBe(false);
});

it("offers remote connection without scanning the server's project files or claiming history was imported", async () => {
  const calls: string[] = [];
  const v2 = createClient({ fetch: (async (url) => {
    const path = new URL(String(url), "https://console.example.test").pathname;
    calls.push(path);
    if (path === "/v2/connectors") return json({ connectors: [] });
    throw new Error(path);
  }) as typeof fetch });
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root.render(createElement(NativeConnections, { v2, go: () => {} })));
  const source = host.querySelector<HTMLInputElement>('input[type="radio"][value="remote"]');
  expect(source).not.toBeNull();
  await act(async () => source!.click());
  expect(calls).toEqual(["/v2/connectors"]);
  expect(host.querySelector('input[aria-label="Project on server host"]')).toBeNull();
  expect(host.textContent).toContain("Connect remote agents");
  expect(host.textContent).toContain("No remote machines connected");
  expect(host.textContent).toContain("does not import past conversations");
  expect(host.textContent).not.toContain("run AgentRun locally there and open its console");
});
