import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import type { Run } from "@/lib/v2";

// While a tool call waits on the owner's approval the message box goes, and one line in its place says why.
const run: Run = {
  run_id: "run_1", agent_id: "fetcher", agent_version: 1, revision: "r1", kind: "agentic", status: "input_required", state: "waiting", title: "Read the page",
  created_at: "2026-11-04T10:00:00.000Z", ended_at: null, result: null, error: null, cost: null, archived_at: null,
  pending: { kind: "approval", id: "ap_0123456789abcdef", tool: "web_fetch", call_id: "call_1", args_preview: "{}", requested_at: "2026-11-04T10:00:02.000Z" },
};

describe("RunDetail's message box while an approval waits", () => {
  it("is replaced by one line saying why", () => {
    const html = renderToStaticMarkup(createElement(RunDetail, { run, agentName: "fetcher", messages: messageFeatures, harnessSteers: true, rows: [], files: [], actions: {}, onMessage: () => {}, onApprove: async () => null }));
    expect(html).not.toContain("id=\"composer\"");
    expect(html.replace(/<[^>]+>/g, " ")).toContain("Answer the approval above to continue.");
  });
});
