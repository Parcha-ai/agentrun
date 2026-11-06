import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor, type EditorProps } from "./AgentEditor";
import type { SaveProblem } from "@/lib/agentForm";

// The Save revision button says whether there is anything to save: with nothing changed it is off and says which revision
// is saved ("Saved · rev N", the served current revision's); an edit turns it on; it says "Saving…" while a save is under
// way; a save that fails leaves it on, with why under it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const definition = { version: 1, name: "Calc", instructions: "Answer.", harness: "pi", skills: [], tools: [] };
const agentAt = (revision: string, revisions: number) => ({ agent_id: "calc", kind: "agentic" as const, revision, revisions, archived_at: null, definition });
const rev = (revision: string, version: number, current: boolean) => ({ revision, version, current, note: null, created_at: "2026-11-05T10:00:00Z" });
const caps = { harnesses: [{ id: "pi", available: true }], tools: [], thinking: ["low"] };

describe("AgentEditor's Save revision button", () => {
  it("is off and says the saved revision when nothing changed, on after an edit, Saving… while it saves, then off at the new revision", async () => {
    let answer: (p: SaveProblem | null) => void = () => {};
    const props = (revision: string, n: number, revisions: ReturnType<typeof rev>[]): EditorProps => ({
      agent: agentAt(revision, n), revisions, caps, step: "context",
      onSave: () => new Promise<SaveProblem | null>((r) => { answer = r; }),
    });
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, props("r1", 1, [rev("r1", 1, true)]))));
    const footer = () => host.querySelector("footer")!;
    const button = () => [...footer().querySelectorAll("button")].at(-1)!;
    const type = (value: string) => act(() => {
      const el = host.querySelector("#agent-instructions") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(button().textContent).toBe("Saved · rev 1");
    expect(button().disabled).toBe(true);
    type("Answer, then check the sum.");
    expect(button().textContent).toBe("Save revision");
    expect(button().disabled).toBe(false);
    await act(async () => { button().click(); });
    expect(button().textContent).toBe("Saving…");
    expect(button().disabled).toBe(true);
    // The save lands, and the page passes the revision it made (the served current one): rev 2.
    await act(async () => { answer(null); });
    act(() => root!.render(createElement(AgentEditor, props("r2", 2, [rev("r2", 2, true), rev("r1", 1, false)]))));
    expect(button().textContent).toBe("Saved · rev 2");
    expect(button().disabled).toBe(true);
    // No separate "Saved" note beside it: the button says it.
    expect([...footer().querySelectorAll("span")].some((s) => s.textContent?.trim() === "Saved")).toBe(false);
    type("Answer, then check the sum twice.");
    expect(button().textContent).toBe("Save revision");
    expect(button().disabled).toBe(false);
  });

  it("a save the server refuses leaves the button on, with why under it in the footer, not at the top of the page", async () => {
    const refused: SaveProblem = { kind: "invalid", message: "instructions is too long", fields: {} };
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(AgentEditor, { agent: agentAt("r1", 1), revisions: [rev("r1", 1, true)], caps, step: "context", onSave: async () => refused })));
    const footer = () => host.querySelector("footer")!;
    const button = () => [...footer().querySelectorAll("button")].at(-1)!;
    act(() => {
      const el = host.querySelector("#agent-instructions") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, "Answer, at length.");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { button().click(); });
    expect(button().textContent).toBe("Save revision");
    expect(button().disabled).toBe(false);
    const alert = footer().querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("instructions is too long");
    // Not at the top of the page any more.
    const top = [...host.querySelectorAll('[role="alert"]')].filter((a) => !footer().contains(a));
    expect(top.map((a) => a.textContent).join(" ")).not.toContain("instructions is too long");
  });
});
