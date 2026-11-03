import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, type AgentFields, editBody } from "@/lib/agentForm";
import { toolChoices } from "@/lib/toolSettings";

// An agent's tool settings, in the editor's Tools step: a provider for each tool it grants that has a choice, the
// server's pick its default; one set here is marked, with a reset, and saved in the definition's tool_settings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const tools = [{ name: "read", available: true }, { name: "web_search", available: true }, { name: "web_fetch", available: true }];
const caps = { harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }], tools, thinking: ["low"] };
// capabilities.tools' choices: the server picks exa-keyless for web_search; web_fetch is at its default.
const SEARCH = { name: "web_search", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "exa-keyless", default_provider: "auto", available: true, resolves: { pi: "exa-keyless", "claude-agent": "exa-keyless", codex: "native" } };
const FETCH = { name: "web_fetch", providers: ["kernel", "parallel"], provider: "kernel", default_provider: "kernel", resolves: { pi: "kernel", "claude-agent": "native", codex: "native" } };
const choices = toolChoices([SEARCH, FETCH]);
const agentWith = (toolSettings?: Agent["definition"]["tool_settings"], resolved = "exa-keyless"): Agent => ({
  agent_id: "searcher", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Searcher", instructions: "Look it up.", harness: "pi", skills: [], tools: ["read", "web_search"], ...(toolSettings ? { tool_settings: toolSettings } : {}) },
  // GET /agents/{id}'s tools: what each grant resolves to for this agent.
  tools: [{ name: "read" }, { name: "web_search", provider: toolSettings?.web_search?.provider ?? "exa-keyless", provider_from: toolSettings ? "agent" : "server", default_provider: "exa-keyless", resolved }],
});

async function open(agent: Agent, { providerChoices = choices, editorCaps = caps }: { providerChoices?: typeof choices; editorCaps?: typeof caps } = {}) {
  const saves: AgentFields[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent, caps: editorCaps, providerChoices, step: "tools", onSave: async (fields: AgentFields) => { saves.push(fields); return null; } })));
  const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await settle();
  const row = (tool: string) => host.querySelector<HTMLTableRowElement>(`section[aria-label="Tool settings"] tr[data-tool="${tool}"]`);
  const select = (tool: string) => row(tool)!.querySelector("select")!;
  const choose = async (tool: string, provider: string) => {
    await act(async () => { const s = select(tool); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, provider); s.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  const button = (label: RegExp) => [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()));
  const click = async (label: RegExp) => { await act(async () => { button(label)!.click(); }); await settle(); };
  return { host, saves, row, select, choose, click };
}

describe("AgentEditor, an agent's tool settings", () => {
  it("lists only the granted tools that have a choice, the server's pick as their default, chosen", async () => {
    const page = await open(agentWith());
    expect(page.row("web_search")).toBeTruthy();
    expect(page.row("web_fetch")).toBeNull();
    expect(page.row("read")).toBeNull();
    expect([...page.select("web_search").options].map((o) => o.textContent)).toEqual(["auto", "native", "Exa keyless (default)", "Parallel", "off"]);
    expect(page.select("web_search").value).toBe("exa-keyless");
    expect(page.row("web_search")!.hasAttribute("data-set")).toBe(false);
    // The server's word on what it resolves to for this agent.
    expect(page.row("web_search")!.textContent).toContain("pi: Exa keyless");
  });

  it("a pick unlike the default is marked and saved in the definition's tool_settings; what it resolves to waits for the save", async () => {
    const agent = agentWith();
    const page = await open(agent);
    await page.choose("web_search", "parallel");
    expect(page.row("web_search")!.hasAttribute("data-set")).toBe(true);
    expect(page.row("web_search")!.textContent).toContain("default: Exa keyless");
    expect(page.row("web_search")!.textContent).toContain("once saved");
    await page.click(/^Save revision$/);
    expect(page.saves).toHaveLength(1);
    expect(page.saves[0].tool_settings).toEqual({ web_search: { provider: "parallel" } });
    expect(editBody(agent, page.saves[0], "").definition.tool_settings).toEqual({ web_search: { provider: "parallel" } });
  });

  it("with the server's web_search off, its tool says it is unavailable with the server's reason, and so does what it resolves to", async () => {
    const OFF = "web_search is turned off in settings";
    const off = toolChoices([{ ...SEARCH, provider: "off", available: false, reason: OFF, resolves: { pi: `unavailable: ${OFF}`, "claude-agent": `unavailable: ${OFF}`, codex: `unavailable: ${OFF}` } }, FETCH]);
    const offCaps = { ...caps, tools: caps.tools.map((t) => (t.name === "web_search" ? { ...t, available: false } : t)) };
    const agent = agentWith(undefined, `unavailable: ${OFF}`);
    const page = await open(agent, { providerChoices: off, editorCaps: offCaps });
    expect(page.host.querySelector('input[value="web_search"]')!.closest("label")!.textContent).toContain(OFF);
    // The server's off is this agent's default: chosen, unmarked, and what it resolves to is the server's word.
    expect(page.select("web_search").value).toBe("off");
    expect(page.row("web_search")!.hasAttribute("data-set")).toBe(false);
    expect(page.row("web_search")!.textContent).toContain(`pi: unavailable: ${OFF}`);
  });

  it("reloaded, the agent's own pick is chosen and marked; Reset takes it back to the server's, and the definition carries none", async () => {
    const agent = agentWith({ web_search: { provider: "parallel" } }, "unavailable: PARALLEL_API_KEY is not set");
    const page = await open(agent);
    expect(page.select("web_search").value).toBe("parallel");
    expect(page.row("web_search")!.hasAttribute("data-set")).toBe(true);
    expect(page.row("web_search")!.textContent).toContain("pi: unavailable: PARALLEL_API_KEY is not set");
    await page.click(/^Reset web_search to its default$/);
    expect(page.select("web_search").value).toBe("exa-keyless");
    expect(page.row("web_search")!.hasAttribute("data-set")).toBe(false);
    await page.click(/^Save revision$/);
    expect(page.saves[0].tool_settings).toEqual({});
    const body = editBody(agent, page.saves[0], "");
    expect("tool_settings" in body.definition).toBe(false);
    expect(body.unchanged).toBe(false);
  });
});
