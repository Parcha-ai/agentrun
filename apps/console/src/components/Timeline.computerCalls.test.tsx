import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

// A tool call's computer calls are on its result row (serve's computer_calls: a code-mode script's many, each with its own
// start time). The step folds call and result into one row, which says how many calls it made; open, each call in words,
// how long after the first it started, and how long it took.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const T = "2026-11-14T12:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T) + ms).toISOString();
const rows = (): TimelineRow[] => [
  { id: "u1", seq: 1, kind: "tool_use", summary: "Ran a script", text: null, timestamp: T, tool_name: "codemode", tool_use_id: "toolu_1", tool_input_preview: "// Open the totals file" } as TimelineRow,
  {
    id: "r1", seq: 2, kind: "tool_result", summary: "Ran a script: ok", text: null, timestamp: at(4000), tool_name: "codemode", tool_use_id: "toolu_1", tool_status: "success", tool_result_preview: "saved",
    computer_calls: [
      { method: "apps.launch", started_at: at(100), app: "com.apple.TextEdit", ok: true, ms: 900 },
      { method: "ui.act", started_at: at(1500), app: "com.apple.TextEdit", ok: true, ms: 640, steps: [{ do: "key", keys: "super+a", route: "background" }, { do: "type", on: { role: "textbox" }, route: "semantic", verified: true }] },
      { method: "ui.act", started_at: at(2600), app: "com.apple.TextEdit", ok: true, ms: 420, steps: [{ do: "key", keys: "super+s", route: "background" }], expect: "met" },
      { method: "ui.act", started_at: at(3100), ok: false, ms: 12, code: "denied" },
    ],
  } as TimelineRow,
];
const draw = (given: TimelineRow[]) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows: given, live: false, ended: true } as never)));
  return host;
};

describe("a tool call's computer calls, on its step", () => {
  it("closed: how many it made and how many failed", () => {
    const host = draw(rows());
    const toggle = host.querySelector('[aria-label="Show the computer calls"]') as HTMLButtonElement;
    expect(toggle.textContent).toBe("4 computer calls · 1 failed");
    expect(host.querySelector('[aria-label="The computer calls"]')).toBeNull();
  });

  it("open: each call in words, when it started after the first, a failed one's code, and how long it took", () => {
    const host = draw(rows());
    act(() => (host.querySelector('[aria-label="Show the computer calls"]') as HTMLButtonElement).click());
    const lines = [...host.querySelectorAll('[aria-label="The computer calls"] li')].map((li) => li.textContent);
    expect(lines).toEqual([
      "+0 msOpened TextEdit900 ms",
      "+1.4 sSelected all (⌘A), typed into the text box640 ms",
      "+2.5 sSaved (⌘S)420 ms",
      "+3.0 sCould not act on the computerdenied12 ms",
    ]);
  });

  it("a step with no computer calls has no such line", () => {
    const host = draw(rows().map((row) => ({ ...row, computer_calls: undefined }) as TimelineRow));
    expect(host.querySelector('[aria-label="Show the computer calls"]')).toBeNull();
  });
});
