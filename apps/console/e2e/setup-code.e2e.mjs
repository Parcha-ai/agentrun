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
// With --url URL --setup-code-file F --password-file P, it starts nothing and checks a server already running (a hosted
// one, at its public address): the plain address shows the Setup code field and its note; the setup code (or the
// server's API token) in F, with the owner's password in P, sets the password and signs in; over https the page carries
// Strict-Transport-Security. Neither file's content is printed.
// No fixed sleeps: every wait is for a condition, with a bound. Exits 0 when every check holds, else 1.
// Needs the repository built (npm run build). Chrome: CHROME_BIN, else playwright's own; playwright-core: PLAYWRIGHT_CORE
// (its index.mjs or its index.js: either loads), else the package `playwright-core`.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ROOT, "packages/serve/dist/cli.js");
// index.mjs exports `chromium`; the CommonJS index.js, imported, has it only on its default export.
const playwright = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error(`no chromium in ${process.env.PLAYWRIGHT_CORE ?? "playwright-core"}`);
const NOTE = "On Render: paste the server's AGENTRUN_TOKEN from the service's Environment tab. Elsewhere: paste the setup code the server printed in its log, or open the link it prints.";
const PASSWORD = ["not", "a", "secret", "e2e", "setup"].join("-");
const HSTS = "max-age=31536000";
const SETUP_LINE = /^Set up this server: \S+\/setup#code=([A-Za-z0-9_-]{22}) \(or paste AGENTRUN_TOKEN\)$/gm;

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
  /** Its process group stopped, while alive, and its directory gone. */
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000).unref())]);
    await rm(root, { recursive: true, force: true });
  };
  const base = await new Promise((resolve, reject) => {
    // Its output holds the server's token: never echoed, here or on a failure.
    const timer = setTimeout(() => reject(new Error("the server did not print its address in 60 s")), 60_000);
    // The banner's first line names the address it listens on; the Open line names the public one.
    const look = () => { const m = /^agentrun-serve on (http:\/\/[^\s/]+)/m.exec(out); if (m) { clearTimeout(timer); child.stdout.off("data", look); resolve(m[1]); } };
    child.stdout.on("data", look);
    look();
  }).catch(async (error) => { await stop(); throw error; });
  const codes = () => [...out.matchAll(SETUP_LINE)].map((m) => m[1]);
  return {
    base,
    codes,
    /** The API token this start made (the banner's AGENTRUN_API_KEY line), once printed (bounded): typed into the
     *  field, never printed here. */
    token: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server printed no token in 30 s")), 30_000);
      const look = () => { const m = /^AGENTRUN_API_KEY=(\S+)$/m.exec(out); if (m) { clearTimeout(timer); child.stdout.off("data", look); resolve(m[1]); } };
      child.stdout.on("data", look);
      look();
    }),
    /** The first setup code it printed, once it has (bounded). */
    firstCode: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server printed no setup code in 30 s")), 30_000);
      const look = () => { const [code] = codes(); if (code) { clearTimeout(timer); child.stdout.off("data", look); resolve(code); } };
      child.stdout.on("data", look);
      look();
    }),
    stop,
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
const fill = async (page, code, password = PASSWORD) => {
  if (code !== undefined) await codeField(page).locator("input").fill(code);
  await page.fill('input[aria-label="New password"]', password);
  await page.fill('input[aria-label="Password again"]', password);
};
/** Whether the server says this browser is signed in, within 30 s: settles, rejecting at the bound. */
const signedIn = (page) => page.waitForFunction(async () => (await (await fetch("/v2/auth/session")).json()).signed_in === true, null, { timeout: 30_000 });

const arg = (name) => { const at = process.argv.indexOf(name); return at > 1 ? process.argv[at + 1] : undefined; };
const hosted = arg("--url");
// A --url given empty (an unset variable) never falls back to the local servers: that would pass without checking it.
if (process.argv.includes("--url") && !hosted) { console.error("--url needs the server's address"); process.exit(2); }
if (hosted) {
  try {
    const code = (await readFile(arg("--setup-code-file") ?? "", "utf8")).trim();
    // The password as the file holds it, spaces kept; only a final line ending is not part of it.
    const password = (await readFile(arg("--password-file") ?? "", "utf8")).replace(/\r?\n$/, "");
    check("a setup code (or token) and a password of 12 characters or more were given", code.length > 0 && password.length >= 12);
    const url = hosted.replace(/\/+$/, "");
    const { page, errors, headers } = await open(`${url}/`);
    if (url.startsWith("https://")) check("the page carries HSTS over https", headers["strict-transport-security"] === HSTS, headers["strict-transport-security"] ?? "none");
    else console.log("--   HSTS not checked: the --url is not https");
    const field = codeField(page);
    check("the plain address shows the Setup code field", (await field.count()) === 1);
    check("with its note", ((await field.textContent()) ?? "").includes(NOTE));
    await fill(page, code, password);
    await page.click('button[type="submit"]');
    check("the setup code (or token) sets the password and signs in", await signedIn(page).then(() => true, () => false));
    check("no console errors", errors.length === 0, errors.join(" | "));
  } catch (error) {
    check("the walk ran to its end", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
  } finally {
    await browser.close();
  }
  const passed = checks.length > 0 && checks.every(Boolean);
  console.log(`${passed ? "PASS" : "FAIL"} setup-code e2e (--url): ${checks.filter(Boolean).length}/${checks.length}`);
  process.exit(passed ? 0 : 1);
}

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
    check("a wrong code is refused in words", ((await page.textContent('[role="alert"]')) ?? "").includes("That setup code was refused: open the newest setup link in the server's log, or paste the server's token (AGENTRUN_TOKEN) here."));
    await fill(page, code);
    await page.click('button[type="submit"]');
    check("the code from the server's log sets the password and signs in", await signedIn(page).then(() => true, () => false));
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
    check("the link's code sets the password and signs in", await signedIn(page).then(() => true, () => false));
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
    const token = await d.token();
    check("server 4 printed the token it made", typeof token === "string" && token.length > 0);
    const { page, errors } = await open(`${d.base}/`);
    await fill(page, token);
    await page.click('button[type="submit"]');
    check("the server's API token in the Setup code field sets the password and signs in", await signedIn(page).then(() => true, () => false));
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
