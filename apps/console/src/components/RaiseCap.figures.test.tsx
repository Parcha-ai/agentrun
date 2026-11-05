import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { RunHeader } from "./RunHeader";
import { messageFeatures, runFixture } from "@/fixtures";
import type { RaiseAnswer, Run } from "@/lib/v2";

// A run paused at its cap names two figures that read as a contradiction side by side: the least cap that sends the
// refused request (`least_cap_usd`, the "at least $X" in the server's words) and the raise it is offered
// (`suggested_cap_usd`, prefilled). Each raise form says them apart, labelled, both as served; with no least served (an
// older server) only the suggestion is named.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: (() => void)[] = [];
afterEach(() => { roots.splice(0).forEach((u) => u()); document.body.innerHTML = ""; });

const SAID = "Not sent: the run has spent $0.52 of its $0.60 cap, and its next faux-1 request needs at least $0.10. Raise the cap to at least $0.62 to run it.";
const pending = (extra: Record<string, unknown> = {}) => ({ kind: "budget", cap_usd: 0.6, spent_usd: 0.52, needs_usd: 0.1, least_cap_usd: 0.62, suggested_cap_usd: 4, said: SAID, at: "2026-11-05T00:00:05Z", ...extra });
const paused = (p: Record<string, unknown>): Run => {
  const f = runFixture("run.input_required.waiting.1");
  return { ...f.run, kind: "agentic", status: "input_required", state: "waiting", ended_at: null, cost: { usd: 0.52, basis: "estimate", charge_state: null, cap_usd: 0.6 }, pending: p } as unknown as Run;
};
const onRaiseCap = async (usd: number): Promise<RaiseAnswer> => ({ run_id: "r1", max_cost_usd: usd, resumed: true, status: "input_required", state: "waiting" });

function mount(el: ReturnType<typeof createElement>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(el));
  roots.push(() => act(() => root.unmount()));
  return host;
}
// The figures a raise form names, by their labels, from its elements.
const figures = (form: Element) => [...form.querySelectorAll("[data-cap-figure]")].map((e) => [e.getAttribute("data-cap-figure"), e.textContent?.trim()]);
const banner = (run: Run) => {
  const f = runFixture("run.input_required.waiting.1");
  const host = mount(createElement(RunDetail, { run, agentName: "invoice-checker", messages: messageFeatures, harnessSteers: true, rows: f.page.rows, files: [], actions: { onRaiseCap }, onMessage: () => {}, tab: "report" }));
  // The banner's form, not the header's (closed until its button is clicked).
  const forms = host.querySelectorAll('form[aria-label="Raise the cap"]');
  expect(forms).toHaveLength(1);
  return forms[0]!;
};
const header = async (run: Run) => {
  const host = mount(createElement(RunHeader, { run, agentName: "Calc", actions: { onStop: () => {}, onCancel: () => {}, onRaiseCap } }));
  await act(async () => { [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Raise the cap")!.click(); });
  return host.querySelector('form[aria-label="Raise the cap"]')!;
};
const input = (form: Element) => form.querySelector<HTMLInputElement>('input[aria-label="New cap in dollars"]')!;

describe("a raise form names the least to continue and the suggestion apart", () => {
  it("the banner's: Least to continue $0.62, Suggested $4, the input prefilled with the suggestion", () => {
    const form = banner(paused(pending()));
    expect(figures(form)).toEqual([["least", "Least to continue: $0.62"], ["suggested", "Suggested: $4"]]);
    expect(input(form).value).toBe("4");
  });

  it("the header's, on the same pause: the same two figures, the same prefill", async () => {
    const form = await header(paused(pending()));
    expect(figures(form)).toEqual([["least", "Least to continue: $0.62"], ["suggested", "Suggested: $4"]]);
    expect(input(form).value).toBe("4");
  });

  it("with no least served (an older server), each names the suggestion only", async () => {
    const run = paused(pending({ least_cap_usd: undefined }));
    expect(figures(banner(run))).toEqual([["suggested", "Suggested: $4"]]);
    roots.splice(0).forEach((u) => u()); document.body.innerHTML = "";
    expect(figures(await header(run))).toEqual([["suggested", "Suggested: $4"]]);
  });

  it("a working run's header form (no pause) names neither", async () => {
    const working = { ...paused(pending()), status: "working", state: "working", pending: null } as unknown as Run;
    expect(figures(await header(working))).toEqual([]);
  });
});
