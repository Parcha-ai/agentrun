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

const f = runFixture("run.completed.idle.1");
const header = (compact: boolean) => {
  const el = document.createElement("div");
  el.innerHTML = renderToStaticMarkup(<RunHeader run={f.run} agentName="invoice-checker" compact={compact} />);
  return el.querySelector("header")!;
};
// Hidden on a phone only (below sm, the header's own phone width): `max-sm:hidden` on the element or an ancestor inside
// the header, or a parent's `max-sm:[&>selector]:hidden` that the element (or an ancestor) matches.
const phoneHidden = (el: Element | null) => {
  for (let e = el; e && e.tagName !== "HEADER"; e = e.parentElement) {
    if (e.classList.contains("max-sm:hidden")) return true;
    for (const c of e.parentElement?.classList ?? []) {
      const sel = /^max-sm:\[&>(.+)\]:hidden$/.exec(c)?.[1];
      if (sel && e.matches(sel)) return true;
    }
  }
  return false;
};
const classes = (h: Element) => new Set([h, ...h.querySelectorAll("*")].flatMap((e) => [...e.classList]));

// On a phone the run page is its header, its steps and the message box. Once the steps scroll, the header keeps what a
// person acts on (the title on one line, the status, the actions) and lets the steps have the rest; at the top, or on a
// wider screen, it is whole.
describe("RunHeader, compact on a phone", () => {
  it("keeps the title on one line, the status and the actions, and leaves out the breadcrumb and the details", () => {
    const h = header(true);
    expect(phoneHidden(h.querySelector("nav"))).toBe(true);
    expect(h.querySelector("h1")!.classList.contains("max-sm:line-clamp-1")).toBe(true);
    expect(phoneHidden(h.querySelector("h1"))).toBe(false);
    const details = [...h.querySelectorAll("span.font-mono")];
    expect(details.length).toBeGreaterThan(0);
    for (const d of details) expect(phoneHidden(d), d.textContent ?? "").toBe(true);
    const status = [...h.querySelectorAll("*")].find((e) => e.textContent === "Completed" && e.querySelector("svg"));
    expect(status, "the status badge").toBeDefined();
    expect(phoneHidden(status!)).toBe(false);
  });

  it("is whole when not compact, and changes only what a phone shows when it is", () => {
    expect(phoneHidden(header(false).querySelector("nav"))).toBe(false);
    const whole = classes(header(false));
    const compact = classes(header(true));
    const added = [...compact].filter((c) => !whole.has(c));
    const gone = [...whole].filter((c) => !compact.has(c));
    expect(added.length).toBeGreaterThan(0);
    for (const c of [...added, ...gone]) expect(c).toMatch(/^max-sm:/);
  });
});

describe("RunDetail, the header while the steps scroll", () => {
  const open = () => {
    const el = document.body.appendChild(document.createElement("div"));
    root = createRoot(el);
    act(() => root!.render(<RunDetail run={f.run} agentName="invoice-checker" messages={messageFeatures} harnessSteers rows={f.page.rows} files={f.files} actions={{}} onMessage={() => {}} tab="timeline" />));
    return el;
  };
  // jsdom lays nothing out: the area's sizes are set as a browser reports them.
  const scrollTo = (el: HTMLElement, top: number, { scrollHeight = 2000, clientHeight = 360 } = {}) => {
    const area = el.querySelector<HTMLElement>("[data-run-scroll]")!;
    Object.defineProperty(area, "scrollTop", { value: top, configurable: true });
    Object.defineProperty(area, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(area, "clientHeight", { value: clientHeight, configurable: true });
    // The whole header's height at 390 px.
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

  // Steps that would fit once the header shrank would snap the scroll back to the top, and the header would grow again:
  // a flicker. A page the compact header lets fit stays whole.
  // Another tab is another page of the run: it starts at its top, so the header is whole again there.
  it("is whole again on another tab", () => {
    const el = open();
    scrollTo(el, 120);
    expect(compact(el)).toBe(true);
    act(() => [...el.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Report")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(compact(el)).toBe(false);
  });

  it("stays whole when the steps overflow by less than the compact header gives back", () => {
    const el = open();
    scrollTo(el, 60, { scrollHeight: 428, clientHeight: 360 });
    expect(compact(el)).toBe(false);
  });
});
