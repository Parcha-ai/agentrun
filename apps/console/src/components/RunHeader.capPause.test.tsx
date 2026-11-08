import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import { RaiseCap } from "./NeedsYou";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import type { RaiseAnswer, Run } from "@/lib/v2";

// A run paused at its spend cap, as a first-timer meets it: the chip says it is paused at its cap (not that it asks for
// input), the header shows what it spent of its cap (the served cost.cap_usd), the one raise is the pause banner's (the
// header's would be a second way in), the raise says a cap is a ceiling, not a charge, and the header's actions wrap on a
// phone instead of running off its edge.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: (() => void)[] = [];
afterEach(() => { roots.splice(0).forEach((u) => u()); document.body.innerHTML = ""; });

const CEILING = "A cap is a ceiling: the run is charged only for what it uses.";
const base = (extra: Partial<Run> = {}): Run => ({ sha: null, updated_at: "2026-11-05T00:00:00Z", poll_after_ms: 0,
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

  it("a run waiting on a tool call's approval reads Approval required (the card's own heading)", () => {
    const approving = base({ status: "input_required", state: "waiting", pending: { kind: "approval", id: "a1", tool: "bash", call_id: "c1", args_preview: "{}", requested_at: "2026-11-05T00:00:05Z" } } as Partial<Run>);
    expect(mount(approving).chip()).toBe("Approval required");
  });

  it("a kind this console doesn't know keeps Input required", () => {
    const other = base({ status: "input_required", state: "waiting", pending: { kind: "a_future_kind" } } as unknown as Partial<Run>);
    expect(mount(other).chip()).toBe("Input required");
  });

  it("a budget pause sent with its kind only still offers a raise: the banner's, at the run's served cost.cap_usd", () => {
    const f = runFixture("run.input_required.waiting.1");
    const run = { ...f.run, kind: "agentic", status: "input_required", state: "waiting", ended_at: null, cost: { usd: 0.52, basis: "estimate", charge_state: null, cap_usd: 0.6 }, pending: { kind: "budget" } } as unknown as Run;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(createElement(RunDetail, { run, agentName: "Calc", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions, onMessage: () => {}, tab: "report" })));
    roots.push(() => act(() => root.unmount()));
    const forms = host.querySelectorAll('form[aria-label="Raise the cap"]');
    expect(forms).toHaveLength(1);
    expect(forms[0]!.querySelector("input")?.getAttribute("placeholder")).toBe("more than $0.60");
    expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("Raise the cap and continue");
  });

  it("the header offers no raise while paused (the banner's raise continues it); a working capped run's header still does", () => {
    expect(mount(paused()).button("Raise the cap")).toBeUndefined();
    roots.splice(0).forEach((u) => u()); document.body.innerHTML = "";
    expect(mount(base()).button("Raise the cap")).toBeDefined();
  });

  // A workflow run takes a cap too (serve's #1861): paused at it, the same one way in, the banner's raise.
  it("a workflow run paused at its cap: the banner's raise, and no raise in the header", () => {
    const run = { ...paused(), kind: "workflow" } as Run;
    expect(mount(run).button("Raise the cap")).toBeUndefined();
    expect(mount(base({ kind: "workflow" })).button("Raise the cap")).toBeDefined();
    const f = runFixture("run.input_required.waiting.1");
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(createElement(RunDetail, { run, agentName: "Calc", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions, onMessage: () => {}, tab: "report" })));
    roots.push(() => act(() => root.unmount()));
    expect(host.querySelectorAll('form[aria-label="Raise the cap"]')).toHaveLength(1);
    expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("Raise the cap and continue");
  });

  // A workflow run opens on its Graph tab: paused at its cap, the banner and its one raise show there too.
  it("a workflow run paused at its cap, on its Graph tab: the banner's raise shows above the graph", () => {
    const run = { ...paused(), kind: "workflow" } as Run;
    const f = runFixture("run.input_required.waiting.1");
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    act(() => root.render(createElement(RunDetail, { run, agentName: "Calc", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions, onMessage: () => {}, tab: "graph", graphView: createElement("div", { "data-graph": "" }) })));
    roots.push(() => act(() => root.unmount()));
    expect(host.querySelector("[data-graph]")).not.toBeNull();
    expect(host.querySelectorAll('form[aria-label="Raise the cap"]')).toHaveLength(1);
    expect([...host.querySelectorAll("button")].map((b) => b.textContent?.trim())).toContain("Raise the cap and continue");
  });

  // A live workflow page gives its graph's cost (costText): its served cap shows beside it, and the new one once raised.
  it("a workflow run's header shows its graph's cost and its served cap beside it", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const render = (r: Run) => act(() => root.render(createElement(RunHeader, { run: r, agentName: "Calc", actions, costText: "$0.31 so far" })));
    render(base({ kind: "workflow" }));
    roots.push(() => act(() => root.unmount()));
    const cost = () => host.querySelector("header span[title^=\"The run's decisions\"]")?.textContent?.trim();
    expect(cost()).toBe("$0.31 so far · $0.60 cap");
    render(base({ kind: "workflow", cost: { usd: 0.52, basis: "estimate", charge_state: null, cap_usd: 2 } }));
    expect(cost()).toBe("$0.31 so far · $2 cap");
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
