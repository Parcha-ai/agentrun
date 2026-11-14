import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunDetail } from "./RunDetail";
import { messageFeatures } from "@/fixtures";
import { createClient } from "@/lib/client";
import type { Run, TimelineRow } from "@/lib/v2";

// The run view on a runner-path server (the one store): an approval's id is its tool call's id, opaque (any characters
// the harness gave the call); a run read carries `claim` (the runner holding it) and `approvals` (never: unattended);
// a run paused at its cap and a paused workflow run read as before. The card answers with the id exactly as served.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

const CALL = "toolu_01:Ab/c+d=e f";
const PENDING = { kind: "approval" as const, id: CALL, tool: "web_fetch", call_id: CALL, args_preview: "{\"url\":\"http://public.example/\"}", requested_at: "2026-11-09T10:00:02.000Z" };
const base: Run = { sha: null, updated_at: "2026-11-09T00:00:00Z", poll_after_ms: 0,
  run_id: "run_1", place: { mode: "runner" }, agent_id: "fetcher", agent_version: 1, revision: "r1", kind: "agentic", status: "input_required", state: "waiting", title: "Read the page",
  created_at: "2026-11-09T10:00:00.000Z", ended_at: null, result: null, error: null, cost: { usd: null, basis: "estimate", charge_state: null, cap_usd: null }, archived_at: null,
  claim: { runner: "runner-7", epoch: 3, until: "2026-11-09T10:05:00.000Z" }, approvals: "ask", pending: PENDING,
} as Run;
const at = (s: number) => `2026-11-09T10:00:0${s}.000Z`;
const row = (seq: number, over: Partial<TimelineRow>): TimelineRow => ({ created_at: at(seq), agent_label: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, id: `row_${seq}`, seq, kind: "phase", summary: "", text: null, timestamp: at(seq), tool_name: null, ...over });
const rows: TimelineRow[] = [
  row(0, { kind: "user_message", summary: "You: Read the page" }),
  row(1, { kind: "tool_use", summary: "web_fetch", tool_name: "web_fetch", tool_use_id: CALL, tool_input_preview: PENDING.args_preview }),
  row(2, { kind: "tool_result", summary: "web_fetch: This web_fetch call waits for a person's approval; the run pauses here and continues with the result when they answer.", tool_name: "web_fetch", tool_use_id: CALL }),
  row(3, { id: "row_2:approval", kind: "tool_approval_requested", summary: `Waiting for your approval: web_fetch ${PENDING.args_preview}`, text: PENDING.args_preview, tool_name: "web_fetch", tool_use_id: CALL }),
];

async function page(run: Run, onApprove: (id: string, decision: "allow" | "deny") => Promise<string | null> = async () => null, tab: "report" | "timeline" = "timeline") {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => { root!.render(createElement(RunDetail, { run, agentName: "fetcher", messages: messageFeatures, harnessSteers: true, rows, files: [], actions: {}, onMessage: () => {}, onApprove, tab })); });
  return host;
}

describe("the run view on a runner-path server", () => {
  it("an approval whose id is its tool call's id: the card shows, its row points to it, and Allow once answers that id exactly", async () => {
    const answered: string[] = [];
    const host = await page(base, async (id) => { answered.push(id); return null; });
    const card = host.querySelector('[aria-label="Approval required"]');
    expect(card, "the approval card").not.toBeNull();
    expect(host.textContent).toContain("Waits for your approval above.");
    const allow = [...card!.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Allow once");
    expect(allow, "Allow once").toBeTruthy();
    await act(async () => { allow!.click(); });
    expect(answered).toEqual([CALL]);
  });

  it("the client posts the opaque id as one path segment", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { asked.push(url); return new Response(null, { status: 204 }); });
    await createClient().answerApproval("run_1", CALL, "allow");
    expect(asked).toEqual([`/v2/runs/run_1/approvals/${encodeURIComponent(CALL)}`]);
  });

  it("an unattended run (approvals never) holding a runner's claim reads as any working run", async () => {
    const host = await page({ ...base, status: "working", state: "working", pending: null, approvals: "never" } as Run, undefined, "report");
    expect(host.querySelector('[aria-label="Approval required"]')).toBeNull();
    expect(host.textContent).toContain("Writing the answer");
  });

  it("a run paused at its cap shows the budget card with the server's figures", async () => {
    const budget = { kind: "budget" as const, cap_usd: 0.5, spent_usd: 0.48, needs_usd: 0.04, least_cap_usd: 0.52, suggested_cap_usd: 1, said: "The run stopped at its $0.50 spend cap.", at: at(4) };
    const host = await page({ ...base, state: "idle", pending: budget } as Run, undefined, "report");
    expect(host.textContent).toContain("Paused at its spend cap");
    expect(host.textContent).toContain("It has spent $0.48 of its $0.50 cap.");
    expect(host.querySelector("#composer")).toBeNull();
  });

  it("a paused workflow run says no new step starts until it is resumed", async () => {
    const host = await page({ ...base, kind: "workflow", status: "paused", state: "idle", pending: null } as Run, undefined, "report");
    expect(host.textContent).toContain("No new step starts until it's resumed.");
  });
});
