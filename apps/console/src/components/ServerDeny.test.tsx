import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { ToolsPage } from "./ToolsPage";
import type { Agent } from "@/lib/agentForm";
import { toolChoices, toolGates } from "@/lib/toolSettings";
import type { AgentTool, ToolSettings } from "@/lib/v2";
import { picker, valueOf } from "@/test/picker";

// A server's deny is absolute: a tool set to deny in the server's table is refused for every agent, whatever the agent's
// own setting or Never ask. Settings → Tools says so at the row; the agent editor says the same at the tool, keeps its
// permission at deny, and doesn't offer the tool to tick. The agent's read says it per tool: permission "deny" with
// permission_from "server".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const LINE = "Refused on this server for every agent, whatever the agent's own setting or Never ask.";
const ALL: ("allow" | "ask" | "deny")[] = ["allow", "ask", "deny"];
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = () => { const host = document.body.appendChild(document.createElement("div")); root = createRoot(host); return host; };

describe("a server deny, in Settings → Tools", () => {
  async function open(start: ToolSettings) {
    let held: ToolSettings = { ...start };
    const raw = () => [
      { name: "read", permissions: ALL, default_permission: "allow" },
      { name: "bash", permissions: ALL, default_permission: "allow" },
    ].map((t) => ({ ...t, available: true, permission: held[t.name]?.permission ?? t.default_permission }));
    const v2 = { toolSettings: async () => held, saveToolSettings: async (body: ToolSettings) => { held = { ...body }; return held; } };
    const host = mount();
    const render = () => act(() => { root!.render(createElement(ToolsPage, { v2: v2 as never, choices: toolChoices(raw()), gates: toolGates(raw()), onSaved: () => render() })); });
    render();
    await settle();
    return { host, row: (tool: string) => host.querySelector<HTMLTableRowElement>(`tr[data-tool="${tool}"]`)! };
  }

  it("says at a deny row that it holds for every agent, and only there", async () => {
    const page = await open({ bash: { permission: "deny" } });
    expect(page.row("bash").textContent).toContain(LINE);
    expect(page.row("read").textContent).not.toContain(LINE);
  });

  it("never says an agent's own permission keeps it over a deny here", async () => {
    const page = await open({});
    expect(page.host.textContent).not.toContain("An agent with a permission of its own keeps it.");
    expect(page.host.textContent).toContain("deny here refuses it for every agent");
  });
});

