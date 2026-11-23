// Suggested agents in a real browser, on a server with the faux scout model and the fake GitHub App (--faux-github): the
// page offers the App's repository, a scan runs and its suggestions appear (the one that does not check is left out),
// Discard takes one away with an undo, and Create checks GitHub, shows the files, opens the pull request on the fake
// GitHub and says what the app sets. With E2E_SHOTS=<dir>, each step's screenshot is saved there for a person to look at.
import { randomBytes } from "node:crypto";
import { check, freePort, LOOPBACK } from "../harness.mjs";

const shots = process.env.E2E_SHOTS;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }); };
/** The same page in the dark theme, picked as a person picks it (the sidebar's switch), then back to the system's. */
const darkShot = async (page, name) => {
  if (!shots) return;
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  // Controls ease their colours over duration-base at most: the picture waits that out (a picture only, never a check).
  await page.waitForTimeout(400);
  await shot(page, name);
  await page.getByRole("button", { name: "System", exact: true }).click();
};

const scanAndCreate = {
  name: "suggest-agents",
  signedIn: true,
  server: { faux: "faux-scout.mjs", args: ["--faux-github"] },
  async run({ page, errors, origin }) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/#/suggestions`);
    await page.getByRole("heading", { name: "Suggested agents" }).waitFor();
    // The App's one repository is offered, and nothing is scanned yet.
    await page.getByRole("heading", { name: "Scan a repository" }).waitFor();
    await shot(page, "1-scan-box");
    await page.getByRole("button", { name: "Scan repository" }).click();
    await page.waitForURL(/#\/suggestions\?repo=faux-org%2Fdemo$/);
    const triage = page.getByRole("article", { name: "Triage support tickets" });
    await triage.waitFor({ timeout: 45_000 });
    await page.getByRole("article", { name: "Review refund requests" }).waitFor();
    await page.getByText("1 suggestion was left out because it did not check").waitFor();
    // The App's one repository is scanned: the box offers no other, and only the repository's own Scan again stays.
    await page.getByText("Every repository the GitHub App is installed on is scanned.").waitFor();
    check((await page.getByRole("button", { name: /Scan again/ }).count()) === 1, "a scanned repository is offered twice for a scan");
    await shot(page, "2-suggestions");
    await darkShot(page, "2-suggestions-dark");
    // On a phone (390 px) the page has no sideways scroll: the cards, the evidence and the actions fit; a long line of code
    // scrolls inside its own block.
    await page.setViewportSize({ width: 390, height: 844 });
    const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth, main: (() => { const m = document.querySelector("main"); return m ? m.scrollWidth - m.clientWidth : 0; })() }));
    check(wide.doc <= 0 && wide.main <= 0, `at 390 px the page scrolls sideways: ${JSON.stringify(wide)}`);
    await shot(page, "2-suggestions-phone");
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Discard: gone at once, said with an undo; the undo brings it back.
    await page.getByRole("button", { name: "Discard Review refund requests" }).click();
    await page.getByText("Discarded Review refund requests.").waitFor();
    check((await page.getByRole("article", { name: "Review refund requests" }).count()) === 0, "a discarded suggestion stayed on the page");
    await shot(page, "3-discarded");
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("article", { name: "Review refund requests" }).waitFor();

    // Create: GitHub is checked, the files are shown, and the pull request opens on the fake GitHub.
    await page.getByRole("button", { name: "Create Triage support tickets" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Ready to open the pull request").waitFor();
    await dialog.getByText(".agentrun/agents/ticket-triage/agent.md").click();
    await shot(page, "4-create-dialog");
    await dialog.getByRole("button", { name: "Create and open pull request" }).click();
    await dialog.getByText("Triage support tickets: created").waitFor({ timeout: 30_000 });
    const pull = dialog.getByRole("link", { name: /Open pull request #1/ });
    check((await pull.getAttribute("href")) === "https://github.com/faux-org/demo/pull/1", "the pull request's link is the fake GitHub's");
    await dialog.getByText("AGENTRUN_AGENT_TICKET_TRIAGE").waitFor();
    await shot(page, "5-created");
    await page.keyboard.press("Escape");
    // The list shows it created, with its pull request.
    await page.getByRole("link", { name: /#1/ }).waitFor();
    await shot(page, "6-created-row");
    check(errors.length === 0, `the page reported errors: ${errors.join(" | ")}`);
  },
};

// Not connected: the page says what it does and what GitHub is asked for, and Connect posts the App's manifest to GitHub
// (stubbed here) asking for Contents write, the one permission the pull requests need beyond the App's defaults; this
// tab keeps where to come back to after GitHub.
let publicOrigin = "";
const notConnected = {
  name: "suggest-agents-not-connected",
  signedIn: true,
  allow: ["github.com"],
  async server() {
    const port = await freePort();
    publicOrigin = `http://${LOOPBACK}:${port}`;
    return { port, faux: "faux-scout.mjs", env: { AGENTRUN_PUBLIC_URL: publicOrigin, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") } };
  },
  origin: () => publicOrigin,
  async run({ context, page, errors, origin }) {
    const posted = [];
    await context.route("https://github.com/**", async (route) => {
      posted.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>GitHub (stub)</title><p>GitHub, stubbed.</p>" });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/#/suggestions`);
    await page.getByRole("heading", { name: "Find where agents fit in your app" }).waitFor();
    await page.getByRole("heading", { name: "What GitHub is asked for" }).waitFor();
    await shot(page, "0-not-connected");
    await darkShot(page, "0-not-connected-dark");
    const reached = page.waitForRequest((r) => r.url().startsWith("https://github.com/settings/apps/new?state="));
    const kept = await page.evaluate(() => sessionStorage.getItem("agentrun.github.return"));
    check(kept === null, "a return was kept before Connect");
    await page.getByRole("button", { name: "Connect GitHub" }).click();
    const request = await reached;
    const manifest = JSON.parse(new URLSearchParams(request.postData() ?? "").get("manifest") ?? "{}");
    check(manifest.default_permissions?.contents === "write" && manifest.default_permissions?.pull_requests === "write", `the manifest asked for ${JSON.stringify(manifest.default_permissions)}`);
    check(errors.length === 0, `the page reported errors: ${errors.join(" | ")}`);
  },
};

export default [notConnected, scanAndCreate];
