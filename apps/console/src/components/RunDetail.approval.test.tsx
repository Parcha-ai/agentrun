import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import type { Run, TimelineRow } from "@/lib/v2";

// A run parked on a tool call's approval (serve's tool gate): status input_required, state waiting, pending of kind
// approval. Its timeline holds the call, its result (the gate's "waits for a person's approval") and the approval's row,
// which follows the result and shares its tool_use_id.
const PENDING = { kind: "approval" as const, id: "ap_0123456789abcdef", tool: "web_fetch", call_id: "call_1", args_preview: "{\"url\":\"http://public.example/\"}", requested_at: "2026-11-04T10:00:02.000Z" };
const run: Run = { sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0,
  run_id: "run_1", agent_id: "fetcher", agent_version: 1, revision: "r1", kind: "agentic", status: "input_required", state: "waiting", title: "Read the page",
  created_at: "2026-11-04T10:00:00.000Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, pending: PENDING,
};
const at = (s: number) => `2026-11-04T10:00:0${s}.000Z`;
const row = (seq: number, over: Partial<TimelineRow>): TimelineRow => ({ created_at: "2026-10-28T19:33:16.118Z", agent_label: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, id: `row_${seq}`, seq, kind: "phase", summary: "", text: null, timestamp: at(seq), tool_name: null, ...over });
// An earlier question, answered: a stopped or approval-waiting run can still hold it.
const rows: TimelineRow[] = [
  row(0, { kind: "user_message", summary: "You: Read the page" }),
  row(1, { id: "ask_1:waiting", kind: "waiting", summary: "Waiting for you: Which page, the old or the new?", text: "Which page, the old or the new?" }),
  row(2, { kind: "user_message", summary: "You: The new one" }),
  row(3, { kind: "tool_use", summary: "web_fetch", tool_name: "web_fetch", tool_use_id: "call_1", tool_input_preview: PENDING.args_preview }),
  row(4, { kind: "tool_result", summary: "web_fetch: This web_fetch call waits for a person's approval; the run pauses here and continues with the result when they answer.", tool_name: "web_fetch", tool_use_id: "call_1" }),
  row(5, { id: "row_4:approval", kind: "tool_approval_requested", summary: `Waiting for your approval: web_fetch ${PENDING.args_preview}`, text: PENDING.args_preview, tool_name: "web_fetch", tool_use_id: "call_1", tool_status: null }),
];

const page = (r: Run, tab: "report" | "timeline" = "timeline") =>
  renderToStaticMarkup(createElement(RunDetail, { run: r, agentName: "fetcher", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, onMessage: () => {}, onApprove: async () => null, tab }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("RunDetail, a run waiting on a tool call's approval", () => {
  it("shows the approval card where a question would be, never an old answered question", () => {
    const html = page(run);
    expect(html).toContain("aria-label=\"Approval required\"");
    expect(html).not.toContain("aria-label=\"The agent asks\"");
    // The old question stays on the timeline as a past step; it is not shown above as the question.
    expect(text(html).split("Which page, the old or the new?").length - 1).toBe(1);
  });

  it("keeps the message box while the call waits: Allow or Deny answers it, and a message declines it", () => {
    const html = page(run);
    expect(html).toContain("id=\"composer\"");
    expect(text(html)).toContain("or type what to do instead; sending it declines this call");
  });

  it("the timeline's approval row reads as yours, waiting, and points to the card above", () => {
    const shown = text(page(run));
    expect(shown).toContain("Your approval");
    expect(shown).toContain("Waits for your approval above.");
    expect(shown).not.toContain("tool_approval_requested");
  });

  it("once answered, the row says so in the server's words and no card is shown", () => {
    const answered = rows.map((r) => (r.kind === "tool_approval_requested" ? { ...r, summary: `Asked your approval: web_fetch ${PENDING.args_preview}` } : r));
    const html = renderToStaticMarkup(createElement(RunDetail, { run: { ...run, status: "working", state: "working", pending: null }, agentName: "fetcher", messages: messageFeatures, harnessSteers: true, rows: answered, files: [], actions: {}, onMessage: () => {}, onApprove: async () => null, tab: "timeline" }));
    expect(html).not.toContain("aria-label=\"Approval required\"");
    expect(text(html)).toContain("Your approval");
    expect(text(html)).toContain("Asked your approval: web_fetch");
  });
});
