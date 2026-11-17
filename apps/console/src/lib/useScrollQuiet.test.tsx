import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCROLL_LANE_PX, SCROLL_QUIET_MS, useScrollQuiet } from "./useScrollQuiet";

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

  // Firefox styles a scrollbar by the box alone, so the pointer finding the bar has to be told to the box.
  it("marks the box while the pointer is over its scrollbar's lane, and not while it is over the content or gone", () => {
    root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root!.render(createElement(Box)));
    const box = document.getElementById("box")!;
    box.getBoundingClientRect = () => ({ left: 100, right: 400, top: 0, bottom: 300, width: 300, height: 300, x: 100, y: 0, toJSON() {} });
    const move = (clientX: number) => box.dispatchEvent(new MouseEvent("pointermove", { clientX, bubbles: true }));
    move(400 - SCROLL_LANE_PX - 1);
    expect(box.hasAttribute("data-scroll-lane")).toBe(false);
    move(400 - SCROLL_LANE_PX);
    expect(box.hasAttribute("data-scroll-lane")).toBe(true);
    move(200);
    expect(box.hasAttribute("data-scroll-lane")).toBe(false);
    move(399);
    box.dispatchEvent(new MouseEvent("pointerleave"));
    expect(box.hasAttribute("data-scroll-lane")).toBe(false);
    expect(box.hasAttribute("data-scrolling")).toBe(false);
  });
});
