import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { ToolTable, toolRows } from "./ToolSettings";
import { ToolsPage } from "./ToolsPage";
import type { Agent, AgentFields } from "@/lib/agentForm";
import { toolChoices, toolGates } from "@/lib/toolSettings";
import type { ToolSettings } from "@/lib/v2";
import { pick } from "@/test/picker";
import { servedAgent } from "@/test/agent";

// PUT /v2/settings/tools replaces the whole map, and an agent's save sends its whole tool_settings. A save from the
// console is a read-modify-write of the WHOLE map: it reads the map as it is now, changes only the key and the field the
// person touched, and writes everything else back as it was: a permission, a provider, an MCP server's wildcard, a
// catalog tool's key, and any field this console does not know.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const choose = async (s: HTMLButtonElement, value: string) => {
  await pick(s, value);
  await settle();
};

const ALL = ["allow", "ask", "deny"];
const SEARCH = { name: "web_search", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "auto", default_provider: "auto", available: true, resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" } };
const FETCH = { name: "web_fetch", providers: ["kernel", "parallel"], provider: "kernel", default_provider: "kernel", available: true, resolves: { pi: "kernel", "claude-agent": "native", codex: "native" } };
const RAW = [
  { name: "read", available: true, permission: "allow", default_permission: "allow", permissions: ALL },
  { name: "bash", available: true, permission: "allow", default_permission: "allow", permissions: ALL },
  { ...FETCH, permission: "allow", default_permission: "allow", permissions: ALL },
  { ...SEARCH, permission: "allow", default_permission: "allow", permissions: ALL },
];

/** The server: its map, a GET's answer with each capability's provider filled in, and every PUT. `meanwhile` changes the
 *  map between the page's first read and its save, as another tab or a script would. */
function server(start: ToolSettings) {
  let held: ToolSettings = structuredClone(start);
  const answer = (): ToolSettings => ({ ...structuredClone(held), web_search: { ...held.web_search, provider: held.web_search?.provider ?? "auto" }, web_fetch: { ...held.web_fetch, provider: held.web_fetch?.provider ?? "kernel" } });
  const puts: ToolSettings[] = [];
  let reads = 0;
  const v2 = { toolSettings: async () => { reads++; return answer(); }, saveToolSettings: async (body: ToolSettings) => { puts.push(structuredClone(body)); held = structuredClone(body); return answer(); } };
  return { v2, puts, reads: () => reads, meanwhile: (next: ToolSettings) => { held = structuredClone(next); } };
}

async function openPage(start: ToolSettings) {
  const s = server(start);
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(ToolsPage, { v2: s.v2 as never, choices: toolChoices(RAW), gates: toolGates(RAW), onSaved: () => {} })));
  await settle();
  const select = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-haspopup=listbox][aria-label="${label}"]`)!;
  return { ...s, host, select };
}

describe("Settings → Tools saves the whole map, read then changed in one place", () => {
  it("a provider change keeps a deny permission, an MCP server's wildcard and a catalog tool's key", async () => {
    const page = await openPage({ bash: { permission: "deny" }, "mcp:linear/*": { permission: "deny" }, "monid.run": { permission: "allow" } });
    await choose(page.select("web_search provider"), "parallel");
    expect(page.puts).toEqual([{ web_search: { provider: "parallel" }, bash: { permission: "deny" }, "mcp:linear/*": { permission: "deny" }, "monid.run": { permission: "allow" } }]);
  });

  it("keeps a field this console doesn't know, on the key it changes and on any other", async () => {
    const page = await openPage({ web_search: { provider: "native", budget: 3 } as never, "mcp:linear/*": { permission: "ask", note: "later" } as never });
    await choose(page.select("web_search permission"), "deny");
    expect(page.puts).toEqual([{ web_search: { provider: "native", permission: "deny", budget: 3 }, "mcp:linear/*": { permission: "ask", note: "later" } }]);
  });

  it("reads the map again before it saves: a key set meanwhile (another tab) is kept, and only the touched field changes", async () => {
    const page = await openPage({ bash: { permission: "deny" } });
    page.meanwhile({ bash: { permission: "deny" }, "mcp:github/*": { permission: "deny" }, read: { permission: "ask" } });
    await choose(page.select("bash permission"), "ask");
    expect(page.puts).toEqual([{ bash: { permission: "ask" }, "mcp:github/*": { permission: "deny" }, read: { permission: "ask" } }]);
    expect(page.reads()).toBeGreaterThanOrEqual(2);
  });

  it("the provider column for web_search and web_fetch is the same with the permission column beside it as without", () => {
    const cells = (withGates: boolean) => {
      const html = renderToStaticMarkup(createElement(ToolTable, { label: "t", rows: toolRows(toolChoices([SEARCH, FETCH]), withGates ? toolGates(RAW) : []), settings: { web_search: { provider: "parallel" } }, fallbackOf: (t) => t.default_provider, resolvesOf: () => "r", issues: {}, onEdit: () => {} }));
      const doc = new DOMParser().parseFromString(html, "text/html");
      // Headless UI numbers its fields' ids per render: the same cell either way, but for those.
      return ["web_search", "web_fetch"].map((n) => doc.querySelector(`tr[data-tool="${n}"] button[aria-haspopup=listbox][aria-label="${n} provider"]`)!.closest("td")!.outerHTML.replace(/ (id|aria-controls)="[^"]*"/g, ""));
    };
    expect(cells(true)).toEqual(cells(false));
    expect(cells(false)[0]).toContain("aria-label=\"web_search provider\"");
  });
});

describe("the agent editor saves the agent's whole tool_settings, changed in one place", () => {
  const agent: Agent = servedAgent({
    agent_id: "fetcher", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
    definition: { version: 1, name: "Fetcher", instructions: "Fetch it.", harness: "pi", skills: [], tools: ["read", "web_fetch", "web_search"],
      tool_settings: { web_search: { provider: "parallel", budget: 3 } as never, "mcp:linear/*": { permission: "deny" }, "monid.run": { permission: "allow", note: "ok" } as never } },
  });
  it("a permission change keeps the provider, unknown fields, an MCP wildcard and a catalog tool's key", async () => {
    const saves: AgentFields[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const caps = { harnesses: [{ id: "pi", available: true }], tools: RAW.map(({ name }) => ({ name, available: true })), thinking: [] };
    act(() => root!.render(createElement(AgentEditor, { agent, caps, providerChoices: toolChoices(RAW), permissionGates: toolGates(RAW), step: "tools", onSave: async (f: AgentFields) => { saves.push(f); return null; } })));
    await settle();
    const scope = host.querySelector("section[aria-label='Tool settings']")!;
    await choose(scope.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox][aria-label='web_search permission']")!, "ask");
    await choose(scope.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox][aria-label='web_fetch permission']")!, "deny");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /^Save revision$/.test(b.textContent?.trim() ?? ""))!.click(); });
    await settle();
    expect(saves.at(-1)?.tool_settings).toEqual({ web_search: { provider: "parallel", budget: 3, permission: "ask" }, web_fetch: { permission: "deny" }, "mcp:linear/*": { permission: "deny" }, "monid.run": { permission: "allow", note: "ok" } });
  });
});
