import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { setDownloadBehavior } from "../dist/providers/browserbase.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { stopWatchingChromeStderr, watchedChromeStderr } from "../dist/providers/chrome-stderr.js";
import { CHROME, commandLine, isRunning, LOCAL_TELEMETRY, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { CHROME_SINGLETON, scratch, scratchShort } from "./fixtures/scratch.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (ref) => Number(/^local:(\d+):/.exec(ref.id)[1]);
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });

test("a local Chrome is created, driven through Stagehand's extension over the provider's attach target, and killed by its exact pid on release", { skip: NO_CHROME, timeout: 90_000 }, async (t) => {
  const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
  const server = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>Loopback Fixture</title><h1>hello</h1>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await scratch(t, "cdp-provider-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] } });
  const signal = new AbortController().signal;
  let ref; let stagehand;
  try {
    ref = await provider.create(spec("cdp-test-1"), signal);
    assert.equal(ref.tag, "cdp-test-1");
    assert.equal(await provider.status(ref), "running");
    const target = await provider.attach(ref);
    assert.match(target.sdkCdpUrl, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//, "the extension dials a debugger URL, so the target is one");
    (await setDownloadBehavior(target.sdkCdpUrl)).close();
    await assert.rejects(setDownloadBehavior(target.sdkCdpUrl.replace(/devtools\/browser\/.*/, "devtools/browser/nope"), { timeoutMs: 2_000 }));
    let browser;
    try {
      browser = await localBrowser.connect({ cdpUrl: target.sdkCdpUrl, ...(target.extensionId ? { extensionId: target.extensionId } : {}) });
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

test("an endpoint provider attaches to a browser the host runs and release leaves it running; a pid it did not start is never signalled", { skip: NO_CHROME, timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-provider-");
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
  const root = await scratch(t, "cdp-setting-");
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
      browser = await localBrowser.connect({ cdpUrl: target.sdkCdpUrl, ...(target.extensionId ? { extensionId: target.extensionId } : {}) });
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

test("a process whose last await is a release exits 0: the wait for Chrome's exit keeps the event loop alive", { skip: NO_CHROME, timeout: 60_000 }, async (t) => {
  const { execFileSync } = await import("node:child_process");
  const root = await scratch(t, "cdp-exit-");
  try {
    const script = `import { cdpProvider } from ${JSON.stringify(new URL("../dist/providers/cdp.js", import.meta.url).href)};
      const p = cdpProvider({ chrome: { executablePath: ${JSON.stringify(CHROME)}, profileRoot: ${JSON.stringify(root)} } });
      const ref = await p.create({ tag: "exit-1", viewport: { width: 800, height: 600 }, metadata: {} }, new AbortController().signal);
      await p.release(ref);`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe", timeout: 50_000 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Chrome that cannot start rejects create with its reason and never raises an unhandled error", async (t) => {
  const root = await scratch(t, "cdp-nochrome-");
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

test("release touches only what its lease made: a path-shaped tag, an id and tag from two leases, or a pid that is not the browser on the recorded port kill and remove nothing; the lease's own release kills its Chrome and removes its profile", { skip: NO_CHROME, timeout: 90_000 }, async (t) => {
  const { spawn } = await import("node:child_process");
  const base = await scratch(t, "cdp-tag-");
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
    // A fresh provider holds no child handle (a release after a restart): a pid that is not the browser on the recorded
    // port is not signalled.
    const restarted = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
    await restarted.release({ id: `local:${bystander.pid}:${port}:legit-lease`, tag: "legit-lease" });
    assert.equal(running(bystander.pid), true, "an unrelated live pid, even with the right port in its lease, is never signalled");
    assert.equal(await restarted.status({ id: `local:${bystander.pid}:${port}:legit-lease`, tag: "legit-lease" }), "gone");
    assert.equal(running(Number(pid)), true);
    assert.ok((await readdir(path.join(root, "legit-lease"))).includes("DevToolsActivePort"), "the profile of the Chrome still running on it is left to that Chrome");
  } finally {
    try { process.kill(-bystander.pid, "SIGKILL"); } catch {}
    if (ref) await provider.release(ref);
  }
  try {
    assert.equal(running(Number(/^local:(\d+):/.exec(ref.id)[1])), false);
    assert.deepEqual((await readdir(root)).sort(), ["legit-lease.downloads", "other-lease"], "its profile is gone; its downloads outlive the release, as a provider's stored downloads do");
    // Chrome already gone (crashed): the profile is still the lease's to remove.
    await mkdir(path.join(root, "crashed-1"));
    await provider.release({ id: "local:999999:1:crashed-1", tag: "crashed-1" });
    assert.deepEqual((await readdir(root)).sort(), ["legit-lease.downloads", "other-lease"]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a lease is recognised without the child handle and without /proc: status and release by a fresh provider work from the pid and the recorded port alone", { skip: NO_CHROME, timeout: 90_000 }, async (t) => {
  const root = await scratch(t, "cdp-restart-");
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

test("a local lease id this provider cannot read is gone, not running; an endpoint lease is running", async (t) => {
  const local = cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: "/nonexistent-root" } });
  assert.equal(await local.status({ id: "local:123:4567", tag: "old-form" }), "gone", "the id form without a tag carries nothing to check");
  assert.equal(await local.status({ id: "local:x", tag: "t" }), "gone");
  assert.equal(await cdpProvider({ endpoint: "http://127.0.0.1:1" }).status({ id: "endpoint:t", tag: "t" }), "running");
});

test("Chrome's sandbox is a knob, never keyed on CI: --no-sandbox only for sandbox: false or PI_BROWSER_NO_SANDBOX=1 when the option is absent; a SIGABRT start with the sandbox on says how to turn it off", async (t) => {
  const root = await scratch(t, "cdp-sandbox-");
  const argvFile = path.join(root, "argv.txt");
  // A stand-in Chrome: records its arguments, then dies the way Chrome does when it cannot start its sandbox, or exits
  // plainly.
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

test("a Chrome that exits before its port opens puts the last lines of what it said in the failure, scrubbed; the sandbox hint comes when the sandbox is on and Chrome aborted or named the sandbox", async (t) => {
  const root = await scratch(t, "cdp-said-");
  const secret = ["sk", "ABCDEFGHIJKLMNOPQRSTUVWX"].join("-");
  // Stand-in Chromes: each writes to stderr, then exits the way its name says.
  const stand = async (name, body) => { const file = path.join(root, name); await writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return file; };
  const sandboxed = await stand("sandbox.sh", `echo '[1:1:ERROR:zygote_host_impl_linux.cc:130] No usable sandbox! If this is a Debian system, install the chromium-sandbox package.' >&2\nexit 1`);
  const other = await stand("other.sh", `i=1; while [ $i -le 14 ]; do echo "gpu line $i" >&2; i=$((i+1)); done\necho 'key ${secret}' >&2\nexit 2`);
  const silent = await stand("silent.sh", "exit 3");
  // sandbox: true is explicit: the host's PI_BROWSER_NO_SANDBOX=1 (the documented container setting) must not turn the sandbox-on cases off.
  const create = (executablePath, tag, chrome = {}) => cdpProvider({ chrome: { executablePath, profileRoot: path.join(root, "p"), sandbox: true, ...chrome } }).create(spec(tag), new AbortController().signal).then(() => null, (error) => error);

  const named = await create(sandboxed, "said-sandbox");
  assert.equal(named?.name, "BrowserFailureError", "a Chrome that exited 1 and named its sandbox is the typed failure");
  assert.deepEqual([named.failure.code, named.failure.retryable, named.failure.effect], ["browser_unavailable", false, "none"]);
  assert.match(named.failure.message, /\(1\)/);
  assert.ok(named.failure.message.includes("No usable sandbox!"), "Chrome's own words are in the failure");
  assert.ok(named.failure.message.includes("sandbox: false") && named.failure.message.includes("PI_BROWSER_NO_SANDBOX=1") && named.failure.message.includes("container"), "and so is how to turn the sandbox off");

  const off = await create(sandboxed, "said-sandbox-off", { sandbox: false });
  assert.ok(off && off.name !== "BrowserFailureError", "with the sandbox already off the sandbox hint is not given");
  assert.ok(off.message.includes("No usable sandbox!") && !off.message.includes("PI_BROWSER_NO_SANDBOX"), "Chrome's words stay, the hint does not");

  const plain = await create(other, "said-other");
  assert.ok(plain && plain.name !== "BrowserFailureError", "another reason is not a sandbox failure");
  assert.match(plain.message, /\(2\)/);
  const lines = plain.message.split("\n").map((line) => line.trim());
  assert.ok(lines.includes("gpu line 14") && lines.includes("gpu line 6") && !lines.includes("gpu line 5"), "the last ten lines of stderr, no more");
  assert.ok(!plain.message.includes(secret) && plain.message.includes("[redacted]"), "a key of a common shape is redacted");
  assert.ok(!plain.message.includes("sandbox"), "no sandbox hint when Chrome's words do not name the sandbox");

  // A key that straddles the 300-character cut, and a key the 4096-byte window starts inside, are redacted whole lines first: the cut must not leave a prefix the shapes no longer match.
  const google = ["AI", "za"].join("") + "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678";
  const longLine = `${"z".repeat(280)} ${google} tail`;
  const first = `${"a".repeat(50)} ${secret} end`;
  const windowStart = first.indexOf(secret) + 12;  // inside the key's body, after its "sk-" prefix
  const pad = "p".repeat(4096 + windowStart - (first.length + 1) - 1);  // the file is 4096 + windowStart bytes, so the last 4096 begin there
  await writeFile(path.join(root, "cut.txt"), `${longLine}\n`);
  await writeFile(path.join(root, "window.txt"), `${first}\n${pad}\n`);
  const cut = await stand("cut.sh", `cat "${path.join(root, "cut.txt")}" >&2\nexit 4`);
  const window = await stand("window.sh", `cat "${path.join(root, "window.txt")}" >&2\nexit 5`);
  // No newline anywhere in the window: one partial line, whose key lost its prefix, so nothing of it is shown.
  await writeFile(path.join(root, "nonl.txt"), `${first}${"p".repeat(4096 + windowStart - first.length)}`);
  const nonl = await stand("nonl.sh", `cat "${path.join(root, "nonl.txt")}" >&2\nexit 6`);
  const nonlError = await create(nonl, "said-nonl");
  assert.ok(!nonlError.message.includes(secret.slice(-12)) && !nonlError.message.includes("Chrome said"), "a window with no newline in it shows nothing, not a partial line");
  const cutError = await create(cut, "said-cut");
  assert.ok(cutError.message.includes("zzzz") && !cutError.message.includes(google.slice(4, 14)), "a Google key the 300-character cut would have split is redacted whole");
  const windowError = await create(window, "said-window");
  assert.ok(!windowError.message.includes(secret.slice(-12)), "a first line the byte window starts inside is dropped, so no suffix of its key shows");

  const quiet = await create(silent, "said-silent");
  assert.ok(quiet && quiet.name !== "BrowserFailureError" && /\(3\)/.test(quiet.message) && !quiet.message.includes("Chrome said"), "a Chrome that said nothing adds nothing");
  const leftover = (await readdir(path.join(root, "p")).catch(() => [])).filter((name) => !name.endsWith(".downloads"));
  assert.deepEqual(leftover.filter((name) => !name.startsWith(".")), [], "no profile is left behind by the failed starts");
});

test("a launch whose spawn throws closes the parent's copy of Chrome's stderr file and leaves no private directory: repeated failed creates leak neither", { skip: process.platform !== "linux" }, async (t) => {
  const root = await scratch(t, "cdp-fd-");
  const fake = path.join(root, "chrome.sh");
  await writeFile(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // An argument with a null byte makes spawn throw at once, before any child exists.
  const provider = cdpProvider({ chrome: { executablePath: fake, profileRoot: path.join(root, "p"), args: ["--bad\0arg"] } });
  const signal = new AbortController().signal;
  const fds = () => readdirSync("/proc/self/fd").length;
  const privates = () => readdirSync(os.tmpdir()).filter((name) => name.startsWith("pib-")).length;
  await provider.create(spec("fd-warm"), signal).catch(() => undefined);
  const [fdsBefore, privatesBefore] = [fds(), privates()];
  for (let i = 0; i < 5; i++) assert.ok(await provider.create(spec(`fd-${i}`), signal).then(() => null, (error) => error), "a spawn that throws rejects the create");
  assert.equal(fds(), fdsBefore, "no descriptor is left open by the failed creates");
  assert.equal(privates(), privatesBefore, "no private directory is left by the failed creates");
});

test("a host that recovers a running Chrome bounds its stderr file too: attach on a lease this host did not start watches the file again", { skip: NO_CHROME, timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-recover-watch-");
  const owner = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
  const ref = await owner.create(spec("recover-watch-1"), new AbortController().signal);
  try {
    assert.ok(watchedChromeStderr() >= 1, "the launching host watches the file once the port is open");
    stopWatchingChromeStderr();
    assert.equal(watchedChromeStderr(), 0);
    const restarted = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root } });
    await restarted.attach(ref);
    assert.equal(watchedChromeStderr(), 1, "the restarted host watches it");
    await restarted.attach(ref);
    assert.equal(watchedChromeStderr(), 1, "a second attach does not add a second timer");
  } finally { stopWatchingChromeStderr(); await owner.release(ref); await rm(root, { recursive: true, force: true }); }
});

test("a real Chrome starts with sandbox: false", { skip: NO_CHROME, timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-nosandbox-");
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: root, sandbox: false } });
  const ref = await provider.create(spec("cdp-nosandbox-1"), new AbortController().signal);
  try {
    assert.equal(await provider.status(ref), "running");
    assert.ok(commandLine(/^local:(\d+):/.exec(ref.id)[1]).includes("--no-sandbox"), "the running Chrome carries the flag");
  } finally { await provider.release(ref); await rm(root, { recursive: true, force: true }); }
});

test("Chrome's singleton socket directory, and everything else it writes to its TMPDIR, is in a private directory of the lease's, which release removes: the host's TMPDIR is as it was", { skip: NO_CHROME, timeout: 60_000 }, async (t) => {
  const root = await scratch(t, "cdp-singleton-");
  const tmp = await scratchShort(t, "single-tmp-");
  const outer = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(() => { process.env.TMPDIR = outer; }, { timeout: 30_000 });
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(root, "profiles") } });
  let ref;
  try { ref = await provider.create(spec("singleton-1"), new AbortController().signal); } catch (error) { if (skipIncapable(t, error)) return; throw error; }
  t.after(() => provider.release(ref).catch(() => undefined), { timeout: 30_000 });
  process.env.TMPDIR = outer;
  const made = await readdir(tmp);
  // The host's TMPDIR holds the lease's private directory and nothing else: Chrome was given that directory as its TMPDIR, so what it makes goes in it.
  assert.equal(made.length, 1, `the TMPDIR Chrome was started under holds one entry: ${made}`);
  assert.match(made[0], /^pib-[A-Za-z0-9]{6}$/);
  const profiles = await readdir(path.join(root, "profiles"));
  const socket = await readlink(path.join(root, "profiles", profiles.find((name) => !name.endsWith(".downloads")), "SingletonSocket"));
  const singleton = path.dirname(socket);
  assert.equal(path.dirname(singleton), path.join(tmp, made[0]), "Chrome's singleton directory is inside the private directory");
  assert.ok(CHROME_SINGLETON.test(path.basename(singleton)), path.basename(singleton));
  await provider.release(ref);
  const left = await readdir(tmp);
  t.diagnostic(`the host's TMPDIR before release: ${made.join(", ")}; after: ${left.join(", ") || "none"}`);
  assert.deepEqual(left, [], "release removed the private directory with the singleton directory in it, and nothing else of Chrome's is left in the host's TMPDIR");
});
