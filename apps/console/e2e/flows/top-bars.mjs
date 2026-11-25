// A page's top bar stays where it is beside the sidebar: its bottom edge meets the edge under the navigation's logo row
// at rest and after the page's content has scrolled. A bar that scrolled with its page left that edge as soon as the
// page moved. Measured in a real browser, on every page that has the bar (pageToolbarClass), in a window short enough
// to scroll and still wide and tall enough for the sidebar.
// On a phone there is no logo row to meet, and a bar whose actions wrap would hold a large part of the screen: the
// pages marked `whole` scroll as a whole there, bar and all.
// A fresh server's lists are short, so each page's content is made long here: a tall block added under what the page
// shows, in the element that follows its bar.
import { check } from "../harness.mjs";

// [what the page is called here, its address, whether a phone scrolls it as a whole]. The connected agent and the race
// are ones this server does not have: their pages draw the same frame to say so.
const PAGES = [
  ["Mission Control", "#/", false],
  ["Runs", "#/runs", false],
  ["Agents", "#/agents", true],
  ["Triggers", "#/triggers", true],
  ["Suggested agents", "#/suggestions", true],
  ["Templates", "#/templates", true],
  ["Learning Dojo", "#/dojo", true],
  ["a connected agent", "#/observations/none", true],
  ["New race", "#/races/new", true],
  ["a race", "#/races/none", true],
  ["Compare runs", "#/compare", true],
];
// The bar, by the two classes of pageToolbarClass that give it its height and its edge.
const BAR = 'main [class~="min-h-12"][class~="border-b"]';

/** Where the bar ends, where the logo row ends (0 with no sidebar), and how far the page has scrolled: in the main pane,
 *  and in all (the main pane's offset plus every pane's inside it). */
function edges(barSelector) {
  const main = document.querySelector("main");
  let scrolled = main.scrollTop;
  for (const el of main.querySelectorAll("*")) scrolled += el.scrollTop;
  return { logo: document.querySelector("aside > div")?.getBoundingClientRect().bottom ?? 0, bar: document.querySelector(barSelector).getBoundingClientRect().bottom, scrolled, main: main.scrollTop };
}

/** Opens `hash`, makes its content long and scrolls it: the edges at rest and after, or no `moved` if nothing scrolled. */
async function scrollOf(page, base, hash, at) {
  await page.goto(`${base}/${hash}`);
  await page.reload();
  await page.locator(BAR).first().waitFor({ timeout: 30_000 });
  // The page's first reads have answered, so what follows the bar is the page's own and stays.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  const rest = await page.evaluate(edges, BAR);
  await page.evaluate((barSelector) => {
    const block = document.createElement("div");
    block.style.height = "2000px";
    document.querySelector(barSelector).nextElementSibling.append(block);
  }, BAR);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, 160);
  const moved = await page.waitForFunction((barSelector) => {
    const main = document.querySelector("main");
    let scrolled = main.scrollTop;
    for (const el of main.querySelectorAll("*")) scrolled += el.scrollTop;
    return scrolled > 0;
  }, BAR, { timeout: 5_000 }).then(() => page.evaluate(edges, BAR), () => null);
  return { rest, moved };
}

export default {
  name: "top-bars",
  signedIn: true,
  async run({ page, base }) {
    const wrong = [];
    await page.setViewportSize({ width: 1280, height: 520 });
    for (const [name, hash] of PAGES) {
      const { rest, moved } = await scrollOf(page, base, hash, { x: 800, y: 400 });
      if (!(rest.logo > 0) || rest.bar !== rest.logo) wrong.push(`${name} at rest (bar ${rest.bar}, logo row ${rest.logo})`);
      if (!moved) wrong.push(`${name} did not scroll`);
      else if (moved.bar !== moved.logo) wrong.push(`${name} after a scroll of ${moved.scrolled}px (bar ${moved.bar}, logo row ${moved.logo})`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [name, hash, whole] of PAGES) {
      if (!whole) continue;
      const { moved } = await scrollOf(page, base, hash, { x: 195, y: 600 });
      if (!moved) wrong.push(`${name} did not scroll on a phone`);
      else if (!(moved.main > 0)) wrong.push(`${name} on a phone keeps its bar on screen instead of scrolling as a whole`);
    }
    // One line: the runner prints a failure's first lines only, and every page that is wrong must be in them.
    check(wrong.length === 0, `a page's top bar is out of place: ${wrong.join("; ")}`);
  },
};
