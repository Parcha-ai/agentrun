// Apply a template on the Templates page and see its agent open. The template is kyb, which the server ships: it needs no
// MCP server and no key, and its one required parameter fills its display name, so the agent's name shows the parameter
// reached the server. Whether the Apply screen shows warnings first is the server's answer, which the flow reads and follows.
import { check } from "../harness.mjs";

const TEMPLATE = "kyb";
const RISK = "medium";
const AGENT_NAME = `KYB due diligence (${RISK} risk appetite)`;

export default {
  name: "template-apply",
  signedIn: true,
  pending: "waits on #1975 (the Templates page and its Apply screen)",
  async run({ page, base, api }) {
    await page.goto(`${base}/#/templates`);
    // The list: the kyb card by its title, the package's display name with "…" for its unfilled parameter.
    const card = page.locator('article[aria-label^="KYB due diligence"]');
    await card.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForURL((url) => url.hash === `#/templates/${TEMPLATE}`);

    // The Apply screen: the required parameter, then Apply.
    await page.locator('[data-field="parameters.risk_appetite"] input').fill(RISK);
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/v2/templates/${TEMPLATE}/apply`);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const response = await answered;
    check(response.status() === 201, `the apply answered ${response.status()}: ${await response.text()}`);
    const applied = await response.json();
    const agentHash = `#/agents/${encodeURIComponent(applied.agent_id)}`;

    // With warnings, the screen says the agent is made and shows each one, then opens it on a click; without, it opens at once.
    if (applied.warnings.length) {
      const made = page.getByRole("region", { name: "Applied" });
      for (const w of applied.warnings) await made.getByText(w.message, { exact: false }).first().waitFor();
      await made.getByRole("link", { name: "Open the agent" }).click();
    }
    await page.waitForURL((url) => url.hash === agentHash);

    // The agent opened: its page is headed with the name the server made, the display name with the parameter filled in.
    const agent = await api("GET", `/agents/${encodeURIComponent(applied.agent_id)}`);
    check(agent.status === 200, `GET the applied agent answered ${agent.status}`);
    check(agent.body.definition.name === AGENT_NAME, `the agent is named ${JSON.stringify(agent.body.definition.name)}, not ${JSON.stringify(AGENT_NAME)}`);
    await page.getByRole("heading", { level: 1, name: AGENT_NAME, exact: true }).waitFor();
  },
};
