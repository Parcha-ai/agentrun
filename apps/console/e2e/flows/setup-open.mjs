// First visit with no public URL: the server is open to set up, so the page asks only for the owner's password, twice.
// Setting it signs this browser in (a session cookie, HttpOnly), and the console opens on Mission Control. The page is
// served with the server's CSP, which the console runs under.
import { check, PASSWORD, signedIn } from "../harness.mjs";

export default {
  name: "setup-open",
  async run({ page, context, origin }) {
    const first = await page.goto(`${origin}/`);
    check(first?.status() === 200, `GET / answered ${first?.status()}`);
    check(!!first?.headers()["content-security-policy"], "the page is served with no Content-Security-Policy");
    await page.getByRole("heading", { name: "Start building" }).waitFor();
    // No setup code is asked for: the server prints none to type with no public URL.
    check(await page.getByLabel(/setup code/i).count() === 0, "an open setup asks for a setup code");
    await page.getByLabel("New password").fill(PASSWORD);
    await page.getByLabel("Password again").fill(PASSWORD);
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v2/setup");
    await page.getByRole("button", { name: "Set password and continue" }).click();
    const setup = await answered;
    check(setup.ok(), `the setup answered ${setup.status()}`);
    await signedIn(page);
    const session = (await context.cookies(origin)).filter((c) => c.httpOnly);
    check(session.length > 0, "setting the password left no HttpOnly session cookie");
  },
};
