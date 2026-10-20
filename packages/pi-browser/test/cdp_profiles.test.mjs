import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { chmod, lstat, mkdir, open, readdir, readFile, readlink, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cdpProvider, closeGracefully, copyProfile, ProfileNotRemovedError } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME } from "./fixtures/local-chrome.mjs";
import { processesNaming, scratch, scratchShort } from "./fixtures/scratch.mjs";
import { startSite } from "./fixtures/site.mjs";

const spec = (tag, profile, metadata = { run: "r1", label: "a" }) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata, ...(profile ? { profile } : {}) });
const signal = () => new AbortController().signal;
/** SIGKILLs a lease's Chrome and waits until the process is gone, reaped: the provider sees a lease whose child handle has not exited as still running, and a
 *  Chrome's teardown takes well over a fixed sleep when the box is loaded, so a replacement asked for too early is refused as a second saver. */
async function crash(t, ref) {
  const pid = Number(/^local:(\d+):/.exec(ref.id)[1]);
  const started = Date.now();
  process.kill(pid, "SIGKILL");
  for (const end = started + 30_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 25))) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") { t.diagnostic(`the killed Chrome was gone after ${Date.now() - started} ms`); return; } }
  }
  throw new Error(`pid ${pid} still exists 30 s after SIGKILL`);
}
const get = (url, headers) => new Promise((resolve, reject) => { http.get(url, { headers }, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject); });
// A stranger on the host: a port prober sends GET / with Go's HTTP client to every new loopback listener, with no Sec-Fetch-*
// headers. A test that counts what reached its site counts only the browser's requests.
const stranger = (base) => get(`${base}/`, { "user-agent": "Go-http-client/1.1" });
/** The requests a browser sent: a browser sends Sec-Fetch-Dest to 127.0.0.1, while a port prober and Node's fetch do not. */
const browserRequests = (site) => site.requests.filter((r) => Boolean(r.dest));

async function evaluate(pageWs, expression) {
  const ws = new WebSocket(pageWs);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("page socket")); });
  const answer = new Promise((resolve) => { ws.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id === 1) resolve(message); }; });
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  const message = await answer;
  ws.close();
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.equal(message.result.exceptionDetails, undefined, JSON.stringify(message.result.exceptionDetails?.exception?.description ?? message.result.exceptionDetails));
  return message.result.result.value;
}

