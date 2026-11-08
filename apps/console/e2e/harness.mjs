// The console's real-browser tests: the built server (packages/serve/dist, with the console it serves) started as a person
// starts it, and headless Chrome driven through playwright-core, so the page loads with the server's real headers, its CSP,
// its cookies and its redirects. jsdom sees none of those.
//
// The target is a built checkout (this one by default): a flow gets a server of its own from it on loopback with a fresh
// data dir and home, which it removes when it ends. Or the target is a server already running (attachServer): the flows
// that can share one run against it. Nothing waits on a clock: every wait is on the server's output, a selector, or a
// response.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** The one address the servers here listen on, and the pages open: nothing leaves loopback. */
export const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the e2e servers listen on loopback only
/** The same loopback by name: another origin for the same server (a page opened at another address than its own). */
export const LOOPBACK_NAME = "localhost"; // key-gate: loopback-rule the same e2e server by its loopback name

/** The checkout these tests are in: the default target. */
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "../../..");

/** A serve test fixture by its file name (packages/serve/test/fixtures), e.g. the faux model. */
export const fixture = (name, checkout = ROOT) => join(checkout, "packages/serve/test/fixtures", name);

/** The owner's password, for the flows that set one or sign in: one no one uses anywhere, or E2E_PASSWORD for a running
 *  server whose owner is already set. */
export const PASSWORD = process.env.E2E_PASSWORD || ["e2e", "not", "a", "real", "password"].join("-");

