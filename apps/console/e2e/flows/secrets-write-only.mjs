// Secrets are write-only (SECRETS-PLAN, rules 1-4), in a real browser on the built server. On the owner's password
// session, Settings → Keys pastes a key: its row then reads Set · Pasted here. A key the server was started with reads
// Set in the environment, greyed, with nothing to paste over it. No value, pasted or from the environment, is ever in the
// page. And the API token never writes a secret: the same PUT with it is 403 in the server's words.
import { check } from "../harness.mjs";

// Canaries, not secret shapes: what the page must never hold.
const PASTED = "CANARY-VALUE-3c9e51d7";
const FROM_ENV = "CANARY-VALUE-8a2f60b4";
const BY_TOKEN = "CANARY-VALUE-61b0e2c9";

export default {
  name: "secrets-write-only",
  signedIn: true,
  server: { env: { PARALLEL_API_KEY: FROM_ENV } },
  async run({ page, origin, api, errors }) {
    await page.goto(`${origin}/#/settings/keys`);

    // Set in the environment: greyed, said so, and no Paste, Replace or Remove.
    const fromEnv = page.locator('[data-secret="tool:PARALLEL_API_KEY"]');
    await fromEnv.getByText("Set in the environment").waitFor();
    check((await fromEnv.getAttribute("data-source")) === "env", "the key set in the environment isn't marked env");
    check((await fromEnv.getByRole("button").count()) === 0, "the key set in the environment offers a button");

    // The password session pastes one: Paste, type it, Save; its row then reads Set · Pasted here.
    const monid = page.locator('[data-secret="tool:MONID_API_KEY"]');
    await monid.getByRole("button", { name: "Paste" }).click();
    await page.locator('input[name="MONID_API_KEY"]').fill(PASTED);
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/v2/settings/tool-keys/monid");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const answer = await saved;
    check(answer.status() < 300, `the paste answered ${answer.status()}: ${await answer.text()}`);
    await monid.getByText("Pasted here").waitFor();

    // No value in the page: not the one pasted, not the environment's.
    const html = await page.content();
    check(!html.includes(PASTED), "the pasted value is in the page");
    check(!html.includes(FROM_ENV), "the environment's value is in the page");

    // The API token never writes a secret: 403, in the server's one refusal.
    const refused = await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: BY_TOKEN } });
    check(refused.status === 403, `the token's paste answered ${refused.status}`);
    check(JSON.stringify(refused.body).includes("the API token can't write secrets"), `the token's refusal said ${JSON.stringify(refused.body)}`);
    check(errors.length === 0, `the page reported errors: ${errors.join(" | ")}`);
  },
};
