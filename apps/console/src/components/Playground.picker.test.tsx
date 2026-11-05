import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// The Playground's Agent and Revision fields are the console's picker, not native <select>s, which a phone opens
// detached from the field: each opens its list right under itself (anchored "bottom start"; the walk measures the real
// box at 390×844 and 844×390), and is driven by the keyboard as a listbox is. jsdom has no layout, so here the list's
// anchored placement is read from its data-anchor, which starts "bottom" when it opens below its field.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => {
  // The picker's positioning watches its field's size; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const base = agentFixture("invoice-checker");
const other = { ...base, agent_id: "second", definition: { ...base.definition, name: "Second agent" } };
const REVISIONS = [{ revision: "rv2", version: 2, current: true, note: null }, { revision: "rv1", version: 1, current: false, note: "first cut" }];
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); }); await settle(); };

function open(onAgent?: (id: string) => void) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Playground, { agents: [base, other], revisions: REVISIONS, efforts: [], origin: "http://serve.test", agentId: base.agent_id, onAgent })));
  const field = (label: string) => host.querySelector(`button[aria-haspopup="listbox"][aria-label="${label}"]`) as HTMLButtonElement | null;
  return { host, field };
}

describe("Playground's Agent and Revision pickers", () => {
  it("are listbox pickers, not native selects", () => {
    const t = open();
    expect(t.host.querySelector("select")).toBeNull();
    expect(t.field("Agent")?.textContent).toContain(base.definition.name);
    expect(t.field("Revision")?.textContent).toContain("The current revision");
  });

  it("the Agent picker opens its list under the field, and the keyboard picks: ArrowDown, Enter", async () => {
    const picked: string[] = [];
    const t = open((id) => picked.push(id));
    await act(async () => { t.field("Agent")!.click(); });
    await settle();
    const list = document.querySelector('[role="listbox"]')!;
    expect(list, "the list opens").not.toBeNull();
    expect(list.getAttribute("data-anchor")).toMatch(/^bottom/);
    expect([...list.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([base.definition.name, "Second agent"]);
    await key(list, "ArrowDown");
    await key(list, "Enter");
    expect(picked).toEqual(["second"]);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(t.field("Agent")?.textContent).toContain("Second agent");
    expect(t.host.textContent).toContain("/v2/agents/second/runs");
  });

  it("the Revision picker lists the current revision first and each revision, and the one picked goes in the request", async () => {
    const t = open();
    await act(async () => { t.field("Revision")!.click(); });
    await settle();
    const list = document.querySelector('[role="listbox"]')!;
    expect(list.getAttribute("data-anchor")).toMatch(/^bottom/);
    expect([...list.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(["The current revision", "rev 2 (current)", "rev 1: first cut"]);
    await key(list, "End");
    await key(list, "Enter");
    expect(t.field("Revision")?.textContent).toContain("rev 1: first cut");
    // The request is built once it has its input.
    await act(async () => { const ta = t.host.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, "Check it."); ta.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(t.host.textContent).toContain('"revision":"rv1"');
  });

  it("Esc closes the list and leaves the value as it was", async () => {
    const picked: string[] = [];
    const t = open((id) => picked.push(id));
    await act(async () => { t.field("Agent")!.click(); });
    await settle();
    await key(document.querySelector('[role="listbox"]')!, "Escape");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(picked).toEqual([]);
    expect(t.field("Agent")?.textContent).toContain(base.definition.name);
  });
});
