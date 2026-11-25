// The API playground's Agent picker, measured in the browser at a desktop and a phone width (jsdom lays nothing out, so
// a class list there says what was asked of the layout, not what came of it):
//  - where its row has the room (a desktop), the field shows the longest agent's name whole, and is the same width
//    whichever agent is picked;
//  - on a phone the field stays inside the window, cuts a name that does not fit with an ellipsis, and the page never
//    scrolls sideways.
import { check } from "../harness.mjs";

/** Longer than the 14rem the field once had, in the console's mono type. */
const LONG = "Quarterly Vendor Invoice Reconciliation";
const SHORT = "Notes";
const DESKTOP = 1280;
const PHONE = 390;

/** The field as laid out: its box, its picked words, and whether they are cut off. */
function field() {
  const button = document.querySelector("#playground-agent");
  const words = [...button.querySelectorAll("span")].find((s) => !s.children.length && !s.hasAttribute("data-picker-sizer"));
  const box = button.getBoundingClientRect();
  return { width: box.width, right: box.right, window: innerWidth, text: words.textContent, clipped: words.scrollWidth > words.clientWidth,
    ellipsis: getComputedStyle(words).textOverflow, sideways: document.documentElement.scrollWidth - innerWidth };
}

export default {
  name: "playground-agent-width",
  signedIn: true,
  async run({ page, base, api }) {
    const ids = {};
    for (const name of [LONG, SHORT]) {
      const made = await api("POST", "/agents", { definition: { name, instructions: "Answer.", tools: ["read"] } });
      check(made.status === 201, `POST /v2/agents (${name}) answered ${made.status}: ${JSON.stringify(made.body)}`);
      ids[name] = made.body.agent_id;
    }
    const wrong = [];
    const button = page.locator("#playground-agent");
    const pick = async (name) => {
      await button.click();
      await page.locator(`[data-picker-list] [role="option"][data-value="${ids[name]}"]`).click();
      await page.locator(`#playground-agent[data-value="${ids[name]}"]`).waitFor();
      await page.locator("[data-picker-list]").waitFor({ state: "detached" });
      return page.evaluate(field);
    };
    for (const width of [DESKTOP, PHONE]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/#/playground`);
      await button.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const widths = [];
      for (const name of [LONG, SHORT]) {
        const now = await pick(name);
        const at = `${width}px, ${name} picked`;
        widths.push(now.width);
        if (now.text !== name) wrong.push(`${at}: the field reads ${JSON.stringify(now.text)}`);
        if (now.sideways > 0) wrong.push(`${at}: the page scrolls sideways by ${now.sideways}px`);
        if (now.right > now.window + 0.5) wrong.push(`${at}: the field ends at ${Math.round(now.right)}px of a ${now.window}px window`);
        // A desktop row has the room for the whole name; a phone's does not, and the cut is marked.
        if (width === DESKTOP && now.clipped) wrong.push(`${at}: the name is cut off in the field`);
        if (width === PHONE && name === LONG && (!now.clipped || now.ellipsis !== "ellipsis")) wrong.push(`${at}: the name is not cut with an ellipsis (clipped ${now.clipped}, text-overflow ${now.ellipsis})`);
        if (width === PHONE && name === SHORT && now.clipped) wrong.push(`${at}: the name is cut off in the field`);
      }
      if (Math.max(...widths) - Math.min(...widths) > 0.5) wrong.push(`${width}px: the field is ${widths.map((w) => Math.round(w * 10) / 10).join(", ")}px wide as ${LONG} and ${SHORT} are picked`);
    }
    check(wrong.length === 0, `the API playground's Agent picker:\n${wrong.join("\n")}`);
  },
};
