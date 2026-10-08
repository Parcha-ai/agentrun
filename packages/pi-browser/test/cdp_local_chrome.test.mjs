// The cdp provider on a real local Chrome with Stagehand's extension: its own profile and port under TMPDIR, loopback
// pages only, killed by exact pid. Skipped where there is no Chrome.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setDownloadBehavior } from "../dist/providers/browserbase.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, commandLine, isRunning, LOCAL_TELEMETRY, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (ref) => Number(/^local:(\d+):/.exec(ref.id)[1]);
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });

test("a local Chrome is created, driven through Stagehand's extension over the provider's attach target, and killed by its exact pid on release", { skip: NO_CHROME, timeout: 90_000 }, async (t) => {
  const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>Loopback Fixture</title><h1>hello</h1>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-provider-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
  const signal = new AbortController().signal;
  let ref; let stagehand;
  try {
    ref = await provider.create(spec("cdp-test-1"), signal);
    assert.equal(ref.tag, "cdp-test-1");
    assert.equal(await provider.status(ref), "running");
    const target = await provider.attach(ref);
    assert.match(target.sdkCdpUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//, "the extension dials a debugger URL, so the target is one");
    (await setDownloadBehavior(target.sdkCdpUrl)).close(); // the real CDP command Browserbase attach sends, answered by a real Chrome
    await assert.rejects(setDownloadBehavior(target.sdkCdpUrl.replace(/devtools\/browser\/.*/, "devtools/browser/nope"), { timeoutMs: 2_000 }));
    let browser;
    try {
      browser = await localBrowser.connect({ cdpUrl: target.sdkCdpUrl });
      stagehand = await Stagehand.create({ browser, logging: { level: "off" }, telemetry: LOCAL_TELEMETRY });
    } catch (error) { if (skipIncapable(t, error)) return; throw error; }
    const [page] = await browser.context.pages();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await page.title(), "Loopback Fixture");
    assert.equal(await provider.status(ref), "running");
    await stagehand.close().catch(() => undefined);
    stagehand = null;
    assert.deepEqual(await provider.findByTag("cdp-test-1"), [], "a local Chrome is not tag-searchable");
    await provider.release(ref);
    assert.equal(alive(pidOf(ref)), false, "the Chrome this provider started is gone");
    assert.equal(await provider.status(ref), "gone");
    await provider.release(ref);
  } finally {
    await stagehand?.close().catch(() => undefined);
    if (ref && alive(pidOf(ref))) process.kill(-pidOf(ref), "SIGKILL");
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an endpoint provider attaches to a browser the host runs and release leaves it running; a pid it did not start is never signalled", { skip: NO_CHROME, timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-provider-"));
  const owner = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  const signal = new AbortController().signal;
  const started = await owner.create(spec("cdp-test-2"), signal);
  try {
    const port = /^local:\d+:(\d+):/.exec(started.id)[1];
    const endpoint = cdpProvider({ endpoint: `http://127.0.0.1:${port}`, extensionId: "abc" });
    const ref = await endpoint.create(spec("cdp-test-3"), signal);
    const target = await endpoint.attach(ref);
    assert.match(target.sdkCdpUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\//);
    assert.equal(target.extensionId, "abc");
    await endpoint.release(ref);
    assert.equal(alive(pidOf(started)), true, "release of a borrowed browser closes nothing");
    // A lease whose pid now belongs to some other process (a recycled pid) is not signalled.
    await owner.release({ id: `local:${process.pid}:1:x`, tag: "x" });
    assert.equal(alive(process.pid), true);
  } finally {
    await owner.release(started);
    await rm(root, { recursive: true, force: true });
  }
});