describe("a server deny, in the agent editor", () => {
  const RAW = [
    { name: "read", available: true, permission: "allow", default_permission: "allow", permissions: ALL },
    { name: "bash", available: true, permission: "deny", default_permission: "allow", permissions: ALL },
  ];
  const caps = { harnesses: [{ id: "pi", available: true }], tools: RAW.map(({ name, available }) => ({ name, available, harnesses: ["pi"] })), thinking: [] };
  const agentWith = (tools: string[], over: Partial<Agent> = {}, toolSettings?: ToolSettings): Agent => ({
    agent_id: "fixer", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
    definition: { version: 1, name: "Fixer", instructions: "Fix it.", harness: "pi", skills: [], tools, ...(toolSettings ? { tool_settings: toolSettings } : {}) },
    ...over,
  });
  async function open(agent: Agent, raw = RAW) {
    const host = mount();
    act(() => root!.render(createElement(AgentEditor, { agent, caps, providerChoices: toolChoices(raw), permissionGates: toolGates(raw), step: "tools", onSave: async () => null })));
    await settle();
    const row = (tool: string) => host.querySelector<HTMLTableRowElement>(`section[aria-label="Tool settings"] tr[data-tool="${tool}"]`)!;
    const select = (tool: string) => picker(row(tool), `${tool} permission`)!;
    const tick = (tool: string) => host.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${tool}"]`)!;
    return { host, row, select, tick };
  }

  it("keeps a server-denied tool's permission at deny, says why, and leaves the others to set", async () => {
    // The agent's own allow is kept in its definition, and holds nothing over the server's deny.
    const page = await open(agentWith(["read", "bash"], {}, { bash: { permission: "allow" } }));
    expect(valueOf(page.select("bash"))).toBe("deny");
    expect(page.select("bash").disabled).toBe(true);
    expect(page.row("bash").textContent).toContain(LINE);
    expect(page.select("read").disabled).toBe(false);
    expect(page.row("read").textContent).not.toContain(LINE);
  });

  it("reads the agent's own word for a tool capabilities don't list: permission deny from the server", async () => {
    const served: AgentTool[] = [{ name: "mcp:linear/create_issue", permission: "deny", permission_from: "server", default_permission: "allow", permissions: ALL }];
    const page = await open(agentWith(["read", "mcp:linear/create_issue"], { tools: served }), [RAW[0]!]);
    expect(page.select("mcp:linear/create_issue").disabled).toBe(true);
    expect(page.row("mcp:linear/create_issue").textContent).toContain(LINE);
  });

  it("doesn't offer a server-denied tool to tick, and says why", async () => {
    const page = await open(agentWith(["read"]));
    expect(page.tick("bash").disabled).toBe(true);
    expect(page.tick("bash").closest("label")!.textContent).toContain(LINE);
    expect(page.tick("read").disabled).toBe(false);
  });

  // An MCP server as its read gives it: each tool with this server's permission in force.
  const LINEAR = { name: "linear", url: "https://mcp.example.test/mcp", auth: { type: "none" }, credential: null, protocol: "2025-06-18", server_info: null, listed_at: "2026-11-08T00:00:00Z", updated_at: "2026-11-08T00:00:00Z",
    tools: [
      { name: "create_issue", input_schema: {}, permission: "deny", default_permission: "allow", permissions: ALL },
      { name: "list_issues", input_schema: {}, permission: "allow", default_permission: "allow", permissions: ALL },
    ] };
  async function openMcp(agent: Agent) {
    const host = mount();
    act(() => root!.render(createElement(AgentEditor, { agent, caps: { ...caps, mcp: true, mcpHarnesses: ["pi"] }, providerChoices: toolChoices(RAW), permissionGates: toolGates(RAW), mcpServers: [LINEAR] as never, step: "tools", onSave: async () => null })));
    await settle();
    const row = (tool: string) => host.querySelector<HTMLTableRowElement>(`section[aria-label="Tool settings"] tr[data-tool="${tool}"]`)!;
    const select = (tool: string) => picker(row(tool), `${tool} permission`)!;
    const tick = (tool: string) => host.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${tool}"]`)!;
    return { host, row, select, tick };
  }

  it("an MCP tool picked from its server's read, not saved yet, is held at deny when that read says the server denies it", async () => {
    const page = await openMcp(agentWith(["read", "mcp:linear/create_issue"]));
    expect(page.select("mcp:linear/create_issue").disabled).toBe(true);
    expect(valueOf(page.select("mcp:linear/create_issue"))).toBe("deny");
    expect(page.row("mcp:linear/create_issue").textContent).toContain(LINE);
  });

  it("the MCP picker doesn't offer a tool its server's read says this server denies, and says why", async () => {
    const page = await openMcp(agentWith(["read"]));
    expect(page.tick("mcp:linear/create_issue").disabled).toBe(true);
    expect(page.tick("mcp:linear/create_issue").closest("label")!.textContent).toContain(LINE);
    expect(page.tick("mcp:linear/list_issues").disabled).toBe(false);
  });

  it("the agent's read is newer than capabilities: a deny lifted since capabilities were read no longer holds the tool", async () => {
    // Capabilities (read as the editor opened) still say bash is denied; the agent's read, after, says it is allowed.
    const served: AgentTool[] = [{ name: "bash", permission: "allow", permission_from: "default", default_permission: "allow", permissions: ALL }];
    const page = await open(agentWith(["read", "bash"], { tools: served }));
    expect(page.select("bash").disabled).toBe(false);
    expect(page.row("bash").textContent).not.toContain(LINE);
  });
});
