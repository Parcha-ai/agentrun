import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { route } from "../App";
import { AgentEditor } from "./AgentEditor";
import { ToolCard } from "./NodeDrawer";
import { RunBar } from "./RunBar";
import { type Agent, type AgentFields, editBody } from "@/lib/agentForm";
import { ClientError } from "@/lib/client";
import type { Effect } from "@/lib/runGraph";
import { callNodeTools, toolBlockers, toolGates } from "@/lib/toolSettings";

// A workflow whose call node calls a tool set to deny, or to ask (a call node can't wait for an approval), is refused at
// its start: 409 agent_not_runnable, `details.denied` and `details.asks` each the settings keys of those tools (arrays,
// present only when not empty). The console says the server's words and links to the place that fixes it: the agent's
// Tools, on that tool's permission, or every agent's in Settings → Tools.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const ASKS = "This workflow's call node calls web_fetch, which is set to ask, and a workflow's call node can't wait for an approval: set it to allow for this agent.";
// The server names only a call node's tool, and a call node runs only the built-in call tools (CALL_TOOLS: web_fetch,
// web_search, pdf_pages, llm), at its settings key: a 409's denied and asks name nothing else (runnable.ts).
const DENIED = "This workflow's call node calls web_search, which is set to deny on this server.";
const refused = (message: string, details: Record<string, unknown>) => {
  const e = new ClientError(409, "agent_not_runnable", message);
  e.details = details;
  return e;
};

describe("the start blockers a 409 names", () => {
  it("reads denied and asks as the arrays the server sends: none, one, several", () => {
    expect(toolBlockers(undefined)).toEqual({ denied: [], asks: [] });
    expect(toolBlockers({ unbound: [], missing: {} })).toEqual({ denied: [], asks: [] });
    expect(toolBlockers({ asks: ["web_fetch"] })).toEqual({ denied: [], asks: ["web_fetch"] });
    expect(toolBlockers({ denied: ["web_search", "llm"], asks: ["web_fetch"] })).toEqual({ denied: ["web_search", "llm"], asks: ["web_fetch"] });
    // Not an array of names: nothing to link.
    expect(toolBlockers({ denied: "bash", asks: [3] })).toEqual({ denied: [], asks: [] });
  });

  it("a workflow's call nodes' tools: each node's tool at its settings key, once, wherever the node sits", () => {
    const workflow = { v: 2, name: "f", root: { node: "sequence", label: "s", steps: [
      { node: "call", label: "a", via: "tool", tool: "web_fetch", args: {} },
      { node: "map", label: "m", itemsPath: "xs", as: "x", body: { node: "call", label: "b", via: "tool", tool: "web_search", args: {} } },
      { node: "call", label: "c", via: "tool", tool: "web_fetch", args: {} },
      { node: "call", label: "d", via: "shell", command: "echo hi" },
    ] } };
    expect(callNodeTools(workflow)).toEqual(["web_fetch", "web_search"]);
    expect(callNodeTools(undefined)).toEqual([]);
  });

});

const workflowAgent = (toolSettings?: Agent["definition"]["tool_settings"]): Agent => ({
  agent_id: "fetch-flow", kind: "workflow", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Fetch flow", workflow: { v: 2, name: "f", root: { node: "call", label: "get", tool: "web_fetch", input: {} } }, skills: [], tools: ["web_fetch", "bash"], ...(toolSettings ? { tool_settings: toolSettings } : {}) },
});

function runBar(e: ClientError) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const v2 = { startRun: async () => { throw e; } };
  act(() => root!.render(createElement(RunBar, { agent: workflowAgent(), efforts: [], v2: v2 as never, go: () => {} })));
  return {
    host,
    // The workflow's input, as JSON: an empty object.
    run: async () => {
      act(() => { const t = host.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(t, "{}"); t.dispatchEvent(new Event("input", { bubbles: true })); });
      await act(async () => { [...host.querySelectorAll("button")].find((b) => /^Run$/.test((b.textContent ?? "").trim()))!.click(); });
    },
    links: () => [...host.querySelectorAll("[role='alert'] a")].map((a) => [a.textContent, a.getAttribute("href")]),
  };
}

describe("a refused start on the agent page", () => {
  it("asks: the server's words, and a link to this agent's Tools on that tool, or every agent's", async () => {
    const page = runBar(refused(ASKS, { adapters: [], unbound: [], missing: {}, code: false, asks: ["web_fetch"] }));
    await page.run();
    await settle();
    expect(page.host.querySelector("[role='alert']")?.textContent).toContain(`The run did not start: ${ASKS}`);
    expect(page.links()).toEqual([["Set web_fetch for this agent", "#/agents/fetch-flow/edit?tool=web_fetch"], ["Settings → Tools", "#/settings/tools"]]);
  });

  it("denied: the same, the server's words unchanged", async () => {
    const page = runBar(refused(DENIED, { adapters: [], unbound: [], missing: {}, code: false, denied: ["web_search"] }));
    await page.run();
    await settle();
    expect(page.host.querySelector("[role='alert']")?.textContent).toContain(`The run did not start: ${DENIED}`);
    expect(page.links()).toEqual([["Set web_search for this agent", "#/agents/fetch-flow/edit?tool=web_search"], ["Settings → Tools", "#/settings/tools"]]);
  });

  it("several: a link for each tool, the Settings link once; none at all when the 409 names no tool", async () => {
    const page = runBar(refused(`${DENIED} ${ASKS}`, { denied: ["llm", "web_search"], asks: ["web_fetch"] }));
    await page.run();
    await settle();
    expect(page.links().map(([, href]) => href)).toEqual(["#/agents/fetch-flow/edit?tool=llm", "#/agents/fetch-flow/edit?tool=web_search", "#/agents/fetch-flow/edit?tool=web_fetch", "#/settings/tools"]);
    act(() => root?.unmount());
    const box = runBar(refused("This server has no docker box.", { unbound: [], missing: {}, box: "docker" }));
    await box.run();
    await settle();
    expect(box.links()).toEqual([]);
  });
});

