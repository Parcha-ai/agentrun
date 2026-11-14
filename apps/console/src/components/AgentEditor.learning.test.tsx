import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor, type EditorCaps } from "./AgentEditor";
import { type Agent, type AgentFields, createBody, editBody } from "@/lib/agentForm";

// The editor's Settings step: "Learns from its runs", the definition's `learning` switch, on an agentic agent of a server
// that has learning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tools = [{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "write", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }];
const caps = (learning?: "on" | "off"): EditorCaps => ({ harnesses: [{ id: "pi", available: true }], tools, thinking: ["low"], ...(learning ? { learning } : {}) });
const agentOf = (definition: Partial<Agent["definition"]> = {}, kind: Agent["kind"] = "agentic"): Agent => ({
  agent_id: "refunds", kind, revision: "r1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Refunds", instructions: "Find it.", harness: "pi", skills: [], tools: ["read", "write"], ...definition },
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function mount(agent: Agent | null, c: EditorCaps) {
  const saves: AgentFields[] = [];
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent, caps: c, step: "settings", onSave: async (f) => { saves.push(f); return null; } })));
  const sw = () => host.querySelector('[role="switch"]') as HTMLButtonElement | null;
  const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
  const save = async () => click([...host.querySelectorAll("button")].find((b) => /^(Save revision|Create)$/.test(b.textContent ?? ""))!);
  return { host, saves, sw, click, save, text: () => host.textContent ?? "" };
}

describe("AgentEditor, the learning switch", () => {
  it("shows on an agentic agent's Settings step, named and explained in a line, off when the definition says nothing", () => {
    const e = mount(agentOf(), caps("on"));
    expect(e.text()).toContain("Learns from its runs");
    expect(e.text()).toContain("After each run, it looks back and keeps a short note when something will help next time; later runs read them first.");
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
    expect(renderToStaticMarkup(createElement(AgentEditor, { agent: agentOf({ learning: true }), caps: caps("off"), step: "settings" }))).toContain("This server has learning turned off");
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

describe("AgentEditor, what the agent learns: notes and skills, or workflows too", () => {
  const choice = (host: HTMLElement, label: RegExp) => [...host.querySelectorAll('input[type="radio"][name="learning-kind"]')].find((r) => label.test(r.closest("label")?.textContent ?? "")) as HTMLInputElement | undefined;
  it("with learning on, offers two choices in plain words, everything checked for learning: true", () => {
    const e = mount(agentOf({ learning: true }), caps("on"));
    expect(choice(e.host, /^Notes, skills and workflows/)?.checked).toBe(true);
    expect(choice(e.host, /^Notes and skills only/)?.checked).toBe(false);
    expect(e.text()).toContain("It never runs a learned workflow, and is never asked to draft one.");
  });
  it("is hidden while learning is off", () => {
    const e = mount(agentOf(), caps("on"));
    expect(choice(e.host, /^Notes and skills only/)).toBeUndefined();
  });
  it("a definition that says learning: \"notes\" shows the switch on and Notes and skills only checked; choosing everything saves learning: true", async () => {
    const e = mount(agentOf({ learning: "notes" }), caps("on"));
    expect(e.sw()!.getAttribute("aria-checked")).toBe("true");
    expect(choice(e.host, /^Notes and skills only/)?.checked).toBe(true);
    await e.click(choice(e.host, /^Notes, skills and workflows/)!);
    await e.save();
    expect(e.saves[0].learning).toBe(true);
  });
  it("choosing Notes and skills only saves learning: \"notes\", and a new agent created so says it", async () => {
    const e = mount(agentOf({ learning: true }), caps("on"));
    await e.click(choice(e.host, /^Notes and skills only/)!);
    await e.save();
    expect(e.saves[0].learning).toBe("notes");
    expect(editBody(agentOf({ learning: true }), e.saves[0], "").definition.learning).toBe("notes");
    expect(createBody({ name: "N", description: "", instructions: "I", harness: "pi", tools: [], learning: "notes" }).definition.learning).toBe("notes");
  });
  it("choosing another kind and then the saved one again saves learning as it was, not a removed field", async () => {
    for (const saved of [true, "notes"] as const) {
      const e = mount(agentOf({ learning: saved }), caps("on"));
      const other = saved === true ? /^Notes and skills only/ : /^Notes, skills and workflows/;
      const same = saved === true ? /^Notes, skills and workflows/ : /^Notes and skills only/;
      await e.click(choice(e.host, other)!);
      await e.click(choice(e.host, same)!);
      // Back on what was saved there is nothing to save: no Save button, and were one pressed the edit is no change.
      expect([...e.host.querySelectorAll("button")].some((b) => /^(Save revision|Create)$/.test(b.textContent ?? ""))).toBe(false);
      expect(editBody(agentOf({ learning: saved }), { learning: saved }, "").unchanged).toBe(true);
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
  });
});
