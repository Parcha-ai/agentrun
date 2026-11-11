import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AgentsList } from "./AgentsList";

// An agent card's footer reads the same whatever its chips (Manuel's QA: a card with the Learning chip squeezed its
// actions and broke "14 runs · 1 live" over three lines): its three actions never shrink and sit apart from the chips,
// and each chip stays on one line, wrapping as a whole chip within the chips' own area. jsdom lays nothing out, so the
// layout is read from the classes that make it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agent = (id: string, revisions: number, runs: { count: number; live: number }, pending = 0) => ({
  agent_id: id, kind: "agentic", revision: "r", revisions, archived_at: null, runs, ...(pending ? { learning: { pending } } : {}),
  definition: { version: 1, name: id, description: "", instructions: "x", harness: "pi", skills: [], tools: [] },
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

function render(agents: ReturnType<typeof agent>[]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(AgentsList, { agents: agents as never, actions: { onEdit: () => {}, onRuns: () => {}, onArchive: () => {}, onLearning: () => {} } })));
  return host;
}
const classes = (el: Element | null) => new Set((el?.getAttribute("class") ?? "").split(/\s+/));

describe("AgentsList card footer", () => {
  it("keeps the three actions full size and each chip on one line, with or without the Learning chip", () => {
    const host = render([agent("plain", 1, { count: 1, live: 0 }), agent("hello", 7, { count: 14, live: 1 }, 1)]);
    const cards = [...host.querySelectorAll("ul > li")];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      const chips = card.querySelector("[data-testid=agent-card-chips]");
      const actions = card.querySelector("[data-testid=agent-card-actions]");
      // The chips' area takes what is left and wraps whole chips; the actions' area never gives up its width.
      expect([...classes(chips)].filter((c) => ["flex-wrap", "flex-1", "min-w-0"].includes(c)).sort()).toEqual(["flex-1", "flex-wrap", "min-w-0"]);
      expect(classes(actions).has("shrink-0")).toBe(true);
      const buttons = [...actions!.querySelectorAll("button")];
      expect(buttons.map((b) => b.getAttribute("aria-label")?.split(" ")[0])).toEqual(["Edit", "Runs", "Archive"]);
      for (const button of buttons) expect(classes(button).has("shrink-0") && classes(button).has("size-control-sm")).toBe(true);
      // Every chip, the Learning one too: one line, never shrunk below its words.
      const each = [...chips!.children];
      expect(each.length).toBe(card === cards[1] ? 3 : 2);
      for (const chip of each) expect([classes(chip).has("whitespace-nowrap"), classes(chip).has("shrink-0")], chip.textContent ?? "").toEqual([true, true]);
    }
    expect(cards[1]!.querySelector("[data-testid=agent-card-chips]")!.textContent).toBe("7 revisions14 runs · 1 liveLearning · 1");
  });
});
