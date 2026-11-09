// Settings → Computers, as served under --faux's computers (packages/serve/src/faux-computers.ts): Faux sandbox needs
// FAUX_SANDBOX_KEY, so it is not ready until a key is pasted; once saved it is Ready and its Test connection passes with
// the server's detail. Faux broken has no key and its test fails with the server's why. The pasted value is a fake made
// here, never printed, and never in the page once saved. The server seals it under its own random seal key.
import { randomBytes } from "node:crypto";
import { check } from "../harness.mjs";

export default {
  name: "computers-keys",
  signedIn: true,
  // Keys are sealed as in production: a seal key made for this run alone, never printed. --faux fakes the model and the
  // computers, never the seal key.
  server: () => ({ env: { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } }),
  pending: "waits on the server switch dispatching /v2/computers and --faux's computers (routed, not dispatched, on this base)",
  async run({ page, base }) {
    const fake = `not-a-real-key-${randomBytes(8).toString("hex")}`;
    await page.goto(`${base}/#/settings/computers`);
    const sandbox = page.locator('section[aria-label="Sandbox"]');
    await sandbox.waitFor();
    const row = (name) => sandbox.locator("li").filter({ has: page.locator("[data-provider]", { hasText: name }) }).first();

    // Faux sandbox: its key by its KEY, Missing, and not ready yet.
    const faux = row("Faux sandbox");
    await faux.getByText("FAUX_SANDBOX_KEY").waitFor();
    const key = faux.locator('li[data-secret="FAUX_SANDBOX_KEY"]');
    check((await key.innerText()).includes("Missing"), "Faux sandbox's key does not read Missing before it is saved");
    check(!(await page.locator("main").innerText()).includes("computer:"), "the page shows a secret's full server name");
    check(!(await faux.innerText()).includes("Ready"), "Faux sandbox reads Ready with no key saved");

    // Paste the key: only that key is sent, the page reads the computers again, and the row turns Ready.
    await key.getByRole("button", { name: "Paste", exact: true }).click();
    await faux.locator('input[name="FAUX_SANDBOX_KEY"]').fill(fake);
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/v2/computers/faux-sandbox/keys");
    await faux.getByRole("button", { name: "Save", exact: true }).click();
    const response = await saved;
    check(response.status() === 200, `saving the key answered ${response.status()}`);
    check(!(await response.text()).includes(fake), "the save's answer holds the key's value");
    await faux.getByText("Ready", { exact: true }).waitFor();
    check((await faux.locator('li[data-secret="FAUX_SANDBOX_KEY"]').innerText()).includes("Pasted here"), "the saved key does not say it was pasted here");
    check(!(await page.content()).includes(fake), "the key's value is in the page after the save");

    // Test connection: Passed with the server's detail.
    await faux.getByRole("button", { name: "Test connection", exact: true }).click();
    const passed = faux.locator("[data-test]");
    await passed.waitFor();
    check(/^Passed · .+ · Faux sandbox: the faux account answered/.test(await passed.innerText()), `Faux sandbox's test reads ${JSON.stringify(await passed.innerText())}`);

    // Faux broken: no key; its test fails in the server's words.
    const broken = row("Faux broken");
    check((await broken.innerText()).includes("No key."), "Faux broken doesn't say it takes no key");
    await broken.getByRole("button", { name: "Test connection", exact: true }).click();
    const failed = broken.locator("[data-test]");
    await failed.waitFor();
    check(/^Failed · .+ · faux-broken is --faux's broken provider: it never answers$/.test(await failed.innerText()), `Faux broken's test reads ${JSON.stringify(await failed.innerText())}`);
  },
};
