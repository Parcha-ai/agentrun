// The API playground's operation picker, measured in the browser at a desktop and a phone width (jsdom lays nothing out,
// so a class list there says what was asked of the layout, not what came of it):
//  - the field is the same width whichever operation is picked, and the picked words are never cut off;
//  - every row of its list has its words on one line, uncut, and the list stays inside the window;
//  - the page never scrolls sideways;
//  - in a space narrower than its longest operation, the field shrinks into it and cuts its words with an ellipsis, and
//    its list is still as wide as its longest row.
// A fresh server has no agent, so "PUT · Edit agent" is in the list but can't be picked: its row is measured, the other
// four are picked in turn.
import { check } from "../harness.mjs";

export const WIDTHS = [1280, 390];
const OPERATIONS = ["create-agent", "apply-template", "run", "list-runs"];
const ROWS = ["POST · Create an agent", "POST · Apply a template", "POST · Start a run", "GET · Query runs", "PUT · Edit agent"];
/** The space the squeezed field is given, in px: well under what its longest operation needs. */
const SQUEEZED = 120;

/** The field as laid out: its width, its picked words, and whether they are cut off. */
function field() {
  const button = document.querySelector("#api-operation");
  const words = [...button.querySelectorAll("span")].find((s) => !s.children.length && !s.hasAttribute("data-picker-sizer"));
  return { width: button.getBoundingClientRect().width, text: words.textContent, clipped: words.scrollWidth > words.clientWidth,
    ellipsis: getComputedStyle(words).textOverflow, sideways: document.documentElement.scrollWidth - innerWidth };
}

/** The open list as laid out: its box against the window, and each row's words (their lines are the line boxes their text makes). */
function list() {
  const box = document.querySelector("[data-picker-list]");
  const r = box.getBoundingClientRect();
  const rows = [...box.querySelectorAll('[role="option"]')].map((row) => {
    const words = [...row.querySelectorAll("span")].find((s) => s.textContent.trim() && !s.children.length);
    const range = document.createRange();
    range.selectNodeContents(words);
    const lines = new Set([...range.getClientRects()].filter((line) => line.width > 0).map((line) => Math.round(line.top)));
    return { text: words.textContent, lines: lines.size, clipped: words.scrollWidth > words.clientWidth + 1, height: Math.round(row.getBoundingClientRect().height) };
  });
  return { left: r.left, right: r.right, window: innerWidth, sideScroll: box.scrollWidth - box.clientWidth, rows, sideways: document.documentElement.scrollWidth - innerWidth };
}

/** The open list, once its place and width have stopped moving: it is anchored to the field a frame or two after it opens. */
async function openList(page) {
  const open = page.locator("[data-picker-list]");
  await open.waitFor();
  await open.evaluate((box) => new Promise((done) => {
    let last = "", same = 0;
    const look = () => {
      const r = box.getBoundingClientRect();
      const now = [r.left, r.top, r.width, r.height].join(" ");
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 3) done(); else requestAnimationFrame(look);
    };
    look();
  }));
  return open;
}

export default {
  name: "playground-operation-width",
  signedIn: true,
  async run({ page, base }) {
    const wrong = [];
    const button = page.locator("#api-operation");
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/#/playground`);
      await button.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const widths = [];
      for (const operation of OPERATIONS) {
        await button.click();
        const open = await openList(page);
        const shown = await page.evaluate(list);
        const at = `${width}px, list opened before picking ${operation}`;
        check(JSON.stringify(shown.rows.map((r) => r.text)) === JSON.stringify(ROWS), `${at}: the list reads ${JSON.stringify(shown.rows.map((r) => r.text))}`);
        const single = Math.min(...shown.rows.map((r) => r.height));
        for (const row of shown.rows) {
          if (row.lines !== 1) wrong.push(`${at}: "${row.text}" takes ${row.lines} lines`);
          if (row.height !== single) wrong.push(`${at}: the row "${row.text}" is ${row.height}px high, a one-line row ${single}px`);
          if (row.clipped) wrong.push(`${at}: "${row.text}" is cut off in its row`);
        }
        if (shown.sideScroll > 1) wrong.push(`${at}: the list scrolls sideways by ${shown.sideScroll}px`);
        if (shown.left < -0.5 || shown.right > shown.window + 0.5) wrong.push(`${at}: the list spans ${Math.round(shown.left)} to ${Math.round(shown.right)}px of a ${shown.window}px window`);
        if (shown.sideways > 0) wrong.push(`${at}: the page scrolls sideways by ${shown.sideways}px`);
        await open.locator(`[role="option"][data-value="${operation}"]`).click();
        await page.locator(`#api-operation[data-value="${operation}"]`).waitFor();
        await open.waitFor({ state: "detached" });
        const now = await page.evaluate(field);
        widths.push(now.width);
        if (now.clipped) wrong.push(`${width}px, ${operation} picked: "${now.text}" is cut off in the field`);
        if (now.sideways > 0) wrong.push(`${width}px, ${operation} picked: the page scrolls sideways by ${now.sideways}px`);
      }
      if (Math.max(...widths) - Math.min(...widths) > 0.5) wrong.push(`${width}px: the field is ${widths.map((w) => Math.round(w * 10) / 10).join(", ")}px wide as ${OPERATIONS.join(", ")} are picked`);
    }
    // A space narrower than the longest operation: the field's row is held to SQUEEZED px, as a narrow panel would hold it.
    await page.locator('#api-operation[data-value="list-runs"]').waitFor();
    const full = (await page.evaluate(field)).width;
    check(full > SQUEEZED + 40, `the field is only ${Math.round(full)}px wide: ${SQUEEZED}px would not squeeze it`);
    await button.evaluate((b, px) => { Object.assign(b.parentElement.style, { boxSizing: "content-box", width: `${px}px`, paddingLeft: "0", paddingRight: "0" }); }, SQUEEZED);
    const squeezed = await page.evaluate(field);
    if (squeezed.width > SQUEEZED + 0.5) wrong.push(`in ${SQUEEZED}px the field stays ${Math.round(squeezed.width)}px wide`);
    if (squeezed.text !== "GET · Query runs") wrong.push(`in ${SQUEEZED}px the field reads ${JSON.stringify(squeezed.text)}`);
    if (!squeezed.clipped || squeezed.ellipsis !== "ellipsis") wrong.push(`in ${SQUEEZED}px the field's words are not cut with an ellipsis (clipped ${squeezed.clipped}, text-overflow ${squeezed.ellipsis})`);
    // Its list is as wide as its longest row needs, not as narrow as the squeezed field: every row still on one line.
    await button.click();
    await openList(page);
    const under = await page.evaluate(list);
    for (const row of under.rows) if (row.lines !== 1 || row.clipped) wrong.push(`in ${SQUEEZED}px, the list: "${row.text}" takes ${row.lines} lines${row.clipped ? ", cut off" : ""}`);
    if (under.left < -0.5 || under.right > under.window + 0.5) wrong.push(`in ${SQUEEZED}px the list spans ${Math.round(under.left)} to ${Math.round(under.right)}px of a ${under.window}px window`);
    check(wrong.length === 0, `the API playground's operation picker:\n${wrong.join("\n")}`);
  },
};
