// Triggers' six New buttons line up wherever the bar is too narrow for one row. Wrapped as loose words they made a ragged
// right edge: one alone on a line, then two, then one, then two. From a tablet's width they stand in columns: every row
// holds the same number, and a column's buttons share a left edge and a width. A phone has no room for two columns of
// their words, so there one New trigger button, on the bar's own line, lists the six.
// Measured in a real browser, on a phone upright and on its side, at the smallest window with the sidebar, on laptops
// and on a wide desktop, with a trigger made so the bar has its buttons (with none yet, the panel under the bar offers
// each kind instead).
import { check } from "../harness.mjs";

const NAMES = ["New app trigger", "New GitHub trigger", "New webhook", "New feed trigger", "New email trigger", "New schedule"];
// [width, height, the rows the buttons take]. One row needs 1,138px inside the bar (its name, the six buttons and their
// gaps): 1440 and 1920 have it and keep the one row they had. Three columns beside the name need 694px: a phone on its
// side, 1024, 1280 and 1366 have that. A phone upright and the smallest window with the sidebar get two columns.
const SIZES = [[844, 390, 2], [768, 600, 3], [1024, 800, 2], [1280, 800, 2], [1366, 768, 2], [1440, 900, 1], [1920, 1000, 1]];
// The menu's order is the first-trigger panel's: the kinds as a person meets them, the schedule first.
const LISTED = ["New schedule", "New webhook", "New GitHub trigger", "New app trigger", "New feed trigger", "New email trigger"];

/** The bar's buttons as they are drawn: their words, their boxes, the bar's inner edges, and any sideways scroll. */
function drawn() {
  const main = document.querySelector("main"), bar = main.querySelector("header");
  const edge = bar.getBoundingClientRect(), style = getComputedStyle(bar);
  const buttons = [...bar.querySelectorAll("[data-new-triggers] button")].filter((b) => b.offsetParent !== null);
  return {
    names: buttons.map((b) => (b.textContent ?? "").trim()),
    left: Math.round(edge.left + parseFloat(style.paddingLeft)), right: Math.round(edge.right - parseFloat(style.paddingRight)),
    boxes: buttons.map((b) => { const r = b.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; }),
    sideways: Math.max(document.documentElement.scrollWidth - innerWidth, main.scrollWidth - main.clientWidth),
  };
}

export default {
  name: "triggers-bar",
  signedIn: true,
  async run({ page, base, api }) {
    const agent = await api("POST", "/agents", { definition: { id: "sorter", name: "Sorter", instructions: "Answer in one line." } });
    check(agent.status === 201, `creating the agent answered ${agent.status}`);
    const hook = await api("POST", "/triggers", { name: "e2e-hook", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "sorter", input: { content: "Sort it." }, max_cost_usd: 0.5 } });
    check(hook.status === 201, `making the trigger answered ${hook.status}`);
    const wrong = [];
    const ready = async () => { await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); };

    // A phone: one button on the bar's own line, which lists the six and opens the one picked.
    for (const [width, height] of [[390, 844], [320, 700]]) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/#/triggers`);
      await page.reload();
      const menu = page.locator("main header").getByRole("button", { name: "New trigger", exact: true });
      await menu.waitFor({ timeout: 30_000 });
      await ready();
      const bar = await page.evaluate(() => {
        const main = document.querySelector("main"), header = main.querySelector("header"), title = header.querySelector("h1").getBoundingClientRect();
        const shown = [...header.querySelectorAll("button")].filter((b) => b.offsetParent !== null);
        const box = shown[0].getBoundingClientRect(), edge = header.getBoundingClientRect();
        return { shown: shown.map((b) => (b.textContent ?? "").trim()), height: Math.round(edge.height), oneLine: box.top < title.bottom && box.bottom > title.top, inside: box.right <= edge.right - parseFloat(getComputedStyle(header).paddingRight) + 1, sideways: Math.max(document.documentElement.scrollWidth - innerWidth, main.scrollWidth - main.clientWidth) };
      });
      if (bar.shown.join() !== "New trigger") wrong.push(`${at}: the bar shows ${bar.shown.join(", ")}`);
      if (!bar.oneLine || bar.height > 49 || !bar.inside) wrong.push(`${at}: the bar is ${bar.height}px high and its button is ${bar.oneLine ? "" : "not "}on its name's line`);
      if (bar.sideways > 0) wrong.push(`${at}: the page scrolls sideways by ${bar.sideways}px`);
      await menu.click();
      await page.getByRole("menuitem").first().waitFor();
      const listed = (await page.getByRole("menuitem").allTextContents()).map((words) => words.trim());
      if (listed.join() !== LISTED.join()) wrong.push(`${at}: the menu lists ${listed.join(", ")}`);
      await page.getByRole("menuitem", { name: "New webhook", exact: true }).click();
      await page.waitForURL((url) => url.hash === "#/triggers/new-webhook", { timeout: 10_000 }).catch(() => wrong.push(`${at}: New webhook in the menu opened ${page.url().split("#")[1]}`));
    }

    for (const [width, height, expected] of SIZES) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/#/triggers`);
      await page.reload();
      await page.locator("main header").getByRole("button", { name: "New schedule", exact: true }).waitFor({ timeout: 30_000 });
      await ready();
      const m = await page.evaluate(drawn);
      // Every kind, in the bar's order, the main one last.
      if (m.names.join() !== NAMES.join()) wrong.push(`${at}: the bar's buttons are ${m.names.join(", ")}`);
      if (m.sideways > 0) wrong.push(`${at}: the page scrolls sideways by ${m.sideways}px`);
      const rows = [...new Set(m.boxes.map((b) => b.top))].sort((a, b) => a - b).map((top) => m.boxes.filter((b) => b.top === top).sort((a, b) => a.left - b.left));
      // No button leaves the bar, whatever the layout.
      if (m.boxes.some((b) => b.left < m.left - 1 || b.right > m.right + 1)) wrong.push(`${at}: a button leaves the bar (${m.left} to ${m.right})`);
      // As few rows as the bar's width allows: one where the six fit beside its name.
      if (rows.length !== expected) wrong.push(`${at}: the buttons are in ${rows.length} rows, not ${expected}`);
      if (rows.length === 1) continue;
      // Wrapped: full rows of equal length, in columns.
      if (new Set(rows.map((row) => row.length)).size !== 1) { wrong.push(`${at}: its rows hold ${rows.map((row) => row.length).join(", ")} buttons`); continue; }
      for (let column = 0; column < rows[0].length; column++) {
        const lefts = new Set(rows.map((row) => row[column].left)), widths = new Set(rows.map((row) => row[column].width));
        if (lefts.size !== 1 || widths.size !== 1) wrong.push(`${at}: column ${column + 1} starts at ${[...lefts].join(", ")} and is ${[...widths].join(", ")} wide`);
      }
      // The columns end at the bar's right edge, as its buttons did.
      if (Math.abs(rows[0].at(-1).right - m.right) > 1) wrong.push(`${at}: the buttons end at ${rows[0].at(-1).right}, the bar at ${m.right}`);
    }
    // One line: the runner prints a failure's first lines only.
    check(wrong.length === 0, `Triggers' New buttons must line up: ${wrong.join("; ")}`);
  },
};
