import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { type Agent, createBody, editBody, toolOffers } from "@/lib/agentForm";
import { toolChoices, toolGates } from "@/lib/toolSettings";

// An agent's approvals (definition.approvals): "ask", the default, parks a call its tool gate says ask for the owner's
// answer; "never" runs it unattended, every tool it has granted (deny and pins still apply). The editor's Tools step sets
// it, and a tool row whose permission is ask says it runs without asking while Never ask is on.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const NEVER_LINE = "Never ask: every tool this agent has runs without waiting for you. A tool set to deny, and a template's pins, still hold.";
const caps = { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools: toolOffers([{ name: "read", available: true }, { name: "bash", available: true }]) };
const gates = toolGates([{ name: "bash", permission: "ask", default_permission: "ask", permissions: ["allow", "ask", "deny"] }]);
const agentWith = (approvals?: "ask" | "never"): Agent => ({ agent_id: "a1", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Mine", instructions: "Do it.", harness: "pi", skills: [], tools: ["read", "bash"], ...(approvals ? { approvals } : {}) } });

function mount(agent: Agent | null) {
  let saved: Record<string, unknown> | undefined;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent, caps, permissionGates: gates, step: "tools", onSave: async (f: Record<string, unknown>) => { saved = f; return null; } } as never)));
  const radio = (label: RegExp) => [...host.querySelectorAll<HTMLInputElement>('fieldset[aria-label="Approvals"] input[type="radio"]')].find((r) => label.test(r.closest("label")?.textContent ?? ""));
  const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
  const save = async () => { await act(async () => { [...host.querySelectorAll("button")].find((b) => /^(Create|Save revision)$/.test(b.textContent?.trim() ?? ""))!.click(); }); return saved; };
  const set = (sel: string, value: string) => act(() => {
    const el = host.querySelector(sel) as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { host, radio, click, save, set };
}

describe("AgentEditor, the agent's approvals", () => {
  it("a new agent asks by default; Never ask says what it grants and is sent as the agent's approvals", async () => {
    const t = mount(null);
    expect(t.radio(/^Ask me/)!.checked).toBe(true);
    expect(t.radio(/^Never ask/)!.checked).toBe(false);
    expect(t.host.textContent).not.toContain(NEVER_LINE);
    t.click(t.radio(/^Never ask/));
    expect(t.host.textContent).toContain(NEVER_LINE);
    t.click([...t.host.querySelectorAll("main ol button, ol button")].find((b) => /Context/.test(b.textContent ?? "")));
    t.set("#agent-name", "Unattended one");
    const sent = await t.save();
    expect(sent?.approvals).toBe("never");
  });

  it("an agent set to never reads Never ask; Ask me again saves its approvals as ask", async () => {
    const t = mount(agentWith("never"));
    expect(t.radio(/^Never ask/)!.checked).toBe(true);
    t.click(t.radio(/^Ask me/));
    const sent = await t.save();
    expect(sent?.approvals).toBe("ask");
  });

  it("while Never ask is on, a tool whose permission is ask says it runs without asking", () => {
    const t = mount(agentWith("never"));
    const row = () => t.host.querySelector('tr[data-tool="bash"]')!.textContent ?? "";
    expect(row()).toContain("Runs without asking: Never ask is on.");
    t.click(t.radio(/^Ask me/));
    expect(row()).not.toContain("Runs without asking");
  });

  it("is sent as the definition's approvals: a new agent's only when it never asks, an edit's as chosen", () => {
    const base = { name: "N", description: "", instructions: "I", harness: "pi", tools: [] };
    expect(createBody({ ...base, approvals: "never" }).definition.approvals).toBe("never");
    expect("approvals" in createBody(base).definition).toBe(false);
    expect(editBody(agentWith("never"), { approvals: "ask" }, "").definition.approvals).toBe("ask");
    expect(editBody(agentWith(), { approvals: "never" }, "").definition.approvals).toBe("never");
  });
});

describe("AgentEditor, the agent's approvals while a save is under way and with ask off", () => {
  it("takes no change of approvals while a save is under way, so what shows is what was sent", async () => {
    let answer: (p: null) => void = () => {};
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent: agentWith("ask"), caps, permissionGates: gates, step: "tools", onSave: () => new Promise((r) => { answer = r; }) } as never)));
    const radios = () => [...host.querySelectorAll<HTMLInputElement>('fieldset[aria-label="Approvals"] input[type="radio"]')];
    act(() => { radios().find((r) => /^Never ask/.test(r.closest("label")?.textContent ?? ""))!.click(); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /^Save revision$/.test(b.textContent?.trim() ?? ""))!.click(); });
    for (const r of radios()) expect(r.disabled).toBe(true);
    await act(async () => { answer(null); });
    for (const r of radios()) expect(r.disabled).toBe(false);
  });

  it("with ask off on this server, a tool set to ask under Never ask says it runs, not that it is refused", () => {
    const off = toolGates([{ name: "bash", permission: "ask", default_permission: "ask", permissions: ["allow", "ask", "deny"], ask_needs: "password" }]);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent: agentWith("never"), caps, permissionGates: off, step: "tools", onSave: async () => null } as never)));
    const row = host.querySelector('tr[data-tool="bash"]')!;
    expect(row.textContent).toContain("Runs without asking: Never ask is on.");
    expect(row.textContent).not.toContain("Each call is refused");
    expect(row.querySelector<HTMLOptionElement>('select[aria-label="bash permission"] option[value="ask"]')!.disabled).toBe(false);
  });
});

