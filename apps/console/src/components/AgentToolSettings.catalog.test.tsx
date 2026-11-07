import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditPage } from "./AgentsPage";
import { AgentToolSettings } from "./ToolSettings";
import { type Agent, toolOffers } from "@/lib/agentForm";
import { createClient } from "@/lib/client";
import type { McpServer } from "@/lib/mcp";
import { toolGates } from "@/lib/toolSettings";

// A catalog tool (an MCP server's `mcp:<server>/<tool>`, monid's `monid.<tool>`) ticked in the Tools step and not saved
// yet: its row in "This agent's tool settings" is there at once, with the permission the server would apply as its
// default (the server's setting for that tool, else for every tool of its MCP server, else ask), so it can be set before
// the first save. A built-in tool's row (capabilities') is as it was.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const ALL = ["allow", "ask", "deny"];
const GATES = [{ name: "read", permission: "allow", default_permission: "allow", permissions: ALL }, { name: "web_fetch", permission: "allow", default_permission: "allow", permissions: ALL }];
const CAPS = { harnesses: [{ id: "pi", available: true }], thinking: [], tools: toolOffers([{ name: "read", available: true }, { name: "web_fetch", available: true }]), mcp: true, mcpHarnesses: ["pi"] };
const tool = (name: string) => ({ name, description: `${name}.`, input_schema: { type: "object" } });
const GITHUB: McpServer = { name: "github", url: "https://mcp.example.test/mcp", auth: { type: "bearer" }, credential: "sealed", tools: [tool("list_issues"), tool("create_issue")], protocol: "2026-07-28" };
const definition = (tools: string[], toolSettings?: Record<string, unknown>) => ({ id: "triage", version: 1, name: "Triage", instructions: "Triage.", harness: "pi", skills: [], tools, ...(toolSettings ? { tool_settings: toolSettings } : {}) });
// The agent as GET /agents/{id} reads it: its saved tools, each with the permission in force (none for a tool not saved).
const read = (tools: string[], toolSettings?: Record<string, unknown>): Agent => ({
  agent_id: "triage", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: definition(tools, toolSettings),
  tools: tools.filter((t) => GATES.some((g) => g.name === t)).map((name) => ({ name, permission: "allow", permission_from: "default", default_permission: "allow", permissions: ALL })),
} as Agent);

async function open(saved: string[], serverSettings: Record<string, unknown>) {
  const puts: { definition: { tools: string[]; tool_settings?: Record<string, unknown> } }[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      return json(200, { ...read(body.definition.tools, body.definition.tool_settings), revision: "r2", revisions: 2 }, { etag: '"r2"' });
    }
    if (path === "/v2/agents/triage") return json(200, read(saved), { etag: '"r1"' });
    if (path.startsWith("/v2/agents/triage/revisions")) return json(200, { revisions: [{ revision: "r1", version: 1, current: true, note: null, created_at: "2026-11-07T10:00:00Z", kind: "agentic", definition: definition(saved) }], next_cursor: null });
    if (path === "/v2/settings/mcp-servers") return json(200, { servers: [GITHUB] });
    if (path === "/v2/settings/tools") return json(200, serverSettings);
    return json(404, { error: { code: "not_found", message: path, retryable: false } });
  }) as typeof globalThis.fetch;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditPage, { v2: createClient({ fetch }), caps: CAPS, gates: toolGates(GATES), agentId: "triage", go: () => {} })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Tools & skills"))!.click(); });
  await settle();
  const row = (name: string) => host.querySelector<HTMLTableRowElement>(`table[aria-label="This agent's tool settings"] tr[data-tool="${name}"]`);
  const permission = (name: string) => row(name)?.querySelector<HTMLSelectElement>(`select[aria-label="${name} permission"]`) ?? null;
  const options = (name: string) => [...(permission(name)?.options ?? [])].map((o) => o.textContent);
  const tick = async (name: string) => { await act(async () => { (host.querySelector(`input[value="${name}"]`) as HTMLInputElement).click(); }); await settle(); };
  const choose = async (name: string, value: string) => {
    await act(async () => { const s = permission(name)!; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, value); s.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
  };
  const save = async () => { await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save revision")!.click(); }); await settle(); };
  return { host, puts, row, permission, options, tick, choose, save };
}

describe("the Tools step, a catalog tool ticked and not saved yet", () => {
  it("an MCP tool's row is there at once, ask its default when the server sets none; Allow is picked and saved, and stays after the save", async () => {
    const page = await open(["read", "web_fetch"], {});
    const before = page.options("web_fetch");
    expect(page.row("mcp:github/list_issues")).toBeNull();
    await page.tick("mcp:github/list_issues");
    expect(page.options("mcp:github/list_issues")).toEqual(["allow", "ask (default)", "deny"]);
    expect(page.permission("mcp:github/list_issues")!.value).toBe("ask");
    await page.choose("mcp:github/list_issues", "allow");
    await page.save();
    expect(page.puts.at(-1)?.definition.tool_settings).toEqual({ "mcp:github/list_issues": { permission: "allow" } });
    expect(page.permission("mcp:github/list_issues")!.value).toBe("allow");
    // A built-in tool's row, capabilities', as it was.
    expect(page.options("web_fetch")).toEqual(before);
    expect(page.options("web_fetch")).toEqual(["allow (default)", "ask", "deny"]);
  });

  it("its default is the server's setting for the tool, else for every tool of its MCP server", async () => {
    const page = await open(["read"], { "mcp:github/*": { permission: "deny" }, "mcp:github/create_issue": { permission: "allow" } });
    await page.tick("mcp:github/list_issues");
    await page.tick("mcp:github/create_issue");
    expect(page.options("mcp:github/list_issues")).toEqual(["allow", "ask", "deny (default)"]);
    expect(page.options("mcp:github/create_issue")).toEqual(["allow (default)", "ask", "deny"]);
  });

  it("a monid tool in the form and not saved yet (a new agent's) has its row the same way; with accounts off, ask is offered disabled", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const gates = toolGates(GATES.map((g) => ({ ...g, ask_needs: "password" })));
    const render = (serverSettings: Record<string, unknown>) => act(() => root!.render(createElement(AgentToolSettings, { agent: null, harness: "pi", tools: ["read", "monid.search"], choices: [], gates, serverSettings, value: {}, issues: {}, onChange: () => {} })));
    render({});
    const select = () => host.querySelector<HTMLSelectElement>('select[aria-label="monid.search permission"]');
    expect([...(select()?.options ?? [])].map((o) => [o.textContent, o.disabled])).toEqual([["allow", false], ["ask (default)", true], ["deny", false]]);
    render({ "monid.search": { permission: "allow" } });
    expect(select()!.value).toBe("allow");
    expect([...select()!.options].map((o) => o.textContent)).toEqual(["allow (default)", "ask", "deny"]);
  });
});
