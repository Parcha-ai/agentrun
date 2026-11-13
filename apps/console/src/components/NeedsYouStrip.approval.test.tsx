import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsYouStrip, type NeedsYouProps } from "./NeedsYouStrip";
import type { Run } from "@/lib/v2";

// Mission Control's Needs you strip: a run waiting on a tool call's approval is answered in place, as a question is.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse("2026-11-04T10:05:00Z");
const run = (id: string, over: Partial<Run>): Run => ({ sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: id, agent_id: "invoice", agent_version: 1, revision: "r1", kind: "agentic", status: "input_required", state: "waiting", title: `Run ${id}`,
  created_at: "2026-11-04T10:00:00Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, ...over,
});
const APPROVAL = { kind: "approval" as const, id: "ap_0123456789abcdef", tool: "monid.run", call_id: "call_1", args_preview: "{\"actor\":\"web-search\"}", requested_at: "2026-11-04T10:03:00Z", price: "not metered" as const };
const asking = [
  run("a1", { title: "Check the vendor", pending: APPROVAL }),
  run("q1", { title: "Which tier", pending: { kind: "question", question: "Which tier applies?", asked_at: "2026-11-04T10:04:00Z" } }),
];

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });
function mount(p: Partial<NeedsYouProps> = {}) {
  const approvals: unknown[][] = [];
  const base: NeedsYouProps = {
    asking, failed: [], live: [], agentName: () => "Invoice checker", now: () => NOW,
    onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null,
    onApprove: async (...args) => { approvals.push(args); return null; },
  };
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(NeedsYouStrip, { ...base, ...p })));
  return { host, approvals };
}

describe("NeedsYouStrip, a run waiting on an approval", () => {
  it("counts it with the questions, and shows the compact approval card with the agent, the run and when it asked", () => {
    const { host } = mount();
    expect(host.querySelector("h2")?.textContent).toBe("Needs you · 2");
    const card = host.querySelector("li[data-run='a1']")!;
    expect(card.querySelector("[aria-label='Approval required']")).toBeTruthy();
    expect(card.textContent).toContain("Invoice checker");
    expect(card.querySelector("a[href='#/runs/a1']")?.textContent).toBe("Check the vendor");
    expect(card.textContent).toContain("asked 2 min ago");
    expect(card.textContent).toContain("monid.run");
    expect(card.textContent).toContain("Not metered");
    // The question beside it is still a question, answered by a message.
    expect(host.querySelector("li[data-run='q1'] input[aria-label='Answer Invoice checker']")).toBeTruthy();
  });

  it("Allow answers that run's approval by its id", async () => {
    const { host, approvals } = mount();
    const allow = [...host.querySelectorAll("li[data-run='a1'] button")].find((b) => b.textContent === "Allow once") as HTMLButtonElement;
    await act(async () => { allow.click(); });
    expect(approvals).toEqual([["a1", "ap_0123456789abcdef", "allow", undefined]]);
  });
});
