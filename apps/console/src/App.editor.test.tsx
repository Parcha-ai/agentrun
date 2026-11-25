import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App, route } from "./App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.unstubAllGlobals(); localStorage.clear(); location.hash = ""; });

it("opens a new agent's full editor without colliding with an existing agent named new", () => {
  const instructions = "Compare A & B.\nKeep #tags + spaces.";
  expect(route(`#/agents/new?${new URLSearchParams({ editor: "true", instructions })}`)).toEqual({ section: "agents", agent: null, edit: true, initialInstructions: instructions });
  expect(route("#/agents/new?editor=true")).toEqual({ section: "agents", agent: null, edit: true });
  expect(route("#/agents/new")).toEqual({ section: "agents", agent: null });
  expect(route("#/agents/new/edit")).toEqual({ section: "agents", agent: "new", edit: true });
});


it("keeps agent settings addresses separate from server settings and preserves focused-tool edit links", () => {
  expect(route("#/agents/inspect%2Fa%20%2B%20b/settings")).toEqual({ section: "agents", agent: "inspect/a + b", tab: "settings" });
  expect(route("#/agents/inspect%2Fa%20%2B%20b/settings?section=tools")).toEqual({ section: "agents", agent: "inspect/a + b", tab: "settings", settingsSection: "tools" });
  expect(route("#/agents/inspect%2Fa%20%2B%20b/settings?section=skills")).toEqual({ section: "agents", agent: "inspect/a + b", tab: "settings", settingsSection: "skills" });
  expect(route("#/agents/new/settings")).toEqual({ section: "agents", agent: "new", tab: "settings" });
  expect(route("#/agents/connect/settings")).toEqual({ section: "agents", agent: "connect", tab: "settings" });
  expect(route("#/settings/tools")).toEqual({ section: "settings", settings: "tools" });
  expect(route("#/agents/inspect%2Fa%20%2B%20b/edit?tool=mcp%3Alinear%2Fsearch")).toEqual({ section: "agents", agent: "inspect/a + b", edit: true, tool: "mcp:linear/search" });
});

it("opens the form with the build brief and creates only after a name and explicit Create", async () => {
  const writes: unknown[] = [];
  const instructions = "Compare A & B.\nKeep #tags + spaces.";
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (init?.method === "POST" && path === "/v2/agents") {
      const body = JSON.parse(String(init.body)); writes.push(body);
      return json({ agent_id: "compare", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: body.definition });
    }
    if (path === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    if (path === "/v2/capabilities") return json({ models: { ready: true }, harnesses: [{ id: "pi", available: true }], tools: [], features: {} });
    if (path === "/v2/agents" || path === "/v2/runs") return json({ agents: [], runs: [], next_cursor: null });
    if (path === "/v2/computers") return json({ kinds: [] });
    if (path === "/v2/settings/tools") return json({});
    return json({ error: { code: "not_found", message: path, retryable: false } }, 404);
  });
  location.hash = `#/agents/new?${new URLSearchParams({ editor: "true", instructions })}`;
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => { root!.render(createElement(App)); });
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(host.querySelector<HTMLTextAreaElement>("#agent-instructions")?.value).toBe(instructions);
  expect(host.querySelector<HTMLInputElement>("#agent-name")?.value).toBe("");
  expect(writes).toEqual([]);
  const create = () => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === "Create")!;
  expect(create().disabled).toBe(true);
  await act(async () => {
    const name = host.querySelector<HTMLInputElement>("#agent-name")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Compare");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(writes).toEqual([]);
  await act(async () => create().click());
  expect(writes).toEqual([expect.objectContaining({ definition: expect.objectContaining({ name: "Compare", instructions }) })]);
});


