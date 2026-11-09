// A GitHub trigger from the console, on a server with no GitHub App connected: Triggers offers New GitHub trigger, whose
// page says to connect GitHub first, shows no form, and links Settings → GitHub. (Making one needs a connected App, and
// connecting one needs GitHub itself: that half is the github-trigger-create flow, pending.)
import { check } from "../harness.mjs";

export default {
  name: "github-trigger-not-connected",
  signedIn: true,
  async run({ page, errors, origin }) {
    await page.goto(`${origin}/#/triggers`);
    await page.getByRole("button", { name: "New GitHub trigger" }).click();
    await page.waitForURL(/#\/triggers\/new-github$/);
    await page.getByText("Connect GitHub first: Settings → GitHub").waitFor();
    check((await page.getByRole("button", { name: "Create GitHub trigger" }).count()) === 0, "a GitHub trigger form showed with GitHub not connected");
    await page.getByRole("link", { name: "Settings → GitHub" }).click();
    await page.waitForURL(/#\/settings\/github$/);
    await page.getByRole("button", { name: "Connect GitHub" }).waitFor();
    // Not connected is GET /v2/integrations/github answering 200 {connected: false}: the page reports no error at all.
    check(errors.length === 0, `the page reported errors: ${errors.join(" | ")}`);
  },
};
