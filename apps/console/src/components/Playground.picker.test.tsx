import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// Agent and Revision open listbox options. The combobox retains focus while arrows preview an option, Enter
// applies it, and Escape dismisses it without changing the request.
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
    expect(t.field("Revision")?.textContent).toContain("The loaded current revision (rev 3)");
  });

  it("the Agent picker opens its list, and the keyboard picks: ArrowDown, Enter", async () => {
    const picked: string[] = [];
    const t = open((id) => picked.push(id));
    await act(async () => { t.field("Agent")!.click(); });
    await settle();
    const list = document.querySelector('[role="listbox"]')!;
    expect(list, "the list opens").not.toBeNull();
    expect(t.field("Agent")?.getAttribute("aria-expanded")).toBe("true");
    expect([...list.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([base.definition.name, "Second agent"]);
    await key(t.field("Agent")!, "ArrowDown");
    await key(t.field("Agent")!, "Enter");
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
    expect(t.field("Revision")?.getAttribute("aria-expanded")).toBe("true");
    expect([...list.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(["The loaded current revision (rev 3)", "rev 2 (current)", "rev 1: first cut"]);
    await key(t.field("Revision")!, "End");
    await key(t.field("Revision")!, "Enter");
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
    await key(t.field("Agent")!, "Escape");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(picked).toEqual([]);
    expect(t.field("Agent")?.textContent).toContain(base.definition.name);
  });
});