/** What a server's output may hold that must never be shown: its API key, any ar_ key, and its setup code. */
const redact = (line) => line.replace(/(AGENTRUN_API_KEY=)\S+/g, "$1<redacted>").replace(/\bar_[A-Za-z0-9_-]+/g, "ar_<redacted>").replace(/([#?&]code=)[^&\s]+/g, "$1<redacted>");

/** Starts the built server from `checkout` on loopback (LOOPBACK), port chosen by the system, with a data dir and home of its own.
 *  Its environment holds only PATH, HOME, TMPDIR and `env` (e.g. AGENTRUN_PUBLIC_URL), so nothing of this machine reaches
 *  it. `faux`: the model fixture (the faux model by default). Resolves once its banner names its URL. Its output stays in
 *  memory: `log()` gives it with keys redacted, `line(re)` waits for a line. With a public URL, `setupCode()` reads the
 *  code setup asks for from that output. */
export async function startServer({ env = {}, faux = "faux-model.mjs", fakes, args = [], port = 0, checkout = ROOT, timeoutMs = 30_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-e2e-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  // `fakes` (startServe's test switches, e.g. { fauxBrowser: "faux-browser.mjs" }, each a fixture): the CLI has no switch
  // for them, so serve-faux.mjs starts the same built server with them, printing the lines read here.
  const command = fakes
    ? [join(HERE, "serve-faux.mjs"), checkout, JSON.stringify({ data: join(dir, "data"), port, ...(faux ? { faux: fixture(faux, checkout) } : {}), ...Object.fromEntries(Object.entries(fakes).map(([k, v]) => [k, fixture(v, checkout)])) })]
    : [join(checkout, "packages/serve/dist/cli.js"), "--data", join(dir, "data"), "--port", String(port), "--listen", LOOPBACK, ...(faux ? ["--faux", fixture(faux, checkout)] : []), ...args];
  const child = spawn(process.execPath, command, {
    env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = new Set();
  const take = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      lines.push(line);
      for (const w of [...waiters]) { const m = w.re.exec(line); if (m) { waiters.delete(w); w.resolve(m); } }
    }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  /** The first line, already printed or to come, that `re` matches; refused when the server exits first or `ms` pass. */
  const line = (re, ms = timeoutMs) => {
    for (const l of lines) { const m = re.exec(l); if (m) return Promise.resolve(m); }
    return new Promise((resolve, reject) => {
      const w = { re, resolve: (m) => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => { waiters.delete(w); reject(new Error(`the server printed no line matching ${re} in ${ms} ms`)); }, ms);
      waiters.add(w);
      void exited.then(({ code, signal }) => { if (waiters.delete(w)) { clearTimeout(timer); reject(new Error(`the server exited (${signal ?? code}) before printing a line matching ${re}`)); } });
    });
  };
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const late = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(late);
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const [, baseUrl] = await line(/^agentrun-serve on (http:\/\/127\.0\.0\.1:\d+\/v2)\b/);
    const server = { baseUrl, origin: baseUrl.replace(/\/v2$/, ""), line, log: () => lines.map(redact).join("\n"), stop };
    // At a public URL, setup takes the code in the link the server prints; kept in memory, never shown.
    if (env.AGENTRUN_PUBLIC_URL) server.setupCode = async () => (await line(/\/setup#code=([^&\s]+)/))[1];
    return server;
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n${lines.map(redact).join("\n")}`);
  }
}

/** A server already running at `url` (its origin, e.g. a QA server or one a person started), as a target. `setupCodeFile`:
 *  a file holding the code its setup asks for (as read from its output), when its owner is not set yet. Nothing is
 *  started or stopped, and its output is not read. */
export function attachServer({ url, setupCodeFile }) {
  const origin = new URL(url).origin;
  return {
    baseUrl: `${origin}/v2`,
    origin,
    attached: true,
    line: () => Promise.reject(new Error("an attached server's output is not read")),
    log: () => "(an attached server: its output is not read here)",
    stop: async () => {},
    ...(setupCodeFile ? { setupCode: async () => readFileSync(setupCodeFile, "utf8").trim() } : {}),
  };
}

/** The server has an owner with `password`: set through the API (POST /v2/setup, with the server's setup code when it has
 *  one) unless it already is. The write names the server's own origin, as its page's would. No browser is signed in. */
export async function owner(server, password = PASSWORD) {
  const session = await fetch(`${server.baseUrl}/auth/session`);
  check(session.ok, `GET /v2/auth/session answered ${session.status}`);
  if ((await session.json()).password_set) return;
  const code = server.setupCode ? await server.setupCode() : undefined;
  const setup = await fetch(`${server.baseUrl}/setup`, { method: "POST", headers: { "content-type": "application/json", origin: server.origin }, body: JSON.stringify({ password, ...(code ? { code } : {}) }) });
  check(setup.ok, `the setup answered ${setup.status}`);
}

/** A /v2 client with the server's token, for the flows that set up or read what the page should show: `api(method, path,
 *  body?)` answers `{ status, body }` (body parsed as JSON when it is). The token is the started server's own (from its
 *  output), or E2E_API_KEY for an attached server; it is never printed. */
export function apiOf(server) {
  let token;
  return async (method, path, body) => {
    token ??= server.attached ? process.env.E2E_API_KEY : await tokenOf(server);
    check(!!token, "this flow calls the API: set E2E_API_KEY for an attached server");
    const response = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON: the text */ }
    return { status: response.status, body: parsed };
  };
}

/** A port free on loopback now: for a flow whose server must know its own address before it starts (its public URL). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, LOOPBACK, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

/** The server's token, from its banner (AGENTRUN_API_KEY=...): in memory only, for a flow that sets up through the API. */
export async function tokenOf(server) {
  const [, token] = await server.line(/^AGENTRUN_API_KEY=(\S+)$/);
  return token;
}

/** Headless Chrome: CHROME_PATH (CI's Chrome for Testing), else E2E_CHROME. */
export async function launchBrowser() {
  const executablePath = process.env.CHROME_PATH || process.env.E2E_CHROME;
  if (!executablePath) throw new Error("Set CHROME_PATH (or E2E_CHROME) to a Chrome or Chrome for Testing binary.");
  return chromium.launch({ executablePath, headless: true });
}

/** A browser context for one flow: only the server's own origin (and data:/blob:) is reached. Any other request is
 *  aborted and recorded in `blocked`, except hosts a flow stubs itself (`allow`: a host name it routes, e.g. github.com). */
export async function newContext(browser, origin, { allow = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const blocked = [];
  const own = new URL(origin).host;
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:" || url.protocol === "blob:" || url.host === own || allow.includes(url.hostname)) return route.fallback();
    blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  return { context, blocked };
}

/** A page that records what went wrong in it: uncaught errors and console errors. */
export async function newPage(context) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`); });
  return { page, errors };
}

/** The first visit's setup, with no public URL (the server is open to set up): the password twice, then the console. */
export async function setUp(page, origin, password = PASSWORD) {
  await page.goto(`${origin}/`);
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Password again").fill(password);
  await page.getByRole("button", { name: "Set password and continue" }).click();
  await signedIn(page);
}

/** Sign in with the owner's password, on a server already set up. */
export async function signIn(page, origin, password = PASSWORD) {
  await page.goto(`${origin}/`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await signedIn(page);
}

/** The console's shell is up: its navigation is on the page and no password field is. */
export async function signedIn(page) {
  await page.getByRole("button", { name: "Mission Control" }).first().waitFor();
  await page.waitForFunction(() => !document.querySelector('input[type="password"]'));
}

/** Throws with `what` unless `ok`. */
export function check(ok, what) {
  if (!ok) throw new Error(what);
}
