import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

// A grade's words open its feedback round on the Timeline as a "Your grade" row (serve's journal marks the FEEDBACK
// entry's user_message row with the ":feedback" id suffix). A wrong grade with no words carries what the server's steer
// says instead (runner/feedback-round.ts feedbackWords): the fields a right answer holds, else "(no words)". Either reads
// as a sensible line under "Your grade", never the verdict again (the Grade chip says that) nor as "You".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const at = (s: number) => `2026-11-15T10:00:0${s}.000Z`;
const row = (seq: number, over: Partial<TimelineRow>): TimelineRow => ({ created_at: at(seq), agent_label: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, id: `row_${seq}`, seq, kind: "phase", summary: "", text: null, timestamp: at(seq), tool_name: null, ...over });
/** A run graded wrong with no words: the job, its answer, then the round's words as the server wrote them. */
const graded = (words: string): TimelineRow[] => [
  row(0, { kind: "user_message", summary: "You: Invoice 17 from Northwind Freight, $240.", text: "Invoice 17 from Northwind Freight, $240." }),
  row(1, { kind: "final_answer", summary: "Answer: 6100 Office supplies", text: "6100 Office supplies" }),
  row(2, { kind: "user_message", id: "run_1:7:feedback", summary: `You: ${words}`, text: words }),
];
const render = (rows: TimelineRow[]) => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows, live: false })));
};
const steps = () => [...host.querySelectorAll("li")];
const titleOf = (li: Element) => [...li.querySelectorAll("span")].find((s) => s.classList.contains("text-prose"))!;

describe("Timeline, a no-words wrong grade's row", () => {
  it.each([
    ["with a correct answer", 'A right answer holds: {"account":"6400"}'],
    ["with nothing", "(no words)"],
  ])("%s reads under Your grade as the steer's words", (_, words) => {
    render(graded(words));
    const li = steps().at(-1)!;
    expect(li.textContent).toContain("Your grade");
    expect(titleOf(li).textContent).toBe(words);
    expect(li.textContent).not.toMatch(/graded .*wrong/i);
    expect(li.textContent).not.toMatch(/\bYou\b(?! grade)/);
  });
});
