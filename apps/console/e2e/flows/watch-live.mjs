// Watch live: the run page frames the run's browser, as served. A run browses (pi-browser's fake browser: one page, no
// vendor, no key) and asks the person, so it waits with its session open. Its page's "Watch live" tab frames the viewer
// (a same-origin path under the run's own live-view route) and the viewer reaches its live state, with no CSP violation in
// the console's page or the viewer's: the console's CSP (page.ts, default-src 'self') lets it frame its own origin, and
// the viewer's (browser-live.ts LIVE_CSP) lets only that origin frame it. Once the run ends, the tab says the browser
// closed with it, with no frame left. The viewer's link holds its token: it is never read out, printed or compared as text.
import { check } from "../harness.mjs";

/** Every CSP violation in every frame of the page (the console's and the viewer's), as a console error the flow fails on. */
const reportViolations = () => {
  // The blocked address's origin alone: a viewer's path names its session.
  document.addEventListener("securitypolicyviolation", (e) => console.error(`csp violation: ${e.violatedDirective} (${/^https?:/.test(e.blockedURI) ? new URL(e.blockedURI).origin : e.blockedURI || "inline"})`));
};

export default {
  name: "watch-live",
  signedIn: true,
  server: {
    faux: "faux-browse-ask.mjs",
    fauxBrowser: "faux-browser.mjs",
    // The browser tool is offered when its vendor's keys are set; the fake browser never sends them anywhere.
    env: { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" },
  },
  async run({ page, api, origin }) {
    await page.context().addInitScript(reportViolations);
    const agent = await api("POST", "/agents", { definition: { id: "watch", name: "watch", instructions: "Browse, then ask.", tools: ["browser", "ask_person"] } });
    check(agent.status === 201, `creating the agent answered ${agent.status}`);
    const started = await api("POST", "/agents/watch/runs", { input: { content: "Browse the example page." } });
    check(started.status === 202, `starting the run answered ${started.status}`);
    const runId = started.body.run_id;
    const livePath = `/v2/runs/${encodeURIComponent(runId)}/computer/live/`;

    // The run's page, loaded again so the violation listener is in it from the start.
    await page.goto(`${origin}/#/runs/${encodeURIComponent(runId)}`);
    await page.reload();
    const consolePage = await page.request.get(`${origin}/`);
    check(/frame-ancestors 'none'/.test(consolePage.headers()["content-security-policy"] ?? ""), "the console's page is framed by no one");

    // A CSP violation or a refused frame, in the console's page or the viewer's, fails the flow when it happens.
    const refused = new Promise((_, reject) => page.on("console", (m) => { if (/csp violation|Refused to (frame|display)|violates the following Content Security Policy/i.test(m.text())) reject(new Error(`the browser refused: ${m.text().replace(/https?:\/\/[^\s'"()]+/g, (u) => (URL.canParse(u) ? new URL(u).origin : "(an address)")).slice(0, 200)}`)); }));
    refused.catch(() => {});

    // The tab reads "Watch live" once the run's browser has a session (the console reads the run's browser as it goes).
    const viewerDocument = page.waitForResponse((r) => r.request().resourceType() === "document" && new URL(r.url()).pathname.startsWith(livePath), { timeout: 45_000 });
    viewerDocument.catch(() => {});
    await page.getByRole("tab", { name: "Watch live" }).click({ timeout: 45_000 });
    const frameEl = page.locator('iframe[title="The run\'s browser"]');
    await frameEl.waitFor();
    check(await frameEl.evaluate((el, path) => new URL(el.src).pathname.startsWith(path), livePath), "the frame is the run's own live-view path");

    // Live: the viewer's page loaded in the frame, its socket is up and the host said ready: Take over is offered (or,
    // read-only, the watch-only note).
    const viewer = page.frameLocator('iframe[title="The run\'s browser"]');
    await Promise.race([viewer.locator("#hands:not([hidden]), #watching:not([hidden])").first().waitFor(), refused]);
    const notice = viewer.locator("#notice");
    check(await notice.isHidden() || !/Disconnected|not accepted|refused|released/i.test(await notice.innerText()), `the viewer says: ${await notice.innerText().catch(() => "")}`);
    const served = await viewerDocument;
    check(served.status() === 200, `the viewer's page answered ${served.status()}`);
    check(/frame-ancestors 'self'/.test(served.headers()["content-security-policy"] ?? ""), "the viewer's page is framed by its own origin alone");

    // The run ends (a follow-up answers its question): its browser closed with it, and no frame is left.
    const answered = await api("POST", `/runs/${encodeURIComponent(runId)}/messages`, { content: "Yes, that is all." });
    check(answered.status === 202, `answering the run answered ${answered.status}`);
    await page.getByText("The browser closed when the run ended.").waitFor({ timeout: 45_000 });
    check(await frameEl.count() === 0, "an ended run's browser is not framed");
  },
};
