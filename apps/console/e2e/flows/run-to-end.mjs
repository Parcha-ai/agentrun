// Start a run on the faux model through the agent page's API playground option and follow it to its end: its page reads Completed, and its
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

    // The agent's shared dropdown carries this agent to the playground, where the first message starts the run.
    await page.goto(`${base}/#/agents/${encodeURIComponent(agentId)}`);
    await page.getByRole("button", { name: "Choose coding agent for Run agent", exact: true }).click();
    await page.getByRole("menuitem", { name: "API playground", exact: true }).click();
    await page.waitForURL((url) => url.hash === `#/playground?agent=${encodeURIComponent(agentId)}`);
    await page.getByPlaceholder(/^The run's first message/).fill(PROMPT);
    const started = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/v2/agents/${encodeURIComponent(agentId)}/runs`);
    await page.getByRole("button", { name: "Send request", exact: true }).click();
    const response = await started;
    check(response.ok(), `the start answered ${response.status()}: ${await response.text()}`);
    check(JSON.parse(response.request().postData() ?? "{}").input?.content === PROMPT, "the playground changed the first message");
    const runId = (await response.json()).run_id;
    await page.getByRole("button", { name: "Open this run", exact: true }).click();
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
