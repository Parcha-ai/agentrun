import { useEffect, useRef } from "react";

/** How long after the last scroll the scrollbar of a `.scroll-quiet` box stays before it fades (styles.css). */
export const SCROLL_QUIET_MS = 800;

/** For a `.scroll-quiet` box: marks it `data-scrolling` while it is being scrolled and for SCROLL_QUIET_MS after, which
 *  is when its scrollbar shows. The mark is set on the element itself, so scrolling renders nothing again. */
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
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => { box.removeEventListener("scroll", onScroll); clearTimeout(timer); box.removeAttribute("data-scrolling"); };
  }, []);
  return ref;
}
