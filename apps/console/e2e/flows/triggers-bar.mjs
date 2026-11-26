// Triggers' six New buttons line up wherever the bar is too narrow for one line. Wrapped as loose words they made a
// ragged edge: one alone on a line, then two, then one, then two, pushed to the right with the space under the bar's
// name left empty. Now the name heads the bar on a line of its own and the buttons stand under it, from the bar's left
// edge to its right: two columns, three where three fit, one row where the six fit. Every row holds the same number,
// and a column's buttons share a left edge and a width. The buttons are never in rows of their own beside the name,
// which made the name a column at their side. Where the bar holds its name and the six on one line, it is one line.
// A phone keeps all six, in the smallest button's measures: each name on one line from 390px wide, and on a narrower
// phone a long name takes a second line and is never cut. In each button the icon and the name share its middle.
// Measured in a real browser, on phones upright and on their side, at the smallest window with the sidebar, on laptops
// and on a wide desktop, with a trigger made so the bar has its buttons (with none yet, the panel under the bar offers
// each kind instead).
import { check } from "../harness.mjs";

const NAMES = ["New app trigger", "New GitHub trigger", "New webhook", "New feed trigger", "New email trigger", "New schedule"];
// [width, height, the rows the buttons take, whether they are under the bar's name]. One line needs 1,138px inside the
// bar (its name, the six buttons and their gaps): 1440 and 1920 have it. Under the name, one row of six needs 1,034px:
// 1366 has that. Three columns need 592px: a phone on its side, 1024 and 1280 have that. The smallest window with the
// sidebar gets two columns, and so does a phone upright, from the widest to the narrowest.
const SIZES = [
  [430, 932, 3, true], [390, 844, 3, true], [375, 667, 3, true], [360, 740, 3, true], [320, 700, 3, true], [640, 800, 3, true], [844, 390, 2, true],
  [768, 600, 3, true], [1024, 800, 2, true], [1280, 800, 2, true], [1366, 768, 1, true], [1440, 900, 1, false], [1920, 1000, 1, false],
];
// Under this width the window is a phone's: its buttons take the smallest button's measures.
const PHONE = 640;
// The smallest button's height, which a name on one line keeps.
const ONE_LINE = 28;
// Beside the sidebar (a window at least 768px wide and over 500px high), its logo row is 48px high (Shell, h-12): the
// bar's name sits level with the logo, and buttons under the name start under that row's edge.
const LOGO_ROW = 48;

