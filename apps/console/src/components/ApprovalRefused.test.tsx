import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsYouStrip, type NeedsYouProps } from "./NeedsYouStrip";
import { RunDetail, type RunDetailProps } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import type { Run } from "@/lib/v2";

// An answer refused because another answer, a stop or a cancel came first: the page reads the run again, the call no
// longer waits and its card goes. The refusal's words must not go with it.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const PENDING = { kind: "approval" as const, id: "ap_0123456789abcdef", tool: "web_fetch", call_id: "call_1", args_preview: "{\"url\":\"http://public.example/\"}", requested_at: "2026-11-04T10:00:02.000Z" };
const waiting: Run = {
  run_id: "run_1", agent_id: "fetcher", agent_version: 1, revision: "r1", kind: "agentic", status: "input_required", state: "waiting", title: "Read the page",
  created_at: "2026-11-04T10:00:00.000Z", ended_at: null, result: null, error: null, cost: null, archived_at: null, pending: PENDING,
};
const movedOn: Run = { ...waiting, status: "working", state: "working", pending: null };
const WORDS = "This call was already allowed, in another tab or by another answer. The run shows what happened next.";
const host = () => document.body.appendChild(document.createElement("div"));
const allow = (scope: ParentNode) => [...scope.querySelectorAll("button")].find((b) => b.textContent === "Allow once") as HTMLButtonElement;

describe("a refused approval answer, once the run moved on", () => {
  it("the run page keeps the words after the card goes", async () => {
    const at = host();
    root = createRoot(at);
    const props = (run: Run): RunDetailProps => ({ run, agentName: "fetcher", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, onMessage: () => {}, tab: "timeline",
      // As the live page does: the run is read again before the refusal comes back, and it no longer waits.
      onApprove: async () => { root!.render(createElement(RunDetail, props(movedOn))); return WORDS; } });
    act(() => root!.render(createElement(RunDetail, props(waiting))));
    await act(async () => { allow(at).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(at.querySelector("section[aria-label='Approval required']")).toBeNull();
    expect(at.querySelector("[role='alert']")?.textContent).toBe(`Your answer wasn't taken: ${WORDS}`);
  });

  it("Mission Control's strip keeps the words, naming the run, after its card goes", async () => {
    const at = host();
    root = createRoot(at);
    const base: Omit<NeedsYouProps, "asking"> = { failed: [], live: [], agentName: () => "Fetcher", now: () => Date.parse("2026-11-04T10:01:00Z"), onAnswer: async () => null, onRunAgain: async () => ({ started: [], problem: null }), onStop: async () => null,
      onApprove: async () => { root!.render(createElement(NeedsYouStrip, { ...base, asking: [] })); return WORDS; } };
    act(() => root!.render(createElement(NeedsYouStrip, { ...base, asking: [waiting] })));
    await act(async () => { allow(at).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(at.querySelector("section[aria-label='Approval required']")).toBeNull();
    const alert = at.querySelector("[role='alert']");
    expect(alert?.textContent).toContain(`Read the page: your answer wasn't taken. ${WORDS}`);
    expect(alert?.querySelector("a[href='#/runs/run_1']")).toBeTruthy();
  });
});