async function rig(t) {
  const site = await startSite();
  const root = await scratch(t, "cdp-profiles-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
  t.after(() => site.close(), { timeout: 30_000 });
  let n = 0;
  const run = async (profile, work) => {
    const ref = await provider.create(spec(`cdp-prof-${process.pid}-${n += 1}`, profile), signal());
    try {
      const port = new URL((await provider.attach(ref)).sdkCdpUrl).port;
      const open = async (pathname) => {
        const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(site.base + pathname)}`, { method: "PUT" })).json();
        // The tab is read once its navigation has committed to the site (its own URL names the requested page earlier): a page
        // still on about:blank would run a sign-in's fetch against nothing.
        for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 50))) {
          if (await evaluate(tab.webSocketDebuggerUrl, `location.origin === ${JSON.stringify(new URL(site.base).origin)} && document.readyState !== "loading"`).catch(() => false)) break;
        }
        return tab.webSocketDebuggerUrl;
      };
      return await work({ open, ref });
    } finally { await provider.release(ref); }
  };
  const signIn = (user) => ({ open }) => open("/login").then((ws) => evaluate(ws, `fetch("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "user=${user}&password=x", credentials: "include" }).then((r) => r.status)`));
  const account = async ({ open }) => {
    const before = browserRequests(site).length;
    const ws = await open("/account");
    const heading = await evaluate(ws, `new Promise((done) => { const end = Date.now() + 15000; const look = () => (document.querySelector("h1") || Date.now() > end ? done(document.querySelector("h1")?.textContent ?? "") : setTimeout(look, 50)); look(); })`);
    return { heading, cookie: browserRequests(site).slice(before).find((r) => r.path === "/account")?.cookie ?? null };
  };
  return { site, root, provider, run, signIn, account };
}

test("a profile saved in session 1 signs in session 2; a session with another profile or none does not", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { run, signIn, account } = await rig(t);
  await run({ name: "work", save: true }, signIn("ann"));
  assert.equal((await run({ name: "work", save: true }, account)).heading, "Signed in as ann", "the saved profile is signed in");
  assert.equal((await run({ name: "other", save: true }, account)).heading, "Signed out", "another profile is its own identity");
  assert.equal((await run(undefined, account)).heading, "Signed out", "no profile is a fresh browser");
});

test("a SESSION cookie (no Expires) set in session 1 on a saved profile is sent in session 2: Chrome restores the session on startup", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { run, account } = await rig(t);
  const signInForTheSession = ({ open }) => open("/login").then((ws) => evaluate(ws, `fetch("/login?session=1", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "user=ann&password=x", credentials: "include" }).then((r) => r.status)`));
  await run({ name: "sess", save: true }, signInForTheSession);
  const second = await run({ name: "sess", save: true }, account);
  assert.equal(second.heading, "Signed in as ann", "the session cookie came back with the profile");
  assert.match(second.cookie ?? "", /sid=ann/);
  assert.equal((await run({ name: "sess-other", save: true }, account)).heading, "Signed out", "another profile does not have it");
  assert.equal((await run(undefined, account)).heading, "Signed out", "no profile does not have it");
});

test("a saved profile's next session opens only the startup page: the previous tabs are not restored, so no old URL is requested before the driver is attached; a session with no profile has one page too", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { run, provider, site } = await rig(t);
  const { stagehandDriver } = await import("../dist/driver/stagehand.js");
  // Session 1 leaves two pages open when it is released (Chrome writes its tab-restore files as it closes).
  await run({ name: "tabs", save: true }, async ({ open }) => { await open("/a"); await open("/b"); });
  // Chrome's own requests carry Sec-Fetch-Dest, so counting the browser's requests would see a restored tab.
  for (const page of ["/a", "/b"]) assert.ok(browserRequests(site).some((r) => r.path === page), `session 1's ${page} is counted as the browser's`);
  const pagesOf = async (target) => { const port = new URL(target.sdkCdpUrl).port; return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((x) => x.type === "page").map((x) => x.url.replace(site.base, "")); };
  const before = browserRequests(site).length;
  const beforeAny = site.requests.length;

  const ref = await provider.create(spec(`cdp-prof-${process.pid}-r`, { name: "tabs", save: true }), signal());
  try {
    const target = await provider.attach(ref);
    // A stranger's GET / lands while the page set is watched: it is not the browser's, so it is not an old URL reloaded.
    await stranger(site.base);
    // Chrome restores tabs a moment after it starts: the page set is watched for as long as a restore would take.
    const seen = new Set();
    for (const end = Date.now() + 4_000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) for (const url of await pagesOf(target)) seen.add(url);
    assert.deepEqual([...seen], ["about:blank"], `only the startup page ever exists: ${JSON.stringify([...seen])}`);
    assert.deepEqual(browserRequests(site).slice(before).map((r) => r.path), [], "no browser request reached the site before anything asked for one: no old URL was reloaded");
    const after = site.requests.slice(beforeAny);
    assert.deepEqual(after.filter((r) => r.path === "/a" || r.path === "/b").map((r) => r.path), [], "nothing, from any client, asked for an old page");
    assert.ok(after.some((r) => r.path === "/" && !r.dest), "the stranger's GET / reached the site and was not counted");
    const driver = await stagehandDriver()(target, signal());
    try { assert.equal(await driver.url(), "about:blank", "the driver starts on a blank page"); } finally { await driver.close(); }
  } finally { await provider.release(ref); }

  const plain = await provider.create(spec(`cdp-prof-${process.pid}-p`, undefined), signal());
  try {
    assert.deepEqual(await pagesOf(await provider.attach(plain)), ["about:blank"], "no profile: one blank page, as before");
  } finally { await provider.release(plain); }
});

test("the site's browser requests leave out a stranger's GET /: a port prober and Node's fetch are not counted, a request with Sec-Fetch-Dest is", async (t) => {
  const site = await startSite();
  t.after(() => site.close(), { timeout: 30_000 });
  await stranger(site.base);
  await fetch(`${site.base}/`).then((r) => r.arrayBuffer());
  await get(`${site.base}/a`, { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" });
  assert.ok(site.requests.filter((r) => r.path === "/").length >= 2 && site.requests.some((r) => r.path === "/a"), "all three reached the site");
  assert.deepEqual(browserRequests(site).map((r) => r.path), ["/a"], "only the request a browser sends is counted");
});

test("a session that does not save starts from the saved state and leaves it as it was",{ skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { run, signIn, account } = await rig(t);
  await run({ name: "work", save: true }, signIn("ann"));
  const during = await run({ name: "work", save: false }, async (session) => {
    const first = await account(session);
    await signIn("mallory")(session);
    return { first, second: await account(session) };
  });
  assert.equal(during.first.heading, "Signed in as ann", "it starts from the saved sign-in");
  assert.equal(during.second.heading, "Signed in as mallory", "and works with its own changes");
  assert.equal((await run({ name: "work", save: true }, account)).heading, "Signed in as ann", "which are not kept");
});

test("release keeps the saved directory, removes the lease's own link and leaves no stray directory", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { root, run, signIn } = await rig(t);
  await run({ name: "work", save: true }, signIn("ann"));
  assert.ok((await lstat(path.join(root, ".profiles", "work"))).isDirectory(), "the profile is still there");
  const left = (await readdir(root)).filter((name) => name !== ".profiles");
  assert.deepEqual(left.filter((name) => !name.endsWith(".downloads")), [], `no per-lease directory or link survives the release (left: ${left.join(", ")})`);
});

test("a second session saving to a profile already being saved is refused; one that does not save is not", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { provider, run, account } = await rig(t);
  await run({ name: "work", save: true }, async () => {
    await assert.rejects(provider.create(spec(`cdp-prof-${process.pid}-w2`, { name: "work", save: true }, { run: "r2", label: "b" }), signal()), (error) => error.failure?.code === "refused" && /one session at a time/.test(error.failure.message));
    assert.equal((await run({ name: "work", save: false }, account)).heading, "Signed out", "a reader is allowed, from whatever was saved when it started");
  });
});

test("a relaunch waits for the old session; a crashed Chrome, a failed start and a relative profile root do not block or break a profile", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const { root, provider, run, signIn, account } = await rig(t);
  await run({ name: "work", save: true }, signIn("ann"));

  const old = await provider.create(spec(`cdp-prof-${process.pid}-old`, { name: "work", save: true }), signal());
  const next = provider.create(spec(`cdp-prof-${process.pid}-new`, { name: "work", save: true }), signal());
  setTimeout(() => { void provider.release(old); }, 400);
  const replacement = await next;
  assert.ok(replacement.id, "the same owner's replacement waited for the release");
  await provider.release(replacement);

  const doomed = await provider.create(spec(`cdp-prof-${process.pid}-doomed`, { name: "work", save: true }), signal());
  process.kill(Number(/^local:(\d+):/.exec(doomed.id)[1]), "SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  const after = await provider.create(spec(`cdp-prof-${process.pid}-after`, { name: "work", save: true }, { run: "r9", label: "z" }), signal());
  assert.ok(after.id, "a Chrome that died is not a writer any more");
  await provider.release(after);
  // Custody releases a crashed browser's lease too; it holds the lease's private TMPDIR until then.
  await provider.release(doomed, signal());

  await mkdir(path.join(root, ".profiles", "broken", "Default", "Preferences"), { recursive: true });
  await assert.rejects(provider.create(spec(`cdp-prof-${process.pid}-bad`, { name: "broken", save: true }), signal()));
  assert.deepEqual((await readdir(root)).filter((name) => name.includes("-bad") && !name.endsWith(".downloads")), [], "a start that failed leaves no link");
  await rm(path.join(root, ".profiles", "broken", "Default", "Preferences"), { recursive: true });
  const fixed = await provider.create(spec(`cdp-prof-${process.pid}-fixed`, { name: "broken", save: true }, { run: "r8", label: "y" }), signal());
  assert.ok(fixed.id, "and the profile is not held by it");
  await provider.release(fixed);

  const relative = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.relative(process.cwd(), root), args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
  const viaRelative = await relative.create(spec(`cdp-prof-${process.pid}-rel`, { name: "work", save: true }), signal());
  await relative.release(viaRelative);
  assert.equal((await run({ name: "work", save: true }, account)).heading, "Signed in as ann", "a relative profile root keeps the same saved directory");
});

test("copying a profile another Chrome is writing skips what vanishes and keeps what stays, links included, without Chrome's locks", async (t) => {
  const root = await scratch(t, "cdp-copy-");
  const from = path.join(root, "from");
  const files = [];
  for (let d = 0; d < 12; d += 1) {
    await mkdir(path.join(from, `dir${d}`), { recursive: true });
    for (let f = 0; f < 60; f += 1) files.push(path.join(from, `dir${d}`, `file${f}`));
  }
  await Promise.all(files.map((file, i) => writeFile(file, `content ${i}`)));
  const keep = path.join(from, "kept");
  await writeFile(keep, "stays");
  await symlink("kept", path.join(from, "link"));
  await writeFile(path.join(from, "SingletonLock"), "x");
  await writeFile(path.join(from, "DevToolsActivePort"), "x");

  const copied = copyProfile(from, path.join(root, "to"));
  // Chrome's journals and temp files go while the copy walks: all of the numbered files here.
  await Promise.all(files.map((file) => rm(file, { force: true })));
  await copied;

  assert.equal(await readFile(path.join(root, "to", "kept"), "utf8"), "stays");
  assert.equal(await readlink(path.join(root, "to", "link")), "kept", "a link stays a link");
  assert.deepEqual((await readdir(path.join(root, "to"))).filter((name) => /^(Singleton|DevToolsActivePort)/.test(name)), [], "Chrome's own lock files are not copied");
});

test("a Chrome that takes the debugging connection and never answers fails the start at its deadline, and release leaves nothing running", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-mute-");
  const mute = path.join(root, "mute-chrome.mjs");
  // Writes the port file Chrome writes, then holds every connection open without a byte.
  await writeFile(mute, `#!${process.execPath}
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
const dir = process.argv.find((a) => a.startsWith("--user-data-dir=")).slice(16);
const server = net.createServer(() => {});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(path.join(dir, "DevToolsActivePort"), server.address().port + "\\n/devtools/browser/mute\\n"));
setInterval(() => {}, 1000);
`);
  await chmod(mute, 0o755);
  const provider = cdpProvider({ chrome: { executablePath: mute, profileRoot: path.join(root, "profiles"), sandbox: false } });
  const started = Date.now();
  await assert.rejects(provider.create(spec(`cdp-mute-${process.pid}`), signal()), /did not open its debugging port/);
  assert.ok(Date.now() - started < 40_000, `the start gave up at its own deadline (took ${Date.now() - started} ms)`);
  assert.deepEqual(processesNaming(root).filter((p) => p.pid !== process.pid), [], "the failed start left no process");
});

