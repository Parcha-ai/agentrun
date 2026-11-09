// Start a run on the faux model from its agent's page and follow it to its end: the run's page reads Completed, and its
// Timeline shows the answer the model gave. The faux model (packages/serve/test/fixtures/faux-model.mjs) answers a message it
// has no rule for with "On <the message>: done.", so the answer is known before the run starts.
import { check } from "../harness.mjs";

const PROMPT = "Name three primes above 100.";
const ANSWER = `On ${PROMPT}: done.`;

export default {
  name: "run-to-end",
  signedIn: true,
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { version: 1, name: "e2e-run", instructions: "Answer the question.", skills: [], tools: [] } });
    check(made.status === 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);
    const agentId = made.body.agent_id;

    // The agent's page: the first message, then Run, read from the server's answer to the start.
    await page.goto(`${base}/#/agents/${encodeURIComponent(agentId)}`);
    const bar = page.getByRole("region", { name: "Start a run" });
    await bar.getByRole("textbox", { name: "The run's first message" }).fill(PROMPT);
    const started = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/v2/agents/${encodeURIComponent(agentId)}/runs`);
    await bar.getByRole("button", { name: "Run", exact: true }).click();
    const response = await started;
    check(response.ok(), `the start answered ${response.status()}: ${await response.text()}`);
    const runId = (await response.json()).run_id;
    await page.waitForURL((url) => url.hash === `#/runs/${encodeURIComponent(runId)}`);

    // It ends: the header's status reads Completed, as the page reads the run again.
    await page.getByRole("heading", { level: 1 }).locator("xpath=..").getByText("Completed", { exact: true }).waitFor({ timeout: 45_000 });
    // The Timeline shows the model's answer.
    await page.getByRole("tab", { name: /^Timeline/ }).click();
    await page.getByText(ANSWER, { exact: true }).first().waitFor();

    // What the page showed is the run's own end.
    const run = await api("GET", `/runs/${encodeURIComponent(runId)}`);
    check(run.body.status === "completed", `the run is ${run.body.status}, not completed`);
  },
};
