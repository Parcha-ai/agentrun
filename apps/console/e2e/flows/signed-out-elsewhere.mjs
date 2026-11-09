// Signed out in another tab: the owner watches a run's browser in one tab and signs out in a second tab of the same
// browser (one cookie). The first tab's next read is refused (401), and the console turns to its sign-in page saying
// why, as a fresh load does: no run page left as if signed in, no tab gone without a word. Signing in again opens the
// same run.
import { check, PASSWORD, signedIn } from "../harness.mjs";

const AGENT = "watch-out";

export default {
  name: "signed-out-elsewhere",
  signedIn: true,
  server: {
    faux: "faux-browse-ask.mjs",
    fauxBrowser: "faux-browser.mjs",
    // The browser tool is offered with a vendor's variables set; the fake backend never reads their values.
    env: { BROWSERBASE_API_KEY: "not-a-secret", BROWSERBASE_PROJECT_ID: "e2e-project" },
  },
  async run({ page, context, base, api, errors }) {
    const made = await api("POST", "/agents", { definition: { id: AGENT, name: "Watch", instructions: "Browse, then ask.", tools: ["browser", "ask_person"] } });
    check(made.status === 201, `creating the agent answered ${made.status}`);
    const started = await api("POST", `/agents/${AGENT}/runs`, { input: { content: "Browse the example page." } });
    check(started.status === 202, `starting the run answered ${started.status}`);
    const runHash = `#/runs/${encodeURIComponent(started.body.run_id)}`;

    // The first tab watches the run's browser.
    await page.goto(`${base}/${runHash}`);
    await page.getByRole("tab", { name: "Watch live" }).click();
    await page.locator('section[aria-label="Browser"] iframe').waitFor();

    // A second tab of the same browser signs out.
    const other = await context.newPage();
    await other.goto(`${base}/#/`);
    await other.getByRole("button", { name: "Sign out" }).first().click();
    await other.getByRole("heading", { name: "Sign in" }).waitFor();

    // The first tab's next read is refused: its sign-in page, saying why, on the same address.
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    await page.getByText("You were signed out. Sign in to go on.").waitFor();
    check((await page.locator("iframe").count()) === 0, "a frame was left on the signed-out page");
    check(new URL(page.url()).hash === runHash, `the address moved to ${new URL(page.url()).hash}`);

    // Signing in again opens the same run.
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();
    await signedIn(page);
    await page.getByRole("tab", { name: /^(Watch live|Browser)$/ }).waitFor();

    // The refused reads are the page's only errors (the browser logs each 401 it got).
    check(errors.every((e) => /status of 401\b/.test(e)), `the page reported errors: ${errors.join(" | ")}`);
    errors.length = 0;
  },
};
