// Triggers' six New buttons line up wherever the bar is too narrow for one row. Wrapped as loose words they made a ragged
// right edge: one alone on a line, then two, then one, then two. They stand in columns instead: every row holds the same
// number, and a column's buttons share a left edge and a width. A phone keeps all six, two columns as wide as the bar
// under its name, in the smallest button's measures: each name on one line from 390px wide, and on a narrower phone a
// long name takes a second line and is never cut.
// Measured in a real browser, on phones upright and on their side, at the smallest window with the sidebar, on laptops
// and on a wide desktop, with a trigger made so the bar has its buttons (with none yet, the panel under the bar offers
// each kind instead).
import { check } from "../harness.mjs";

const NAMES = ["New app trigger", "New GitHub trigger", "New webhook", "New feed trigger", "New email trigger", "New schedule"];
// [width, height, the rows the buttons take]. One row needs 1,138px inside the bar (its name, the six buttons and their
// gaps): 1440 and 1920 have it and keep the one row they had. Three columns beside the name need 694px: a phone on its
// side, 1024, 1280 and 1366 have that. The smallest window with the sidebar gets two columns, and so does a phone
// upright, from the widest to the narrowest.
const SIZES = [[430, 932, 3], [390, 844, 3], [375, 667, 3], [360, 740, 3], [320, 700, 3], [844, 390, 2], [768, 600, 3], [1024, 800, 2], [1280, 800, 2], [1366, 768, 2], [1440, 900, 1], [1920, 1000, 1]];
// Under this width the window is a phone's: the buttons are under the bar's name, as wide as the bar.
const PHONE = 640;
// The smallest button's height, which a name on one line keeps.
const ONE_LINE = 28;

/** The bar's buttons as they are drawn: their words, their boxes, the bar's inner edges, and any sideways scroll. */
function drawn() {
  const main = document.querySelector("main"), bar = main.querySelector("header");
  const edge = bar.getBoundingClientRect(), style = getComputedStyle(bar);
  const shown = (b) => b.offsetParent !== null;
  const buttons = [...bar.querySelectorAll("[data-new-triggers] button")].filter(shown);
  return {
    // Every button of the bar, so one that stood in for the six would show.
    all: [...bar.querySelectorAll("button")].filter(shown).map((b) => (b.textContent ?? "").trim()),
    names: buttons.map((b) => (b.textContent ?? "").trim()),
    left: Math.round(edge.left + parseFloat(style.paddingLeft)), right: Math.round(edge.right - parseFloat(style.paddingRight)),
    title: Math.round(bar.querySelector("h1").getBoundingClientRect().bottom),
    boxes: buttons.map((b) => { const r = b.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height), cut: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1 }; }),
    sideways: Math.max(document.documentElement.scrollWidth - innerWidth, main.scrollWidth - main.clientWidth),
  };
}

export default {
  name: "triggers-bar",
  signedIn: true,
  async run({ page, base, api }) {
    const agent = await api("POST", "/agents", { definition: { id: "sorter", name: "Sorter", instructions: "Answer in one line.", tools: [] } });
    check(agent.status === 201, `creating the agent answered ${agent.status}`);
    const hook = await api("POST", "/triggers", { name: "e2e-hook", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: "sorter", input: { content: "Sort it." }, max_cost_usd: 0.5 } });
    check(hook.status === 201, `making the trigger answered ${hook.status}`);
    const wrong = [];
    const ready = async () => { await page.evaluate(async () => { await document.fonts.ready; await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); };

    for (const [width, height, expected] of SIZES) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/#/triggers`);
      await page.reload();
      await page.locator("main header").getByRole("button", { name: "New schedule", exact: true }).waitFor({ timeout: 30_000 });
      await ready();
      const m = await page.evaluate(drawn);
      // Every kind, in the bar's order, the main one last, and nothing else in the bar: no menu stands in for them.
      if (m.names.join() !== NAMES.join() || m.all.join() !== NAMES.join()) wrong.push(`${at}: the bar's buttons are ${m.all.join(", ")}`);
      if (m.sideways > 0) wrong.push(`${at}: the page scrolls sideways by ${m.sideways}px`);
      const rows = [...new Set(m.boxes.map((b) => b.top))].sort((a, b) => a - b).map((top) => m.boxes.filter((b) => b.top === top).sort((a, b) => a.left - b.left));
      // No button leaves the bar, and none cuts its words, whatever the layout.
      if (m.boxes.some((b) => b.left < m.left - 1 || b.right > m.right + 1)) wrong.push(`${at}: a button leaves the bar (${m.left} to ${m.right})`);
      if (m.boxes.some((b) => b.cut)) wrong.push(`${at}: ${m.names.filter((_, i) => m.boxes[i].cut).join(", ")} is cut`);
      // As few rows as the bar's width allows: one where the six fit beside its name.
      if (rows.length !== expected) wrong.push(`${at}: the buttons are in ${rows.length} rows, not ${expected}`);
      if (rows.length === 1) continue;
      // Wrapped: full rows of equal length, in columns, each row's buttons one height.
      if (new Set(rows.map((row) => row.length)).size !== 1) { wrong.push(`${at}: its rows hold ${rows.map((row) => row.length).join(", ")} buttons`); continue; }
      for (let column = 0; column < rows[0].length; column++) {
        const lefts = new Set(rows.map((row) => row[column].left)), widths = new Set(rows.map((row) => row[column].width));
        if (lefts.size !== 1 || widths.size !== 1) wrong.push(`${at}: column ${column + 1} starts at ${[...lefts].join(", ")} and is ${[...widths].join(", ")} wide`);
      }
      if (rows.some((row) => new Set(row.map((b) => b.height)).size !== 1)) wrong.push(`${at}: a row's buttons are ${rows.map((row) => row.map((b) => b.height).join("/")).join(", ")}px high`);
      // The columns end at the bar's right edge, as its buttons did.
      if (Math.abs(rows[0].at(-1).right - m.right) > 1) wrong.push(`${at}: the buttons end at ${rows[0].at(-1).right}, the bar at ${m.right}`);
      if (width >= PHONE) continue;
      // A phone: under the bar's name, from its left edge to its right, in columns of one width.
      if (rows[0][0].top < m.title) wrong.push(`${at}: the buttons start at ${rows[0][0].top}, above the end of the bar's name at ${m.title}`);
      if (Math.abs(rows[0][0].left - m.left) > 1) wrong.push(`${at}: the buttons start at ${rows[0][0].left}, the bar at ${m.left}`);
      if (new Set(m.boxes.map((b) => b.width)).size !== 1) wrong.push(`${at}: the columns are ${[...new Set(m.boxes.map((b) => b.width))].join(" and ")}px wide`);
      // From 390px wide every name is on one line.
      if (width >= 390 && m.boxes.some((b) => b.height !== ONE_LINE)) wrong.push(`${at}: the buttons are ${m.boxes.map((b) => b.height).join(", ")}px high, not ${ONE_LINE}`);
    }

    // A press on a phone opens the kind's form, as at any width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/#/triggers`);
    await page.reload();
    await page.locator("main header").getByRole("button", { name: "New webhook", exact: true }).click();
    await page.waitForURL((url) => url.hash === "#/triggers/new-webhook", { timeout: 10_000 }).catch(() => wrong.push(`390x844: New webhook opened ${page.url().split("#")[1]}`));
    // One line: the runner prints a failure's first lines only.
    check(wrong.length === 0, `Triggers' New buttons must line up: ${wrong.join("; ")}`);
  },
};
