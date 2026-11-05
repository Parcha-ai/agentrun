import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import { RaiseCap } from "./NeedsYou";
import type { RaiseAnswer, Run } from "@/lib/v2";

// A run paused at its spend cap, as a first-timer meets it: the chip says it is paused at its cap (not that it asks for
// input), the header shows what it spent of its cap (the served cost.cap_usd), the one raise is the pause banner's (the
// header's would be a second way in), the raise says a cap is a ceiling, not a charge, and the header's actions wrap on a
// phone instead of running off its edge.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: (() => void)[] = [];
afterEach(() => { roots.splice(0).forEach((u) => u()); document.body.innerHTML = ""; });

const CEILING = "A cap is a ceiling: the run is charged only for what it uses.";
const base = (extra: Partial<Run> = {}): Run => ({
  run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "working", state: "working", title: "Write one.md",
  created_at: "2026-11-05T00:00:00Z", ended_at: null, result: null, error: null, archived_at: null,
  cost: { usd: 0.52, basis: "estimate", charge_state: null, cap_usd: 0.6 }, ...extra,
});
const paused = (): Run => base({ status: "input_required", state: "waiting",
  pending: { kind: "budget", cap_usd: 0.6, spent_usd: 0.52, needs_usd: 0.1, suggested_cap_usd: 2, said: "Not sent.", at: "2026-11-05T00:00:05Z" } });
const onRaiseCap = async (usd: number): Promise<RaiseAnswer> => ({ run_id: "r1", max_cost_usd: usd, resumed: true, status: "input_required", state: "waiting" });
const actions = { onStop: () => {}, onCancel: () => {}, onArchive: () => {}, onRaiseCap };

function mount(run: Run) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (r: Run) => act(() => root.render(createElement(RunHeader, { run: r, agentName: "Calc", actions })));
  render(run);
  roots.push(() => act(() => root.unmount()));
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  const cost = () => host.querySelector('[data-run-cost]')?.textContent?.trim();
  const chip = () => host.querySelector('[data-run-status]')?.textContent?.trim();
  return { host, render, button, cost, chip };
}

describe("RunHeader on a run paused at its spend cap", () => {
  it("the chip says Paused at cap, not Input required", () => {
    expect(mount(paused()).chip()).toBe("Paused at cap");
  });

  it("a run waiting on a question still reads Input required", () => {
    const asking = base({ status: "input_required", state: "waiting", pending: { kind: "question", question: "Which city?", asked_at: "2026-11-05T00:00:05Z" } });
    expect(mount(asking).chip()).toBe("Input required");
  });

  it("the header offers no raise while paused (the banner's raise continues it); a working capped run's header still does", () => {
    expect(mount(paused()).button("Raise the cap")).toBeUndefined();
    roots.splice(0).forEach((u) => u()); document.body.innerHTML = "";
    expect(mount(base()).button("Raise the cap")).toBeDefined();
  });

  it("the header shows what it spent of its served cap, and the new cap once raised", () => {
    const t = mount(paused());
    expect(t.cost()).toBe("$0.52 est. of $0.60 cap");
    t.render({ ...base(), cost: { usd: 0.52, basis: "estimate", charge_state: null, cap_usd: 2 } });
    expect(t.cost()).toBe("$0.52 est. of $2 cap");
  });

  it("a run with no cap shows its cost alone", () => {
    expect(mount(base({ cost: { usd: 0.52, basis: "estimate", charge_state: null, cap_usd: null } })).cost()).toBe("$0.52 est.");
  });

  it("the header's actions wrap (a phone's width never cuts Archive off)", () => {
    const row = mount(base()).host.querySelector('[role="group"][aria-label="Run actions"]');
    expect(row?.className.split(" ")).toEqual(expect.arrayContaining(["flex-wrap", "max-w-full"]));
    expect(row?.className.split(" ")).not.toContain("shrink-0");
  });
});

describe("RaiseCap says a cap is a ceiling", () => {
  it("under the raise box, paused or working", () => {
    for (const isPaused of [true, false]) {
      const host = document.body.appendChild(document.createElement("div"));
      const root = createRoot(host);
      act(() => root.render(createElement(RaiseCap, { cap: 0.6, suggested: isPaused ? 2 : null, paused: isPaused, onRaise: onRaiseCap })));
      roots.push(() => act(() => root.unmount()));
      expect([...host.querySelectorAll("form p")].map((p) => p.textContent?.trim())).toContain(CEILING);
    }
  });
});
