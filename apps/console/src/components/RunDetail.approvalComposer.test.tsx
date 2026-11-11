import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail, type RunDetailProps } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import type { Run, TimelineRow } from "@/lib/v2";

// While a tool call waits on the owner's approval, a message DECLINES it, with the message as the reason the agent
// reads (the contract, as a coding agent's permission prompt does it): the message box stays, the card says so, and the
// card goes once the run is read again. The approval's timeline row then says "Declined by your message: …".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

const PENDING = { kind: "approval" as const, id: "ap_0123456789abcdef", tool: "web_fetch", call_id: "call_1", args_preview: "{\"url\":\"http://public.example/\"}", requested_at: "2026-11-04T10:00:02.000Z" };
const run: Run = { sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run_1", agent_id: "fetcher", agent_version: 1, revision: "r1", kind: "agentic", status: "input_required", state: "waiting", title: "Read the page",
  created_at: "2026-11-04T10:00:00.000Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, pending: PENDING,
};
const props = (over: Partial<RunDetailProps> = {}): RunDetailProps => ({ run, agentName: "fetcher", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, onMessage: () => {}, onApprove: async () => null, ...over });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("RunDetail's message box while an approval waits", () => {
  it("is shown, says sending declines the call, and the card says so under its buttons", () => {
    const html = renderToStaticMarkup(createElement(RunDetail, props()));
    expect(html).toContain("id=\"composer\"");
    expect(text(html)).toContain("or type what to do instead; sending it declines this call");
    expect(text(html)).not.toContain("Answer the approval above to continue.");
    // Not a question's box: it says what a send does here.
    expect(text(html)).not.toContain("Answer the question");
    expect(text(html)).toContain("Sending it declines the waiting call");
  });

  it("only while an approval waits: a run waiting on a question keeps the question's words", () => {
    const html = renderToStaticMarkup(createElement(RunDetail, props({ run: { ...run, pending: { kind: "question", question: "Which page?", asked_at: run.created_at } } })));
    expect(text(html)).toContain("Answer the question · Answers what the agent asked; the run goes back to work.");
    expect(text(html)).not.toContain("declines");
  });

  it("its send goes as a message, and the card goes once the run is read again", async () => {
    const sent: string[] = [];
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const onMessage = (t: string) => { sent.push(t); root!.render(createElement(RunDetail, props({ run: { ...run, status: "working", state: "working", pending: null }, onMessage }))); return true; };
    act(() => root!.render(createElement(RunDetail, props({ onMessage }))));
    const box = host.querySelector<HTMLTextAreaElement>("#composer")!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Use the cached copy instead."); box.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { host.querySelector("#composer")!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(sent).toEqual(["Use the cached copy instead."]);
    expect(host.querySelector("section[aria-label='Approval required']")).toBeNull();
  });

  it("the approval's row once a message declined it: the server's words, not marked as waiting", () => {
    const rows: TimelineRow[] = [{ created_at: "2026-10-28T19:33:16.118Z", agent_label: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, id: "row_4:approval", seq: 4, kind: "tool_approval_requested", summary: `Declined by your message: web_fetch ${PENDING.args_preview}`, text: PENDING.args_preview, timestamp: "2026-11-04T10:00:04.000Z", tool_name: "web_fetch", tool_use_id: "call_1", tool_status: null }];
    const html = renderToStaticMarkup(createElement(RunDetail, props({ run: { ...run, status: "working", state: "working", pending: null }, rows, tab: "timeline" })));
    expect(text(html)).toContain("Your approval");
    expect(text(html)).toContain("Declined by your message: web_fetch");
    expect(text(html)).not.toContain("Approval required");
    expect(html).not.toMatch(/border-warning\/60/);
  });
});
