import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import type { Agent, AgentFields, SaveProblem } from "@/lib/agentForm";
import { toolChoices } from "@/lib/toolSettings";

// Tool settings saved, changed while that save was under way, then set back to what was saved: nothing is unsaved, so
// leaving asks nothing (the guard compares the effective settings: the form's own, else the definition's).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const tools = [{ name: "read", available: true }, { name: "web_search", available: true }];
const caps = { harnesses: [{ id: "pi", available: true }], tools, thinking: ["low"] };
const SEARCH = { name: "web_search", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "exa-keyless", default_provider: "auto", available: true, resolves: { pi: "exa-keyless" } };
const choices = toolChoices([SEARCH]);
// Each tool's permission, as GET /agents/{id} serves it: the default's.
const GATE = { permission: "allow" as const, permission_from: "default" as const, default_permission: "allow" as const, permissions: ["allow" as const, "ask" as const, "deny" as const] };
const agentWith = (revision: string, toolSettings?: Agent["definition"]["tool_settings"]): Agent => ({
  agent_id: "searcher", kind: "agentic", revision, revisions: 1, archived_at: null,
  definition: { version: 1, name: "Searcher", instructions: "Look it up.", harness: "pi", skills: [], tools: ["read", "web_search"], ...(toolSettings ? { tool_settings: toolSettings } : {}) },
  tools: [{ name: "read", ...GATE }, { name: "web_search", provider: toolSettings?.web_search?.provider ?? "exa-keyless", provider_from: toolSettings ? "agent" : "server", default_provider: "exa-keyless", resolved: "exa-keyless", ...GATE }],
});

describe("AgentEditor, tool settings set back to the saved ones while a save lands", () => {
  it("leaves nothing unsaved: the browser is not asked before the tab closes", async () => {
    let answer: (p: SaveProblem | null) => void = () => {};
    const onSave = (_fields: AgentFields) => new Promise<SaveProblem | null>((r) => { answer = r; });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent: agentWith("r1"), caps, providerChoices: choices, step: "tools", onSave })));
    const select = () => host.querySelector<HTMLSelectElement>('section[aria-label="Tool settings"] tr[data-tool="web_search"] select[aria-label="web_search provider"]')!;
    const choose = (provider: string) => act(() => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select(), provider); select().dispatchEvent(new Event("change", { bubbles: true })); });
    const unloadAsks = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
    // The Save button reads "Save revision" only once there is something to save.
    const save = () => [...host.querySelectorAll("button")].find((b) => /^Save revision$/.test(b.textContent?.trim() ?? ""))!;

    choose("parallel");
    expect(unloadAsks()).toBe(true);
    await act(async () => { save().click(); });
    // While it saves, a change of mind: native.
    choose("native");
    // The save of parallel lands; the page passes the agent at its new revision, its definition naming parallel.
    await act(async () => { answer(null); });
    act(() => root!.render(createElement(AgentEditor, { agent: agentWith("r2", { web_search: { provider: "parallel" } }), caps, providerChoices: choices, step: "tools", onSave })));
    expect(unloadAsks()).toBe(true);
    // Back to parallel, what was saved: nothing is unsaved.
    choose("parallel");
    expect(select().value).toBe("parallel");
    expect(unloadAsks()).toBe(false);
  });
});
