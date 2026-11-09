// The agent editor's Computer step, against --faux's computers (packages/serve/src/faux-computers.ts): the Computer step
// comes right before Tools & skills; Faux sandbox needs FAUX_SANDBOX_KEY, so it is not ready until the key is saved (from
// the signed-in page, as Settings → Computers saves it: a secret write takes the owner's session, never the token); then
// the sandbox kind and that provider are picked in the step, the tools its loop gets are shown as served, and the save
// carries the computer, which the agent read then has.
import { randomBytes } from "node:crypto";
import { check } from "../harness.mjs";

export default {
  name: "computer-step",
  signedIn: true,
  // Keys are sealed as in production: a seal key made for this run alone, never printed.
  server: () => ({ env: { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } }),
  async run({ page, base, api }) {
    const made = await api("POST", "/agents", { definition: { version: 1, name: "e2e-computer", instructions: "Answer.", skills: [], tools: ["read"] } });
    check(made.status === 201, `creating the agent answered ${made.status}: ${JSON.stringify(made.body)}`);
    const id = made.body.agent_id;

    // The editor before the key: the sandbox kind lists Faux sandbox, not ready, in the server's words.
    await page.goto(`${base}/#/agents/${encodeURIComponent(id)}/edit`);
    const rail = page.locator("ol").first();
    await rail.getByRole("button", { name: /Computer/ }).waitFor();
    const names = await rail.getByRole("button").evaluateAll((buttons) => buttons.map((b) => /(Context|Computer|Tools & skills|Settings|History)/.exec(b.textContent ?? "")?.[1] ?? ""));
    check(names.indexOf("Computer") === names.indexOf("Context") + 1 && names.indexOf("Tools & skills") === names.indexOf("Computer") + 1, `the rail reads ${JSON.stringify(names)}`);
    await rail.getByRole("button", { name: /Computer/ }).click();
    await page.locator('input[name="computer-kind"][value="sandbox"]').check();
    const fauxSandbox = page.locator('input[name="computer-provider"][value="faux-sandbox"]');
    await fauxSandbox.waitFor();
    check(await fauxSandbox.isDisabled(), "Faux sandbox can be picked with no key saved");

    // The key, saved from the signed-in page: only its name is sent with a fake value made here, never printed.
    const fake = `not-a-real-key-${randomBytes(8).toString("hex")}`;
    const status = await page.evaluate(async (value) => (await fetch("/v2/computers/faux-sandbox/keys", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ FAUX_SANDBOX_KEY: value }) })).status, fake);
    check(status === 200, `saving Faux sandbox's key answered ${status}`);

    // The editor again: Faux sandbox is ready; pick it, see the tools its loop gets, and save.
    await page.goto(`${base}/#/`);
    await page.goto(`${base}/#/agents/${encodeURIComponent(id)}/edit`);
    await page.locator("ol").first().getByRole("button", { name: /Computer/ }).click();
    await page.locator('input[name="computer-kind"][value="sandbox"]').check();
    await page.locator('input[name="computer-provider"][value="faux-sandbox"]').check();
    const listed = await api("GET", "/computers");
    const tools = listed.body.kinds.find((k) => k.kind === "sandbox").tools.join(", ");
    check((await page.getByLabel("The loop gets").innerText()).includes(tools), `the step's tools are not the served ${JSON.stringify(tools)}`);
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/v2/agents/${encodeURIComponent(id)}`);
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    const response = await saved;
    check(response.ok(), `the save answered ${response.status()}: ${await response.text()}`);

    // The agent read carries the computer picked.
    const agent = await api("GET", `/agents/${encodeURIComponent(id)}`);
    check(JSON.stringify(agent.body.definition.computer) === JSON.stringify({ kind: "sandbox", provider: "faux-sandbox" }), `the agent's computer is ${JSON.stringify(agent.body.definition.computer)}`);
    check(!(await page.content()).includes(fake), "the key's value is in the page");
  },
};
