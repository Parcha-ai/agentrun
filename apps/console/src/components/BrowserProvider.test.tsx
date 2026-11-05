import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { PerHarness, ToolTable, toolRows } from "./ToolSettings";
import type { Agent, AgentFields } from "@/lib/agentForm";
import { providerHelp, providerLabel, toolChoices } from "@/lib/toolSettings";

// The browser's providers (serve's tool-plane.ts PROVIDERS.browser: auto, browserbase, kernel, chrome) read as the
// browser's, not through the labels web_search and web_fetch share: there "kernel" is the guarded fetch and "auto" the
// search rule. Settings → Tools and an agent's editor both show them in the same table.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const SEARCH = { name: "web_search", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "auto", default_provider: "auto", available: true, resolves: { pi: "exa-keyless" } };
const FETCH = { name: "web_fetch", providers: ["kernel", "parallel"], provider: "kernel", default_provider: "kernel", available: true, resolves: { pi: "kernel" } };
const BROWSER = { name: "browser", providers: ["auto", "browserbase", "kernel", "chrome"], provider: "auto", default_provider: "auto", available: true, resolves: { pi: "kernel", "claude-agent": "kernel", codex: "kernel", opencode: "kernel" } };
const choices = toolChoices([SEARCH, FETCH, BROWSER]);
const AUTO = "Auto (Browserbase where its key is saved, else Kernel)";

describe("the browser's provider names and help", () => {
  it("names each browser provider as the browser's", () => {
    expect(["auto", "browserbase", "kernel", "chrome"].map((p) => providerLabel(p, "browser"))).toEqual([AUTO, "Browserbase", "Kernel", "Local Chrome"]);
  });

  it("explains each in a line of its own, none borrowed from search or fetch", () => {
    const help = ["auto", "browserbase", "kernel", "chrome"].map((p) => providerHelp(p, "browser"));
    expect(help.every(Boolean)).toBe(true);
    expect(new Set(help).size).toBe(4);
    expect(help).not.toContain(providerHelp("kernel", "web_fetch"));
    expect(help).not.toContain(providerHelp("auto", "web_search"));
    expect(providerHelp("kernel", "browser")).toMatch(/Kernel/);
    expect(providerHelp("browserbase", "browser")).toMatch(/Browserbase/);
  });

  it("leaves search's and fetch's names and help as they were", () => {
    expect(["auto", "native", "exa-keyless", "parallel"].map((p) => providerLabel(p, "web_search"))).toEqual(["auto", "native", "Exa keyless", "Parallel"]);
    expect(["kernel", "parallel"].map((p) => providerLabel(p, "web_fetch"))).toEqual(["kernel fetch", "Parallel"]);
    expect(providerHelp("kernel", "web_fetch")).toBe("This server's own fetch, guarded against private addresses.");
    expect(providerHelp("auto", "web_search")).toBe("The harness's own search, or the model provider's hosted one, else keyless Exa.");
    // A caller that names no tool reads the shared names, as before.
    expect(providerLabel("kernel")).toBe("kernel fetch");
  });
});

describe("Settings → Tools, the browser row", () => {
  function table() {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(ToolTable, { label: "This server's tool providers", rows: toolRows(choices, []), settings: {}, fallbackOf: (t) => t.default_provider, resolvesOf: (t) => createElement(PerHarness, { choice: t }), issues: {}, onEdit: () => {} })));
    const row = (tool: string) => host.querySelector<HTMLTableRowElement>(`tr[data-tool="${tool}"]`)!;
    return { row, options: (tool: string) => [...row(tool).querySelectorAll("option")].map((o) => o.textContent) };
  }

  it("offers the browser's choices by name, explains the one picked, and says what it resolves to as the browser's", () => {
    const t = table();
    expect(t.options("browser")).toEqual([`${AUTO} (default)`, "Browserbase", "Kernel", "Local Chrome"]);
    expect(t.row("browser").textContent).toContain(providerHelp("auto", "browser")!);
    expect(t.row("browser").textContent).toContain("pi: Kernel");
    expect(t.row("browser").textContent).not.toContain("kernel fetch");
  });

  it("search's and fetch's rows read as they did", () => {
    const t = table();
    expect(t.options("web_search")).toEqual(["auto (default)", "native", "Exa keyless", "Parallel", "off"]);
    expect(t.options("web_fetch")).toEqual(["kernel fetch (default)", "Parallel"]);
    expect(t.row("web_fetch").textContent).toContain("pi: kernel fetch");
  });
});

describe("an agent's browser pick in its editor", () => {
  const caps = { harnesses: [{ id: "pi", available: true }], tools: [{ name: "read", available: true }, { name: "browser", available: true }], thinking: ["low"] };
  const agentWith = (provider?: string): Agent => ({
    agent_id: "browsing", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
    definition: { version: 1, name: "Browsing", instructions: "Look.", harness: "pi", skills: [], tools: ["read", "browser"], ...(provider ? { tool_settings: { browser: { provider } } } : {}) },
    tools: [{ name: "read" }, { name: "browser", provider: provider ?? "auto", provider_from: provider ? "agent" : "server", default_provider: "auto", resolved: provider === "browserbase" ? "browserbase" : "kernel" }],
  });
  async function open(agent: Agent) {
    const saves: AgentFields[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent, caps, providerChoices: choices, step: "tools", onSave: async (fields: AgentFields) => { saves.push(fields); return null; } })));
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const select = () => host.querySelector<HTMLSelectElement>('section[aria-label="Tool settings"] tr[data-tool="browser"] select')!;
    return { host, saves, select };
  }

  it("shows the agent's saved pick, by the browser's names", async () => {
    const page = await open(agentWith("kernel"));
    expect(page.select().value).toBe("kernel");
    expect([...page.select().options].map((o) => o.textContent)).toEqual([`${AUTO} (default)`, "Browserbase", "Kernel", "Local Chrome"]);
  });

  it("saves a new pick in tool_settings.browser, and a re-read shows it", async () => {
    const page = await open(agentWith("kernel"));
    await act(async () => { const s = page.select(); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, "browserbase"); s.dispatchEvent(new Event("change", { bubbles: true })); });
    const save = [...page.host.querySelectorAll("button")].find((b) => /^Save/.test((b.textContent ?? "").trim()))!;
    await act(async () => { save.click(); });
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(page.saves.at(-1)?.tool_settings).toEqual({ browser: { provider: "browserbase" } });
    act(() => root?.unmount()); document.body.innerHTML = "";
    const again = await open(agentWith("browserbase"));
    expect(again.select().value).toBe("browserbase");
  });
});