test("Browser.setDownloadBehavior lasts as long as the socket that sent it: a download after attach returned lands where the held socket said; once the socket is closed it no longer does", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/f/")) { res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${req.url.slice(3)}"` }); return res.end("payload"); }
    res.setHeader("content-type", "text/html"); res.end('<title>d</title><a id="a" href="/f/held.bin">a</a><a id="b" href="/f/closed.bin">b</a>');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-setting-"));
  const chosen = path.join(root, "chosen");
  await mkdir(chosen);
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
  let ref; let stagehand; let setting;
  const landed = async (dir, name) => { for (const deadline = Date.now() + 10_000; Date.now() < deadline; await new Promise((r) => setTimeout(r, 200))) if ((await readdir(dir).catch(() => [])).includes(name)) return true; return false; };
  try {
    ref = await provider.create({ tag: "cdp-setting-1", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} }, new AbortController().signal);
    const target = await provider.attach(ref);
    setting = await setDownloadBehavior(target.sdkCdpUrl, { downloadPath: chosen });
    assert.equal(setting.open, true);
    let browser;
    try {
      browser = await localBrowser.connect({ cdpUrl: target.sdkCdpUrl });
      stagehand = await Stagehand.create({ browser, logging: { level: "off" }, telemetry: LOCAL_TELEMETRY });
    } catch (error) { if (skipIncapable(t, error)) return; throw error; }
    const [page] = await browser.context.pages();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(() => document.getElementById("a").click());
    assert.equal(await landed(chosen, "held.bin"), true, "a download after attach returned lands in the directory the held socket chose");
    setting.close();
    await new Promise((r) => setTimeout(r, 500));
    await page.evaluate(() => document.getElementById("b").click());
    assert.equal(await landed(chosen, "closed.bin"), false, "with the socket closed the setting is gone: nothing lands in the directory it chose");
  } finally {
    setting?.close();
    await stagehand?.close().catch(() => undefined);
    if (ref) await provider.release(ref);
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a process whose last await is a release exits 0: the wait for Chrome's exit keeps the event loop alive", { skip: NO_CHROME, timeout: 60_000 }, async () => {
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-exit-"));
  try {
    const script = `import { cdpProvider } from ${JSON.stringify(new URL("../dist/providers/cdp.js", import.meta.url).href)};
      const p = cdpProvider({ chrome: { executablePath: ${JSON.stringify(CHROME)}, profileRoot: ${JSON.stringify(root)} } });
      const ref = await p.create({ tag: "exit-1", viewport: { width: 800, height: 600 }, metadata: {} }, new AbortController().signal);
      await p.release(ref);`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe", timeout: 50_000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Chrome that cannot start rejects create with its reason and never raises an unhandled error", async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-nochrome-"));
  const unhandled = [];
  const watch = (error) => unhandled.push(error);
  process.on("uncaughtException", watch);
  try {
    await assert.rejects(cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: root } }).create(spec("cdp-missing-1"), new AbortController().signal), /ENOENT/);
    await assert.rejects(cdpProvider({ chrome: { executablePath: "/bin/false", profileRoot: root } }).create(spec("cdp-exits-1"), new AbortController().signal), /exited before/);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(await readdir(root), [], "a launch that failed leaves no profile behind");
  } finally { process.off("uncaughtException", watch); await rm(root, { recursive: true, force: true }); }
});

test("release touches only what its lease made: a path-shaped tag, an id and tag from two leases, or a pid that is not the browser on the recorded port kill and remove nothing; the lease's own release kills its Chrome and removes its profile", { skip: NO_CHROME, timeout: 90_000 }, async () => {
  const { spawn } = await import("node:child_process");
  const base = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-tag-"));
  const root = path.join(base, "profiles");
  const neighbor = path.join(base, "neighbor");
  await mkdir(root); await mkdir(neighbor); await mkdir(path.join(root, "other-lease"));
  await writeFile(path.join(neighbor, "keep.txt"), "x");
  await writeFile(path.join(root, "other-lease", "Preferences"), "{}");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  const running = isRunning;
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true });
  let ref;
  try {
    await assert.rejects(provider.create(spec("../neighbor"), new AbortController().signal), /one path segment/);
    ref = await provider.create(spec("legit-lease"), new AbortController().signal);
    const [, pid, port] = /^local:(\d+):(\d+):/.exec(ref.id);
    // Its id names one lease and its tag another: neither the Chrome nor any folder is touched.
    await provider.release({ id: ref.id, tag: "other-lease" });
    await provider.release({ id: ref.id, tag: "../neighbor" });
    assert.equal(running(Number(pid)), true, "a mismatched ref kills nothing");
    assert.equal(await readFile(path.join(neighbor, "keep.txt"), "utf8"), "x", "a folder outside the profile root is never removed");
    assert.deepEqual(await readdir(path.join(root, "other-lease")), ["Preferences"], "another lease's profile is never removed");
    // A fresh provider holds no child handle (a release after a restart): a pid that is not the browser on the recorded port is not signalled.
    const restarted = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
    await restarted.release({ id: `local:${bystander.pid}:${port}:legit-lease`, tag: "legit-lease" });
    assert.equal(running(bystander.pid), true, "an unrelated live pid, even with the right port in its lease, is never signalled");
    assert.equal(await restarted.status({ id: `local:${bystander.pid}:${port}:legit-lease`, tag: "legit-lease" }), "gone");
    assert.equal(running(Number(pid)), true);
  } finally {
    try { process.kill(-bystander.pid, "SIGKILL"); } catch { /* gone */ }
    if (ref) await provider.release(ref);
  }
  try {
    // The lease's own release kills its Chrome and removes its own profile only.
    assert.equal(running(Number(/^local:(\d+):/.exec(ref.id)[1])), false);
    assert.deepEqual((await readdir(root)).sort(), ["legit-lease.downloads", "other-lease"], "its profile is gone; its downloads outlive the release, as a provider's stored downloads do");
    // Chrome already gone (crashed): the profile is still the lease's to remove.
    await mkdir(path.join(root, "crashed-1"));
    await provider.release({ id: "local:999999:1:crashed-1", tag: "crashed-1" });
    assert.deepEqual((await readdir(root)).sort(), ["legit-lease.downloads", "other-lease"]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a lease is recognised without the child handle and without /proc: status and release by a fresh provider work from the pid and the recorded port alone", { skip: NO_CHROME, timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-restart-"));
  const owner = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  const ref = await owner.create(spec("restart-1"), new AbortController().signal);
  const pid = Number(/^local:(\d+):/.exec(ref.id)[1]);
  const after = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  try {
    assert.equal(await after.status(ref), "running", "the browser on the recorded port reports the recorded pid");
    assert.equal(await after.status({ id: ref.id.replace(/:\d+:/, ":1:"), tag: ref.tag }), "gone", "a port nothing serves is not the lease");
    await after.release(ref);
    assert.equal(await after.status(ref), "gone");
    assert.throws(() => process.kill(pid, 0), "the process is gone");
    assert.deepEqual(await readdir(root), ["restart-1.downloads"], "its profile is removed (its downloads outlive the release)");
  } finally { await owner.release(ref); await rm(root, { recursive: true, force: true }); }
});

test("a local lease id this provider cannot read is gone, not running; an endpoint lease is running", async () => {
  const local = cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: "/nonexistent-root" } });
  assert.equal(await local.status({ id: "local:123:4567", tag: "old-form" }), "gone", "the id form without a tag carries nothing to check");
  assert.equal(await local.status({ id: "local:x", tag: "t" }), "gone");
  assert.equal(await cdpProvider({ endpoint: "http://127.0.0.1:1" }).status({ id: "endpoint:t", tag: "t" }), "running");
});

test("Chrome's sandbox is a knob, never keyed on CI: --no-sandbox only for sandbox: false or PI_BROWSER_NO_SANDBOX=1 when the option is absent; a SIGABRT start with the sandbox on says how to turn it off", async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-sandbox-"));
  const argvFile = path.join(root, "argv.txt");
  // A stand-in Chrome: records its arguments, then dies the way Chrome does when it cannot start its sandbox, or exits plainly.
  const fake = path.join(root, "chrome.sh");
  await writeFile(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argvFile}"\nif [ "$FAKE_CHROME_EXIT" = abort ]; then kill -ABRT $$; fi\nexit 3\n`, { mode: 0o755 });
  const saved = { no: process.env.PI_BROWSER_NO_SANDBOX, exit: process.env.FAKE_CHROME_EXIT, ci: process.env.CI };
  const argv = async () => (await readFile(argvFile, "utf8")).split("\n");
  const create = (chrome, tag) => cdpProvider({ chrome: { executablePath: fake, profileRoot: path.join(root, "p"), ...chrome } }).create(spec(tag), new AbortController().signal);
  try {
    process.env.FAKE_CHROME_EXIT = "plain"; delete process.env.PI_BROWSER_NO_SANDBOX; process.env.CI = "true";
    await assert.rejects(create({}, "sb-default"), /exited before/);
    assert.equal((await argv()).includes("--no-sandbox"), false, "the sandbox stays on by default, even on CI");
    await assert.rejects(create({ sandbox: false }, "sb-off"), /exited before/);
    const off = await argv();
    assert.equal(off.includes("--no-sandbox"), true, "sandbox: false adds the flag");
    assert.ok(off.indexOf("--no-sandbox") < off.indexOf("about:blank"));
    process.env.PI_BROWSER_NO_SANDBOX = "1";
    await assert.rejects(create({}, "sb-env"), /exited before/);
    assert.equal((await argv()).includes("--no-sandbox"), true, "the environment turns it off when the option is absent");
    await assert.rejects(create({ sandbox: true }, "sb-explicit"), /exited before/);
    assert.equal((await argv()).includes("--no-sandbox"), false, "an explicit sandbox: true wins over the environment");
    process.env.PI_BROWSER_NO_SANDBOX = "0";
    await assert.rejects(create({}, "sb-zero"), /exited before/);
    assert.equal((await argv()).includes("--no-sandbox"), false, "only 1 turns it off");

    delete process.env.PI_BROWSER_NO_SANDBOX; process.env.FAKE_CHROME_EXIT = "abort";
    const typed = await create({}, "sb-abort").then(() => null, (error) => error);
    assert.equal(typed?.name, "BrowserFailureError");
    assert.deepEqual([typed.failure.code, typed.failure.retryable, typed.failure.effect], ["browser_unavailable", false, "none"]);
    assert.ok(typed.failure.message.includes("sandbox: false") && typed.failure.message.includes("PI_BROWSER_NO_SANDBOX=1"), "the failure names both ways to turn the sandbox off");
    const plain = await create({ sandbox: false }, "sb-abort-off").then(() => null, (error) => error);
    assert.ok(plain && plain.name !== "BrowserFailureError", "an abort with the sandbox already off is not a sandbox failure");
  } finally {
    for (const [key, name] of [["no", "PI_BROWSER_NO_SANDBOX"], ["exit", "FAKE_CHROME_EXIT"], ["ci", "CI"]]) { if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key]; }
    await rm(root, { recursive: true, force: true });
  }
});

test("a real Chrome starts with sandbox: false", { skip: NO_CHROME, timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "cdp-nosandbox-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, sandbox: false } });
  const ref = await provider.create(spec("cdp-nosandbox-1"), new AbortController().signal);
  try {
    assert.equal(await provider.status(ref), "running");
    assert.ok(commandLine(/^local:(\d+):/.exec(ref.id)[1]).includes("--no-sandbox"), "the running Chrome carries the flag");
  } finally { await provider.release(ref); await rm(root, { recursive: true, force: true }); }
});
