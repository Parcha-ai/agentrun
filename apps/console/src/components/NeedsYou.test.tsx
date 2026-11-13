import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RaiseCap } from "./NeedsYou";
import { ClientError } from "@/lib/client";
import type { RaiseAnswer } from "@/lib/v2";

// A run's spend cap is raised from its page: the new cap prefilled with the server's own suggestion
// (`pending.suggested_cap_usd` of a run paused at its cap; the console computes none), editable before it is sent, sent
// once (PATCH /v2/runs/{id}), and every answer said in words. With no suggestion served the input starts empty.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const OK: RaiseAnswer = { run_id: "r1", max_cost_usd: 2, resumed: true, message_id: "m1", status: "input_required", state: "waiting" };

async function mount(props: { cap: number; suggested?: number | null; paused?: boolean }, onRaise: (usd: number) => Promise<RaiseAnswer>) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(RaiseCap, { cap: props.cap, suggested: props.suggested ?? null, paused: props.paused ?? true, onRaise })));
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const input = () => host.querySelector('input[aria-label="New cap in dollars"]') as HTMLInputElement;
  const button = () => host.querySelector('form[aria-label="Raise the cap"] button[type="submit"]') as HTMLButtonElement;
  const type = async (v: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), v); input().dispatchEvent(new Event("input", { bubbles: true })); }); };
  const click = async () => { await act(async () => { button().click(); }); };
  return { host, input, button, type, click, settle };
}

describe("RaiseCap", () => {
  it("is prefilled with the server's suggested cap, and Raise the cap and continue sends it", async () => {
    const asked: number[] = [];
    const t = await mount({ cap: 0.05, suggested: 2 }, async (usd) => { asked.push(usd); return OK; });
    expect(t.input().value).toBe("2");
    expect(t.button().textContent).toBe("Raise the cap and continue");
    await t.click(); await t.settle();
    expect(asked).toEqual([2]);
  });

  it("the suggestion is editable: the raise sends the cap the person named, not the suggestion", async () => {
    const asked: number[] = [];
    const t = await mount({ cap: 0.05, suggested: 2 }, async (usd) => { asked.push(usd); return OK; });
    await t.type("3");
    await t.click(); await t.settle();
    expect(asked).toEqual([3]);
  });

  it("with no suggestion served it starts empty, says what it must be above, and sends nothing until a cap is named", async () => {
    const asked: number[] = [];
    const t = await mount({ cap: 0.05, suggested: null }, async (usd) => { asked.push(usd); return OK; });
    expect(t.input().value).toBe("");
    expect(t.input().placeholder).toBe("more than $0.05");
    expect(t.button().disabled).toBe(true);
    await t.type("2");
    await t.click(); await t.settle();
    expect(asked).toEqual([2]);
  });

  it("a double click is one raise: the button is disabled, and says so, while it posts", async () => {
    const asked: number[] = [];
    let answer!: (a: RaiseAnswer) => void;
    const t = await mount({ cap: 0.05, suggested: 2 }, (usd) => { asked.push(usd); return new Promise((r) => (answer = r)); });
    await act(async () => { t.button().click(); t.button().click(); });
    expect(asked).toHaveLength(1);
    expect(t.button().disabled).toBe(true);
    expect(t.button().textContent).toBe("Raising");
    await act(async () => { answer(OK); }); await t.settle();
    expect(asked).toHaveLength(1);
  });

  it("a 422 is said under the input, in the server's words; the cap stays to change", async () => {
    const refused = new ClientError(422, "invalid", "A cap is only raised: name more than the run's $0.05.");
    const t = await mount({ cap: 0.05, suggested: 2 }, async () => { throw refused; });
    await t.type("0.04");
    await t.click(); await t.settle();
    expect(t.host.querySelector('[role="alert"]')?.textContent).toContain("A cap is only raised: name more than the run's $0.05.");
    expect(t.input().value).toBe("0.04");
    expect(t.button().disabled).toBe(false);
  });

  it("an ended run (409) and a run the server no longer has (404) are said in words", async () => {
    const ended = await mount({ cap: 0.05, suggested: 2 }, async () => { throw new ClientError(409, "not_continuable", "The run has ended."); });
    await ended.click(); await ended.settle();
    expect(ended.host.querySelector('[role="alert"]')?.textContent).toContain("This run has ended, so its cap can't be raised.");
    act(() => root?.unmount()); document.body.innerHTML = "";
    const gone = await mount({ cap: 0.05, suggested: 2 }, async () => { throw new ClientError(404, "not_found", "No such run."); });
    await gone.click(); await gone.settle();
    expect(gone.host.querySelector('[role="alert"]')?.textContent).toContain("This run is no longer on the server.");
  });

  it("a working run's raise is labelled for one, and its answer's note is said: the live process keeps its old cap until its next one", async () => {
    const note = "The run's process keeps the $10 cap it was opened with; the $11 cap holds from its next process.";
    const asked: number[] = [];
    const t = await mount({ cap: 10, suggested: null, paused: false }, async (usd) => { asked.push(usd); return { ...OK, max_cost_usd: usd, resumed: false, message_id: undefined, status: "working", state: "working", note }; });
    expect(t.button().textContent).toBe("Raise the cap");
    await t.type("11");
    await t.click(); await t.settle();
    expect(asked).toEqual([11]);
    expect(t.host.textContent).toContain(note);
  });
});