const entryButton = (scope: ParentNode, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")].find(control => control.getAttribute("aria-label") === label || control.textContent?.trim() === label);
async function waitForEntry(ok: () => boolean) {
  const end = Date.now() + 4000;
  while (!ok() && Date.now() < end) await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(ok()).toBe(true);
}
async function openAgentEntry(hash = "#/agents") {
  const writes: string[] = [];
  const reads: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://serve.test").pathname;
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${path}`); else reads.push(path);
    if (path === "/v2/auth/session") return json({ password_set: true, signed_in: true, secrets_writable: true });
    if (path === "/v2/capabilities") return json({ models: { ready: true }, harnesses: [{ id: "pi", available: true }], tools: [], features: {} });
    if (path === "/v2/agents" || path === "/v2/runs") return json({ agents: [], runs: [], next_cursor: null });
    if (path === "/v2/templates") return json({ templates: [] });
    if (path === "/v2/computers") return json({ kinds: [] });
    if (path === "/v2/settings/tools") return json({});
    return json({ error: { code: "not_found", message: path, retryable: false } }, 404);
  });
  location.hash = hash;
  const host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
  await act(async () => root!.render(createElement(App)));
  await waitForEntry(() => !!host.querySelector('nav[aria-label="Navigation"]'));
  return { host, reads, writes };
}

it("opens creation from the Agents toolbar and keeps Templates accessible without a Build page or writes", async () => {
  const { host, reads, writes } = await openAgentEntry();
  await waitForEntry(() => host.querySelector("h1")?.textContent === "Agents");
  const nav = host.querySelector('nav[aria-label="Navigation"]')!;
  const agents = entryButton(nav, "Agents")!;
  expect(entryButton(nav, "Build")).toBeUndefined();
  expect(entryButton(nav, "Connected agents")).toBeUndefined();
  expect(agents.getAttribute("aria-expanded")).toBeNull();
  expect(agents.parentElement).toBe(entryButton(nav, "Templates")?.parentElement);
  expect(agents.parentElement).toBe(entryButton(nav, "Runs")?.parentElement);
  const toolbar = host.querySelector("h1")!.closest("header")!;
  expect([...toolbar.querySelectorAll("a")].map(a => a.textContent?.trim())).toEqual(["Connect agent", "New agent"]);
  expect(toolbar.querySelector('[aria-haspopup="menu"]')).toBeNull();
  const editor = [...toolbar.querySelectorAll("a")].find(link => link.textContent?.trim() === "New agent")!;
  expect(editor?.getAttribute("href")).toBe("#/agents/new?editor=true");
  await act(async () => editor.click());
  await waitForEntry(() => !!host.querySelector("#agent-name"));
  expect(host.querySelector("h1")?.textContent).toBe("New agent");
  expect(host.textContent).not.toContain("What do you want to build?");
  expect(entryButton(host, "Create")?.disabled).toBe(true);
  await act(async () => entryButton(host, "Back")!.click());
  await waitForEntry(() => location.hash === "#/agents" && host.querySelector("h1")?.textContent === "Agents");
  await act(async () => entryButton(nav, "Templates")!.click());
  await waitForEntry(() => location.hash === "#/templates" && host.querySelector("h1")?.textContent === "Templates");
  expect(reads).toContain("/v2/templates");
  expect(writes).toEqual([]);
});

it.each(["#/agents/new", "#/agents/new?editor=true"])("opens %s directly as a clean form and returns to Agents", async hash => {
  const { host, writes } = await openAgentEntry(hash);
  await waitForEntry(() => !!host.querySelector("#agent-name"));
  expect(host.querySelector<HTMLInputElement>("#agent-name")?.value).toBe("");
  expect(host.textContent).not.toContain("What do you want to build?");
  expect(entryButton(host, "Back to Build")).toBeUndefined();
  await act(async () => entryButton(host, "Back")!.click());
  await waitForEntry(() => location.hash === "#/agents");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(writes).toEqual([]);
});

it("discards a confirmed legacy editor move and guards the next draft while Back retraces editor navigation", async () => {
  const { host, writes } = await openAgentEntry("#/agents/new?editor=true");
  await waitForEntry(() => !!host.querySelector("#agent-instructions"));
  const input = () => host.querySelector<HTMLTextAreaElement>("#agent-instructions")!;
  const initial = input().value;
  const type = async (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await type("This draft will be discarded.");
  await act(async () => { location.hash = "#/agents/new"; });
  await waitForEntry(() => !!entryButton(document.body, "Leave") && location.hash === "#/agents/new?editor=true");
  await act(async () => entryButton(document.body, "Leave")!.click());
  await waitForEntry(() => location.hash === "#/agents/new" && input()?.value === initial);
  await type("Keep this next draft.");
  await act(async () => entryButton(host, "Back")!.click());
  await waitForEntry(() => !!entryButton(document.body, "Stay"));
  await act(async () => entryButton(document.body, "Stay")!.click());
  expect(location.hash).toBe("#/agents/new");
  expect(input().value).toBe("Keep this next draft.");
  await act(async () => entryButton(host, "Back")!.click());
  await waitForEntry(() => !!entryButton(document.body, "Leave"));
  await act(async () => entryButton(document.body, "Leave")!.click());
  // Back follows the prior console address; the old legacy entry has a fresh, discarded draft.
  await waitForEntry(() => location.hash === "#/agents/new?editor=true" && input()?.value === initial);
  await act(async () => entryButton(host, "Back")!.click());
  await waitForEntry(() => location.hash === "#/agents" && !host.querySelector("#agent-name"));
  expect(writes).toEqual([]);
});
