// The agent editor's Computer step, against --faux's computers: the Computer step comes right before Tools & skills, and
// once faux-sandbox's key is saved (through the API, as Settings → Computers saves it), the sandbox kind and that provider
// are picked in the step and saved: the agent read carries the computer.
import { check } from "../harness.mjs";

/** faux-sandbox's one key (packages/serve/src/faux-computers.ts): any value, it reaches nothing. */
const FAUX_KEY = "FAUX_SANDBOX_KEY";

export default {
  name: "computer-step",
  signedIn: true,
  pending: "waits on the server switch registering GET /v2/computers and capabilities.computers (with --faux's computers)",
  async run({ page, base, api }) {
    const keyed = await api("PUT", "/computers/faux-sandbox/keys", { [FAUX_KEY]: ["e2e", "faux", "value"].join("-") });
    check(keyed.status === 200, `saving faux-sandbox's key answered ${keyed.status}`);
    const made = await api("POST", "/agents", { definition: { version: 1, name: "e2e-computer", instructions: "Answer.", skills: [], tools: ["read"] } });
    check(made.status === 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);
    const id = made.body.agent_id;

    await page.goto(`${base}/#/agents/${encodeURIComponent(id)}/edit`);
    // The rail: Computer right after Context and right before Tools & skills.
    const rail = page.locator("ol").first();
    await rail.getByRole("button", { name: /Computer/ }).waitFor();
    const names = await rail.getByRole("button").evaluateAll((buttons) => buttons.map((b) => /(Context|Computer|Tools & skills|Settings|History)/.exec(b.textContent ?? "")?.[1] ?? ""));
    check(names.indexOf("Computer") === names.indexOf("Context") + 1 && names.indexOf("Tools & skills") === names.indexOf("Computer") + 1, `the rail reads ${JSON.stringify(names)}`);

    // The step: the sandbox kind, then faux-sandbox among its providers, then save.
    await rail.getByRole("button", { name: /Computer/ }).click();
    await page.locator('input[name="computer-kind"][value="sandbox"]').check();
    await page.locator('input[name="computer-provider"][value="faux-sandbox"]').check();
    await page.getByLabel("The loop gets").waitFor();
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/v2/agents/${encodeURIComponent(id)}`);
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    const response = await saved;
    check(response.ok(), `the save answered ${response.status()}: ${await response.text()}`);

    // The agent read carries the computer picked.
    const agent = await api("GET", `/agents/${encodeURIComponent(id)}`);
    check(JSON.stringify(agent.body.definition.computer) === JSON.stringify({ kind: "sandbox", provider: "faux-sandbox" }), `the agent's computer is ${JSON.stringify(agent.body.definition.computer)}`);
  },
};