describe("the editor's address for one tool", () => {
  it("opens the agent's Tools on that tool; the plain address still opens the editor", () => {
    expect(route("#/agents/fetch-flow/edit?tool=web_fetch")).toEqual({ section: "agents", agent: "fetch-flow", edit: true, tool: "web_fetch" });
    expect(route("#/agents/fetch-flow/edit?tool=mcp%3Alinear%2Fsearch")).toEqual({ section: "agents", agent: "fetch-flow", edit: true, tool: "mcp:linear/search" });
    expect(route("#/agents/fetch-flow/edit")).toEqual({ section: "agents", agent: "fetch-flow", edit: true });
    expect(route("#/agents/fetch-flow")).toEqual({ section: "agents", agent: "fetch-flow" });
  });
});

describe("a workflow agent's tool permissions in its editor", () => {
  const ALL = ["allow", "ask", "deny"];
  const RAW = [
    { name: "bash", available: true, permission: "allow", default_permission: "allow", permissions: ALL },
    { name: "web_fetch", available: true, permission: "ask", default_permission: "allow", permissions: ALL, providers: ["kernel", "parallel"], provider: "kernel", default_provider: "kernel", resolves: { pi: "kernel" } },
  ];
  const caps = { harnesses: [{ id: "pi", available: true }], tools: RAW.map(({ name }) => ({ name, available: true, nodes: true })), thinking: [] };
  async function open(agent: Agent, focus?: string) {
    const saves: AgentFields[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent, caps, permissionGates: toolGates(RAW), step: "tools", ...(focus ? { focusTool: focus } : {}), onSave: async (f: AgentFields) => { saves.push(f); return null; } })));
    await settle();
    const scope = () => host.querySelector("section[aria-label='Tool settings']");
    return { host, saves, scope };
  }

  it("shows the permission of each tool its call nodes call, and no provider column", async () => {
    const page = await open(workflowAgent());
    const scope = page.scope()!;
    // bash is granted but no call node calls it; a call node runs only the server's built-in call tools.
    expect([...scope.querySelectorAll("tr[data-tool]")].map((r) => r.getAttribute("data-tool"))).toEqual(["web_fetch"]);
    expect(scope.querySelector("select[aria-label='web_fetch permission']")).toBeTruthy();
    expect(scope.querySelector("select[aria-label$=' provider']")).toBeNull();
    expect([...scope.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["Tool", "Permission", "Reset"]);
  });

  it("no row for a catalog tool, which no call node runs, even when the agent grants it and its read names a permission", async () => {
    const base = workflowAgent();
    const agent: Agent = { ...base, definition: { ...base.definition, tools: ["web_fetch", "monid.run"] }, tools: [{ name: "monid.run", permission: "ask", permission_from: "default", default_permission: "ask", permissions: ["allow", "ask", "deny"] }] };
    const page = await open(agent);
    expect([...page.scope()!.querySelectorAll("tr[data-tool]")].map((r) => r.getAttribute("data-tool"))).toEqual(["web_fetch"]);
  });

  it("the address's tool is the one focused, at its own row", async () => {
    const page = await open(workflowAgent(), "web_fetch");
    expect(document.activeElement).toBe(page.scope()!.querySelector("select[aria-label='web_fetch permission']"));
  });

  it("an address naming a tool with no row here opens the Tools step, focuses nothing, and doesn't fail", async () => {
    const page = await open(workflowAgent(), "bash");
    expect(page.scope()).toBeTruthy();
    expect(page.host.querySelector("[aria-current='step']")?.textContent).toMatch(/Tools/);
    expect(document.activeElement === document.body || !page.host.contains(document.activeElement)).toBe(true);
  });

  it("a permission set here is saved in tool_settings, and the workflow is kept whole", async () => {
    const agent = workflowAgent({ bash: { permission: "deny" } });
    const page = await open(agent, "web_fetch");
    const s = page.scope()!.querySelector<HTMLSelectElement>("select[aria-label='web_fetch permission']")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, "allow"); s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    await act(async () => { [...page.host.querySelectorAll("button")].find((b) => /^Save revision$/.test(b.textContent?.trim() ?? ""))!.click(); });
    await settle();
    const fields = page.saves.at(-1)!;
    expect(fields.tool_settings).toEqual({ bash: { permission: "deny" }, web_fetch: { permission: "allow" } });
    const body = editBody(agent, fields, "").definition;
    expect(body.workflow).toEqual(agent.definition.workflow);
    expect(body.tools).toEqual(["web_fetch", "bash"]);
    expect(body.tool_settings).toEqual({ bash: { permission: "deny" }, web_fetch: { permission: "allow" } });
  });
});

describe("a call node refused mid-run by the gate", () => {
  it("shows the gate's refusal as the call's error", () => {
    const e: Effect = { node: "/root", executionPath: "/root", item: null, tool: "web_fetch", status: "failed", input: { url: "https://public.example/" }, output: null, error: "Permission denied: web_fetch is set to deny on this server. Don't retry it.", startedAt: "2026-11-05T10:00:00Z", endedAt: "2026-11-05T10:00:01Z" };
    const html = renderToStaticMarkup(createElement(ToolCard, { e, fileUrl: (r: string) => r, zoom: () => {} }));
    expect(html).toContain("Permission denied: web_fetch is set to deny on this server. Don&#x27;t retry it.");
  });
});