test("a file Chrome truncates while it is copied ends the copy where the file ends", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-shrink-");
  const from = path.join(root, "from");
  await mkdir(from);
  // Mostly a hole, so the copy takes long enough for the truncation to land inside it.
  const big = await open(path.join(from, "journal"), "w");
  await big.write(Buffer.alloc(1 << 20, 1), 0, 1 << 20, 3 * 1024 ** 3);
  await big.close();
  const copied = copyProfile(from, path.join(root, "to"));
  setTimeout(() => void truncate(path.join(from, "journal"), 0), 30);
  await Promise.race([copied, new Promise((_, reject) => setTimeout(() => reject(new Error("the copy of a truncated file did not end")), 30_000).unref())]);
  assert.ok((await lstat(path.join(root, "to", "journal"))).size < 3 * 1024 ** 3, "what was read before the truncation is all there is");
});

test("a copy cut short by a cancelled create leaves no directory and starts no Chrome, and the copy stops at once instead of finishing", { timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-cancel-");
  const marker = path.join(root, "spawned");
  const chrome = path.join(root, "chrome.mjs");
  await writeFile(chrome, `#!${process.execPath}\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "started");\nsetInterval(() => {}, 1000);\n`);
  await chmod(chrome, 0o755);
  const profiles = path.join(root, "profiles");
  await mkdir(path.join(profiles, ".profiles", "work", "Default"), { recursive: true });
  // Mostly a hole, so a full copy takes seconds and the cancellation lands inside it.
  const big = await open(path.join(profiles, ".profiles", "work", "Default", "History"), "w");
  await big.write(Buffer.alloc(1 << 20, 1), 0, 1 << 20, 2 * 1024 ** 3);
  await big.close();
  const provider = cdpProvider({ chrome: { executablePath: chrome, profileRoot: profiles, sandbox: false } });
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 150);
  const started = Date.now();
  await assert.rejects(provider.create(spec(`cdp-cancel-${process.pid}`, { name: "work", save: false }), abort.signal), (error) => error.name === "AbortError");
  assert.ok(Date.now() - started < 3_000, `the copy stopped when cancelled (took ${Date.now() - started} ms)`);
  assert.deepEqual((await readdir(profiles)).filter((name) => name !== ".profiles"), [], "the partial copy is gone");
  assert.equal(await stat(marker).then(() => true, () => false), false, "no Chrome was started after the cancellation");
});

