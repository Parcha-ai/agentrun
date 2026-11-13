// First visit at a public URL (AGENTRUN_PUBLIC_URL; on Render, its own address): setup takes the code the server prints
// to its log, and the page asks for it at the plain address, with no link. With no code typed, the page sends nothing.
// The server's code (read from its output, never shown) and the owner's password, twice, set the password and sign this
// browser in. Over https the page carries Strict-Transport-Security. It runs against a server already running only with
// its setup code (run.mjs --url with --setup-code-file): one whose owner is set has no first visit to check, so it skips.
import { check, PASSWORD, signedIn } from "../harness.mjs";

const NOTE = "On Render: paste the server's AGENTRUN_TOKEN from the service's Environment tab. Elsewhere: paste the setup code the server printed in its log, or open the link it prints.";

export default {
  name: "setup-public",
  shares: ({ setupCodeFile }) => !!setupCodeFile,
  server: { env: { AGENTRUN_PUBLIC_URL: "https://agentrun-e2e.example.test" } },
  async run({ server, page, origin }) {
    const first = await page.goto(`${origin}/`);
    check(first?.status() === 200, `GET / answered ${first?.status()}`);
    // The public address is https here, and on a hosted server: its pages carry HSTS (whichever address served them).
    if (!server.attached || origin.startsWith("https://")) check(first?.headers()["strict-transport-security"] === "max-age=31536000", `the page's Strict-Transport-Security is ${first?.headers()["strict-transport-security"] ?? "absent"}`);
    await page.getByRole("heading", { name: "Start building" }).waitFor();
    const code = page.getByLabel("Setup code");
    check(await code.count() === 1, "the plain address asks for no setup code");
    check((await page.getByText(NOTE).count()) === 1, "the Setup code field's note is missing");
    await page.getByLabel("New password").fill(PASSWORD);
    await page.getByLabel("Password again").fill(PASSWORD);
    const button = page.getByRole("button", { name: "Set password and continue" });
    check(await button.isDisabled(), "setup can be sent with no setup code");
    check(!!server.setupCode, "the server's setup code is not known (--setup-code-file)");
    await code.fill(await server.setupCode());
    const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v2/setup");
    await button.click();
    const setup = await answered;
    check(setup.ok(), `the setup answered ${setup.status()}`);
    await signedIn(page);
  },
};
