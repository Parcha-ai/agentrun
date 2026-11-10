import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RunHeader } from "./RunHeader";
import type { RaiseAnswer, Run } from "@/lib/v2";

// The run header raises a capped run's spend cap too, so a working run with a cap is raised before it pauses: its
// answer has resumed false and a note (its live process keeps the old cap until its next one), which is said. A capped
// workflow run offers one as an agentic run does; a run with no cap and an ended run offer none.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const run = (extra: Partial<Run> = {}): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0,
  run_id: "r1", agent_id: "calc", agent_version: 1, revision: "rv1", kind: "agentic", status: "working", state: "working", title: "Take your time.",
  created_at: "2026-11-05T00:00:00Z", ended_at: null, result: null, error: null, archived_at: null,
  cost: { usd: 0.01, basis: "estimate", charge_state: null, cap_usd: 10 }, ...extra,
});
const NOTE = "The run's process keeps the $10 cap it was opened with; the $11 cap holds from its next process.";

function mount(r: Run, onRaiseCap?: (usd: number) => Promise<RaiseAnswer>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RunHeader, { run: r, agentName: "Calc", actions: { onStop: () => {}, onCancel: () => {}, ...(onRaiseCap ? { onRaiseCap } : {}) } })));
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);
  return { host, button };
}
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("RunHeader's Raise the cap", () => {
  it("a working run with a cap is raised from the header: the form opens empty, above its cap, and the answer's note is said", async () => {
    const asked: number[] = [];
    const t = mount(run(), async (usd) => { asked.push(usd); return { run_id: "r1", max_cost_usd: usd, resumed: false, status: "working", state: "working", note: NOTE }; });
    expect(t.host.querySelector('form[aria-label="Raise the cap"]')).toBeNull();
    await act(async () => { t.button("Raise the cap")!.click(); });
    const input = t.host.querySelector('input[aria-label="New cap in dollars"]') as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("more than $10");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "11"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { (t.host.querySelector('form[aria-label="Raise the cap"] button[type="submit"]') as HTMLButtonElement).click(); });
    await settle();
    expect(asked).toEqual([11]);
    expect(t.host.textContent).toContain(NOTE);
  });

  it("a run paused at its cap is raised from the header too, prefilled with the server's suggestion", async () => {
    const paused = run({ status: "input_required", state: "waiting", cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: 0.05 },
      pending: { kind: "budget", cap_usd: 0.05, spent_usd: 0, needs_usd: 0.1024, suggested_cap_usd: 2, said: "Not sent.", at: "2026-11-05T00:00:05Z" } });
    const t = mount(paused, async (usd) => ({ run_id: "r1", max_cost_usd: usd, resumed: true, message_id: "m1", status: "input_required", state: "waiting" }));
    await act(async () => { t.button("Raise the cap")!.click(); });
    expect((t.host.querySelector('input[aria-label="New cap in dollars"]') as HTMLInputElement).value).toBe("2");
  });

  it("an open header form follows a new pause: a working run that pauses, then pauses again after a raise, shows each pause's suggestion", async () => {
    const paused = (cap: number, suggested: number, at: string) => run({ status: "input_required", state: "waiting", cost: { usd: 0, basis: "estimate", charge_state: null, cap_usd: cap },
      pending: { kind: "budget", cap_usd: cap, spent_usd: 0, needs_usd: 0.1024, suggested_cap_usd: suggested, said: "Not sent.", at } });
    const onRaiseCap = async (usd: number): Promise<RaiseAnswer> => ({ run_id: "r1", max_cost_usd: usd, resumed: true, status: "input_required", state: "waiting" });
    const t = mount(run(), onRaiseCap);
    await act(async () => { t.button("Raise the cap")!.click(); });
    const value = () => (t.host.querySelector('input[aria-label="New cap in dollars"]') as HTMLInputElement).value;
    expect(value()).toBe("");
    const render = (r: Run) => act(() => root!.render(createElement(RunHeader, { run: r, agentName: "Calc", actions: { onStop: () => {}, onCancel: () => {}, onRaiseCap } })));
    render(paused(10, 12, "2026-11-05T00:00:05Z"));
    expect(value()).toBe("12");
    render(paused(12, 15, "2026-11-05T00:00:09Z"));
    expect(value()).toBe("15");
  });

  it("a capped workflow run that has not ended offers a raise, as an agentic run does", () => {
    expect(mount(run({ kind: "workflow" }), async () => { throw new Error("not raised here"); }).button("Raise the cap")).toBeDefined();
  });

  it("a run with no cap and an ended run offer no raise; nor does a page that gives no way to raise", () => {
    for (const r of [run({ cost: { usd: 0.01, basis: "estimate", charge_state: null, cap_usd: null } }), run({ status: "completed", state: "idle", ended_at: "2026-11-05T00:01:00Z" })]) {
      const t = mount(r, async () => { throw new Error("no raise"); });
      expect(t.button("Raise the cap"), JSON.stringify([r.kind, r.status, r.cost?.cap_usd])).toBeUndefined();
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
    expect(mount(run()).button("Raise the cap")).toBeUndefined();
  });

  // A run that waits on the person for something other than its cap (an approval, a question, its browser or computer)
  // is not held by its cap: a raise there changes nothing it waits on, so the header offers none. A cap pause does.
  it("a run waiting on an approval, a question, its browser or its computer offers no raise; one paused at its cap does", () => {
    const raise = async (): Promise<RaiseAnswer> => { throw new Error("not raised here"); };
    const asked = { instruction: "Sign in to the portal.", completion_condition: "The portal shows the list.", asked_at: "2026-11-05T00:00:30Z", expires_at: "2026-11-05T00:30:00Z" };
    const waits: Run["pending"][] = [
      { kind: "approval", id: "ap1", tool: "web_fetch", call_id: "c1", args_preview: "{}", requested_at: "2026-11-05T00:00:30Z" },
      { kind: "question", question: "Which currency?", asked_at: "2026-11-05T00:00:30Z" },
      { kind: "browser", ...asked },
      { kind: "computer", computer: "phone", ...asked },
    ];
    for (const pending of waits) {
      const t = mount(run({ status: "input_required", state: "waiting", pending }), raise);
      expect(t.button("Raise the cap"), pending!.kind).toBeUndefined();
      act(() => root?.unmount()); document.body.innerHTML = "";
    }
    const paused = mount(run({ status: "input_required", state: "waiting", pending: { kind: "budget", cap_usd: 10, said: "Paused at its cap.", at: "2026-11-05T00:00:30Z" } }), raise);
    expect(paused.button("Raise the cap")).toBeDefined();
  });
});
