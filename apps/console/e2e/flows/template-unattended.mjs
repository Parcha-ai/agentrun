// Apply a template that runs on a trigger: its Apply screen opens on Never ask, the template's own default (kyb's on
// Ask me). The agent reads Unattended, and a run of it calls a tool this server sets to ask without waiting for anyone: the call runs, and the run ends. The template is
// market-monitor, which the server ships: a weekly schedule, no key and no MCP server it needs, and one required parameter.
// The faux model's "Read these paths" rule calls read once (packages/serve/test/fixtures/faux-model.mjs), then answers.
import { check } from "../harness.mjs";

const TEMPLATE = "market-monitor";
const PROMPT = 'Read these paths: ["missing.md"]';

export default {
  name: "template-unattended",
  signedIn: true,
  async run({ page, base, api }) {
    // This server asks before every read: a run that asks would wait here for the owner.
    const tools = await api("PUT", "/settings/tools", { read: { permission: "ask" } });
    check(tools.status === 200, `setting read to ask answered ${tools.status}: ${JSON.stringify(tools.body)}`);

    // A template that asks (kyb) opens on Ask me.
    await page.goto(`${base}/#/templates/kyb`);
    const kyb = page.getByRole("group", { name: "Approvals" });
    await kyb.waitFor();
    check(await kyb.getByRole("radio", { name: /^Ask me/ }).isChecked(), "kyb's Apply screen did not open on Ask me");

    // market-monitor runs unattended by its own default: its Apply screen opens on Never ask, saying what that grants.
    await page.goto(`${base}/#/templates/${TEMPLATE}`);
    const approvals = page.getByRole("group", { name: "Approvals" });
    await approvals.waitFor();
    check(await approvals.getByRole("radio", { name: /^Never ask/ }).isChecked(), "market-monitor's Apply screen did not open on Never ask");
    await approvals.getByText("every tool this agent has runs without waiting for you", { exact: false }).waitFor();
    await page.locator('[data-field="parameters.competitors"] input').fill("Acme (acme.com)");
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/v2/templates/${TEMPLATE}/apply`);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const response = await answered;
    check(response.status() === 201, `the apply answered ${response.status()}: ${await response.text()}`);
    check(JSON.parse(response.request().postData() ?? "{}").overrides?.approvals === "never", "the apply did not send overrides.approvals never");
    const applied = await response.json();
    const agentId = applied.agent_id;
    if (applied.warnings.length) await page.getByRole("region", { name: "Applied" }).getByRole("link", { name: "Open the agent" }).click();
    await page.waitForURL((url) => url.hash === `#/agents/${encodeURIComponent(agentId)}`);

    // The agent reads Unattended, on its page and as the server keeps it.
    await page.getByText("Unattended", { exact: true }).first().waitFor();
    const agent = await api("GET", `/agents/${encodeURIComponent(agentId)}`);
    check(agent.body.definition.approvals === "never", `the agent's approvals are ${JSON.stringify(agent.body.definition.approvals)}, not never`);

    // A run: its read is set to ask, and it runs without waiting; the run ends, and its header says Unattended.
    const bar = page.getByRole("region", { name: "Start a run" });
    await bar.getByRole("textbox", { name: "The run's first message" }).fill(PROMPT);
    const started = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/v2/agents/${encodeURIComponent(agentId)}/runs`);
    await bar.getByRole("button", { name: "Run", exact: true }).click();
    const start = await started;
    check(start.ok(), `the start answered ${start.status()}: ${await start.text()}`);
    const runId = (await start.json()).run_id;
    await page.waitForURL((url) => url.hash === `#/runs/${encodeURIComponent(runId)}`);
    const head = page.getByRole("heading", { level: 1 }).locator("xpath=..");
    await head.getByText("Completed", { exact: true }).waitFor({ timeout: 45_000 });
    await head.getByText("Unattended", { exact: true }).waitFor();

    // What the page showed is the run's own: it never waited for an approval, its read ran, and it knows it never asks.
    const run = await api("GET", `/runs/${encodeURIComponent(runId)}`);
    check(run.body.status === "completed", `the run is ${run.body.status}, not completed`);
    check(run.body.approvals === "never", `the run's approvals are ${JSON.stringify(run.body.approvals)}, not never`);
    check(!run.body.pending, `the run waits on ${JSON.stringify(run.body.pending)}`);
    const timeline = await api("GET", `/runs/${encodeURIComponent(runId)}/timeline`);
    check(timeline.body.rows.some((row) => row.tool_name === "read"), "the run's timeline has no read call");
    check(!timeline.body.rows.some((row) => /approval/i.test(`${row.kind ?? ""} ${row.summary ?? ""}`)), "the run's timeline shows an approval");
  },
};
