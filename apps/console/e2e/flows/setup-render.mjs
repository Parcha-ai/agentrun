// A first visit to a fresh Render server at its plain address (#2222): RENDER_EXTERNAL_URL and no AGENTRUN_PUBLIC_URL,
// render.yaml's trusted proxies, no owner. The page opens setup, asking for the setup code, never the password's sign-in.
// Its first session reads are answered by a gateway's 502 page, as Render's edge answers while a fresh service starts
// (measured on a one-click create: 502 text/html from about 13 s to 84 s, then the server's JSON): the page says the
// server is starting, never "Sign in", asks again on its own, and opens setup once the server answers.
// The server's code (read from its output, never shown) and the owner's password then set the owner up.
import { check, PASSWORD, signedIn } from "../harness.mjs";

export default {
  name: "setup-render",
  server: { env: { RENDER_EXTERNAL_URL: "https://agentrun-e2e.example.test", AGENTRUN_TRUSTED_PROXIES: "uniquelocal" } },
  // The page reports the 502s this flow answers itself; it checks that they are the only errors (below).
  allowsErrors: true,
  async run({ server, page, errors, origin }) {
    let reads = 0;
    const GATEWAY = 3;
    await page.route("**/v2/auth/session", (route) => (reads++ < GATEWAY ? route.fulfill({ status: 502, contentType: "text/html; charset=utf-8", body: "<!DOCTYPE html><html><body>Bad Gateway</body></html>" }) : route.continue()));
    const first = await page.goto(`${origin}/`);
    check(first?.status() === 200, `GET / answered ${first?.status()}`);
    await page.getByRole("heading", { name: "This server is starting" }).waitFor();
    check(await page.getByText("Its address answered 502, not the server.").count() === 1, "the page doesn't say what answered");
    check(await page.getByRole("heading", { name: "Sign in" }).count() === 0, "a starting server showed Sign in");
    await page.getByRole("heading", { name: "Start building" }).waitFor({ timeout: 20_000 });
    check(reads === GATEWAY + 1, `the page read the session ${reads} time(s)`);
    const code = page.getByLabel("Setup code");
    check(await code.count() === 1, "the plain address asks for no setup code");
    check(!!server.setupCode, "the server's setup code is not known");
    await code.fill(await server.setupCode());
    await page.getByLabel("New password").fill(PASSWORD);
    await page.getByLabel("Password again").fill(PASSWORD);
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v2/setup");
    await page.getByRole("button", { name: "Set password and continue" }).click();
    const setup = await answered;
    check(setup.ok(), `the setup answered ${setup.status()}`);
    await signedIn(page);
    const others = errors.filter((e) => !/Failed to load resource: the server responded with a status of 502/.test(e));
    check(others.length === 0, `the page reported errors other than the 502s answered here: ${errors.join(" | ")}`);
  },
};
