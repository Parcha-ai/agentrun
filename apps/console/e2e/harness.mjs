// The console's real-browser tests: the built server (packages/serve/dist, with the console it serves) started as a person
// starts it, and headless Chrome driven through playwright-core, so the page loads with the server's real headers, its CSP,
// its cookies and its redirects. jsdom sees none of those.
//
// The target is a built checkout (this one by default): a flow gets a server of its own from it on loopback with a fresh
// data dir and home, which it removes when it ends. Or the target is a server already running (attachServer): the flows
// that can share one run against it. Nothing waits on a clock: every wait is on the server's output, a selector, or a
// response.
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { constants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** The one address the servers here listen on, and the pages open: nothing leaves loopback. */
export const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule the e2e servers listen on loopback only
/** The same loopback by name: another origin for the same server (a page opened at another address than its own). */
export const LOOPBACK_NAME = "localhost"; // key-gate: loopback-rule the same e2e server by its loopback name

/** The checkout these tests are in: the default target. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/** A serve test fixture by its file name (packages/serve/test/fixtures), e.g. the faux model. */
export const fixture = (name, checkout = ROOT) => join(checkout, "packages/serve/test/fixtures", name);

/** The owner's password, for the flows that set one or sign in: one no one uses anywhere, or E2E_PASSWORD for a running
 *  server whose owner is already set. */
export const PASSWORD = process.env.E2E_PASSWORD || ["e2e", "not", "a", "real", "password"].join("-");

/** What a server's output may hold that must never be shown: its API key, any ar_ key, and its setup code. */
const redact = (line) => line.replace(/(AGENTRUN_API_KEY=)\S+/g, "$1<redacted>").replace(/\bar_[A-Za-z0-9_-]+/g, "ar_<redacted>").replace(/([#?&]code=)[^&\s]+/g, "$1<redacted>");

/** How long a stopped server has to drain and exit before its process group is killed (SIGKILL), and how long it then
 *  has to be gone. */
export const STOP_MS = 10_000;
const KILLED_MS = 5_000;
/** How long the processes a server started have to go once it has exited, before they count as left running. */
const LEFT_MS = 2_000;
/** The servers' process groups not yet stopped, each to its directory: killed, and the directory removed, when this
 *  process exits or is signalled, so no server outlives a run, an interrupted one included. */
const groups = new Map();
const killGroup = (pid) => { try { process.kill(-pid, "SIGKILL"); } catch {} };
const killAll = () => {
  for (const pid of groups.keys()) killGroup(pid);
  for (const dir of groups.values()) try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
};
function started(pid, dir) {
  if (!started.hooked) {
    started.hooked = true;
    process.on("exit", killAll);
    // Signalled: ends as the signal would have (128 + its number), its servers killed on the way out.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => process.exit(128 + constants.signals[signal]));
  }
  groups.set(pid, dir);
}
const ended = (pid) => groups.delete(pid);
/** What is still running in process group `pid` (its server has exited) after up to LEFT_MS: "" when nothing. */
async function leftIn(pid) {
  const alive = () => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
  for (const end = Date.now() + LEFT_MS; alive() && Date.now() < end;) await new Promise((done) => setTimeout(done, 50));
  if (!alive()) return "";
  const ps = spawnSync("ps", ["-o", "pid=,args=", "-g", String(pid)], { encoding: "utf8" });
  return ps.stdout?.trim() || `(process group ${pid})`;
}

/** Starts the built server from `checkout` on loopback (LOOPBACK), port chosen by the system, with a data dir and home of its own.
 *  Its environment holds only PATH, HOME, TMPDIR and `env` (e.g. AGENTRUN_PUBLIC_URL), so nothing of this machine reaches
 *  it. `faux`: the model fixture (the faux model by default); `fauxBrowser`: the browser tool's fake (a fixture, e.g.
 *  faux-browser.mjs), with `faux` only. Resolves once its banner names its URL. Its output stays in
 *  memory: `log()` gives it with keys redacted, `line(re)` waits for a line. With a public URL, `setupCode()` reads the
 *  code setup asks for from that output. */
export async function startServer({ env = {}, faux = "faux-model.mjs", fauxBrowser, args = [], port = 0, checkout = ROOT, timeoutMs = 30_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-e2e-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  const command = [join(checkout, "packages/serve/dist/cli.js"), "--data", join(dir, "data"), "--port", String(port), "--listen", LOOPBACK, ...(faux ? ["--faux", fixture(faux, checkout)] : []), ...(fauxBrowser ? ["--faux-browser", fixture(fauxBrowser, checkout)] : []), ...args];
  // Detached: the server leads a process group of its own, so what it starts can be found, and killed, with it.
  const child = spawn(process.execPath, command, {
    detached: true,
    // No sandbox box: the flows drive the console, and a Docker sandbox needs the computer daemon built (npm run
    // build:daemon, Go) and a Docker daemon. A flow that needs a box sets AGENTRUN_BOXES in its own env.
    env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir(), AGENTRUN_BOXES: "none", AGENTRUN_TELEMETRY: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = [];
  const waiters = new Set();
  const add = (line) => {
    if (!line) return;
    lines.push(line);
    for (const w of [...waiters]) { const m = w.re.exec(line); if (m) { waiters.delete(w); w.resolve(m); } }
  };
  // Each stream's lines, whole: a line split across two chunks waits for its end, and a last line with none is taken at
  // the stream's end.
  const reader = (stream) => {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop() ?? "";
      parts.forEach(add);
    });
    stream.on("end", () => { add(rest); rest = ""; });
  };
  reader(child.stdout);
  reader(child.stderr);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  started(child.pid, dir);

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
  /** Stops it as a person does (SIGTERM: it drains its runs and exits), killing its process group at STOP_MS. Resolves to
   *  its pid and whether it had to be killed (SIGKILL) for the caller to report; refused
   *  when it is still running KILLED_MS after that, when it exits leaving a process of its group running (killed then),
   *  or when its directory cannot be removed: a stop that did not happen is never taken for one that did. */
  const stop = async () => {
    let killed = false;
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const late = setTimeout(() => { killed = true; killGroup(child.pid); }, STOP_MS);
        let unkilled;
        const gone = new Promise((_, reject) => { unkilled = setTimeout(() => reject(new Error(`the server (pid ${child.pid}) was still running ${KILLED_MS} ms after SIGKILL`)), STOP_MS + KILLED_MS); });
        await Promise.race([exited, gone]).finally(() => { clearTimeout(late); clearTimeout(unkilled); });
      }
      const left = await leftIn(child.pid);
      if (left) {
        killGroup(child.pid);
        await leftIn(child.pid);
        throw new Error(`the server exited and left processes of its own running (killed now):\n${left}`);
      }
      ended(child.pid);
      return { pid: child.pid, killed };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    const [, baseUrl] = await line(/^agentrun-serve on (http:\/\/127\.0\.0\.1:\d+\/v2)\b/);
    const server = { baseUrl, origin: baseUrl.replace(/\/v2$/, ""), line, log: () => lines.map(redact).join("\n"), stop };
    // At a public URL (AGENTRUN_PUBLIC_URL, or on Render its RENDER_EXTERNAL_URL), setup takes the code in the link the
    // server prints; kept in memory, never shown.
    if (env.AGENTRUN_PUBLIC_URL || env.RENDER_EXTERNAL_URL) server.setupCode = async () => (await line(/\/setup#code=([^&\s]+)/))[1];
    return server;
  } catch (error) {
    const unstopped = await stop().then(() => "", (e) => `\nand it did not stop: ${e.message}`);
    throw new Error(`${error.message}${unstopped}\n${lines.map(redact).join("\n")}`);
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

/** The ports freePort has given in this process: never one twice, so two flows running at once never get the same one. */
const given = new Set();

/** A port free on loopback now: for a flow whose server must know its own address before it starts (its public URL).
 *  Free when probed, not held: until the server binds it, another flow's server (port 0) or another process can take it.
 *  run.mjs starts such a server again on a new port when its bind finds the port taken (EADDRINUSE). */
export async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, LOOPBACK, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
    if (!given.has(port)) return given.add(port), port;
  }
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

/** The one address the console asks outside its origin: a provider's icon on Settings → Keys, from Google's favicon
 *  service (ProviderIcon.tsx). Answered here with a 1 by 1 PNG, so no flow reaches the network and the page shows an
 *  icon; recorded in `icons` so a flow can say what was asked. Any other path on that host is blocked like the rest. */
const ICON = { origin: "https://www.google.com", path: "/s2/favicons" };
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==", "base64");

/** A browser context for one flow: only the server's own origin (and data:/blob:) is reached, and a provider's icon is
 *  answered here (ICON). Any other request is aborted and recorded in `blocked`, except hosts a flow stubs itself
 *  (`allow`: a host name it routes, e.g. github.com). */
export async function newContext(browser, origin, { allow = [] } = {}) {
  const context = owned(await browser.newContext({ viewport: { width: 1280, height: 900 } }));
  const blocked = [], icons = [];
  const own = new URL(origin).host;
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ICON.origin && url.pathname === ICON.path && route.request().method() === "GET") {
      icons.push({ site: url.searchParams.get("domain"), referer: route.request().headers().referer ?? null });
      return route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
    }
    if (url.protocol === "data:" || url.protocol === "blob:" || url.host === own || allow.includes(url.hostname)) return route.fallback();
    blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    return route.abort();
  });
  return { context, blocked, icons };
}

/** The flow running in this async context (run.mjs sets it around each flow): `{ name, stray(error) }`. */
export const flowScope = new AsyncLocalStorage();

/** The errors a route handler threw, each already handed to its flow's `stray`: run.mjs's unhandledRejection skips them. */
export const strayed = new WeakSet();

const OWNED = Symbol("owned");

/** `target` (a context, or a page) with its route handlers tied to the flow that registers them. Playwright calls a
 *  handler from its connection, outside any flow, and leaves what it throws unhandled; flows run several at once, so the
 *  rejection alone cannot say whose handler it was. Here a handler runs in its flow's async context, and what it throws
 *  fails that flow (its `stray`) before it is thrown on to Playwright as before. A context's pages get the same. */
function owned(target) {
  const flow = flowScope.getStore();
  if (!flow || target[OWNED]) return target;
  target[OWNED] = true;
  const handlers = new WeakMap();
  const tied = (handler) => {
    if (typeof handler !== "function") return handler;
    if (!handlers.has(handler)) handlers.set(handler, AsyncResource.bind(async function (...args) {
      try {
        return await handler.apply(this, args);
      } catch (thrown) {
        const error = thrown instanceof Object ? thrown : new Error(String(thrown));
        strayed.add(error);
        flow.stray(error);
        throw error;
      }
    }));
    return handlers.get(handler);
  };
  const route = target.route.bind(target), unroute = target.unroute.bind(target);
  target.route = (url, handler, options) => route(url, tied(handler), options);
  target.unroute = (url, handler) => unroute(url, handler && tied(handler));
  if (typeof target.newPage === "function") {
    const newPage = target.newPage.bind(target);
    target.newPage = async (...args) => owned(await newPage(...args));
    target.on("page", (page) => flowScope.run(flow, () => owned(page)));
  }
  return target;
}

/** The server's own answer to a GET a flow routes (to change it before the page gets it): `route.fetch`, sent once more
 *  on a connection reset only. Playwright sends it over a kept-alive socket with no idle timer of its own, and the server
 *  closes a socket idle 5 s (+1 s): a request sent just as that timer is due, while the server is busy, finds its
 *  socket closed with the request unread (ECONNRESET, "socket hang up"). Chrome sends such a request again by itself;
 *  route.fetch does not unless asked. Only for an idempotent GET. */
export function serverAnswer(route) {
  return route.fetch({ maxRetries: 1 });
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

/** The "Example data" badge on a shot a person sees outside a test (a PR, a doc, a README): drawn into the page by the
 *  shooting step, in a strip of its own at the top of `box` (a locator) so it never covers the card's words at 390 px, and
 *  on the picture itself, never only in a caption. Not product code: the console never draws it. Idempotent. */
export async function markExample(box) {
  await box.evaluate((el) => {
    if (el.querySelector("[data-example-badge]")) return;
    const row = document.createElement("div");
    row.setAttribute("data-example-badge", "");
    row.style.cssText = "display:flex;justify-content:flex-end;padding:6px 8px 0";
    const badge = document.createElement("span");
    badge.textContent = "Example data";
    badge.style.cssText = "font:600 12px/16px ui-monospace,monospace;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border:1px solid currentColor;background:#fff7d6;color:#7a4b00";
    row.append(badge);
    el.prepend(row);
  });
}
