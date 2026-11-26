import { expect } from "vitest";

// A page's frame (pageClass, pageBodyClass in components/ui/toolbar.ts): its top bar stays in view and the body under it
// is the one box that scrolls. jsdom lays nothing out, so this holds the structure the scrolling comes from, by the classes
// themselves (not the constants, so a change to a constant is caught too): the page as tall as the shell's main, its bar
// first, then its body, marked data-page-body. The e2e flow page-frames.mjs measures the same in a real browser.

const classes = (el: Element) => el.getAttribute("class")?.split(/\s+/) ?? [];
const has = (el: Element, wanted: string[]) => { for (const c of wanted) expect(classes(el), `<${el.tagName.toLowerCase()}> lacks ${c}`).toContain(c); };

/** Checks `host`'s page keeps its bar out of the one scrolling box, and answers that box (where its content is). */
export function expectPinnedBar(host: ParentNode): HTMLElement {
  const bodies = host.querySelectorAll<HTMLElement>("[data-page-body]");
  expect(bodies.length, "a page has one body that scrolls").toBe(1);
  const body = bodies[0]!;
  // Positioned: an `sr-only` label (absolute) inside it would otherwise reach past main and scroll the page.
  has(body, ["relative", "min-h-0", "flex-1", "overflow-auto"]);
  const page = body.parentElement!;
  has(page, ["flex", "flex-col", "h-full", "min-h-0"]);
  expect(classes(page), "a page that grows past main scrolls its bar away").not.toContain("min-h-full");
  const bar = page.firstElementChild!;
  expect(bar).not.toBe(body);
  has(bar, ["shrink-0", "border-b"]);
  expect(body.contains(bar)).toBe(false);
  return body;
}
