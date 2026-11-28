import { expect } from "vitest";

// A page's frame (pageClass, pageBodyClass in components/ui/toolbar.ts). Beside the sidebar (`roomy:`) its top bar stays
// in view and the body under it is the one box that scrolls. In a window too small for the sidebar (a phone) the page
// scrolls as a whole, bar and all: a bar whose actions wrap is tall there, and fixed it would hold much of the screen.
// jsdom lays nothing out, so this holds the structure the scrolling comes from, by the classes themselves (not the
// constants, so a change to a constant is caught too): beside the sidebar the page as tall as the shell's main, its bar
// first, then its body, marked data-page-body; with none of that said for a smaller window. The e2e flow
// page-frames.mjs measures both in a real browser.

const classes = (el: Element) => el.getAttribute("class")?.split(/\s+/) ?? [];
const has = (el: Element, wanted: string[]) => { for (const c of wanted) expect(classes(el), `<${el.tagName.toLowerCase()}> lacks ${c}`).toContain(c); };
const lacks = (el: Element, unwanted: string[], why: string) => { for (const c of unwanted) expect(classes(el), `<${el.tagName.toLowerCase()}> has ${c}: ${why}`).not.toContain(c); };

/** Checks `host`'s page keeps its bar out of the one scrolling box beside the sidebar and scrolls as a whole in a smaller
 *  window, and answers that box (where its content is). */
export function expectPinnedBar(host: ParentNode): HTMLElement {
  const bodies = host.querySelectorAll<HTMLElement>("[data-page-body]");
  expect(bodies.length, "a page has one body that scrolls").toBe(1);
  const body = bodies[0]!;
  // Positioned: an `sr-only` label (absolute) inside it would otherwise reach past main and scroll the page.
  has(body, ["relative", "roomy:min-h-0", "roomy:flex-1", "roomy:overflow-auto"]);
  const page = body.parentElement!;
  has(page, ["flex", "flex-col", "roomy:h-full", "roomy:min-h-0"]);
  // A phone: the page is at least main's height and grows past it, so main scrolls it whole. A page held to main's
  // height at every size, or a body that scrolls at every size, keeps a tall bar on a phone's screen.
  has(page, ["min-h-full"]);
  lacks(page, ["h-full", "min-h-0"], "at every size, the page is held to main's height and a phone cannot scroll its bar away");
  lacks(body, ["min-h-0", "flex-1", "overflow-auto"], "at every size, the body scrolls alone and a phone keeps the bar on screen");
  const bar = page.firstElementChild!;
  expect(bar).not.toBe(body);
  has(bar, ["shrink-0", "border-b"]);
  expect(body.contains(bar)).toBe(false);
  return body;
}
