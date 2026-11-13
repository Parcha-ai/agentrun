import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunBar } from "./RunBar";
import type { Agent } from "@/lib/agentForm";
// The shared picker helper: importing it installs the ResizeObserver stub the picker's positioning needs (jsdom has none).
import "@/test/picker";

// The run bar's visible "Effort" caption is the Picker's label: a click on it acts on the picker as a click on the picker
// does (its list opens, focus moves into it), as a click on a select's label did.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const agent: Agent = {
  agent_id: "thinker", kind: "agentic", revision: "rv1", revisions: 1, archived_at: null,
  definition: { version: 1, name: "Thinker", instructions: "Think.", harness: "pi", skills: [], tools: ["read"] },
};

describe("RunBar, the Effort caption", () => {
  it("a click on the visible Effort caption opens the Effort picker", () => {
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(RunBar, { agent, efforts: ["low", "high"], v2: {} as never, go: () => {} })));
    const button = host.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"][aria-label="Effort"]');
    expect(button).not.toBeNull();
    const caption = [...host.querySelectorAll("label, span")].find((e) => e.textContent?.trim() === "Effort" && e.children.length === 0) as HTMLElement;
    expect(caption).toBeTruthy();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    act(() => caption.click());
    expect(button!.getAttribute("aria-expanded")).toBe("true");
    const list = host.ownerDocument.querySelector('[role="listbox"]');
    expect(list).not.toBeNull();
    expect(list!.contains(document.activeElement)).toBe(true);
  });
});
