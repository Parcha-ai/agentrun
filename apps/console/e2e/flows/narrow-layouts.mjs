// The console's layout where the window is short or half a page, measured in a real browser (jsdom has no media queries):
//  - a phone on its side (844x390, 932x430) with a run waiting on a question: the page has no desktop sidebar (the top bar and
//    its menu, as in portrait), and the page scrolls as a whole, so the question and the Report and Timeline bodies can be
//    read in full, not clipped to the nothing the window leaves under the tabs.
//  - the Playground at 1500 px with a run working: the Response panel's four actions (Raise the cap, Stop, Cancel run, Archive)
//    show and the run's title keeps a width a person can read; the actions wrap onto their own row instead of squeezing it.
//  - an agent's page side by side (1280 px wide, 720 and 420 high) whose description runs to pages: the name and the id stay
//    in view, the description scrolls in a box of its own, and the details under them keep a share of the column and can
//    be scrolled to their end; scrolling them does not move the name.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "../harness.mjs";

const BROWSER = { BROWSERBASE_API_KEY: "not-a-secret", BROWSERBASE_PROJECT_ID: "e2e-project" };

/** Is `el` in view in full: inside the window and inside every ancestor that clips it? (A zero-height scroller clips all.) */
const inView = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p);
    if (o.overflowX === "visible" && o.overflowY === "visible") continue;
    const b = p.getBoundingClientRect();
    if (r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5 || r.left < b.left - 0.5 || r.right > b.right + 0.5) return false;
  }
  return true;
};

export const phoneLandscape = {
  name: "phone-landscape",
  signedIn: true,
  server: { faux: "faux-browse-ask.mjs", fauxBrowser: "faux-browser.mjs", env: BROWSER },
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { id: "asker", name: "Asker", instructions: "Browse, then ask.", tools: ["browser", "ask_person"] } });
    check(made.status === 201, `creating the agent answered ${made.status}`);
    const started = await api("POST", "/agents/asker/runs", { input: { content: "Browse the example page." } });
    check(started.status === 202, `starting the run answered ${started.status}`);
    const runId = started.body.run_id;
    for (const [width, height] of [[844, 390], [932, 430]]) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/#/runs/${encodeURIComponent(runId)}`);
      await page.reload();
      const question = page.getByText("Shall I go on?").first();
      await question.waitFor({ timeout: 45_000 });
      check(!(await page.locator("aside").isVisible()), `${at}: the desktop sidebar shows`);
      check(await page.getByRole("button", { name: "Navigation" }).isVisible(), `${at}: the phone's menu button is missing`);
      // The page scrolls as a whole: its one scroller (main) holds more than it shows, and every tab's body can be brought into full view.
      const scrolls = await page.locator("main").evaluate((m) => m.scrollHeight > m.clientHeight);
      check(scrolls, `${at}: the page does not scroll`);
      for (const tab of ["Report", "Timeline"]) {
        await page.getByRole("tab", { name: tab }).click();
        await question.waitFor();
        await question.scrollIntoViewIfNeeded();
        check(await question.evaluate(inView), `${at}: the question is not readable on the ${tab} tab`);
      }
    }
  },
};

export const playgroundHalfPage = {
  name: "playground-1500",
  signedIn: true,
  server: () => ({ faux: "faux-browse-hold.mjs", fauxBrowser: "faux-browser.mjs", env: { ...BROWSER, FAUX_HOLD_DIR: mkdtempSync(join(tmpdir(), "layout-hold-")) } }),
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { id: "worker", name: "Worker", instructions: "Browse, then hold.", tools: ["browser", "ask_person"] } });
    check(made.status === 201, `creating the agent answered ${made.status}`);
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(`${base}/#/playground`);
    const picker = page.locator("#playground-agent");
    await picker.waitFor();
    if (!/Worker/.test(await picker.innerText())) {
      await picker.click();
      await page.getByRole("option", { name: "Worker" }).click();
    }
    await page.locator('section[aria-label="Request"] textarea').first().fill("Summarise the example page and name the three figures it lists, with their units.");
    await page.getByPlaceholder("e.g. 0.50").fill("5");
    await page.getByRole("button", { name: "Send request" }).click();
    const panel = page.locator('section[aria-label="Code and response"]');
    const actions = ["Raise the cap", "Stop", "Cancel run", "Archive"];
    for (const name of actions) await panel.getByRole("button", { name, exact: true }).waitFor({ timeout: 45_000 });
    const title = panel.getByRole("heading", { level: 1 });
    await title.waitFor();
    const width = await title.evaluate((h) => h.getBoundingClientRect().width);
    check(width >= 120, `the run's title is ${Math.round(width)} px wide beside its actions`);
    for (const name of actions) check(await panel.getByRole("button", { name, exact: true }).isVisible(), `${name} is not visible`);
    check(!!(await title.getAttribute("title")), "the title does not carry its full text for hover");
  },
};

export const agentLongDescription = {
  name: "agent-long-description",
  signedIn: true,
  async run({ page, base, api }) {
    const description = "Reads each invoice against its purchase order and says where they differ. ".repeat(120);
    const made = await api("POST", "/agents", { definition: { id: "wordy", name: "Wordy", description, instructions: "Answer in one line.", tools: [] } });
    check(made.status === 201, `creating the agent answered ${made.status}`);
    for (const [width, height] of [[1280, 720], [1280, 420]]) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await page.goto(`${base}/#/agents/wordy`);
      await page.reload();
      const overview = page.locator('aside[aria-label="Agent overview"]');
      const name = overview.getByRole("heading", { level: 1 });
      await name.waitFor({ timeout: 45_000 });
      const details = overview.locator("[data-agent-details]");
      await details.locator('[aria-label="Live jobs"]').waitFor();
      check(await name.evaluate(inView), `${at}: the agent's name is not in view`);
      check(await overview.getByText("wordy", { exact: true }).evaluate(inView), `${at}: the agent's id is not in view`);
      const text = overview.locator("[data-agent-description]");
      check(await text.evaluate((box) => box.clientHeight >= 20 && box.scrollHeight > box.clientHeight), `${at}: the description does not scroll in a box of its own`);
      const sizes = await details.evaluate((box) => ({ box: box.getBoundingClientRect().height, column: box.parentElement.getBoundingClientRect().height }));
      check(sizes.box >= sizes.column * 0.3, `${at}: the details have ${Math.round(sizes.box)} px of a ${Math.round(sizes.column)} px column`);
      const before = await name.evaluate((h) => h.getBoundingClientRect().top);
      const reached = await details.evaluate((box) => {
        box.scrollTop = box.scrollHeight;
        const last = box.querySelector('[aria-label="Live jobs"]').getBoundingClientRect();
        const frame = box.getBoundingClientRect();
        return { scrolled: box.scrollTop, ends: last.bottom <= frame.bottom + 0.5 && last.bottom > frame.top, inWindow: frame.bottom <= innerHeight + 0.5 };
      });
      check(reached.scrolled > 0, `${at}: the details do not scroll`);
      check(reached.ends && reached.inWindow, `${at}: the last of the details cannot be brought into view`);
      check(await name.evaluate((h) => h.getBoundingClientRect().top) === before, `${at}: scrolling the details moved the agent's name`);
    }
  },
};

export default [phoneLandscape, playgroundHalfPage, agentLongDescription];
