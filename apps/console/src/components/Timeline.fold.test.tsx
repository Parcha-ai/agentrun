import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Timeline } from "@/components/Timeline";
import type { TimelineRow } from "@/lib/v2";

// A long run's older steps fold behind one button above the newest six: it counts them in words that agree with the
// count, "1 earlier step" or "3 earlier steps".
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const phases = (n: number): TimelineRow[] => Array.from({ length: n }, (_, i) => ({ id: `row_${i}`, seq: i, kind: "phase", summary: `Phase: step ${i}`, text: null, timestamp: `2026-11-06T10:00:${String(i).padStart(2, "0")}.000Z`, tool_name: null }));
function fold(n: number) {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(Timeline, { rows: phases(n), live: false })));
  return [...host.querySelectorAll("button")].find((b) => /earlier/.test(b.textContent ?? ""))?.textContent?.trim();
}

describe("Timeline, the folded earlier steps", () => {
  it("one says 1 earlier step", () => {
    expect(fold(7)).toBe("1 earlier step");
  });
  it("more say N earlier steps", () => {
    expect(fold(9)).toBe("3 earlier steps");
  });
  it("none folded, no button", () => {
    expect(fold(6)).toBeUndefined();
  });
});
