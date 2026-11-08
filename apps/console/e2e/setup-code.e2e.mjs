// A real browser's first visit at a public address, against the real built server and console (their own headers and
// CSP): headless Chrome, no fake. Four servers, each started from packages/serve/dist/cli.js on loopback with a fresh
// data directory and home, its setup code read from its own stdout:
//   1. AGENTRUN_PUBLIC_URL set (http): the plain address shows the Setup code field and its note; setups sent with no code
//      are refused and print no new code; a wrong code is refused in words; the code from the server's log sets the
//      password and the console opens. No Strict-Transport-Security (the public address is http).
//   2. AGENTRUN_PUBLIC_URL https: the printed setup link (#code=) fills the field and sets the password; the page carries
//      Strict-Transport-Security.
//   3. No public address (open setup, loopback): no code field, and no Strict-Transport-Security.
//   4. AGENTRUN_PUBLIC_URL set: the server's API token, typed into the Setup code field, sets the password.
// No fixed sleeps: every wait is for a condition, with a bound. Exits 0 when every check holds, else 1.
// Needs the repository built (npm run build). Chrome: CHROME_BIN, else playwright's own; playwright-core: PLAYWRIGHT_CORE,
// else the package `playwright-core`.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ROOT, "packages/serve/dist/cli.js");
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const NOTE = "Find the setup code in the server's log (on Render, the Logs tab), or open the link the log prints. The server's API token (AGENTRUN_TOKEN) works here too.";
const PASSWORD = ["not", "a", "secret", "e2e", "setup"].join("-");
const HSTS = "max-age=31536000";
const SETUP_LINE = /^Set up this server: \S+\/setup#code=([A-Za-z0-9_-]{22})$/gm;

