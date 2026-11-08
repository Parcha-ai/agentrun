// Connect GitHub, up to GitHub's own page: the server has a public URL and a seal key, the page is opened at that public
// origin, and Connect posts the App's manifest to github.com/settings/apps/new?state=… The page's CSP (form-action) must
// let that post leave: the browser's request reaching github.com is the check. GitHub is stubbed, so nothing goes out.
// The same page opened at another origin than the public URL is refused (409 github_wrong_origin) and posts nothing.
import { randomBytes } from "node:crypto";
import { check, freePort, newContext, newPage, owner, signIn } from "../harness.mjs";

let publicOrigin = "";
const notFound = (error) => /status of 404\b/.test(error);

/** GitHub's pages, stubbed in `context`: each request is recorded, and answered with a page of our own. */
async function stubGitHub(context) {
  const seen = [];
  await context.route("https://github.com/**", async (route) => {
    const request = route.request();
    seen.push({ method: request.method(), url: request.url(), body: request.postData() ?? "" });
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>GitHub (stub)</title><p>GitHub, stubbed.</p>" });
  });
  return seen;
}

export default {
  name: "connect-github",
  allow: ["github.com"],
  async server() {
    const port = await freePort();
    publicOrigin = `http://127.0.0.1:${port}`;
    return { port, env: { AGENTRUN_PUBLIC_URL: publicOrigin, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } };
  },
  origin: () => publicOrigin,
  async run({ server, context, page, errors, browser, origin }) {
    // A server with a public URL has no open setup: its owner is set through the API, with the code from its output.
    await owner(server);

    // At the public origin: Connect reaches GitHub's new-App page with the manifest.
    const toGitHub = await stubGitHub(context);
    await signIn(page, origin);
    await page.goto(`${origin}/#/settings/github`);
    const reached = page.waitForRequest((r) => r.url().startsWith("https://github.com/settings/apps/new?state="));
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    const request = await reached;
    check(request.method() === "POST", `the form went to GitHub as ${request.method()}`);
    check(new URLSearchParams(request.postData() ?? "").has("manifest"), "the form to GitHub carried no manifest");
    await page.waitForURL(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    check(toGitHub.length === 1, `GitHub was asked ${toGitHub.length} times`);
    // Not connected is GET /v2/integrations/github answering 404, which the browser logs as an error: the one this page has.
    check(errors.every(notFound), `the page reported errors: ${errors.join(" | ")}`);
    errors.length = 0;

    // At another origin (localhost, not the public 127.0.0.1): refused in the server's words, nothing posted.
    const wrong = origin.replace("127.0.0.1", "localhost");
    const { context: elsewhere, blocked } = await newContext(browser, wrong);
    try {
      const fromElsewhere = await stubGitHub(elsewhere);
      const { page: there, errors: thereErrors } = await newPage(elsewhere);
      await signIn(there, wrong);
      await there.goto(`${wrong}/#/settings/github`);
      const answered = there.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/v2/integrations/github/connect");
      await there.getByRole("button", { name: "Connect GitHub" }).click();
      const refusal = await answered;
      check(refusal.status() === 409, `a start from another origin answered ${refusal.status()}`);
      const code = (await refusal.json().catch(() => null))?.error?.code;
      check(code === "github_wrong_origin", `a start from another origin was refused as ${code}`);
      const alert = there.getByRole("alert");
      const words = await alert.innerText();
      check(words.includes(`Open this server at ${origin} to connect GitHub.`), `the refusal says: ${words}`);
      const link = alert.getByRole("link");
      const href = await link.getAttribute("href");
      check(href?.startsWith(origin), `the refusal links ${href}, not the public URL ${origin}`);
      check(fromElsewhere.length === 0, "a refused start still posted to GitHub");
      check(blocked.length === 0, `requests left loopback: ${blocked.join(", ")}`);
      // Its errors: the not-connected 404, and the refusal's 409.
      check(thereErrors.every((e) => notFound(e) || /status of 409\b/.test(e)), `the page at another origin reported errors: ${thereErrors.join(" | ")}`);
    } finally {
      await elsewhere.close();
    }
  },
};
