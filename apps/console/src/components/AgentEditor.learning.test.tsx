import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor, type EditorCaps, type EditorProps } from "./AgentEditor";
import { type Agent, type AgentFields, createBody, editBody } from "@/lib/agentForm";
import { SERVED_AGENT } from "@/test/agent";
import { pick, picker } from "@/test/picker";

// Learning is its own settings section during both creation and editing.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tools = [{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "write", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }];
const caps = (learning?: "on" | "off"): EditorCaps => ({ harnesses: [{ id: "pi", available: true }], tools, thinking: ["low"], ...(learning ? { learning } : {}) });
const agentOf = (definition: Partial<Agent["definition"]> = {}, kind: Agent["kind"] = "agentic"): Agent => ({
  ...SERVED_AGENT, agent_id: "refunds", kind, revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Refunds", instructions: "Find it.", harness: "pi", skills: [], tools: ["read", "write"], ...definition },
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function mount(agent: Agent | null, c: EditorCaps, props: Partial<EditorProps> = {}) {
  const saves: AgentFields[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent, caps: c, step: "learning", onSave: async (f) => { saves.push(f); return null; }, ...props })));
  const sw = () => host.querySelector('[role="switch"]') as HTMLButtonElement | null;
  const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
  const save = async () => click([...host.querySelectorAll("button")].find((b) => /^(Save revision|Create)$/.test(b.textContent ?? ""))!);
  return { host, saves, sw, click, save, text: () => host.textContent ?? "" };
}

describe("AgentEditor, the learning switch", () => {
  it("shows in the agent's Learning section, named and explained, off when the definition says nothing", () => {
    const e = mount(agentOf(), caps("on"));
    expect(e.text()).toContain("Learns from its runs");
    expect(e.text()).toContain("Every later run is given your corrections first, and a job it does again compiles into a workflow it can run as one step.");
    expect(e.sw()!.getAttribute("aria-checked")).toBe("false");
    expect(e.sw()!.getAttribute("aria-labelledby")).toBe("learning-switch");
  });
  it("is on for a definition that says learning: true, and turning it off saves learning: false", async () => {
    const e = mount(agentOf({ learning: true }), caps("on"));
    expect(e.sw()!.getAttribute("aria-checked")).toBe("true");
    await e.click(e.sw()!);
    await e.save();
    expect(e.saves[0].learning).toBe(false);
    expect(editBody(agentOf({ learning: true }), e.saves[0], "").definition.learning).toBe(false);
  });
  it("turned on saves learning: true; turned on and off again saves no change at all", async () => {
    const e = mount(agentOf(), caps("on"));
    await e.click(e.sw()!);
    await e.save();
    expect(e.saves[0].learning).toBe(true);
    expect(editBody(agentOf(), e.saves[0], "").definition).toMatchObject({ learning: true, version: 2 });
    await e.click(e.sw()!);
    await e.save();
    expect(e.saves[1].learning).toBeUndefined();
    expect(editBody(agentOf(), e.saves[1], "").unchanged).toBe(true);
  });
  it("turned on for an agent without the write tool, asks for no tool: no line about one and no Add it, and the save keeps its tools as they are", async () => {
    const e = mount(agentOf({ tools: ["read"] }), caps("on"));
    await e.click(e.sw()!);
    expect(e.sw()!.getAttribute("aria-checked")).toBe("true");
    expect(e.text()).not.toMatch(/write tool/i);
    expect([...e.host.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Add it");
    await e.save();
    expect(editBody(agentOf({ tools: ["read"] }), e.saves[0], "").definition).toMatchObject({ learning: true, tools: ["read"] });
  });
  it("on a server with learning off, says no run learns there yet", () => {
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: agentOf({ learning: true }), caps: caps("off"), step: "learning" }))).toContain("This server has learning turned off");
  });
  it("is not offered on a server without learning, nor on a workflow agent, which does not learn", () => {
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: agentOf(), caps: caps(), step: "settings" }))).not.toContain("Learns from its runs");
    const wf = agentOf({ instructions: undefined, harness: undefined, workflow: { version: 1, root: { kind: "agent", id: "a", task: "t" } } }, "workflow");
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: wf, caps: caps("on"), step: "settings" }))).not.toContain("Learns from its runs");
  });
  it("a new agent created with it on says learning: true, and with it off says nothing", async () => {
    const e = mount(null, caps("on"));
    expect(e.sw()!.getAttribute("aria-checked")).toBe("false");
    await e.click(e.sw()!);
    expect(createBody({ name: "N", description: "", instructions: "I", harness: "pi", tools: [], learning: true }).definition.learning).toBe(true);
    expect("learning" in createBody({ name: "N", description: "", instructions: "I", harness: "pi", tools: [] }).definition).toBe(false);
  });
});

