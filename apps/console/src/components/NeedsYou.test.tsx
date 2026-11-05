import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RaiseCap, suggestedCap } from "./NeedsYou";
import { ClientError } from "@/lib/client";
import type { BudgetPending, RaiseAnswer } from "@/lib/v2";

// A run paused at its spend cap is raised from its page: the new cap prefilled with what the run would need (what it
// spent, and ten times the refused request's least, rounded up to the cent), sent once (PATCH /v2/runs/{id}), and every
// answer said in words. The figures are the served `pending`'s own; none is made up when it lacks them.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const PAUSED: BudgetPending = { kind: "budget", cap_usd: 0.05, spent_usd: 0.04, needs_usd: 0.1024, said: "Not sent.", at: "2026-11-04T20:08:05.127Z" };
const OK: RaiseAnswer = { run_id: "r1", max_cost_usd: 1.07, resumed: true, message_id: "m1", status: "input_required", state: "waiting" };

async function mount(pending: BudgetPending, onRaise: (usd: number) => Promise<RaiseAnswer>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RaiseCap, { pending, onRaise })));
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const input = () => host.querySelector('input[aria-label="New cap in dollars"]') as HTMLInputElement;
  const button = () => [...host.querySelectorAll("button")].find((b) => /Raise the cap|Raising/.test(b.textContent ?? "")) as HTMLButtonElement;
  const type = async (v: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), v); input().dispatchEvent(new Event("input", { bubbles: true })); }); };
  const click = async () => { await act(async () => { button().click(); }); };
  return { host, input, button, type, click, settle };
}

describe("suggestedCap", () => {
  it("is what the run spent and ten times the refused request's least, rounded up to the cent; none without both figures", () => {
    expect(suggestedCap(PAUSED)).toBe(1.07);
    expect(suggestedCap({ ...PAUSED, spent_usd: 0, needs_usd: 0.1024 })).toBe(1.03);
    expect(suggestedCap({ ...PAUSED, spent_usd: 0.45, needs_usd: 0.03 })).toBe(0.75);
    expect(suggestedCap({ ...PAUSED, spent_usd: undefined, needs_usd: undefined })).toBeNull();
    expect(suggestedCap({ ...PAUSED, needs_usd: undefined })).toBeNull();
  });
});

describe("RaiseCap", () => {
  it("is prefilled with the suggestion, and Raise the cap and continue sends that number", async () => {
    const asked: number[] = [];
    const t = await mount(PAUSED, async (usd) => { asked.push(usd); return OK; });
    expect(t.input().value).toBe("1.07");
    expect(t.button().textContent).toBe("Raise the cap and continue");
    await t.click(); await t.settle();
    expect(asked).toEqual([1.07]);
  });

  it("a double click is one raise: the button is disabled, and says so, while it posts", async () => {
    const asked: number[] = [];
    let answer!: (a: RaiseAnswer) => void;
    const t = await mount(PAUSED, (usd) => { asked.push(usd); return new Promise((r) => (answer = r)); });
    await act(async () => { t.button().click(); t.button().click(); });
    expect(asked).toHaveLength(1);
    expect(t.button().disabled).toBe(true);
    expect(t.button().textContent).toBe("Raising");
    await act(async () => { answer(OK); }); await t.settle();
    expect(asked).toHaveLength(1);
  });

  it("with no figures served it starts empty and sends nothing until a cap is named", async () => {
    const asked: number[] = [];
    const t = await mount({ ...PAUSED, spent_usd: undefined, needs_usd: undefined }, async (usd) => { asked.push(usd); return OK; });
    expect(t.input().value).toBe("");
    expect(t.button().disabled).toBe(true);
    await t.type("2");
    expect(t.button().disabled).toBe(false);
    await t.click(); await t.settle();
    expect(asked).toEqual([2]);
  });

  it("a 422 is said under the input, in the server's words; the cap stays to change", async () => {
    const refused = new ClientError(422, "invalid", "A cap is only raised: name more than the run's $0.05.");
    const t = await mount(PAUSED, async () => { throw refused; });
    await t.type("0.04");
    await t.click(); await t.settle();
    const alert = t.host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("A cap is only raised: name more than the run's $0.05.");
    expect(t.input().value).toBe("0.04");
    expect(t.button().disabled).toBe(false);
  });

  it("an ended run (409) and a run the server no longer has (404) are said in words", async () => {
    const ended = await mount(PAUSED, async () => { throw new ClientError(409, "not_continuable", "The run has ended."); });
    await ended.click(); await ended.settle();
    expect(ended.host.querySelector('[role="alert"]')?.textContent).toContain("This run has ended, so its cap can't be raised.");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const gone = await mount(PAUSED, async () => { throw new ClientError(404, "not_found", "No such run."); });
    await gone.click(); await gone.settle();
    expect(gone.host.querySelector('[role="alert"]')?.textContent).toContain("This run is no longer on the server.");
  });

  it("a working run's answer says its note: the live process keeps its old cap until its next one", async () => {
    const note = "The run's process keeps the $0.05 cap it was opened with; the $1.07 cap holds from its next process.";
    const t = await mount(PAUSED, async () => ({ ...OK, resumed: false, message_id: undefined, status: "working", state: "working", note }));
    await t.click(); await t.settle();
    expect(t.host.textContent).toContain(note);
  });
});
