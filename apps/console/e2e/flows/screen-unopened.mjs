// Screen unopened: a run whose agent has a browser but never opened it says so under Screen, and never waits for it. The
// agent asks its person first (the faux model's "Pick a region"), so the run waits for them with no browser step in its
// journal: GET /computer answers none with session unopened, and the tab says the run hasn't opened its browser. Once the
// person answers and the run ends, it says the run didn't open one, never that its browser closed.
import { check } from "../harness.mjs";

export default {
  name: "screen-unopened",
  signedIn: true,
  server: {
    fauxBrowser: "faux-browser.mjs",
    // The browser tool is offered when its vendor's keys are set; the fake browser never sends them anywhere.
    env: { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" },
  },
  async run({ page, api, origin }) {
    const agent = await api("POST", "/agents", { definition: { id: "unopened", name: "unopened", instructions: "Ask, then answer.", tools: ["browser", "ask_person"] } });
    check(agent.status === 201, `creating the agent answered ${agent.status}`);
    const started = await api("POST", "/agents/unopened/runs", { input: { content: "Pick a region." } });
    check(started.status === 202, `starting the run answered ${started.status}`);
    const runId = started.body.run_id;

    await page.goto(`${origin}/#/runs/${encodeURIComponent(runId)}`);
    await page.getByText("Which region should I use?").first().waitFor({ timeout: 45_000 });
    // The owner's session reads it (a token never does).
    const served = await page.request.get(`${origin}/v2/runs/${encodeURIComponent(runId)}/computer`);
    const body = await served.json();
    check(served.status() === 200 && body.state === "none" && body.session === "unopened", `the run's computer answered ${served.status()} ${JSON.stringify(body)}`);

    await page.getByRole("tab", { name: "Screen" }).click({ timeout: 45_000 });
    const screen = page.locator('section[aria-label="Screen"]');
    await screen.getByText("This run hasn't opened its browser. The agent's page shows here if it opens one.").waitFor({ timeout: 45_000 });
    check(!/Waiting for the browser/.test(await screen.innerText()), "a browser the run never opened is not waited for");

    const answered = await api("POST", `/runs/${encodeURIComponent(runId)}/messages`, { content: "us" });
    check(answered.status === 202, `answering the run answered ${answered.status}`);
    await screen.getByText("This run didn't open its browser.", { exact: false }).waitFor({ timeout: 45_000 });
    check(!/closed when the run ended/.test(await screen.innerText()), "a browser the run never opened did not close with it");
  },
};
