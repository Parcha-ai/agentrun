// A page's top bar stays where it is: its bottom edge meets the edge under the navigation's logo row at rest and after
// the page's content has scrolled. A bar that scrolled with its page left that edge as soon as the page moved.
// Measured in a real browser, on every page that has the bar (pageToolbarClass), in a window short enough to scroll
// and still wide and tall enough for the sidebar. A fresh server's lists are short, so each page's content is made
// long here: a tall block added under what the page shows, in the element that follows its bar.
import { check } from "../harness.mjs";

// [what the page is called here, its address]. The connected agent and the race are ones this server does not have:
// their pages draw the same frame to say so.
const PAGES = [
  ["Mission Control", "#/"],
  ["Runs", "#/runs"],
  ["Agents", "#/agents"],
  ["Triggers", "#/triggers"],
  ["Suggested agents", "#/suggestions"],
  ["Templates", "#/templates"],
  ["Learning Dojo", "#/dojo"],
  ["a connected agent", "#/observations/none"],
  ["New race", "#/races/new"],
  ["a race", "#/races/none"],
  ["Compare runs", "#/compare"],
];
// The bar, by the two classes of pageToolbarClass that give it its height and its edge.
const BAR = 'main [class~="min-h-12"][class~="border-b"]';

/** The two edges, and how far the page has scrolled: its own pane's offset plus the main pane's. */
function edges(barSelector) {
  const bar = document.querySelector(barSelector);
  const main = document.querySelector("main");
  let scrolled = main.scrollTop;
  for (const el of main.querySelectorAll("*")) scrolled += el.scrollTop;
  return { logo: document.querySelector("aside > div").getBoundingClientRect().bottom, bar: bar.getBoundingClientRect().bottom, scrolled };
}

export default {
  name: "top-bars",
  signedIn: true,
  async run({ page, base }) {
    await page.setViewportSize({ width: 1280, height: 520 });
    const wrong = [];
    for (const [name, hash] of PAGES) {
      await page.goto(`${base}/${hash}`);
      await page.reload();
      await page.locator(BAR).first().waitFor({ timeout: 30_000 });
      // The page's first reads have answered, so what follows the bar is the page's own and stays.
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      const rest = await page.evaluate(edges, BAR);
      if (!(rest.logo > 0) || rest.bar !== rest.logo) wrong.push(`${name} at rest (bar ${rest.bar}, logo row ${rest.logo})`);
      // Long content, whatever the server holds: a tall block at the end of what follows the bar.
      await page.evaluate((barSelector) => {
        const under = document.querySelector(barSelector).nextElementSibling;
        const block = document.createElement("div");
        block.setAttribute("data-tall-block", "");
        block.style.height = "2000px";
        under.append(block);
      }, BAR);
      await page.mouse.move(800, 400);
      await page.mouse.wheel(0, 160);
      const moved = await page.waitForFunction((barSelector) => {
        const main = document.querySelector("main");
        let scrolled = main.scrollTop;
        for (const el of main.querySelectorAll("*")) scrolled += el.scrollTop;
        return scrolled > 0;
      }, BAR, { timeout: 5_000 }).then(() => page.evaluate(edges, BAR), () => null);
      if (!moved) { wrong.push(`${name} did not scroll`); continue; }
      if (moved.bar !== moved.logo) wrong.push(`${name} after a scroll of ${moved.scrolled}px (bar ${moved.bar}, logo row ${moved.logo})`);
    }
    // One line: the runner prints a failure's first lines only, and every page that is wrong must be in them.
    check(wrong.length === 0, `a page's top bar must end where the navigation's logo row ends: ${wrong.join("; ")}`);
  },
};
