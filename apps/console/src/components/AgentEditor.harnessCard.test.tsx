import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEditor, type EditorCaps } from "./AgentEditor";

// A harness card the server runs is one click target, edge to edge: a click anywhere on it (its padding included, not
// only the row with the radio) picks the harness. A card it doesn't run keeps its details line apart, so opening the
// reason never picks it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tools = [{ name: "read", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }, { name: "write", available: true, harnesses: ["pi", "claude-agent", "codex", "opencode"] }];
const caps: EditorCaps = { harnesses: [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: false, reason: "codex needs OPENAI_API_KEY." }], tools, thinking: ["low"] };

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function mount() {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentEditor, { agent: null, caps, step: "settings" })));
  const radio = (id: string) => host.querySelector<HTMLInputElement>(`input[name="harness"][value="${id}"]`)!;
  // The card: the radiogroup's child that holds the radio.
  const card = (id: string) => [...host.querySelector('[role="radiogroup"][aria-label="Harness"]')!.children].find((c) => c.contains(radio(id))) as HTMLElement;
  return { host, radio, card };
}

describe("AgentEditor, a harness card's click target", () => {
  it("picks an available harness on a click on the card itself, its padding included", async () => {
    const { radio, card } = mount();
    expect(radio("pi").checked).toBe(true);
    await act(async () => { card("claude-agent").click(); });
    expect(radio("claude-agent").checked).toBe(true);
    expect(radio("pi").checked).toBe(false);
  });

  it("opens an unavailable card's reason without picking it", async () => {
    const { radio, card } = mount();
    const summary = card("codex").querySelector("summary")!;
    await act(async () => { summary.click(); });
    expect(radio("codex").checked).toBe(false);
    expect(radio("pi").checked).toBe(true);
  });
});
