import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor, type EditorCaps, type Revision } from "./AgentEditor";
import { PerHarness } from "./ToolSettings";
import { type Agent, toolOffers, toolsOnSwitch } from "@/lib/agentForm";

// The agent editor's tools follow the harness: what it shows ticked, and what Save sends, is what the chosen harness runs
// on this server (capabilities' tools[].harnesses; features.mcp_client.harnesses for MCP grants), said before any save.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const ALL = ["pi", "claude-agent", "codex", "opencode"];
const caps: EditorCaps = {
  harnesses: ALL.map((id) => ({ id, available: true })),
  thinking: ["low"],
  tools: toolOffers([{ name: "read", available: true, harnesses: ALL }, { name: "ask_person", available: true, harnesses: ["pi"] }]),
  mcp: true,
  mcpHarnesses: ["pi", "claude-agent"],
};
const MCP = "mcp:crm/find_contact";
const agent = (over: Partial<Agent> = {}): Agent => ({ agent_id: "a1", kind: "agentic", revision: "rv2", revisions: 2, archived_at: null,
  definition: { version: 1, name: "mcp-test", instructions: "Do it.", harness: "pi", skills: [], tools: ["read", "ask_person", MCP] }, ...over });
const revisions: Revision[] = [{ revision: "rv2", version: 2, current: true, note: null, created_at: "2026-11-10T00:00:00Z" }, { revision: "rv1", version: 1, current: false, note: null, created_at: "2026-11-09T00:00:00Z" }];

function mount(a: Agent | null, start: "settings" | "tools" | "context" = "settings") {
  const sent: Record<string, unknown>[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent: a, revisions: a ? revisions : [], caps, step: start, onSave: async (f: Record<string, unknown>) => { sent.push(f); return null; } } as never)));
  const pick = (id: string) => act(() => { host.querySelector<HTMLInputElement>(`input[name="harness"][value="${id}"]`)!.click(); });
  const saveButton = () => [...host.querySelectorAll("button")].find((b) => /^(Create|Creating…|Save revision|Saving…|Saved)/.test(b.textContent?.trim() ?? ""))!;
  const save = async () => { await act(async () => { saveButton().click(); }); };
  const step = (label: string) => act(() => { [...host.querySelectorAll<HTMLButtonElement>("ol button")].find((b) => b.textContent?.includes(label))!.click(); });
  const notice = () => host.querySelector('[role="status"][aria-label="Tools this harness doesn\'t run"]');
  const type = (sel: string, value: string) => act(() => {
    const el = host.querySelector(sel) as HTMLTextAreaElement | HTMLInputElement;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return { host, pick, save, saveButton, step, notice, type, sent };
}

describe("AgentEditor: a harness switch keeps no tool the new harness can't run", () => {
  it("unticks a tool the new harness doesn't run at once, says why before any save, and Save sends only what it runs", async () => {
    const t = mount(agent());
    t.pick("claude-agent");
    // The reason is on the Settings step, where the switch was made, before Save.
    expect(t.notice()!.textContent).toContain("Claude doesn't run this tool here, so it's unticked.");
    expect(t.notice()!.textContent).toContain("ask_person: Runs on Pi here, not on Claude");
    expect(t.notice()!.textContent).not.toContain(MCP);
    // The Tools step shows it unticked, can't be ticked, with the same reason.
    t.step("Tools");
    const box = t.host.querySelector<HTMLInputElement>('input[type="checkbox"][value="ask_person"]')!;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(box.closest("label")!.textContent).toContain("Runs on Pi here, not on Claude");
    await t.save();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].harness).toBe("claude-agent");
    expect(t.sent[0].tools).toEqual(["read", MCP]);
  });

  it("takes MCP grants off a harness that runs no MCP tools here, and a switch back ticks everything again", async () => {
    const t = mount(agent());
    t.pick("codex");
    const said = t.notice()!.textContent ?? "";
    expect(said).toContain("Codex doesn't run these tools here, so they're unticked. Switching back ticks them again.");
    expect(said).toContain("ask_person: Runs on Pi here, not on Codex");
    expect(said).toContain(`${MCP}: Codex doesn't run MCP tools here: Pi and Claude do`);
    // Through another harness and back: what pi runs is ticked again, and nothing is left to save.
    t.pick("claude-agent");
    t.pick("pi");
    expect(t.notice()).toBeNull();
    expect(t.saveButton().textContent).toBe("Saved · rev 2");
    expect(t.saveButton().disabled).toBe(true);
    t.step("Tools");
    expect(t.host.querySelector<HTMLInputElement>('input[type="checkbox"][value="ask_person"]')!.checked).toBe(true);
  });

  it("on a new agent whose tools were changed by hand, keeps that choice across a switch and back", async () => {
    const t = mount(null, "tools");
    // A new agent starts with pi's tools; unticking read by hand marks the tools as the person's own.
    await act(async () => { t.host.querySelector<HTMLInputElement>('input[type="checkbox"][value="read"]')!.click(); });
    t.step("Settings");
    t.pick("claude-agent");
    expect(t.notice()!.textContent).toContain("ask_person: Runs on Pi here, not on Claude");
    t.pick("pi");
    t.step("Tools");
    expect(t.host.querySelector<HTMLInputElement>('input[type="checkbox"][value="read"]')!.checked).toBe(false);
    expect(t.host.querySelector<HTMLInputElement>('input[type="checkbox"][value="ask_person"]')!.checked).toBe(true);
  });

  it("keeps a tool capabilities don't list, for the server to judge", () => {
    expect(toolsOnSwitch("claude-agent", ["read", "a_future_tool", "ask_person"], [], caps.tools)).toEqual({ tools: ["read", "a_future_tool"], held: ["ask_person"] });
  });
});