test("a saved profile's Chrome that takes the connection and never answers does not hold the release before its kill", { timeout: 60_000 }, async (t) => {
  const mute = net.createServer(() => {});
  await new Promise((resolve) => mute.listen(0, "127.0.0.1", resolve));
  t.after(() => mute.close(), { timeout: 30_000 });
  const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((resolve) => gone.once("exit", resolve));
  const started = Date.now();
  await closeGracefully(mute.address().port, gone.pid, new Map());
  assert.ok(Date.now() - started < 8_000, `closeGracefully returned (took ${Date.now() - started} ms)`);
});

test("a failed start that cannot remove a reader's copy of the saved cookies says so, naming the directory, with the start's own failure kept", { skip: NO_CHROME, timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-leftcopy-");
  // A Preferences that is a directory: the copy takes it along, and writing the lease's download settings into it fails the start.
  await mkdir(path.join(root, ".profiles", "work", "Default", "Preferences"), { recursive: true });
  let dirOf = "";
  const remove = async (dir, options) => { if (dir.endsWith(dirOf)) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); return rm(dir, options); };
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, headless: true, sandbox: false } }, { remove });
  dirOf = `${path.sep}cdp-leftcopy-${process.pid}`;
  await assert.rejects(provider.create(spec(`cdp-leftcopy-${process.pid}`, { name: "work", save: false }), signal()), (error) => {
    assert.ok(error instanceof ProfileNotRemovedError, `${error?.name}: ${error?.message}`);
    assert.ok(error.dirs.some((d) => d.endsWith(dirOf)), `names the directory: ${error.dirs}`);
    assert.ok(error.original, "the start's own failure is kept");
    return true;
  });
});