describe("AgentEditor, Learning settings navigation", () => {
  it("keeps Learning separate from Model & runtime, reachable in the sidebar and mobile picker without losing its draft", async () => {
    const e = mount(agentOf(), caps("on"), { step: "settings" });
    const nav = e.host.querySelector('nav[aria-label="Agent settings sections"]')!;
    const learning = [...nav.querySelectorAll("ul button")].find(button => button.textContent?.trimStart().startsWith("Learning"));
    expect(learning).toBeTruthy();
    expect(e.sw()).toBeNull();
    expect(e.text()).toContain("Spending");
    await e.click(learning!);
    expect(e.host.querySelector('nav [aria-current="page"]')?.textContent).toContain("Learning");
    expect(e.host.querySelector("fieldset")?.textContent).toContain("Turning learning off stops future runs from using or adding learning");
    await e.click(e.sw()!);
    expect(e.saves).toEqual([]);
    await pick(picker(nav, "Settings section")!, "settings");
    expect(e.sw()).toBeNull();
    await pick(picker(nav, "Settings section")!, "learning");
    expect(e.sw()?.getAttribute("aria-checked")).toBe("true");
    await e.save();
    expect(editBody(agentOf(), e.saves[0], "").definition).toMatchObject({ learning: true, tools: ["read", "write"], instructions: "Find it." });
  });

  it("routes learning warnings to Learning and shows field errors beside the switch", async () => {
    const warning = "Learning is disabled on this server.";
    const e = mount({ ...agentOf(), warnings: [{ field: "definition.learning", reason: "not_set_up_here", message: warning }] }, caps("off"), {
      step: "settings",
      problem: { kind: "invalid", message: "Invalid learning settings", fields: { "definition.learning.compile_after": "compile_after must be positive" } },
    });
    const warningLink = [...e.host.querySelectorAll('[aria-label="Save warnings"] button')].find(button => button.textContent === "Learning");
    expect(warningLink).toBeTruthy();
    await e.click(warningLink!);
    expect(e.sw()).toBeTruthy();
    expect(e.host.querySelector("fieldset")?.textContent).toContain(warning);
    expect(e.host.querySelector("fieldset [role=alert]")?.textContent).toBe("compile_after must be positive");
  });

  it.each(["on", "off"] as const)("offers the section when the server reports learning %s", learning => {
    const e = mount(agentOf(), caps(learning));
    expect(e.host.querySelector('nav [aria-current="page"]')?.textContent).toContain("Learning");
    expect(e.sw()).toBeTruthy();
  });

  it("hides Learning navigation for workflows and servers without the capability", () => {
    const wf = agentOf({ workflow: { version: 1, root: { kind: "agent", id: "a", task: "t" } } }, "workflow");
    for (const [agent, c] of [[agentOf(), caps()], [wf, caps("on")]] as const) {
      const html = renderToStaticMarkup(createElement(AgentEditor, { agent, caps: c, step: "settings" }));
      expect(html).not.toContain("Learns from its runs");
      expect(html).not.toContain("Corrections and reusable workflows");
    }
  });

  it("keeps creation learning in its own section and hides it for a workflow starter", async () => {
    const e = mount(null, caps("on"));
    expect(e.sw()).toBeTruthy();
    await pick(picker(e.host, "Settings section")!, "settings");
    await pick(picker(e.host, "Runtime")!, "starter:workflow");
    expect(e.sw()).toBeNull();
    await pick(picker(e.host, "Runtime")!, "pi");
    await pick(picker(e.host, "Settings section")!, "learning");
    expect(e.sw()).toBeTruthy();
  });
});

describe("AgentEditor, a definition that sets the loop's numbers", () => {
  it("learning: {compile_after: 5} is on, offers no kind to choose, and off then on again keeps its numbers", async () => {
    const loop = { compile_after: 5 };
    const e = mount(agentOf({ learning: loop }), caps("on"));
    expect(e.sw()!.getAttribute("aria-checked")).toBe("true");
    expect(e.host.querySelector('input[type="radio"][name="learning-kind"]')).toBeNull();
    await e.click(e.sw()!);
    await e.click(e.sw()!);
    // Back on what was saved there is nothing to save: no Save button, and were one pressed the edit is no change.
    expect([...e.host.querySelectorAll("button")].some((b) => /^(Save revision|Create)$/.test(b.textContent ?? ""))).toBe(false);
    expect(editBody(agentOf({ learning: loop }), { learning: loop }, "").unchanged).toBe(true);
    await e.click(e.sw()!);
    await e.save();
    expect(e.saves[0].learning).toBe(false);
  });
});
