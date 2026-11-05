import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import { rowFailed } from "@/lib/timeline";
import type { TimelineRow } from "@/lib/v2";

// A request the run's spend cap couldn't cover is not sent, and the run pauses (budget). Its timeline row keeps kind
// "error" and says `paused: true` (tl-jobs' serve/cap-words: pi-durable-agent TimelineEvent.paused, serve's
// TimelineRow.paused): it reads as a pause, labelled "Paused", in the warning tone, with the server's words, and no red.
// A raise doesn't turn it back into an error: the row says what happened then.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const WORDS = "Not sent: this run's cap of $0.05 can't cover one faux-1 request (at least $0.11). Raise the cap to at least $0.11 to run it.";
const row = (over: Partial<TimelineRow> & Record<string, unknown>): TimelineRow => ({ id: "e1", seq: 2, kind: "error", summary: WORDS, text: null, timestamp: "2026-11-05T17:09:00Z", tool_name: null, ...over } as TimelineRow);
const draw = (r: TimelineRow, live = false) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows: [r], live })));
  return host.querySelector("li") as HTMLElement;
};
const red = (el: Element) => [el, ...el.querySelectorAll("*")].some((e) => /\b(text|border|bg)-destructive/.test(e.getAttribute("class") ?? ""));

describe("the timeline, a request the spend cap held back", () => {
  it("reads as a pause: labelled Paused, the server's words, the warning tone, and nothing red", () => {
    const li = draw(row({ paused: true }));
    expect(li.textContent).toContain("Paused");
    expect(li.textContent).toContain(WORDS);
    expect(li.textContent).not.toMatch(/Error/);
    expect(red(li)).toBe(false);
    expect(li.querySelector(".border-warning\\/60")).not.toBeNull();
  });

  it("is no failure to the rest of the page (a failure's count, its repeats)", () => {
    expect(rowFailed(row({ paused: true }))).toBe(false);
    expect(rowFailed(row({}))).toBe(true);
  });

  it("stays a pause once the run goes on after a raise", () => {
    const li = draw(row({ paused: true }), true);
    expect(li.textContent).toContain("Paused");
    expect(red(li)).toBe(false);
  });

  it("an error the server doesn't mark paused is still an error, in red", () => {
    const li = draw(row({ summary: "Model request failed: 529 overloaded" }));
    expect(li.textContent).toMatch(/Error/);
    expect(red(li)).toBe(true);
  });
});
