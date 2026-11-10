import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditPage } from "./AgentsPage";
import { type Agent, toolOffers } from "@/lib/agentForm";
import { createClient } from "@/lib/client";
import type { McpServer } from "@/lib/mcp";
import { toolGates } from "@/lib/toolSettings";

// An MCP tool (`mcp:<server>/<tool>`) ticked in the Tools step and not saved yet: its row in "This agent's tool settings"
// is there at once, with the permission its server's read gives (the one this server applies to an agent that sets
// none), so it can be set before the first save. The agent's own setting for every tool of that MCP server comes first,
// as the server applies it. A built-in tool's row (capabilities') is as it was. The rows' control may be a native select
// or the console's picker (a listbox button): these read either.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const ALL = ["allow", "ask", "deny"] as ("allow" | "ask" | "deny")[];
// As capabilities give each tool (serve's toolsView, serverGate): monid's catalog tools among them, ask by default.
const GATES = [{ name: "read", permission: "allow", default_permission: "allow", permissions: ALL }, { name: "web_fetch", permission: "allow", default_permission: "allow", permissions: ALL }, { name: "monid.discover", permission: "allow", default_permission: "ask", permissions: ALL }];
const CAPS = { harnesses: [{ id: "pi", available: true }], thinking: [], tools: toolOffers([{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "web_fetch", available: true, harnesses: ["pi"] }, { name: "monid.discover", available: true, harnesses: ["pi"] }]), mcp: true, mcpHarnesses: ["pi"] };
// As a saved server's read gives a tool: with its permission in force under the server's tool settings (`inForce`).
const tool = (name: string, inForce?: "allow" | "ask" | "deny") => ({ name, description: `${name}.`, input_schema: { type: "object" }, ...(inForce ? { permission: inForce, default_permission: "ask" as const, permissions: ALL } : {}) });
const github = (inForce?: "allow" | "ask" | "deny"): McpServer => ({ name: "github", url: "https://mcp.example.test/mcp", auth: { type: "bearer" }, credential: "sealed", tools: [tool("list_issues", inForce), tool("create_issue", inForce)], protocol: "2026-07-28" });
const definition = (tools: string[], toolSettings?: Record<string, unknown>) => ({ id: "triage", version: 1, name: "Triage", instructions: "Triage.", harness: "pi", skills: [], tools, ...(toolSettings ? { tool_settings: toolSettings } : {}) });
// The agent as GET /agents/{id} reads it: its saved tools, each with the permission in force.
// An MCP tool's entry is as serve's agentTools gives it: `inForce` with the agent's own layer, its default the server's.
const read = (tools: string[], toolSettings?: Record<string, unknown>, mcp: { inForce: "allow" | "ask" | "deny"; server: "allow" | "ask" | "deny" } = { inForce: "ask", server: "ask" }): Agent => ({
  agent_id: "triage", kind: "agentic", revision: "r1", revisions: 1, archived_at: null, definition: definition(tools, toolSettings),
  tools: tools.map((name) => (GATES.some((g) => g.name === name)
    ? { name, permission: "allow", permission_from: "default", default_permission: "allow", permissions: ALL }
    : { name, permission: mcp.inForce, permission_from: "agent", default_permission: mcp.server, permissions: ALL })),
} as Agent);