test("a saved lease released while the Chrome that replaced it runs on the same profile removes its own link and private TMPDIR, and touches nothing the replacement holds", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const outer = process.env.TMPDIR;
  const tmp = await scratchShort(t, "lease-tmp-");
  process.env.TMPDIR = tmp;
  t.after(() => { if (outer === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = outer; }, { timeout: 30_000 });
  const root = await scratch(t, "cdp-leases-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, headless: true, sandbox: false, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
  const privateTmps = async () => (await readdir(tmp)).filter((name) => /^pib-/.test(name));
  const crashed = await provider.create(spec(`cdp-crashed-${process.pid}`, { name: "work", save: true }), signal());
  await crash(t, crashed);
  const replacement = await provider.create(spec(`cdp-replacement-${process.pid}`, { name: "work", save: true }, { run: "r2", label: "b" }), signal());
  assert.equal((await privateTmps()).length, 2, "each lease has its own private TMPDIR");
  await provider.release(crashed, signal());
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("cdp-crashed") && !name.endsWith(".downloads")), [], "the crashed lease's link is gone (its downloads folder stays, as for any release)");
  assert.equal((await privateTmps()).length, 1, "and so is its private TMPDIR: only the replacement's is left");
  assert.equal(await provider.status(replacement), "running", "the replacement still runs");
  assert.ok((await lstat(path.join(root, ".profiles", "work"))).isDirectory(), "the saved profile is intact");
  assert.ok((await lstat(path.join(root, `cdp-replacement-${process.pid}`))).isSymbolicLink(), "and the replacement's link");
  await provider.release(replacement, signal());
  assert.equal((await privateTmps()).length, 0);
});

