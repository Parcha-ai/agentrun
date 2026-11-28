import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackedGrid } from "./PackedGrid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lays nothing out: each card's height is set here by its id, and the grid's gap is 12px.
const heights: Record<string, number> = {};
const observers: FakeObserver[] = [];
class FakeObserver {
  watched = new Set<Element>();
  constructor(readonly call: ResizeObserverCallback) { observers.push(this); }
  observe(el: Element) { this.watched.add(el); }
  unobserve(el: Element) { this.watched.delete(el); }
  disconnect() { this.watched.clear(); }
  resized(...els: Element[]) { this.call(els.map((target) => ({ target }) as ResizeObserverEntry), this as unknown as ResizeObserver); }
}

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  for (const k of Object.keys(heights)) delete heights[k];
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", FakeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { height: heights[this.dataset.card ?? ""] ?? 0 } as DOMRect;
  });
  const computed = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const style = computed(el, pseudo);
    return el instanceof HTMLUListElement ? new Proxy(style, { get: (s, k) => (k === "columnGap" ? "12px" : k === "marginBottom" ? "0px" : Reflect.get(s, k)) }) : style;
  });
});
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const cards = (ids: string[]) => ids.map((id) => createElement("li", { key: id, "data-card": id }, createElement("input", { "aria-label": id })));
const mount = (ids: string[]) => {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  act(() => root!.render(createElement(PackedGrid, { className: "grid-cols-2 gap-3" }, cards(ids))));
  return host;
};
const rerender = (ids: string[]) => act(() => root!.render(createElement(PackedGrid, { className: "grid-cols-2 gap-3" }, cards(ids))));
const card = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-card="${id}"]`)!;

describe("PackedGrid, cards packed into columns as masonry does", () => {
  it("gives each card as many 1px rows as it is tall plus the gap, so the card after a short one starts right under it", () => {
    Object.assign(heights, { short: 191, tall: 346, next: 128.4 });
    const host = mount(["short", "tall", "next"]);
    const grid = host.querySelector("ul")!;
    expect(grid.classList.contains("grid")).toBe(true);
    expect(grid.classList.contains("items-start")).toBe(true);
    expect([grid.style.gridAutoRows, grid.style.rowGap]).toEqual(["1px", "0px"]);
    // The gap under the lowest card comes off the grid's margin, so the space after the grid is what it was.
    expect(grid.style.marginBottom).toBe("-12px");
    expect(["short", "tall", "next"].map((id) => card(host, id).style.gridRowEnd)).toEqual(["span 203", "span 358", "span 141"]);
  });

  it("fits a card again when it changes size, and watches the cards that come and stops watching the ones that go", () => {
    Object.assign(heights, { a: 100, b: 100 });
    const host = mount(["a", "b"]);
    const [watch] = observers;
    expect([...watch!.watched].map((c) => (c as HTMLElement).dataset.card)).toEqual(["a", "b"]);
    heights.a = 250;
    act(() => watch!.resized(card(host, "a")));
    expect(card(host, "a").style.gridRowEnd).toBe("span 262");
    const gone = card(host, "a");
    heights.c = 40;
    rerender(["b", "c"]);
    expect(watch!.watched.has(gone)).toBe(false);
    expect([...watch!.watched].map((c) => (c as HTMLElement).dataset.card)).toEqual(["b", "c"]);
    expect(card(host, "c").style.gridRowEnd).toBe("span 52");
  });

  it("keeps a card's element, and what is typed in it, when a card before it goes", () => {
    const host = mount(["a", "b", "c"]);
    const typed = card(host, "c").querySelector("input")!;
    typed.value = "half an answer";
    rerender(["b", "c"]);
    expect(card(host, "c").querySelector("input")).toBe(typed);
    expect(typed.value).toBe("half an answer");
  });

  it("stops watching once gone, and leaves the grid's rows to its classes where nothing can measure", () => {
    mount(["a"]);
    act(() => root!.unmount());
    root = undefined;
    expect(observers[0]!.watched.size).toBe(0);
    vi.unstubAllGlobals();
    vi.stubGlobal("ResizeObserver", undefined);
    const host = mount(["a", "b"]);
    const grid = host.querySelector("ul")!;
    expect([grid.style.gridAutoRows, grid.style.rowGap, grid.style.marginBottom, card(host, "a").style.gridRowEnd]).toEqual(["", "", "", ""]);
  });
});
