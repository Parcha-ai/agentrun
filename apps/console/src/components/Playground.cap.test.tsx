import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// The playground's max_cost_usd box: empty, a run takes the agent's default cap (its definition's max_cost_usd), so the
// box shows that cap and says so, as the run bar does. An agent with no default cap runs uncapped when the box is empty.
// A picked revision runs with its own default cap, not the current one's, so the box then shows that revision's.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver; });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const base = agentFixture("invoice-checker");
type Rev = { revision: string; version: number; current: boolean; note: string | null; definition?: Record<string, unknown> };
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const key = async (el: Element, k: string) => { await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); }); await settle(); };
function open(maxCostUsd?: number, revisions: Rev[] = []) {
  const agent = { ...base, definition: { ...base.definition, ...(maxCostUsd === undefined ? {} : { max_cost_usd: maxCostUsd }) } };
  if (maxCostUsd === undefined) delete (agent.definition as { max_cost_usd?: number }).max_cost_usd;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Playground, { agents: [agent], revisions, efforts: [], origin: "http://serve.test", agentId: agent.agent_id })));
  const read = () => {
    const box = host.querySelector<HTMLInputElement>("#playground-cap")!;
    return { box, note: box.closest("label, div")!.parentElement!.textContent ?? "" };
  };
  // Picks the last revision in the Revision picker's list, as a person does with the keyboard.
  const pickLast = async () => {
    await act(async () => { (host.querySelector('button[aria-haspopup="listbox"][aria-label="Revision"]') as HTMLButtonElement).click(); });
    await settle();
    const list = document.querySelector('[role="listbox"]')!;
    await key(list, "End");
    await key(list, "Enter");
  };
  return { ...read(), read, pickLast };
}

describe("Playground's max_cost_usd box", () => {
  it("shows the agent's default cap, and says an empty box uses it", () => {
    const t = open(0.25);
    expect(t.box.placeholder).toBe("$0.25");
    expect(t.note).toContain("Empty uses the agent's default cap, $0.25.");
    expect(t.note).not.toContain("empty means none");
  });

  it("says an empty box means no cap when the agent has no default", () => {
    const t = open(undefined);
    expect(t.box.placeholder).toBe("e.g. 0.50");
    expect(t.note).toContain("Empty runs it with no cap.");
  });

  it("shows the picked revision's default cap, not the current revision's", async () => {
    const t = open(0.25, [{ revision: "rv2", version: 2, current: true, note: null, definition: { max_cost_usd: 0.25 } }, { revision: "rv1", version: 1, current: false, note: "first cut", definition: {} }]);
    expect(t.note).toContain("Empty uses the agent's default cap, $0.25.");
    await t.pickLast();
    const uncapped = t.read();
    expect(uncapped.box.placeholder).toBe("e.g. 0.50");
    expect(uncapped.note).toContain("Empty runs it with no cap.");
    expect(uncapped.note).not.toContain("$0.25");
  });

  it("shows a picked revision's own cap when the current revision has another", async () => {
    const t = open(0.25, [{ revision: "rv2", version: 2, current: true, note: null, definition: { max_cost_usd: 0.25 } }, { revision: "rv1", version: 1, current: false, note: null, definition: { max_cost_usd: 2 } }]);
    await t.pickLast();
    const older = t.read();
    expect(older.box.placeholder).toBe("$2");
    expect(older.note).toContain("Empty uses that revision's default cap, $2.");
  });

  it("names no amount for a picked revision whose definition the page does not hold", async () => {
    const t = open(0.25, [{ revision: "rv2", version: 2, current: true, note: null }, { revision: "rv1", version: 1, current: false, note: null }]);
    await t.pickLast();
    const unknown = t.read();
    expect(unknown.box.placeholder).toBe("e.g. 0.50");
    expect(unknown.note).toContain("Empty uses that revision's default cap, or none if it has none.");
    expect(unknown.note).not.toContain("$0.25");
  });
});