const checks = [];
const check = (what, ok, detail = "") => { checks.push(ok); console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`); };

/** The server, started as a person starts it, in a process group of its own: its address and what it printed. */
async function start(env) {
  const root = await mkdtemp(join(tmpdir(), "agentrun-e2e-setup-"));
  const child = spawn(process.execPath, [CLI, "--data", join(root, "data"), "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"], detached: true,
    env: { ...process.env, HOME: root, AGENTRUN_PUBLIC_URL: "", RENDER_EXTERNAL_URL: "", AGENTRUN_ACCOUNTS: "", ...env },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", () => {});
  const exited = new Promise((r) => child.once("exit", r));
  const base = await new Promise((resolve, reject) => {
    // Its output holds the server's token: never echoed, here or on a failure.
    const timer = setTimeout(() => reject(new Error("the server did not print its address in 60 s")), 60_000);
    // The banner's first line names the address it listens on; the Open line names the public one.
    const look = () => { const m = /^agentrun-serve on (http:\/\/[^\s/]+)/m.exec(out); if (m) { clearTimeout(timer); child.stdout.off("data", look); resolve(m[1]); } };
    child.stdout.on("data", look);
    look();
  });
  const codes = () => [...out.matchAll(SETUP_LINE)].map((m) => m[1]);
  return {
    base,
    codes,
    /** The API token this start made (the banner's AGENTRUN_API_KEY line): typed into the field, never printed here. */
    token: () => /^AGENTRUN_API_KEY=(\S+)$/m.exec(out)?.[1],
    /** The first setup code it printed, once it has (bounded). */
    firstCode: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server printed no setup code in 30 s")), 30_000);
      const look = () => { const [code] = codes(); if (code) { clearTimeout(timer); child.stdout.off("data", look); resolve(code); } };
      child.stdout.on("data", look);
      look();
    }),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000).unref())]);
      await rm(root, { recursive: true, force: true });
    },
  };
}

const browser = await chromium.launch(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {});
/** A fresh browser page on `url`: the page, and the first document's response headers. */
async function open(url) {
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  // A refused request's status is Chrome's own console line ("Failed to load resource"); the refusals here are expected.
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource: the server responded with a status of 403/.test(m.text())) errors.push(m.text()); });
  const response = await page.goto(url);
  await page.waitForSelector('input[aria-label="New password"]', { timeout: 30_000 });
  return { page, errors, headers: response?.headers() ?? {} };
}
const codeField = (page) => page.locator("label", { has: page.locator("span", { hasText: /^Setup code$/ }) });
const fill = async (page, code) => {
  if (code !== undefined) await codeField(page).locator("input").fill(code);
  await page.fill('input[aria-label="New password"]', PASSWORD);
  await page.fill('input[aria-label="Password again"]', PASSWORD);
};
const signedIn = (page) => page.waitForFunction(async () => (await (await fetch("/v2/auth/session")).json()).signed_in === true, null, { timeout: 30_000 });

try {
  // 1. A public address over http: the plain address.
  const a = await start({ AGENTRUN_PUBLIC_URL: "http://agentrun-e2e.example.test" });
  try {
    const code = await a.firstCode();
    check("server 1 printed one setup code", a.codes().length === 1, `${a.codes().length} printed`);
    const { page, errors, headers } = await open(`${a.base}/`);
    check("server 1 page has no HSTS (http public address)", headers["strict-transport-security"] === undefined, headers["strict-transport-security"] ?? "");
    const field = codeField(page);
    check("the plain address shows the Setup code field", (await field.count()) === 1);
    check("with its note", ((await field.textContent()) ?? "").includes(NOTE));
    await fill(page);
    check("Set password waits for a code", await page.locator('button[type="submit"]').isDisabled());
    // Setups with no code, as a page that hid the field sent them: refused, and the printed code stands.
    const empty = await page.evaluate(async (password) => {
      const said = [];
      for (let i = 0; i < 6; i++) {
        const r = await fetch("/v2/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
        said.push(r.status);
      }
      return said;
    }, PASSWORD);
    check("six setups with no code are refused", empty.every((s) => s === 403), empty.join(","));
    check("and print no new code", a.codes().length === 1, `${a.codes().length} printed`);
    await fill(page, "wrong-code-0000000000x");
    await page.click('button[type="submit"]');
    await page.waitForSelector('[role="alert"]', { timeout: 15_000 });
    check("a wrong code is refused in words", ((await page.textContent('[role="alert"]')) ?? "").includes("That setup code is not the one in the server's log."));
    await fill(page, code);
    await page.click('button[type="submit"]');
    await signedIn(page);
    check("the code from the server's log sets the password and signs in", true);
    check("server 1 page: no console errors", errors.length === 0, errors.join(" | "));
  } finally { await a.stop(); }

  // 2. A public address over https: the printed link, opened on the server's own address.
  const b = await start({ AGENTRUN_PUBLIC_URL: "https://agentrun-e2e.example.test" });
  try {
    const code = await b.firstCode();
    const { page, errors, headers } = await open(`${b.base}/setup#code=${code}`);
    check("server 2 page carries HSTS (https public address)", headers["strict-transport-security"] === HSTS, headers["strict-transport-security"] ?? "none");
    check("the setup link fills the Setup code field", (await codeField(page).locator("input").inputValue()) === code);
    check("and leaves the address without the code", !page.url().includes(code));
    await fill(page);
    await page.click('button[type="submit"]');
    await signedIn(page);
    check("the link's code sets the password and signs in", true);
    check("server 2 page: no console errors", errors.length === 0, errors.join(" | "));
  } finally { await b.stop(); }

  // 3. No public address: open setup on loopback.
  const c = await start({});
  try {
    const { page, headers } = await open(`${c.base}/`);
    check("server 3 page has no HSTS (loopback, no public address)", headers["strict-transport-security"] === undefined, headers["strict-transport-security"] ?? "");
    check("open setup shows no Setup code field", (await codeField(page).count()) === 0);
  } finally { await c.stop(); }

  // 4. The server's API token in the Setup code field.
  const d = await start({ AGENTRUN_PUBLIC_URL: "http://agentrun-e2e.example.test" });
  try {
    await d.firstCode();
    const token = d.token();
    check("server 4 printed the token it made", typeof token === "string" && token.length > 0);
    const { page, errors } = await open(`${d.base}/`);
    await fill(page, token);
    await page.click('button[type="submit"]');
    await signedIn(page);
    check("the server's API token in the Setup code field sets the password and signs in", true);
    check("server 4 page: no console errors", errors.length === 0, errors.join(" | "));
  } finally { await d.stop(); }
} catch (error) {
  check("the walk ran to its end", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
} finally {
  await browser.close();
}
const passed = checks.length > 0 && checks.every(Boolean);
console.log(`${passed ? "PASS" : "FAIL"} setup-code e2e: ${checks.filter(Boolean).length}/${checks.length}`);
process.exit(passed ? 0 : 1);
