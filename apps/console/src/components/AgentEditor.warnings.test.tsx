import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor } from "./AgentEditor";
import { AgentEditPage } from "./AgentsPage";
import type { Agent, SaveWarning } from "@/lib/agentForm";

// A save the server took can still say what this host lacks to run it (`warnings`): the editor shows each one, above
// the form and beside the field it names, so nothing the server said is hidden.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const caps = { harnesses: [{ id: "pi", available: true }], tools: [{ name: "read", available: true }], thinking: ["low"] };
const MODEL: SaveWarning = { field: "definition.model", reason: "not_set_up_here", message: "No key for openai is set on this server: set OPENAI_API_KEY." };
const PLACE: SaveWarning = { field: "definition.place", reason: "not_set_up_here", message: "The place shared-1 is not set up on this server." };
const agentAt = (revision: string, warnings?: SaveWarning[]): Agent => ({
  agent_id: "calc", kind: "agentic", revision, revisions: revision === "r1" ? 1 : 2, archived_at: null,
  definition: { version: revision === "r1" ? 1 : 2, name: "Calc", instructions: "Answer.", harness: "pi", model: "openai/gpt-x", skills: [], tools: ["read"] }, ...(warnings ? { warnings } : {}),
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

describe("AgentEditor, a save's warnings", () => {
  it("lists every warning above the form, a field the form has no input for included, and each one beside its field", () => {
    const settings = renderToStaticMarkup(createElement(AgentEditor, { agent: agentAt("r2", [MODEL, PLACE]), caps, step: "settings" }));
    expect(settings).toContain("Save warnings");
    for (const w of [MODEL, PLACE]) { expect(settings).toContain(w.field); expect(settings).toContain(w.message); }
    // The model's warning twice: in the list and under the Model field.
    expect(settings.split(MODEL.message).length - 1).toBe(2);
    expect(settings.split(PLACE.message).length - 1).toBe(1);
  });

  it("shows none when the answer had none, or for an agent read back (a read carries no warnings)", () => {
    for (const agent of [agentAt("r2", []), agentAt("r2")]) expect(renderToStaticMarkup(createElement(AgentEditor, { agent, caps, step: "settings" }))).not.toContain("Save warnings");
  });

  it("an edit whose answer has warnings shows them on the page after the save", async () => {
    const v2 = {
      getAgent: async () => ({ agent: agentAt("r1"), etag: "r1" }),
      listRevisions: async () => ({ revisions: [], next_cursor: null }),
      updateDefinition: async () => ({ agent: agentAt("r2", [MODEL]), etag: "r2" }),
    };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditPage, { v2: v2 as never, caps: caps as never, agentId: "calc", go: () => {} })));
    const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
    await settle();
    expect(host.textContent).not.toContain(MODEL.message);
    const instructions = host.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(instructions, "Answer in one word."); instructions.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { [...host.querySelectorAll("button")].find((b) => /^Save revision$/.test((b.textContent ?? "").trim()))!.click(); });
    await settle();
    expect(host.textContent).toContain("Saved. A run of this revision is refused");
    expect(host.textContent).toContain(MODEL.message);
  });
});
