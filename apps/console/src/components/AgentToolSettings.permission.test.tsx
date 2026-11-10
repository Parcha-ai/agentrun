import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import type { Agent, AgentFields } from "@/lib/agentForm";
import { toolChoices, toolGates } from "@/lib/toolSettings";
import { optionsOf, pick, valueOf } from "@/test/picker";
import { servedAgent } from "@/test/agent";

// An agent's own permission for each tool it grants, in the editor's Tools step: the server's permission its default,
// one set here marked and saved in the definition's tool_settings beside any provider.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const ALL: ("allow" | "ask" | "deny")[] = ["allow", "ask", "deny"];
const SEARCH = { name: "web_search", available: true, providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "auto", default_provider: "auto", resolves: { pi: "exa-keyless" }, permission: "allow", default_permission: "allow", permissions: ALL };
const RAW = [
  { name: "read", available: true, permission: "allow", default_permission: "allow", permissions: ALL },
  { name: "bash", available: true, permission: "deny", default_permission: "allow", permissions: ALL },
  SEARCH,
];
const caps = { harnesses: [{ id: "pi", available: true }], tools: RAW.map(({ name, available }) => ({ name, available })), thinking: [] };
const agentWith = (toolSettings?: Agent["definition"]["tool_settings"], over: Partial<Agent> = {}): Agent => servedAgent({
  agent_id: "fetcher", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Fetcher", instructions: "Fetch it.", harness: "pi", skills: [], tools: ["read", "bash", "web_search"], ...(toolSettings ? { tool_settings: toolSettings } : {}) },
  ...over,
});

async function open(agent: Agent, askNeeds = false) {
  const saves: AgentFields[] = [];
  const raw = RAW.map((t) => (askNeeds ? { ...t, ask_needs: "password" } : t));
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent, caps, providerChoices: toolChoices(raw), permissionGates: toolGates(raw), step: "tools", onSave: async (f: AgentFields) => { saves.push(f); return null; } })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const row = (tool: string) => host.querySelector<HTMLTableRowElement>(`section[aria-label="Tool settings"] tr[data-tool="${tool}"]`);
  const permission = (tool: string) => row(tool)!.querySelector<HTMLButtonElement>(`button[aria-haspopup=listbox][aria-label="${tool} permission"]`)!;
  const choose = async (tool: string, value: string) => {
    await pick(permission(tool), value);
    await settle();
  };
  const click = async (label: RegExp) => { await act(async () => { [...host.querySelectorAll("button")].find((b) => label.test((b.textContent ?? "").trim()))!.click(); }); await settle(); };
  return { host, saves, row, permission, choose, click };
}

describe("AgentEditor, an agent's tool permissions", () => {
  it("lists every granted tool with a permission, the server's in force its default", async () => {
    const page = await open(agentWith());
    expect(["read", "bash", "web_search"].map((t) => !!page.row(t))).toEqual([true, true, true]);
    // bash is denied by this server and held there: its picker shows deny, and is not to be changed.
    expect(valueOf(page.permission("bash"))).toBe("deny");
    expect(page.permission("bash").disabled).toBe(true);
    expect((await optionsOf(page.permission("read"))).map((o) => o.text)).toEqual(["allow (default)", "ask", "deny"]);
  });

  it("a permission set here is saved in tool_settings beside the agent's own provider", async () => {
    const page = await open(agentWith({ web_search: { provider: "parallel" } }));
    await page.choose("web_search", "ask");
    await page.click(/^Save revision$/);
    expect(page.saves.at(-1)?.tool_settings).toEqual({ web_search: { provider: "parallel", permission: "ask" } });
  });

  it("takes the server's word for this agent's default when GET /agents/{id} gave it", async () => {
    const page = await open(agentWith(undefined, { tools: [{ name: "read", permission: "ask", permission_from: "server", default_permission: "ask", permissions: ALL }] }));
    expect(valueOf(page.permission("read"))).toBe("ask");
    expect((await optionsOf(page.permission("read"))).map((o) => o.text)).toEqual(["allow", "ask (default)", "deny"]);
  });

  it("with accounts off, ask is disabled with why", async () => {
    const page = await open(agentWith(), true);
    expect((await optionsOf(page.permission("read"))).find((o) => o.value === "ask")!.disabled).toBe(true);
    expect(page.host.textContent).toContain("Ask is off on this server");
  });
});
