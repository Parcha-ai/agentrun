// Integration: real Stagehand 4.1.0 on a real local Chrome with its own profile. Chrome resolves example.com
// (Stagehand's default trace endpoint, which its in-browser runtime posts to) to a local TLS trap; the driver's
// Stagehand (`stagehandDriver`, created sealed) must leave the trap silent while a bare create, on the same rig, reaches
// it. Without Chrome or openssl, or with a Chrome that cannot load Stagehand's extension, the test skips with that
// reason; AGENTRUN_REQUIRE_LOCAL_CHROME=1 turns each of those into a failure.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { CHROME, NO_CHROME, REQUIRED, skipIncapable } from "./fixtures/local-chrome.mjs";

const HAS_OPENSSL = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const SKIP = NO_CHROME || (!REQUIRED && !HAS_OPENSSL ? "needs openssl" : false);

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** Stagehand as its default creates it, on the launched browser: the control. */
async function bare(Stagehand, browser, pageUrl) {
  const stagehand = await Stagehand.create({ browser, logging: { level: "off" } });
  const page = await stagehand.browser.context.activePage();
  await page.goto(pageUrl);
  await page.locator("input").fill("typed value");
  return () => stagehand.close();
}

/** The driver's own Stagehand, attached to the launched browser through its CDP endpoint, driven by page code. */
async function viaDriver(_Stagehand, _browser, pageUrl, debugPort) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  const driver = await stagehandDriver()({ sdkCdpUrl: webSocketDebuggerUrl }, new AbortController().signal, { batchTimeoutMs: 30_000 });
  await driver.run({ code: `await page.goto(${JSON.stringify(pageUrl)}); await page.locator("input").fill("typed value"); return 1;` });
  return () => driver.close();
}

async function exportsFor(drive) {
  const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "stagehand-telemetry-"));
  const cleanups = [() => rm(dir, { recursive: true, force: true })];
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=example.com", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
    let posts = 0;
    const trap = https.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }, (req, res) => {
      req.resume(); req.on("end", () => { if (req.method === "POST" && req.url === "/v1/traces") posts += 1; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    });
    const page = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>t</title><input name=q><button>go</button>"); });
    cleanups.unshift(() => trap.close(), () => page.close());
    const [trapPort, pagePort, debugPort] = [await listen(trap), await listen(page), await freePort()];
    const { Stagehand, localBrowser } = await import("@browserbasehq/stagehand");
    const browser = await localBrowser.launch({
      headless: true, executablePath: CHROME, userDataDir: path.join(dir, "profile"), port: debugPort, ignoreHTTPSErrors: true,
      args: [`--host-resolver-rules=MAP example.com 127.0.0.1:${trapPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`],
    });
    cleanups.unshift(() => browser.close());
    cleanups.unshift(await drive(Stagehand, browser, `http://127.0.0.1:${pagePort}/`, debugPort));
    for (let waited = 0; waited < 12_000 && !(drive === bare && posts > 0); waited += 250) await new Promise((r) => setTimeout(r, 250));
    return posts;
  } finally {
    for (const cleanup of cleanups) await Promise.resolve().then(cleanup).catch(() => undefined);
  }
}

test("Stagehand's default exports its trace to example.com; the driver's sealed Stagehand keeps it on this host", { skip: SKIP, timeout: 120_000 }, async (t) => {
  let control;
  try { control = await exportsFor(bare); } catch (error) {
    // A Chrome that refuses to load an unpacked extension cannot run Stagehand at all, so it proves nothing either way.
    if (skipIncapable(t, error)) return;
    throw error;
  }
  assert.ok(control > 0, "control: the default reaches the example.com trap, so the rig can see an export");
  assert.equal(await exportsFor(viaDriver), 0, "the driver's Stagehand leaves the trap silent");
});