test("a crashed saved lease released through a provider made after the crash removes its own private TMPDIR, though a replacement has taken the profile's marker", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const outer = process.env.TMPDIR;
  const tmp = await scratchShort(t, "lease-tmp-");
  process.env.TMPDIR = tmp;
  t.after(() => { if (outer === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = outer; }, { timeout: 30_000 });
  const root = await scratch(t, "cdp-leases-");
  const options = { chrome: { executablePath: CHROME, profileRoot: root, headless: true, sandbox: false, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } };
  const privateTmps = async () => (await readdir(tmp)).filter((name) => /^pib-/.test(name));
  // The provider that made the lease is gone with its process: its in-memory record of the lease's TMPDIR went with it.
  const crashed = await cdpProvider(options).create(spec(`cdp-crashed-${process.pid}`, { name: "work", save: true }), signal());
  await crash(t, crashed);
  const later = cdpProvider(options);
  const replacement = await later.create(spec(`cdp-replacement-${process.pid}`, { name: "work", save: true }, { run: "r2", label: "b" }), signal());
  assert.equal((await privateTmps()).length, 2, "each lease has its own private TMPDIR");
  await later.release(crashed, signal());
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("cdp-crashed") && !name.endsWith(".downloads")), [], "the crashed lease's link is gone");
  assert.equal((await privateTmps()).length, 1, "and so is its private TMPDIR: only the replacement's is left");
  assert.equal(await later.status(replacement), "running", "the replacement still runs");
  const records = async () => (await readdir(path.join(root, ".profiles", ".leases")).catch(() => [])).sort();
  assert.deepEqual(await records(), [`cdp-replacement-${process.pid}`], "the crashed lease's record went with its release");
  await later.release(replacement, signal());
  assert.equal((await privateTmps()).length, 0);
  assert.deepEqual(await records(), [], "and the replacement's with its own");
});

test("a crashed saved lease whose replacement crashed too is released by a provider made after both, and its private TMPDIR goes with it", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const outer = process.env.TMPDIR;
  const tmp = await scratchShort(t, "lease-tmp-");
  process.env.TMPDIR = tmp;
  t.after(() => { if (outer === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = outer; }, { timeout: 30_000 });
  const root = await scratch(t, "cdp-leases-");
  const options = { chrome: { executablePath: CHROME, profileRoot: root, headless: true, sandbox: false, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } };
  const privateTmps = async () => (await readdir(tmp)).filter((name) => /^pib-/.test(name));
  const crashed = await cdpProvider(options).create(spec(`cdp-crashed-${process.pid}`, { name: "work", save: true }), signal());
  await crash(t, crashed);
  const replacement = await cdpProvider(options).create(spec(`cdp-replacement-${process.pid}`, { name: "work", save: true }, { run: "r2", label: "b" }), signal());
  await crash(t, replacement);
  assert.equal((await privateTmps()).length, 2, "each lease made its own private TMPDIR");
  // The profile's marker now names the replacement's directory: the crashed lease's is found only by its own record.
  const later = cdpProvider(options);
  await later.release(crashed, signal());
  assert.equal((await privateTmps()).length, 1, "the crashed lease's private TMPDIR is gone, the other lease's is not touched");
  await later.release(replacement, signal());
  assert.equal((await privateTmps()).length, 0);
  assert.deepEqual((await readdir(path.join(root, ".profiles", ".leases"))).sort(), [], "no record is left");
});