describe("AgentEditor: Save follows the form", () => {
  it("is off with nothing to save and names the saved revision; on with an edit; off again once the edit is undone", () => {
    const t = mount(agent(), "context");
    expect(t.saveButton().textContent).toBe("Saved · rev 2");
    expect(t.saveButton().disabled).toBe(true);
    t.type("#agent-instructions", "Do it twice.");
    expect(t.saveButton().textContent).toBe("Save revision");
    expect(t.saveButton().disabled).toBe(false);
    t.type("#agent-instructions", "Do it.");
    expect(t.saveButton().disabled).toBe(true);
  });

  it("is off again once a saved setting the form sets only on a change (approvals) is changed and set back", () => {
    const t = mount(agent({ definition: { ...agent().definition, approvals: "never" } }), "tools");
    const radio = (v: string) => t.host.querySelector<HTMLInputElement>(`fieldset[aria-label="Approvals"] input[type="radio"][value="${v}"]`)!;
    act(() => { radio("ask").click(); });
    expect(t.saveButton().disabled).toBe(false);
    act(() => { radio("never").click(); });
    expect(t.saveButton().textContent).toBe("Saved · rev 2");
    expect(t.saveButton().disabled).toBe(true);
  });

  it("is off again after a save, the form as saved", async () => {
    const t = mount(agent());
    t.pick("claude-agent");
    await t.save();
    expect(t.saveButton().disabled).toBe(true);
    expect(t.notice()).toBeNull();
  });

  it("on a new agent, says under Create what it still needs", () => {
    const t = mount(null, "context");
    expect(t.host.textContent).toContain("Give the agent a name to create it.");
    expect(t.saveButton().disabled).toBe(true);
    t.type("#agent-name", "lead-scorer");
    expect(t.host.textContent).not.toContain("Give the agent a name to create it.");
  });
});

describe("AgentEditor: the save warnings name the step, not a raw field", () => {
  it("links each line to the step its field is on, the field on hover", () => {
    const t = mount(agent({ definition: { ...agent().definition, harness: "claude-agent", tools: ["read", "ask_person"] }, warnings: [{ field: "definition.tools[1]", reason: "not_set_up_here", message: "ask_person runs on pi here; on claude-agent it is not bound yet." }] }));
    const banner = t.host.querySelector('[aria-label="Save warnings"]')!;
    const link = [...banner.querySelectorAll("button")].find((b) => b.textContent === "Tools & skills")!;
    expect(link.getAttribute("title")).toBe("definition.tools[1]");
    expect([...banner.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Tools & skills ask_person runs on pi here; on claude-agent it is not bound yet."]);
    act(() => { link.click(); });
    expect(t.host.querySelector('input[type="checkbox"][value="ask_person"]')).not.toBeNull();
  });
});

describe("Settings → Tools: a harness this server can't run", () => {
  it("is greyed out as not offered here, the server's reason on hover", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const choice = { name: "web_search", provider: "exa", default_provider: "exa", providers: ["exa"], resolves: { pi: "native", "claude-agent": "native", codex: "native", opencode: "exa-keyless" } } as never;
    act(() => root!.render(createElement(PerHarness, { choice, harnesses: [{ id: "pi", available: true }, { id: "codex", available: false, reason: "codex needs OPENAI_API_KEY." }] })));
    const lines = [...host.querySelectorAll("span")];
    const codex = lines.find((l) => l.textContent?.startsWith("codex:"))!;
    expect(codex.textContent).toBe("codex: not offered here");
    expect(codex.getAttribute("title")).toBe("codex needs OPENAI_API_KEY.");
    expect(lines.find((l) => l.textContent?.startsWith("pi:"))!.textContent).not.toContain("not offered");
  });
});
