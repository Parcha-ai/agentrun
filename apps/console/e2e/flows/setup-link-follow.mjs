// First visit at a public URL the way a person gets it: the setup LINK the server printed (`Set up this server:
// <url>/setup#code=<code>`), opened in a browser, never a code typed in. The link's address goes through /setup's redirect
// to the console, which must keep the code from its fragment: the Setup code field holds exactly the printed code, and
// the setup the page sends carries exactly it. The server prints a new code (five wrong tries void one, as an expired one
// is replaced): a link from the older line is refused, in words that say to open the newest link or paste the token; the
// newest link's code is the one sent, and it sets the password.
import { check, PASSWORD, signedIn } from "../harness.mjs";

const REFUSED = "That setup code was refused: open the newest setup link in the server's log, or paste the server's token (AGENTRUN_TOKEN) here.";

/** The printed link's path and fragment, opened on the server's own address (the public URL here names no real host). */
const onServer = (link, origin) => { const u = new URL(link); return `${origin}${u.pathname}${u.search}${u.hash}`; };

/** Fills the passwords, sends setup from the page, and answers the code the page sent and the server's status. */
async function submit(page) {
  await page.getByLabel("New password").fill(PASSWORD);
  await page.getByLabel("Password again").fill(PASSWORD);
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v2/setup");
  await page.getByRole("button", { name: "Set password and continue" }).click();
  const r = await answered;
  return { sent: JSON.parse(r.request().postData() ?? "{}").code, status: r.status() };
}

export default {
  name: "setup-link-follow",
  server: { env: { AGENTRUN_PUBLIC_URL: "https://agentrun-e2e.example.test" } },
  async run({ server, context, page, errors, origin }) {
    // The server's first link, and its code.
    const [, firstLink, firstCode] = await server.line(/Set up this server: (\S+\/setup#code=([A-Za-z0-9_-]+))$/);
    // Five wrong tries void it: the server prints a new link. A person then opens the newest one.
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${server.baseUrl}/setup`, { method: "POST", headers: { "content-type": "application/json", origin: server.origin }, body: JSON.stringify({ password: PASSWORD, code: `wrong-${i}` }) });
      check(r.status === 403, `a wrong code answered ${r.status}`);
    }
    const [, newLink, newCode] = await server.line(new RegExp(`Set up this server: (\\S+/setup#code=(?!${firstCode})([A-Za-z0-9_-]+))$`));
    check(newCode !== firstCode, "the server printed no new code after five wrong tries");
    check(firstLink !== newLink, "the new link is the old one");

    // The OLDER link, opened as a person who copied the wrong log line opens it: refused, in words that say what to do.
    await page.goto(onServer(firstLink, origin));
    await page.getByRole("heading", { name: "Start building" }).waitFor();
    check(await page.getByLabel("Setup code").inputValue() === firstCode, "the older link's page holds another code than its own");
    const old = await submit(page);
    check(old.sent === firstCode && old.status === 403, `the older link's code was sent as ${String(old.sent).length} characters and answered ${old.status}`);
    const said = (await page.getByRole("alert").textContent()) ?? "";
    check(said === REFUSED, `the refusal says "${said}"`);

    // The newest link, opened as a person opens it: /setup, its redirect, the console.
    const first = await page.goto(onServer(newLink, origin));
    check(first?.status() === 200, `opening the link answered ${first?.status()}`);
    await page.getByRole("heading", { name: "Start building" }).waitFor();
    const field = page.getByLabel("Setup code");
    check(await field.count() === 1, "the setup link's page asks for no setup code");
    const shown = await field.inputValue();
    check(shown === newCode, `the field holds ${shown.length} characters that are not the printed code`);
    const { sent, status } = await submit(page);
    check(sent === newCode, `the page sent a code that is not the printed one (${String(sent).length} characters)`);
    check(status === 201, `the setup with the printed code answered ${status}`);
    await signedIn(page);
    // The older link's refusal is the one error the page reports (its 403); nothing else.
    check(errors.every((e) => /status of 403\b/.test(e)), `the page reported errors: ${errors.join(" | ")}`);
    errors.length = 0;
    void context;
  },
};
