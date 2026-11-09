// Settings → Workspace, as served: Archil is off; saving its disk, region and S3 URL with a key turns it on, with no real
// disk anywhere; Test then fails and says why in the server's words (the disk cannot be reached); Turn off asks first,
// then turns it off with its keys kept. The key is a fake made per run, never printed, and never in the page once saved.
import { randomBytes } from "node:crypto";
import { check } from "../harness.mjs";

export default {
  name: "workspace-archil",
  signedIn: true,
  // Keys are sealed as in production: a seal key made for this run alone, never printed.
  server: () => ({ env: { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } }),
  pending: "waits on the server switch dispatching /v2/workspace/archil (routed, not dispatched, on this base)",
  async run({ page, base }) {
    const fake = `not-a-real-key-${randomBytes(8).toString("hex")}`;
    await page.goto(`${base}/#/settings/workspace`);
    const archil = page.locator('section[aria-label="Archil"]');
    await archil.waitFor();
    check(await archil.locator("[data-state]").innerText() === "Off", "Archil does not read Off on a new server");

    // Save the fields and the key: the PUT answers the view, and the page reads On with the disk and region.
    await archil.locator('input[name="diskId"]').fill("dsk-e2e-test");
    await archil.locator('input[name="region"]').fill("aws-us-east-1");
    // A reserved name (RFC 2606 .invalid): no disk answers there.
    await archil.locator('input[name="s3Url"]').fill("https://s3.archil.invalid");
    await archil.locator('li[data-secret="ARCHIL_API_KEY"]').getByRole("button", { name: "Paste", exact: true }).click();
    await archil.locator('input[name="ARCHIL_API_KEY"]').fill(fake);
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/v2/workspace/archil");
    await archil.getByRole("button", { name: "Turn on", exact: true }).click();
    const response = await saved;
    check(response.status() === 200, `saving Archil answered ${response.status()}`);
    check(!(await response.text()).includes(fake), "the save's answer holds the key's value");
    await archil.locator("[data-state]").getByText("On", { exact: true }).waitFor();
    check(await archil.locator("[data-disk]").innerText() === "dsk-e2e-test · aws-us-east-1", "the disk and region do not show once on");
    check(!(await page.content()).includes(fake), "the key's value is in the page after the save");

    // Test: no disk answers, so it fails, in the server's words.
    await archil.getByRole("button", { name: "Test", exact: true }).click();
    const tested = archil.locator("[data-test]");
    await tested.waitFor({ timeout: 30_000 });
    const said = await tested.innerText();
    check(/^Failed · .+ · \S/.test(said), `Archil's test reads ${JSON.stringify(said)}`);

    // Turn off: a confirm, then Off; the key stays saved.
    await archil.getByRole("button", { name: "Turn off", exact: true }).click();
    await archil.locator("[data-confirm]").getByRole("button", { name: "Turn off", exact: true }).click();
    await archil.locator("[data-state]").getByText("Off", { exact: true }).waitFor();
    check((await archil.locator('li[data-secret="ARCHIL_API_KEY"]').innerText()).includes("Set"), "the key is not kept after Turn off");
    check(!(await page.locator("main").innerText()).includes("workspace:archil"), "the page shows the secret's full server name");
  },
};
