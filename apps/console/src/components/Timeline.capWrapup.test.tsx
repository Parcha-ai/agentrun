import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { CAP_WRAPUP, timelineOf } from "@timeline/index";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

// The spend cap's wrap-up, the note the run's model was told near its cap, as the timeline library projects it (its own
// test, timeline-wrapup-row.test.mjs, from the same entries): the server's row, `origin: "server"`, "AgentRun: <words>",
// its id ending in the note suffix. The console reads it as AgentRun's, its words as the title without the prefix, muted.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const WORDS = "About $1 left of this run's budget: finish now with your answer.";
const at = (s: number) => Date.UTC(2026, 9, 15, 20, 14, 0) + s * 1000;
const ENTRIES = [
  { kind: "pi.user", id: 100, conversationId: 1, model: [{ role: "user", content: "go", timestamp: at(0) }] },
  { kind: CAP_WRAPUP, id: 101, conversationId: 1, data: { capUsd: 1, leftUsd: 1, words: WORDS } },
];

describe("Timeline, the spend cap's wrap-up", () => {
  it("reads as AgentRun's: the label, its words as the title without the prefix, muted", () => {
    const rows = timelineOf(ENTRIES as never, { settled: true }) as unknown as TimelineRow[];
    const served = rows.find((r) => r.text === WORDS)!;
    expect([served.kind, served.origin, served.summary]).toEqual(["phase", "server", `AgentRun: ${WORDS}`]);
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    act(() => root!.render(createElement(Timeline, { rows, live: false })));
    const li = [...host.querySelectorAll("li")].find((l) => (l.textContent ?? "").includes(WORDS))!;
    expect(li.querySelector("button > span > span")!.textContent).toBe("AgentRun");
    const title = [...li.querySelectorAll("span")].find((s) => s.classList.contains("text-[15px]"))!;
    expect(title.textContent).toBe(WORDS);
    expect(title.classList.contains("text-muted-foreground")).toBe(true);
  });
});