describe("AgentEditor, the Tool settings words under Never ask", () => {
  const SEARCH = { name: "web_search", providers: ["auto", "native", "exa-keyless", "parallel", "off"], provider: "auto", default_provider: "auto", available: true, resolves: { pi: "exa-keyless" } };
  const searchCaps = { ...caps, tools: toolOffers([{ name: "read", available: true }, { name: "web_search", available: true }]) };
  const GATE = { permission: "ask" as const, permission_from: "default" as const, default_permission: "ask" as const, permissions: ["allow" as const, "ask" as const, "deny" as const] };
  const searcher = (approvals: "ask" | "never"): Agent => ({ agent_id: "s1", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
    definition: { version: 1, name: "Searcher", instructions: "Look.", harness: "pi", skills: [], tools: ["read", "web_search"], approvals },
    tools: [{ name: "read", ...GATE }, { name: "web_search", provider: "auto", provider_from: "server", default_provider: "auto", resolved: "exa-keyless", ...GATE }] });
  const mountSearcher = (approvals: "ask" | "never") => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent: searcher(approvals), caps: searchCaps, providerChoices: toolChoices([SEARCH]), permissionGates: toolGates([{ name: "web_search", permission: "ask", default_permission: "ask", permissions: ["allow", "ask", "deny"] }]), step: "tools", onSave: async () => null } as never)));
    const radio = (label: RegExp) => [...host.querySelectorAll<HTMLInputElement>('fieldset[aria-label="Approvals"] input[type="radio"]')].find((r) => label.test(r.closest("label")?.textContent ?? ""));
    return { host, radio };
  };

  it("says what ask means under Never ask: a tool on ask runs without waiting, not that the run waits", () => {
    const t = mountSearcher("never");
    const intro = t.host.querySelector('section[aria-label="Tool settings"] p')!.textContent ?? "";
    expect(intro).toContain("Never ask is on: a tool on ask runs without waiting for you.");
    expect(intro).not.toContain("makes the run wait");
    act(() => { t.radio(/^Ask me/)!.click(); });
    expect(t.host.querySelector('section[aria-label="Tool settings"] p')!.textContent).toContain("A tool on ask makes the run wait for your approval at each call.");
  });

  it("shows a tool's saved resolution only for the approvals it was read under; changed, it resolves once saved", () => {
    const t = mountSearcher("ask");
    const resolves = () => t.host.querySelector('tr[data-tool="web_search"]')!.textContent ?? "";
    expect(resolves()).toContain("pi: Exa keyless");
    act(() => { t.radio(/^Never ask/)!.click(); });
    expect(resolves()).toContain("once saved");
  });
});
