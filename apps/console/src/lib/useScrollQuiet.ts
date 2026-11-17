import { useEffect, useRef } from "react";

/** How long after the last scroll the scrollbar of a `.scroll-quiet` box stays before it fades (styles.css). */
export const SCROLL_QUIET_MS = 800;

/** How far in from a `.scroll-quiet` box's right edge the pointer counts as on its scrollbar: the bar and the space
 *  the box keeps between the bar and its content. */
export const SCROLL_LANE_PX = 16;

/** For a `.scroll-quiet` box: marks it `data-scrolling` while it is being scrolled and for SCROLL_QUIET_MS after, and
 *  `data-scroll-lane` while the pointer is over its scrollbar's lane; its scrollbar shows while it has either mark.
 *  The lane mark is what lets someone find the bar with the pointer in a browser whose CSS cannot tell a pointer on
 *  the bar from one on the box (Firefox). The marks are set on the element itself, so neither renders anything again. */
export function useScrollQuiet<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      box.setAttribute("data-scrolling", "");
      clearTimeout(timer);
      timer = setTimeout(() => box.removeAttribute("data-scrolling"), SCROLL_QUIET_MS);
    };
    const onMove = (event: PointerEvent) => box.toggleAttribute("data-scroll-lane", event.clientX >= box.getBoundingClientRect().right - SCROLL_LANE_PX);
    const onLeave = () => box.removeAttribute("data-scroll-lane");
    box.addEventListener("scroll", onScroll, { passive: true });
    box.addEventListener("pointermove", onMove, { passive: true });
    box.addEventListener("pointerleave", onLeave);
    return () => {
      box.removeEventListener("scroll", onScroll);
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerleave", onLeave);
      clearTimeout(timer);
      box.removeAttribute("data-scrolling");
      box.removeAttribute("data-scroll-lane");
    };
  }, []);
  return ref;
}
