// Demo mode, from Settings → Demo: the console fills with the sample story, says so on every page, lets the person
// approve a waiting call, refuses a picked file in the page, and asks the server for nothing but the session and its catalogue; turned off, the console is
// the server's again (here: a new server, with no agents).
import { check } from "../harness.mjs";

export default {
  name: "demo-mode",
  signedIn: true,
  async run({ page, errors, base }) {
    const asked = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.pathname.startsWith("/v2/")) asked.push(`${r.method()} ${u.pathname}`); });
    await page.goto(`${base}/#/settings/demo`);
    await page.getByRole("heading", { name: "Demo", exact: true }).waitFor();
    await page.getByRole("switch", { name: "Demo mode" }).click();
    await page.locator("[data-demo-bar]").waitFor();
    asked.length = 0;

    await page.getByRole("link", { name: /Approve a tool call/ }).click();
    await page.getByRole("heading", { name: "Refund request R-48213: Mara Ellison" }).waitFor();
    await page.getByRole("button", { name: "Allow once" }).click();
    await page.getByText("You allowed email_send. It ran.").waitFor();
    await page.getByText(/^Full refund, no return for Mara Ellison/).first().waitFor();

    await page.goto(`${base}/#/agents`);
    await page.getByText("9 agents").waitFor();
    // A file picked in the playground is refused in the page: its bytes never reach the server's /v2/files.
    await page.goto(`${base}/#/playground`);
    await page.getByLabel("Pick files").setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n") });
    await page.getByRole("alert").getByText(/^notes\.md: Demo mode shows sample data/).waitFor();
    await page.goto(`${base}/#/`);
    await page.getByText("Weekly risk brief").first().waitFor();

    const beyond = asked.filter((r) => !/^(GET \/v2\/(capabilities|templates|auth\/session|health))$/.test(r));
    check(beyond.length === 0, `demo mode asked the server for more than its session and catalogue: ${[...new Set(beyond)].join(", ")}`);

    await page.getByRole("button", { name: "Turn off" }).click();
    await page.locator("[data-demo-bar]").waitFor({ state: "detached" });
    await page.getByText("Off: the console shows your server").waitFor();
    await page.goto(`${base}/#/agents`);
    await page.getByText("9 agents").waitFor({ state: "detached" });
    check(errors.length === 0, `the console reported errors in demo mode: ${errors.join(" | ")}`);
  },
};
