import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalCard, type ApprovalCardProps } from "./ApprovalCard";
import type { PendingApproval } from "@/lib/v2";

// The card a run waiting on a tool call's approval shows: the tool, its arguments, what a call costs, an optional note
// sent with Deny, and Allow and Deny. One answer is one POST, however fast the clicks come.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const PENDING: PendingApproval = { kind: "approval", id: "ap_0123456789abcdef", tool: "monid.run", call_id: "call_1", args_preview: "{\"actor\":\"web-search\",\"input\":{\"query\":\"Contoso Freight\"}}", requested_at: "2026-11-04T10:00:00.000Z", price: 0.02 };

function mount(p: Partial<ApprovalCardProps> = {}) {
  const answers: { decision: string; note?: string }[] = [];
  let release: (v: string | null) => void = () => {};
  const held = { on: false };
  const onAnswer: ApprovalCardProps["onAnswer"] = (decision, note) => {
    answers.push({ decision, ...(note !== undefined ? { note } : {}) });
    return held.on ? new Promise((r) => { release = r; }) : Promise.resolve(null);
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const render = (q: Partial<ApprovalCardProps> = {}) => act(() => root!.render(createElement(ApprovalCard, { pending: PENDING, onAnswer, ...p, ...q })));
  render();
  const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!;
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  const type = async (text: string) => {
    const box = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text); box.dispatchEvent(new Event("input", { bubbles: true })); });
  };
  return { host, answers, button, settle, type, render, hold: () => { held.on = true; }, release: (v: string | null) => act(async () => { release(v); }) };
}

describe("ApprovalCard", () => {
  it("names the tool, shows its arguments in a block of their own that scrolls, and what a call costs", () => {
    const { host } = mount();
    expect(host.querySelector("[aria-label='Approval required']")).toBeTruthy();
    expect(host.textContent).toContain("monid.run");
    const args = host.querySelector("pre")!;
    expect(args.textContent).toBe("actor: web-search\ninput: {\"query\":\"Contoso Freight\"}");
    // Never wider than the page at 375 px: the block scrolls in its own box, and long words break.
    expect(args.className).toMatch(/overflow-auto/);
    expect(args.className).toMatch(/max-h-/);
    expect(args.className).toMatch(/break-all/);
    expect(host.textContent).toContain("Costs $0.02 per call");
  });

  it("says Not metered for an unpriced call, and no price line when the tool names none", () => {
    const { host, render } = mount({ pending: { ...PENDING, price: "not metered" } });
    expect(host.textContent).toContain("Not metered");
    const { price: _gone, ...unpriced } = PENDING;
    render({ pending: unpriced });
    expect(host.textContent).not.toMatch(/Costs|Not metered/);
  });

  it("Allow answers allow with no note, once, however many clicks land before the answer", async () => {
    const page = mount();
    page.hold();
    await act(async () => { page.button("Allow once").click(); page.button("Allow once").click(); page.button("Deny").click(); });
    expect(page.answers).toEqual([{ decision: "allow" }]);
    expect(page.button("Allow once").disabled).toBe(true);
    expect(page.button("Deny").disabled).toBe(true);
    await page.release(null);
    await page.settle();
    expect(page.answers).toHaveLength(1);
    expect(page.host.textContent).toContain("Allowed. The run goes on.");
  });

  it("Deny sends the note the agent reads, trimmed; an empty one is not sent", async () => {
    const page = mount();
    await page.type("  Use the cached list instead.  ");
    await act(async () => { page.button("Deny").click(); });
    await page.settle();
    expect(page.answers).toEqual([{ decision: "deny", note: "Use the cached list instead." }]);
    expect(page.host.textContent).toContain("Denied. The agent reads why and goes on.");
    const again = mount();
    await again.type("   ");
    await act(async () => { again.button("Deny").click(); });
    expect(again.answers).toEqual([{ decision: "deny" }]);
  });

  it("caps the note at the server's 2000 characters", () => {
    const { host } = mount();
    expect(host.querySelector("textarea")!.maxLength).toBe(2000);
  });

  it("a refused answer is said in words and the buttons come back", async () => {
    const page = mount({ onAnswer: async () => "The run was stopped while this call waited, so the call was withdrawn. It never ran." });
    await act(async () => { page.button("Allow once").click(); });
    await page.settle();
    expect(page.host.querySelector("[role='alert']")?.textContent).toBe("The run was stopped while this call waited, so the call was withdrawn. It never ran.");
    expect(page.button("Allow once").disabled).toBe(false);
  });

  it("compact, for the Needs you strip: the same tool, arguments and buttons, the arguments in a shorter block", () => {
    const { host, button } = mount({ compact: true, heading: createElement("span", null, "Invoice checker") });
    expect(host.textContent).toContain("Invoice checker");
    expect(host.textContent).toContain("monid.run");
    expect(host.querySelector("pre")!.className).toMatch(/max-h-28/);
    expect(button("Allow once")).toBeTruthy();
    expect(button("Deny")).toBeTruthy();
  });
});
