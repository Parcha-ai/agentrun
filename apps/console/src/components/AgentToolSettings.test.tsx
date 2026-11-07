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

  it("with the server's web_search off, an agent that does not grant it picks its own provider first, then grants it, and saves both", async () => {
    const OFF = "web_search is turned off in settings";
    const off = toolChoices([{ ...SEARCH, provider: "off", available: false, reason: OFF, resolves: { pi: `unavailable: ${OFF}`, "claude-agent": `unavailable: ${OFF}`, codex: `unavailable: ${OFF}` } }, FETCH]);
    const offCaps = { ...caps, tools: caps.tools.map((t) => (t.name === "web_search" ? { ...t, available: false } : t)) };
    const base = agentWith();
    const agent: Agent = { ...base, definition: { ...base.definition, tools: ["read"] }, tools: [{ name: "read" }] };
    const page = await open(agent, { providerChoices: off, editorCaps: offCaps });
    const grant = () => page.host.querySelector<HTMLInputElement>('input[value="web_search"]')!;
    // The server's off is the only obstacle: the grant waits for a provider of the agent's own, offered before it.
    expect(grant().disabled).toBe(true);
    expect(page.row("web_search")).toBeTruthy();
    await page.choose("web_search", "exa-keyless");
    expect(grant().disabled).toBe(false);
    await act(async () => { grant().click(); });
    await page.click(/^Save revision$/);
    expect(page.saves[0].tool_settings).toEqual({ web_search: { provider: "exa-keyless" } });
    expect(page.saves[0].tools).toContain("web_search");
  });

  it("what a tool resolves to is the server's word only for the model it was read for: another model in the form says once saved", async () => {
    const base = agentWith(undefined, "native");
    const agent: Agent = { ...base, definition: { ...base.definition, model: "anthropic/claude-sonnet-5" } };
    const page = await open(agent);
    expect(page.row("web_search")!.textContent).toContain("pi: native");
    await page.click(/Harness, thinking and model/);
    const model = page.host.querySelector<HTMLInputElement>('input[placeholder="provider/model"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(model, "openai/gpt-x"); model.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.click(/What this agent can do/);
    expect(page.row("web_search")!.textContent).not.toContain("pi: native");
    expect(page.row("web_search")!.textContent).toContain("once saved");
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

// The second review: a pick made while a save is under way is kept (never cleared by that save's answer), and the agent's
// resolution is shown only beside the provider it was read for.
describe("AgentEditor, tool settings around a save and a stale read", () => {
  it("a pick made while a save is pending survives that save, unsaved and marked", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const saves: AgentFields[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent: agentWith(), caps, providerChoices: choices, step: "tools", onSave: async (fields: AgentFields) => { saves.push(fields); await held; return null; } })));
    const select = () => host.querySelector<HTMLTableRowElement>('section[aria-label="Tool settings"] tr[data-tool="web_search"]')!.querySelector("select")!;
    const choose = async (p: string) => { await act(async () => { const s = select(); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, p); s.dispatchEvent(new Event("change", { bubbles: true })); }); };
    await choose("parallel");
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /^Save/.test((b.textContent ?? "").trim()))!.click(); });
    // While that save is under way, the person picks another provider.
    await choose("native");
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(saves[0]!.tool_settings).toEqual({ web_search: { provider: "parallel" } });
    expect(select().value).toBe("native");
  });

  // While a save is under way, the form's settings are measured against what that save sent, which the agent's definition
  // becomes once it lands, never against the definition from before it: a change back to that older one is a change.
  async function pending(before: Agent, after: Agent) {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const saves: AgentFields[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const render = (agent: Agent) => root!.render(createElement(AgentEditor, { agent, caps, providerChoices: choices, step: "tools", onSave }));
    // As AgentEditPage does: the saved agent is put in before the save's answer comes back to the editor.
    const onSave = async (fields: AgentFields) => { saves.push(fields); if (saves.length === 1) { await held; render(after); } return null; };
    act(() => render(before));
    const row = () => host.querySelector<HTMLTableRowElement>('section[aria-label="Tool settings"] tr[data-tool="web_search"]')!;
    const select = () => row().querySelector("select")!;
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    const choose = async (p: string) => { await act(async () => { const s = select(); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, p); s.dispatchEvent(new Event("change", { bubbles: true })); }); };
    const click = async (label: RegExp) => { await act(async () => { [...host.querySelectorAll("button")].find((b) => label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()))!.click(); }); };
    const land = async () => { await act(async () => { release(); }); await settle(); };
    return { saves, row, select, choose, click, land };
  }

  it("a reset made while a save of a pick is pending is kept: the saved pick doesn't come back, and the reset saves", async () => {
    // An agent with no provider of its own: pick Parallel, save, and reset before the save comes back.
    const page = await pending(agentWith(), agentWith({ web_search: { provider: "parallel" } }, "parallel"));
    await page.choose("parallel");
    await page.click(/^Save/);
    await page.click(/^Reset web_search/);
    await page.land();
    expect(page.saves[0]!.tool_settings).toEqual({ web_search: { provider: "parallel" } });
    // The reset stands, unsaved: the server's pick, not the Parallel that save put in the definition.
    expect(page.select().value).toBe("exa-keyless");
    expect(page.row().hasAttribute("data-set")).toBe(false);
    // And the next save sends it: the agent's own provider goes.
    await page.click(/^Save/);
    expect(page.saves[1]!.tool_settings).toEqual({});
    expect("tool_settings" in editBody(agentWith({ web_search: { provider: "parallel" } }), page.saves[1]!, "").definition).toBe(false);
  });

  it("a pick made while a reset's save is pending, back to the agent's old provider, is kept", async () => {
    // An agent with Parallel of its own: reset, save, and pick Parallel again before the save comes back.
    const page = await pending(agentWith({ web_search: { provider: "parallel" } }, "parallel"), agentWith());
    await page.click(/^Reset web_search/);
    await page.click(/^Save/);
    await page.choose("parallel");
    await page.land();
    expect(page.saves[0]!.tool_settings).toEqual({});
    expect(page.select().value).toBe("parallel");
    expect(page.row().hasAttribute("data-set")).toBe(true);
    await page.click(/^Save/);
    expect(page.saves[1]!.tool_settings).toEqual({ web_search: { provider: "parallel" } });
  });

  it("the agent's resolution shows only beside the provider it was read for: another one since says once saved", async () => {
    // The agent read says the server's provider is now parallel (changed in another tab), while capabilities, read
    // earlier, still say exa-keyless: the select shows exa-keyless, so the agent's word is not shown beside it.
    const agent = agentWith(undefined, "parallel");
    agent.tools = [{ name: "read" }, { name: "web_search", provider: "parallel", provider_from: "server", default_provider: "exa-keyless", resolved: "parallel" }] as Agent["tools"];
    const page = await open(agent);
    expect(page.select("web_search").value).toBe("exa-keyless");
    expect(page.row("web_search")!.textContent).not.toContain("pi: Parallel");
    // Capabilities' word, read with the provider the select shows.
    expect(page.row("web_search")!.textContent).toContain("pi: Exa keyless");
  });
});

// On a phone (375 px) the provider table is wider than the screen: it scrolls in a box of its own, never the page.
describe("AgentEditor, the tool settings on a narrow screen", () => {
  it("holds the provider table in a box that scrolls sideways", async () => {
    const page = await open(agentWith());
    const table = page.host.querySelector("section[aria-label=\"Tool settings\"] table")!;
    expect(table.parentElement!.className.split(" ")).toContain("overflow-x-auto");
    // Positioned, so the header's screen-reader "Reset" (absolute, sr-only) is placed inside the box and scrolls with it:
    // unpositioned, it hung past the box and widened the page to 427 px.
    expect(table.parentElement!.className.split(" ")).toContain("relative");
  });
});
