import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures, runFixture } from "@/fixtures";
import type { Run } from "@/lib/v2";

// A run paused at its spend cap shows one raise form, under its banner. The header's Raise the cap button takes the
// person to that form (it scrolls to it and focuses its amount) instead of opening a second one above it. A working
// capped run has no banner form, so there the header's button still opens its own.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const f = runFixture("run.input_required.waiting.1");
const raise = async (usd: number) => ({ run_id: f.run.run_id, max_cost_usd: usd, resumed: true, message_id: "m1", status: "input_required", state: "waiting" }) as never;
function mount(run: Run) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunDetail, { run, agentName: "invoice-checker", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: { onRaiseCap: raise }, onMessage: () => {} })));
  const forms = () => host.querySelectorAll('form[aria-label="Raise the cap"]');
  const button = () => [...host.querySelectorAll("header button")].find((b) => b.textContent?.includes("Raise the cap")) as HTMLButtonElement | undefined;
  return { host, forms, button };
}

describe("raising a run's cap from its page", () => {
  it("a run paused at its cap shows one raise form; the header's button goes to it instead of opening another", () => {
    const paused: Run = { ...f.run, status: "input_required", state: "waiting", cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: 0.00001 },
      pending: { kind: "budget", cap_usd: 0.00001, spent_usd: 0, needs_usd: 0.01, suggested_cap_usd: 1, said: "Not sent.", at: "2026-11-18T19:18:00Z" } } as Run;
    const t = mount(paused);
    expect(t.forms().length).toBe(1);
    expect(t.button()).toBeDefined();
    act(() => t.button()!.click());
    expect(t.forms().length).toBe(1);
    expect(document.activeElement).toBe(t.forms()[0].querySelector("input"));
  });

  it("a working capped run, with no banner form, still opens the header's own form", () => {
    const working: Run = { ...f.run, status: "working", state: "working", pending: null, cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: 0.5 } } as unknown as Run;
    const t = mount(working);
    expect(t.forms().length).toBe(0);
    act(() => t.button()!.click());
    expect(t.forms().length).toBe(1);
  });
});
