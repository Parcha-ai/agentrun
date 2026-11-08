import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

// The approval's resume, as serve sends it since it stopped showing the gate's head (serve's runs.ts withApprovals:
// resumeSays for the summary, resumeShows for the text; its mcp-gate test's resumeRowIsAgentRuns): a `phase` row with
// `origin: "server"`, the summary "AgentRun: <tool> ran once you allowed it" (or "was refused: you declined it"), and a
// text of the outcome then the call's result. On every harness the row reads as AgentRun's, and no call id (the
// harness's call_…, toolu_…, fc_…) shows in its title or in what it opens to.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const at = (s: number) => `2026-11-06T19:00:0${s}.000Z`;
const row = (seq: number, over: Partial<TimelineRow>): TimelineRow => ({ created_at: at(seq), agent_label: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, id: `row_${seq}`, seq, kind: "phase", summary: "", text: null, timestamp: at(seq), tool_name: null, ...over });
const CALL = "toolu_01AbCdEfGhIjKlMnOpQrStUv";
const rowsWith = (resume: Partial<TimelineRow>): TimelineRow[] => [
  row(0, { kind: "user_message", summary: "You: Pay for ada", text: "Pay for ada" }),
  // The parked call's own rows: no status, its words from parkedCallSays.
  row(1, { kind: "tool_use", summary: "Allowed: its result is in the message that resumed the run", tool_name: "mcp:fake/paid", tool_use_id: CALL, tool_status: null, tool_input_preview: '{"query":"ada"}' }),
  row(2, { kind: "tool_result", summary: "Allowed: its result is in the message that resumed the run", tool_name: "mcp:fake/paid", tool_use_id: CALL, tool_status: null }),
  row(3, { ...resume, kind: "phase", origin: "server" } as Partial<TimelineRow>),
];
function open(rows: TimelineRow[]) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows, live: false })));
  const li = [...host.querySelectorAll("li")].find((l) => (l.textContent ?? "").includes("AgentRun"))!;
  return li;
}
const IDS = /\b(call_|toolu_|fc_)/;

describe("Timeline, the approval's resume as serve sends it", () => {
  it("allowed: AgentRun's row, its outcome as the title, the result when opened, no call id anywhere", async () => {
    const li = open(rowsWith({ summary: "AgentRun: mcp:fake/paid ran once you allowed it", text: "mcp:fake/paid ran once you allowed it. Its result:\npaid for ada" }));
    expect(li.textContent).toContain("AgentRun");
    const title = [...li.querySelectorAll("span")].find((s) => s.classList.contains("text-[15px]"))!.textContent!;
    expect(title).toBe("mcp:fake/paid ran once you allowed it");
    await act(async () => { li.querySelector("button")!.click(); });
    const opened = li.querySelector("pre")!.textContent!;
    expect(opened).toBe("mcp:fake/paid ran once you allowed it. Its result:\npaid for ada");
    expect(`${title}\n${opened}`).not.toMatch(IDS);
  });
  it("refused: AgentRun's row, the refusal as the title and when opened, no call id anywhere", async () => {
    const li = open(rowsWith({ summary: "AgentRun: mcp:fake/paid was refused: you declined it", text: "mcp:fake/paid was refused: you declined it." }));
    const title = [...li.querySelectorAll("span")].find((s) => s.classList.contains("text-[15px]"))!.textContent!;
    expect(title).toBe("mcp:fake/paid was refused: you declined it");
    await act(async () => { li.querySelector("button")!.click(); });
    const opened = li.querySelector("pre")!.textContent!;
    expect(`${title}\n${opened}`).not.toMatch(IDS);
    // Never as a person's row.
    expect([...li.parentElement!.querySelectorAll("li")].filter((l) => (l.textContent ?? "").startsWith("You") && (l.textContent ?? "").includes("[tool approval]"))).toEqual([]);
  });
});
