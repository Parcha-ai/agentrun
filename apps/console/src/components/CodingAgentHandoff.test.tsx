import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodingAgentHandoff } from "./CodingAgentHandoff";
import { CODING_AGENT_KEY } from "@/lib/codingAgentHandoff";
import { optionsOf, pick, picker, valueOf } from "@/test/picker";

// "… with your coding agent": a dialog that copies a reviewed prompt for Claude Code or Codex. It keeps only the
// application picked, opens nothing, sends nothing, and leaves the prompt selected when the clipboard is refused.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
});

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const button = (scope: ParentNode, name: string) => [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const clipboard = (writeText: unknown) => Object.defineProperty(navigator, "clipboard", { configurable: true, value: writeText === undefined ? undefined : { writeText } });

function mount(props: Parameters<typeof CodingAgentHandoff>[0]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(CodingAgentHandoff, props)));
  return host;
}
async function open(host: HTMLElement, label: string) {
  await click(button(host, label)!);
  const d = dialog();
  if (!d) throw new Error("no dialog opened");
  return d;
}
function type(text: HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(text, value);
    text.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CodingAgentHandoff", () => {
  it("opens a dialog named for the task, the keyboard on the application, with its four destinations", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const host = mount({ context: { kind: "edit", agentId: "citer", revision: "r1" }, label: "Edit with your coding agent" });
    const d = await open(host, "Edit with your coding agent");
    expect(document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent).toBe("Edit with your coding agent");
    const field = picker(d, "Application")!;
    expect(document.activeElement).toBe(field);
    expect(valueOf(field)).toBe("claude");
    expect((await optionsOf(field)).map((o) => o.text)).toEqual(["Claude Code app", "Claude Code CLI", "Codex app", "Codex CLI"]);
    expect(d.textContent).toContain("Open your project in Claude Code and paste the prompt");
    expect(d.querySelector("textarea")!.value).toContain("PUT /v2/agents/citer/definition");
    // Opening it sent nothing.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("remembers only the application picked, and opens on it next time", async () => {
    const host = mount({ context: { kind: "create" }, label: "Build with your coding agent" });
    let d = await open(host, "Build with your coding agent");
    await pick(picker(d, "Application")!, "codex-cli");
    expect(d.textContent).toContain("start Codex with codex");
    await click(button(d, "Close")!);
    expect(dialog()).toBeNull();
    expect({ ...localStorage }).toEqual({ [CODING_AGENT_KEY]: "codex-cli" });
    d = await open(host, "Build with your coding agent");
    expect(valueOf(picker(d, "Application")!)).toBe("codex-cli");
  });

  it("copies the prompt as edited, says where to paste it, and keeps nothing of it in storage", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    clipboard(writeText);
    const host = mount({ context: { kind: "edit", agentId: "citer", revision: "r1" }, label: "Edit with your coding agent" });
    const d = await open(host, "Edit with your coding agent");
    type(d.querySelector("textarea")!, "Review this agent before revising.");
    await click(button(d, "Copy prompt")!);
    expect(writeText).toHaveBeenCalledWith("Review this agent before revising.");
    expect(d.querySelector('[role="status"]')?.textContent).toContain("Paste it into Claude Code app");
    expect(JSON.stringify({ ...localStorage })).not.toContain("Review this agent");
    // An edit after the copy takes the word back: what is in the field was not copied.
    type(d.querySelector("textarea")!, "Something else.");
    expect(d.textContent).not.toContain("Paste it into");
  });

  it.each([["refuses", true], ["is missing", false]])("when the clipboard %s, leaves the prompt selected and says to copy it with the keyboard", async (_, present) => {
    clipboard(present ? vi.fn().mockRejectedValue(new Error("Denied")) : undefined);
    const host = mount({ context: { kind: "edit", agentId: "citer", revision: "r1" }, label: "Edit with your coding agent" });
    const d = await open(host, "Edit with your coding agent");
    const text = d.querySelector("textarea")!;
    await click(button(d, "Copy prompt")!);
    expect(document.activeElement).toBe(text);
    expect([text.selectionStart, text.selectionEnd]).toEqual([0, text.value.length]);
    expect(d.querySelector('[role="alert"]')?.textContent).toContain("Copy it with your keyboard");
  });

  it("works with storage disabled", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("SecurityError"); });
    const host = mount({ context: { kind: "create" }, label: "Build with your coding agent" });
    const d = await open(host, "Build with your coding agent");
    await pick(picker(d, "Application")!, "codex");
    expect(valueOf(picker(d, "Application")!)).toBe("codex");
  });

  it("reads a run's context when pressed: the input as typed then, pinned to the revision", async () => {
    let typed = "First draft.";
    const host = mount({ context: () => ({ kind: "run", agentId: "citer", revision: "r7", input: { content: typed } }), label: "Run with your coding agent" });
    typed = "Check this claim.";
    const d = await open(host, "Run with your coding agent");
    const prompt = d.querySelector("textarea")!.value;
    expect(prompt).toContain('"content": "Check this claim."');
    expect(prompt).toContain("POST /v2/agents/citer/runs");
    expect(prompt).toContain('"revision": "r7"');
  });
});