async function open(server: McpServer, toolSettings?: Record<string, unknown>, saved: { tools: string[]; mcp: { inForce: "allow" | "ask" | "deny"; server: "allow" | "ask" | "deny" } } = { tools: ["read", "web_fetch"], mcp: { inForce: "ask", server: "ask" } }) {
  const puts: { definition: { tools: string[]; tool_settings?: Record<string, unknown> } }[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      return json(200, { ...read(body.definition.tools, body.definition.tool_settings), revision: "r2", revisions: 2 }, { etag: '"r2"' });
    }
    if (path === "/v2/agents/triage") return json(200, read(saved.tools, toolSettings, saved.mcp), { etag: '"r1"' });
    if (path.startsWith("/v2/agents/triage/revisions")) return json(200, { revisions: [{ revision: "r1", version: 1, current: true, note: null, created_at: "2026-11-07T10:00:00Z", kind: "agentic", definition: definition(saved.tools, toolSettings) }], next_cursor: null });
    if (path === "/v2/settings/mcp-servers") return json(200, { servers: [server] });
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
  const control = (name: string) => row(name)?.querySelector<HTMLElement>(`[aria-label="${name} permission"]`) ?? null;
  // What the row shows: the permission picked and its words ("deny (default)").
  const shown = (name: string) => {
    const c = control(name);
    if (!c) return null;
    if (c instanceof HTMLSelectElement) return { value: c.value, label: c.selectedOptions[0]?.textContent ?? "" };
    return { value: c.getAttribute("data-value"), label: (c.textContent ?? "").trim() };
  };
  const tick = async (name: string) => { await act(async () => { (host.querySelector(`input[value="${name}"]`) as HTMLInputElement).click(); }); await settle(); };
  const choose = async (name: string, value: string) => {
    const c = control(name)!;
    if (c instanceof HTMLSelectElement) {
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(c, value); c.dispatchEvent(new Event("change", { bubbles: true })); });
    } else {
      await act(async () => { c.click(); });
      await settle();
      await act(async () => { document.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)!.click(); });
    }
    await settle();
  };
  const save = async () => { await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save revision")!.click(); }); await settle(); };
  return { host, puts, row, shown, tick, choose, save };
}

describe("the Tools step, an MCP tool ticked and not saved yet", () => {
  it("its row is there at once with the permission its server's read gives in force; another is picked, saved, and stays after the save", async () => {
    const page = await open(github("allow"));
    const before = page.shown("web_fetch");
    expect(page.row("mcp:github/list_issues")).toBeNull();
    await page.tick("mcp:github/list_issues");
    expect(page.shown("mcp:github/list_issues")).toEqual({ value: "allow", label: "allow (default)" });
    await page.choose("mcp:github/list_issues", "deny");
    await page.save();
    expect(page.puts.at(-1)?.definition.tool_settings).toEqual({ "mcp:github/list_issues": { permission: "deny" } });
    expect(page.shown("mcp:github/list_issues")?.value).toBe("deny");
    // A built-in tool's row, capabilities', as it was.
    expect(page.shown("web_fetch")).toEqual(before);
    expect(page.shown("web_fetch")).toEqual({ value: "allow", label: "allow (default)" });
  });

  it("the agent's own setting for every tool of the MCP server comes first: the row shows it, and a choice unlike it is kept for the tool", async () => {
    const page = await open(github("allow"), { "mcp:github/*": { permission: "deny" } });
    await page.tick("mcp:github/list_issues");
    expect(page.shown("mcp:github/list_issues")).toEqual({ value: "deny", label: "deny (default)" });
    await page.choose("mcp:github/list_issues", "allow");
    await page.save();
    expect(page.puts.at(-1)?.definition.tool_settings).toEqual({ "mcp:github/*": { permission: "deny" }, "mcp:github/list_issues": { permission: "allow" } });
  });

  it("a saved MCP tool's row falls back to the agent's own setting for its MCP server too, and the agent's own key for the tool wins over it", async () => {
    // Saved: the agent denies every github tool and allows list_issues alone; the server's own default for it is ask.
    const page = await open(github("ask"), { "mcp:github/*": { permission: "deny" }, "mcp:github/list_issues": { permission: "allow" } }, { tools: ["read", "web_fetch", "mcp:github/list_issues", "mcp:github/create_issue"], mcp: { inForce: "deny", server: "ask" } });
    expect(page.shown("mcp:github/list_issues")?.value).toBe("allow");
    expect(page.row("mcp:github/list_issues")!.textContent).toContain("default: deny");
    expect(page.shown("mcp:github/create_issue")).toEqual({ value: "deny", label: "deny (default)" });
  });

  it("a monid tool ticked and not saved: its row is there at once with the permission capabilities give it in force", async () => {
    const page = await open(github("allow"));
    expect(page.row("monid.discover")).toBeNull();
    await page.tick("monid.discover");
    // Allowed in force on this server (its default is ask): a tool the server denies can't be ticked at all (ServerDeny).
    expect(page.shown("monid.discover")).toEqual({ value: "allow", label: "allow (default)" });
  });

  it("a server whose read gives no permission (an older one): the row waits for the save, as before", async () => {
    const page = await open(github());
    await page.tick("mcp:github/list_issues");
    expect(page.row("mcp:github/list_issues")).toBeNull();
  });
});
