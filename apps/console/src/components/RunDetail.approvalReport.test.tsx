import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail, type RunDetailProps } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import type { Run, TimelineRow } from "@/lib/v2";

// The Report tab of a run waiting on a tool call's approval, and the approval's timeline row after a stop overtook a
// message that would have declined the call (the server keeps the words, never sent, in the row's text).
const PENDING = { kind: "approval" as const, id: "ap_0123456789abcdef", tool: "web_fetch", call_id: "call_1", args_preview: "{\"url\":\"http://public.example/\"}", requested_at: "2026-11-04T10:00:02.000Z" };
const run: Run = { sha: null, updated_at: "2026-11-04T00:00:00Z", poll_after_ms: 0, place: { mode: "runner" },
  run_id: "run_1", agent_id: "fetcher", agent_version: 1, revision: "r1", kind: "agentic", status: "input_required", state: "waiting", title: "Read the page",
  created_at: "2026-11-04T10:00:00.000Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null, pending: PENDING,
};
const props = (over: Partial<RunDetailProps> = {}): RunDetailProps => ({ run, agentName: "fetcher", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, onMessage: () => {}, onApprove: async () => null, ...over });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("RunDetail's Report tab while an approval waits", () => {
  it("says it waits for your approval, pointing at the card, never that it is writing the answer", () => {
    const shown = text(renderToStaticMarkup(createElement(RunDetail, props({ tab: "report" }))));
    expect(shown).toContain("Waiting for your approval");
    expect(shown).toContain("The run continues once you answer the approval above, or send a message below to decline it.");
    expect(shown).not.toContain("Waiting for you The run continues once you give it what it waits on.");
    expect(shown).not.toContain("Writing the answer");
  });
});

describe("the approval's row when a stop overtook a declining message", () => {
  it("shows the words that were not sent under the server's summary, plainly, without opening the row", () => {
    const args = PENDING.args_preview;
    const rows: TimelineRow[] = [{ created_at: "2026-10-28T19:33:16.118Z", agent_label: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, id: "row_4:approval", seq: 4, kind: "tool_approval_requested", summary: `Withdrawn when the run was stopped: web_fetch ${args}`, text: `${args}\n\nNot sent: the run was stopped. Your message: Use the cached copy instead.`, timestamp: "2026-11-04T10:00:04.000Z", tool_name: "web_fetch", tool_use_id: "call_1", tool_status: null }];
    const html = renderToStaticMarkup(createElement(RunDetail, props({ run: { ...run, state: "idle", pending: null }, rows, tab: "timeline" })));
    expect(text(html)).toContain("Withdrawn when the run was stopped: web_fetch");
    expect(text(html)).toContain("Not sent: the run was stopped. Your message: Use the cached copy instead.");
    expect(html).not.toMatch(/border-warning\/60/);
    expect(text(html)).not.toContain("Approval required");
  });
});
