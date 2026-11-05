import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { ToolsPage } from "./ToolsPage";
import type { Agent } from "@/lib/agentForm";
import { toolChoices, toolGates } from "@/lib/toolSettings";
import type { ToolSettings } from "@/lib/v2";

// What a tool resolves to depends on its permission too (deny: unavailable; ask: no search that can't wait). An answer
// read for one permission says nothing of another: until the server answers for the new one, the row says so.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const pick = async (s: HTMLSelectElement, value: string) => {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(s, value); s.dispatchEvent(new Event("change", { bubbles: true })); });
  await settle();
};
const ALL = ["allow", "ask", "deny"];
const SEARCH = { name: "web_search", available: true, providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "auto", default_provider: "auto", resolves: { pi: "exa-keyless", "claude-agent": "native", codex: "native" }, permission: "allow", default_permission: "allow", permissions: ALL };

describe("a permission change and what the tool resolves to", () => {
  it("the agent editor: the server's word for the old permission isn't shown for a new one; it resolves once saved", async () => {
    const agent: Agent = {
      agent_id: "searcher", kind: "agentic", revision: "r1", revisions: 1, archived_at: null,
      definition: { version: 1, name: "Searcher", instructions: "Look it up.", harness: "pi", skills: [], tools: ["web_search"] },
      tools: [{ name: "web_search", provider: "auto", provider_from: "default", default_provider: "auto", resolved: "exa-keyless", permission: "allow", permission_from: "default", default_permission: "allow", permissions: ["allow", "ask", "deny"] }],
    };
    const caps = { harnesses: [{ id: "pi", available: true }], tools: [{ name: "web_search", available: true }], thinking: [] };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent, caps, providerChoices: toolChoices([SEARCH]), permissionGates: toolGates([SEARCH]), step: "tools", onSave: async () => null })));
    await settle();
    const row = () => host.querySelector("section[aria-label='Tool settings'] tr[data-tool='web_search']")!;
    expect(row().textContent).toContain("pi: Exa keyless");
    await pick(row().querySelector<HTMLSelectElement>("select[aria-label='web_search permission']")!, "deny");
    expect(row().textContent).not.toContain("pi: Exa keyless");
    expect(row().textContent).toContain("once saved");
  });

  it("Settings → Tools: capabilities read for the old permission aren't shown once it changed, until they're read again", async () => {
    let held: ToolSettings = {};
    const v2 = { toolSettings: async () => ({ ...held, web_search: { ...held.web_search, provider: "auto" } }), saveToolSettings: async (b: ToolSettings) => { held = b; return { ...b, web_search: { ...b.web_search, provider: "auto" } }; } };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    // Capabilities stay as first read (the permission allow): the page's own read of them never lands here.
    act(() => root!.render(createElement(ToolsPage, { v2: v2 as never, choices: toolChoices([SEARCH]), gates: toolGates([SEARCH]), onSaved: () => {}, onOpen: () => new Promise<boolean>(() => {}) })));
    await settle();
    const row = () => host.querySelector("tr[data-tool='web_search']")!;
    expect(row().textContent).toContain("pi: Exa keyless");
    await pick(row().querySelector<HTMLSelectElement>("select[aria-label='web_search permission']")!, "deny");
    expect(held).toEqual({ web_search: { permission: "deny" } });
    expect(row().textContent).not.toContain("pi: Exa keyless");
    expect(row().textContent).toContain("reading…");
  });
});
