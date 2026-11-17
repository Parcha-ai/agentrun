import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCROLL_QUIET_MS, useScrollQuiet } from "./useScrollQuiet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); });
function Box() { return createElement("div", { ref: useScrollQuiet<HTMLDivElement>(), id: "box" }); }

describe("useScrollQuiet", () => {
  it("marks the box while it scrolls and until the scrolling has stopped for a while, each scroll starting the wait again", () => {
    vi.useFakeTimers();
    root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root!.render(createElement(Box)));
    const box = document.getElementById("box")!;
    const scroll = () => box.dispatchEvent(new Event("scroll"));
    expect(box.hasAttribute("data-scrolling")).toBe(false);
    scroll();
    expect(box.hasAttribute("data-scrolling")).toBe(true);
    vi.advanceTimersByTime(SCROLL_QUIET_MS - 1);
    scroll();
    vi.advanceTimersByTime(SCROLL_QUIET_MS - 1);
    expect(box.hasAttribute("data-scrolling")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(box.hasAttribute("data-scrolling")).toBe(false);
  });
});
