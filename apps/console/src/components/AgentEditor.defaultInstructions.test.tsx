import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { DEFAULT_INSTRUCTIONS as SENT, toolOffers } from "@/lib/agentForm";

// A new agent never dead-ends on Instructions: the form opens with a sensible one to edit, so Create works as soon as it
// has a name. The field stays required: emptied, Create is blocked again. An agent's own instructions are its own.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

// The words, as a person reads them in the field (agentForm's DEFAULT_INSTRUCTIONS).
const DEFAULT_INSTRUCTIONS = "You are a helpful agent. Do the task you're given and report what you found.";
const caps = { harnesses: [{ id: "pi", available: true }], thinking: ["low"], tools: toolOffers([{ name: "read", available: true }]) };

function mount(agent: unknown = null) {
  let saved: Record<string, unknown> | undefined;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent, caps, step: "context", onSave: async (f: Record<string, unknown>) => { saved = f; return null; } } as never)));
  const set = (sel: string, value: string) => act(() => {
    const el = host.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const create = () => [...host.querySelectorAll("button")].find((b) => /^Create/.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
  const save = async () => { await act(async () => { create()!.click(); }); return saved; };
  return { host, set, create, save };
}

describe("AgentEditor, a new agent's instructions", () => {
  it("opens with a default to edit, and the field is still required", () => {
    const { host } = mount();
    const field = host.querySelector("#agent-instructions") as HTMLTextAreaElement;
    expect(field.value).toBe(DEFAULT_INSTRUCTIONS);
    expect(SENT).toBe(DEFAULT_INSTRUCTIONS);
    const label = host.querySelector('label[for="agent-instructions"]')!;
    expect(label.textContent).toContain("Instructions");
    expect(label.textContent).toContain("*");
  });

  it("creates as soon as it has a name, sending the default; emptied, Create is blocked again", async () => {
    const t = mount();
    expect(t.create()!.disabled).toBe(true);
    t.set("#agent-name", "Shelly");
    expect(t.create()!.disabled).toBe(false);
    t.set("#agent-instructions", "  ");
    expect(t.create()!.disabled).toBe(true);
    t.set("#agent-instructions", DEFAULT_INSTRUCTIONS);
    const sent = await t.save();
    expect(sent?.instructions).toBe(DEFAULT_INSTRUCTIONS);
  });

  it("says in the footer why Create is off: a name to give, instructions to write; once filled, it says nothing", async () => {
    const t = mount();
    const footer = () => t.host.querySelector("footer")!.textContent ?? "";
    expect(t.create()!.disabled).toBe(true);
    expect(footer()).toContain("Give the agent a name to create it.");
    expect(footer()).not.toContain("instructions to create it");
    t.set("#agent-name", "Shelly");
    expect(t.create()!.disabled).toBe(false);
    expect(footer()).not.toContain("to create it");
    t.set("#agent-instructions", "");
    expect(t.create()!.disabled).toBe(true);
    expect(footer()).toContain("Write its instructions to create it.");
    expect(footer()).not.toContain("Give the agent a name");
    t.set("#agent-name", "");
    expect(footer()).toContain("Give the agent a name to create it.");
    expect(footer()).toContain("Write its instructions to create it.");
  });

  it("an agent being edited keeps its own instructions, never the default", () => {
    const { host } = mount({ agent_id: "a1", kind: "agentic", revision: "rv1", revisions: 1, version: 1, definition: { version: 1, name: "Mine", instructions: "Only mine.", harness: "pi", tools: [] } });
    expect((host.querySelector("#agent-instructions") as HTMLTextAreaElement).value).toBe("Only mine.");
  });
});
