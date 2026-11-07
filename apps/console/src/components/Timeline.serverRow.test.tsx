import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

// A message the server wrote into a run (an approval's resume, a raised cap's follow-up) comes as a `phase` row with
// `origin: "server"` and the summary "AgentRun: <its first line>" (pi-durable-agent's timeline). It reads as AgentRun's,
// muted, never as the person's; a plain phase row keeps "Phase".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const at = (s: number) => `2026-11-05T10:00:0${s}.000Z`;
const row = (seq: number, over: Partial<TimelineRow>): TimelineRow => ({ created_at: "2026-10-28T19:33:16.118Z", agent_label: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, id: `row_${seq}`, seq, kind: "phase", summary: "", text: null, timestamp: at(seq), tool_name: null, ...over });
const RESUME = "[tool approval] This answers your web_fetch call call_1 (arguments {\"url\":\"http://public.example/\"}), which waited for a person's approval; it is not a new message from them.";
const rows: TimelineRow[] = [
  row(0, { kind: "user_message", summary: "You: Fetch the page" }),
  row(1, { kind: "tool_use", summary: "web_fetch", tool_name: "web_fetch", tool_use_id: "call_1" }),
  row(2, { kind: "tool_result", summary: "web_fetch: ok", tool_name: "web_fetch", tool_use_id: "call_1" }),
  // Right after the call's result, with no path: its own step, never folded into the call's.
  row(3, { summary: `AgentRun: ${RESUME}`, text: `${RESUME}\nThey allowed it, and it ran. Its result:\n…`, origin: "server" } as Partial<TimelineRow>),
  row(4, { summary: "Phase: plan made" }),
];
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows, live: false })));
});
const steps = () => [...host.querySelectorAll("li")];
const step = (has: string) => steps().find((li) => (li.textContent ?? "").includes(has))!;
// A step's title: the line under its label.
const titleOf = (li: Element) => [...li.querySelectorAll("span")].find((s) => s.classList.contains("text-[15px]"))!;

describe("Timeline, a message the server wrote", () => {
  it("reads as AgentRun's, with its first line as the title, never as yours", () => {
    const li = step("[tool approval]");
    expect(li).toBeTruthy();
    expect(li.textContent).toContain("AgentRun");
    expect(titleOf(li).textContent).toBe(RESUME);
    expect(li.textContent).not.toMatch(/\bYou\b/);
  });

  it("is muted, as a note from the server, not a step of the agent's", () => {
    expect(titleOf(step("[tool approval]")).classList.contains("text-muted-foreground")).toBe(true);
    expect(titleOf(step("plan made")).classList.contains("text-muted-foreground")).toBe(false);
  });

  it("is its own step after the call's result: not folded into the call", () => {
    expect(steps()).toHaveLength(4);
  });

  it("a plain phase row keeps its label", () => {
    const li = step("plan made");
    expect(li.textContent).toContain("Phase");
    expect(li.textContent).not.toContain("AgentRun");
  });
});
