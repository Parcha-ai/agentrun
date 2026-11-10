// A first visit to a fresh Render server at its plain address (#2222): RENDER_EXTERNAL_URL and no AGENTRUN_PUBLIC_URL,
// render.yaml's trusted proxies, no owner. The page opens setup, asking for the setup code, never the password's sign-in.
// Its first session read is answered by another's page in the server's place (a proxy's 404, as an edge can while a
// service starts): the page says it can't read the session, never "Sign in", asks again on its own, and opens setup.
// The server's code (read from its output, never shown) and the owner's password then set the owner up.
import { check, PASSWORD, signedIn } from "../harness.mjs";

export default {
  name: "setup-render",
  server: { env: { RENDER_EXTERNAL_URL: "https://agentrun-e2e.example.test", AGENTRUN_TRUSTED_PROXIES: "uniquelocal" } },
  // The page reports the one 404 this flow answers itself; it checks that it is the only error (below).
  allowsErrors: true,
  async run({ server, page, errors, origin }) {
    let reads = 0;
    await page.route("**/v2/auth/session", (route) => (reads++ === 0 ? route.fulfill({ status: 404, contentType: "text/html", body: "<h1>Not Found</h1>" }) : route.continue()));
    const first = await page.goto(`${origin}/`);
    check(first?.status() === 200, `GET / answered ${first?.status()}`);
    await page.getByRole("heading", { name: "Can't read this server's sign-in" }).waitFor();
    check(await page.getByRole("heading", { name: "Sign in" }).count() === 0, "an unread session showed Sign in");
    await page.getByRole("heading", { name: "Start building" }).waitFor({ timeout: 10_000 });
    check(reads >= 2, `the page read the session ${reads} time(s)`);
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
    const others = errors.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e));
    check(errors.length === 1 && others.length === 0, `the page reported errors other than the one 404 answered here: ${errors.join(" | ")}`);
  },
};
