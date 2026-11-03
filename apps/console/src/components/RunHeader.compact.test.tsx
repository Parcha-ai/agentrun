import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetail } from "./RunDetail";
import { RunHeader } from "./RunHeader";
import { messageFeatures, runFixture } from "@/fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

const f = runFixture("run.with-files");
const header = (compact: boolean) => {
  const el = document.createElement("div");
  el.innerHTML = renderToStaticMarkup(<RunHeader run={f.run} agentName="release-notes-writer" compact={compact} />);
  return el.querySelector("header")!;
};
// Hidden on a phone only (below md): `max-md:hidden` on the element or an ancestor inside the header, or a parent's
// `max-md:[&>selector]:hidden` that the element (or an ancestor) matches.
const phoneHidden = (el: Element | null) => {
  for (let e = el; e && e.tagName !== "HEADER"; e = e.parentElement) {
    if (e.classList.contains("max-md:hidden")) return true;
    for (const c of e.parentElement?.classList ?? []) {
      const sel = /^max-md:\[&>(.+)\]:hidden$/.exec(c)?.[1];
      if (sel && e.matches(sel)) return true;
    }
  }
  return false;
};

// On a phone the run page is its header, its steps and the message box. Once the steps scroll, the header keeps what a
// person acts on (the title on one line, the status, Stop) and lets the steps have the rest; at the top, or on a wider
// screen, it is whole.
describe("RunHeader, compact on a phone", () => {
  it("keeps the title on one line, the status and the actions, and leaves out the breadcrumb and the details", () => {
    const h = header(true);
    expect(phoneHidden(h.querySelector("nav"))).toBe(true);
    expect(h.querySelector("h1")!.className).toContain("max-md:truncate");
    expect(phoneHidden(h.querySelector("h1"))).toBe(false);
    const details = [...h.querySelectorAll("span.font-mono")];
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) expect(phoneHidden(d), d.textContent ?? "").toBe(true);
    // The status chip: an icon and its word.
    const status = [...h.querySelectorAll("*")].find((e) => e.textContent === "Completed" && e.querySelector("svg"));
    expect(status, "the status badge").toBeDefined();
    expect(phoneHidden(status!)).toBe(false);
  });

  it("is whole when not compact, and on a wide screen in any case", () => {
    const tokens = (h: Element) => new Set([h, ...h.querySelectorAll("*")].flatMap((e) => [...e.classList]));
    const whole = tokens(header(false));
    expect([...whole].filter((c) => c.startsWith("max-"))).toEqual([]);
    // Compact changes only what a phone shows: every class it adds is a below-md one.
    const compact = tokens(header(true));
    const added = [...compact].filter((c) => !whole.has(c));
    expect(added.length).toBeGreaterThan(0);
    for (const c of added) expect(c).toMatch(/^max-(md|sm):/);
    expect([...whole].filter((c) => !compact.has(c)), "nothing a wide screen shows is taken away").toEqual([]);
  });
});

describe("RunDetail, the header while the steps scroll", () => {
  const open = () => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    act(() => root!.render(<RunDetail run={f.run} agentName="release-notes-writer" messages={messageFeatures} harnessSteers rows={f.page.rows} files={f.files} actions={{}} onMessage={() => {}} tab="timeline" />));
    return el;
  };
  // jsdom lays nothing out: the area's sizes are set as a browser would report them (a tall page by default).
  const scrollTo = (el: HTMLElement, top: number, { scrollHeight = 2000, clientHeight = 360 } = {}) => {
    const area = el.querySelector<HTMLElement>("[data-run-scroll]")!;
    Object.defineProperty(area, "scrollTop", { value: top, configurable: true });
    Object.defineProperty(area, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(area, "clientHeight", { value: clientHeight, configurable: true });
    // The whole header's height at 390 px, as a browser measured it.
    Object.defineProperty(el.querySelector("header")!, "offsetHeight", { value: 250, configurable: true });
    act(() => { area.dispatchEvent(new Event("scroll")); });
  };
  const compact = (el: HTMLElement) => phoneHidden(el.querySelector("header nav"));

  it("goes compact once the steps scroll, and whole again back at the top", () => {
    const el = open();
    expect(compact(el)).toBe(false);
    scrollTo(el, 120);
    expect(compact(el)).toBe(true);
    scrollTo(el, 0);
    expect(compact(el)).toBe(false);
  });

  // In a browser at 390 px: steps that overflowed by 68 px fit once the header shrank, the scroll snapped back to the
  // top, and the header grew again, a flicker. A page that the compact header would let fit stays whole.
  it("stays whole when the steps overflow by less than the compact header gives back", () => {
    const el = open();
    scrollTo(el, 60, { scrollHeight: 428, clientHeight: 360 });
    expect(compact(el)).toBe(false);
  });

  // Measured in a browser at 390 px: a 250 px header that compacts to 65 frees 185 px, so steps that overflow by 229
  // still scroll by 44 once it's compact. That page goes compact; a whole header's worth of overflow isn't needed.
  it("goes compact when the steps still scroll with the header compact, if by less than the whole header", () => {
    const el = open();
    scrollTo(el, 200, { scrollHeight: 588, clientHeight: 359 });
    expect(compact(el)).toBe(true);
  });
});