/** The bar's buttons as they are drawn: their words, their boxes, the bar's name and inner edges, and any sideways scroll. */
function drawn() {
  const main = document.querySelector("main"), bar = main.querySelector("header");
  const edge = bar.getBoundingClientRect(), style = getComputedStyle(bar), name = bar.querySelector("h1").getBoundingClientRect();
  const shown = (b) => b.offsetParent !== null;
  const buttons = [...bar.querySelectorAll("[data-new-triggers] button")].filter(shown);
  return {
    // Every button of the bar, so one that stood in for the six would show.
    all: [...bar.querySelectorAll("button")].filter(shown).map((b) => (b.textContent ?? "").trim()),
    names: buttons.map((b) => (b.textContent ?? "").trim()),
    left: Math.round(edge.left + parseFloat(style.paddingLeft)), right: Math.round(edge.right - parseFloat(style.paddingRight)),
    name: { top: name.top - edge.top, bottom: name.bottom - edge.top, middle: (name.top + name.bottom) / 2 - edge.top, left: Math.round(name.left) },
    boxes: buttons.map((b) => {
      const r = b.getBoundingClientRect(), icon = b.querySelector("svg").getBoundingClientRect();
      // The name's lines, first to last: its own text, after the icon.
      const words = document.createRange(); words.selectNodeContents([...b.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim()));
      const lines = [...words.getClientRects()], middle = (r.top + r.bottom) / 2;
      return {
        top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height), cut: b.scrollWidth > b.clientWidth + 1 || b.scrollHeight > b.clientHeight + 1,
        // From the bar's top, for where the buttons are against its name.
        from: r.top - edge.top, to: r.bottom - edge.top,
        // How far the icon and the name are from the button's middle, and whether the button and its icon start on a whole pixel.
        icon: (icon.top + icon.bottom) / 2 - middle, name: (lines[0].top + lines.at(-1).bottom) / 2 - middle, whole: Number.isInteger(r.top) && Number.isInteger(icon.top),
      };
    }),
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

    for (const [width, height, expected, under] of SIZES) {
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
      // As few rows as the bar's width allows.
      if (rows.length !== expected) wrong.push(`${at}: the buttons are in ${rows.length} rows, not ${expected}`);
      // Full rows of equal length, each row's buttons one height, ending at the bar's right edge.
      if (new Set(rows.map((row) => row.length)).size !== 1) { wrong.push(`${at}: its rows hold ${rows.map((row) => row.length).join(", ")} buttons`); continue; }
      if (rows.some((row) => new Set(row.map((b) => b.height)).size !== 1)) wrong.push(`${at}: a row's buttons are ${rows.map((row) => row.map((b) => b.height).join("/")).join(", ")}px high`);
      if (Math.abs(rows[0].at(-1).right - m.right) > 1) wrong.push(`${at}: the buttons end at ${rows[0].at(-1).right}, the bar at ${m.right}`);
      // The bar's name starts the bar, at its left edge.
      if (Math.abs(m.name.left - m.left) > 1) wrong.push(`${at}: the bar's name starts at ${m.name.left}, the bar at ${m.left}`);
      const first = Math.min(...m.boxes.map((b) => b.from));
      if (!under) {
        // One line: the buttons on the name's own line.
        if (first >= m.name.bottom || Math.max(...m.boxes.map((b) => b.to)) <= m.name.top) wrong.push(`${at}: the buttons are not on the name's line (they start ${first}px down, the name ends ${m.name.bottom}px down)`);
        continue;
      }
      // Under the name, never beside it: the name is the bar's heading, and no button shares its line.
      if (first < m.name.bottom) wrong.push(`${at}: the buttons start ${first}px down, beside the bar's name, which ends ${m.name.bottom}px down`);
      // From the bar's left edge: no empty space under the name.
      if (Math.abs(rows[0][0].left - m.left) > 1) wrong.push(`${at}: the buttons start at ${rows[0][0].left}, the bar at ${m.left}`);
      if (rows.length > 1) {
        // In columns: each shares a left edge and a width, and all are one width.
        for (let column = 0; column < rows[0].length; column++) {
          const lefts = new Set(rows.map((row) => row[column].left)), widths = new Set(rows.map((row) => row[column].width));
          if (lefts.size !== 1 || widths.size !== 1) wrong.push(`${at}: column ${column + 1} starts at ${[...lefts].join(", ")} and is ${[...widths].join(", ")} wide`);
        }
        if (new Set(m.boxes.map((b) => b.width)).size !== 1) wrong.push(`${at}: the columns are ${[...new Set(m.boxes.map((b) => b.width))].join(" and ")}px wide`);
      }
      // Each button's icon and name are in its middle, top to bottom, and both start on a whole pixel: on a half pixel
      // the browser drew the name a pixel above its icon.
      const off = m.boxes.map((b, i) => (Math.abs(b.icon) > 0.05 || Math.abs(b.name) > 0.05 || !b.whole ? `${m.names[i]} (icon ${b.icon.toFixed(2)}px, name ${b.name.toFixed(2)}px from the middle${b.whole ? "" : ", on a part of a pixel"})` : "")).filter(Boolean);
      if (off.length) wrong.push(`${at}: not centred top to bottom: ${off.join(", ")}`);
      // Beside the sidebar the name is level with the sidebar's logo, and the buttons start under the logo row's edge.
      if (width >= 768 && height > 500 && (Math.abs(m.name.middle - LOGO_ROW / 2) > 0.5 || first !== LOGO_ROW)) wrong.push(`${at}: the bar's name is ${m.name.middle}px down and the buttons start ${first}px down, not ${LOGO_ROW / 2} and ${LOGO_ROW}`);
      // A phone, from 390px wide: every name on one line.
      if (width < PHONE && width >= 390 && m.boxes.some((b) => b.height !== ONE_LINE)) wrong.push(`${at}: the buttons are ${m.boxes.map((b) => b.height).join(", ")}px high, not ${ONE_LINE}`);
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
