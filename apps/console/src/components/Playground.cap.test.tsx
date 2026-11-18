import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Playground } from "./Playground";
import { agentFixture } from "@/fixtures";

// The playground's max_cost_usd box: empty, a run takes the agent's default cap (its definition's max_cost_usd), so the
// box shows that cap and says so, as the run bar does. An agent with no default cap runs uncapped when the box is empty.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => { globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver; });
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const base = agentFixture("invoice-checker");
function open(maxCostUsd?: number) {
  const agent = { ...base, definition: { ...base.definition, ...(maxCostUsd === undefined ? {} : { max_cost_usd: maxCostUsd }) } };
  if (maxCostUsd === undefined) delete (agent.definition as { max_cost_usd?: number }).max_cost_usd;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Playground, { agents: [agent], revisions: [], efforts: [], origin: "http://serve.test", agentId: agent.agent_id })));
  const box = host.querySelector<HTMLInputElement>("#playground-cap")!;
  const note = box.closest("label, div")!.parentElement!.textContent ?? "";
  return { box, note };
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
});
