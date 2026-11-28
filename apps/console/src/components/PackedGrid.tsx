import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Watch = { observer: ResizeObserver; fit: (cards: Element[]) => void; watched: Set<Element> };

/** A list of cards in grid columns that pack as masonry does: each card takes the column with room soonest, in the
 *  list's order, and starts right under the card above it. A grid's rows would start each card under the tallest card
 *  of the row before, and leave the space beside that card empty.
 *
 *  The grid's rows are 1px, and each card spans as many as it is tall plus the gap under it, measured again whenever it
 *  changes size. A card is never moved to another parent, so what is typed in one stays when another comes or goes.
 *  The grid's own gap under its lowest card comes off its bottom margin. Without ResizeObserver (a server render, a
 *  test DOM) the grid keeps the rows its classes give it. */
export function PackedGrid({ className, children, ...rest }: Omit<HTMLAttributes<HTMLUListElement>, "style">) {
  const grid = useRef<HTMLUListElement>(null);
  const watch = useRef<Watch | null>(null);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const style = getComputedStyle(el);
    const gap = parseFloat(style.columnGap) || 0;
    const below = parseFloat(style.marginBottom) || 0;
    el.style.gridAutoRows = "1px";
    el.style.rowGap = "0px";
    el.style.marginBottom = `${below - gap}px`;
    // Every height read before any span is written, so the cards are laid out once.
    const fit = (cards: Element[]) => {
      const heights = cards.map((c) => c.getBoundingClientRect().height);
      cards.forEach((c, i) => { if (c instanceof HTMLElement) c.style.gridRowEnd = `span ${Math.max(1, Math.ceil(heights[i]! + gap))}`; });
    };
    const observer = new ResizeObserver((entries) => fit(entries.map((e) => e.target)));
    watch.current = { observer, fit, watched: new Set() };
    return () => {
      observer.disconnect();
      watch.current = null;
      el.style.gridAutoRows = el.style.rowGap = el.style.marginBottom = "";
    };
  }, []);
  // After every render: the cards in the grid now, each fitted and watched, and the ones gone no longer watched.
  useLayoutEffect(() => {
    const el = grid.current, w = watch.current;
    if (!el || !w) return;
    const cards = [...el.children];
    for (const c of w.watched) if (!cards.includes(c)) { w.observer.unobserve(c); w.watched.delete(c); }
    w.fit(cards);
    for (const c of cards) if (!w.watched.has(c)) { w.observer.observe(c); w.watched.add(c); }
  });
  return <ul ref={grid} className={cn("grid items-start", className)} {...rest}>{children}</ul>;
}
