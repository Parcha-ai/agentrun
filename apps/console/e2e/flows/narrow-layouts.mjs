// The console's layout where the window is short or half a page, measured in a real browser (jsdom has no media queries):
//  - a phone on its side (844x390, 932x430) with a run waiting on a question: the page has no desktop sidebar (the top bar and
//    its menu, as in portrait), and the page scrolls as a whole, so the question and the Report and Timeline bodies can be
//    read in full, not clipped to the nothing the window leaves under the tabs.
//  - the Playground at 1500 px with a run working: the Response panel's four actions (Raise the cap, Stop, Cancel run, Archive)
//    show and the run's title keeps a width a person can read; the actions wrap onto their own row instead of squeezing it.
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

export default [phoneLandscape, playgroundHalfPage];
