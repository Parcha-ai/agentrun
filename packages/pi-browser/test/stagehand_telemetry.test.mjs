// Chrome resolves example.com (Stagehand's default trace endpoint) to a local TLS trap: the sealed driver must leave it
// silent while a bare create, on the same rig, reaches it. Both arms attach to a Chrome the cdp provider starts, as the
// driver does in production, so they differ only in how Stagehand is created. Stagehand's close flushes its trace
// exporter before it answers, so once close resolves every export it will ever send has reached the trap or failed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME, REQUIRED, skipIncapable } from "./fixtures/local-chrome.mjs";

const HAS_OPENSSL = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const SKIP = NO_CHROME || (!REQUIRED && !HAS_OPENSSL ? "needs openssl" : false);

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} });

/** Stagehand as its default creates it: the control. */
async function bare(target, pageUrl) {
  const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
  const browser = await localBrowser.connect({ cdpUrl: target.sdkCdpUrl });
  const stagehand = await Stagehand.create({ browser, logging: { level: "off" } });
  const page = await stagehand.browser.context.activePage();
  await page.goto(pageUrl);
  await page.locator("input").fill("typed value");
  return () => stagehand.close();
}

async function viaDriver(target, pageUrl) {
  const driver = await stagehandDriver()(target, new AbortController().signal, { batchTimeoutMs: 30_000 });
  await driver.run({ code: `await page.goto(${JSON.stringify(pageUrl)}); await page.locator("input").fill("typed value"); return 1;` });
  return () => driver.close();
}

/** The POSTs to the trap's /v1/traces once `drive`'s Stagehand has closed. */
async function exportsFor(drive) {
  const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "stagehand-telemetry-"));
  const cleanups = [() => rm(dir, { recursive: true, force: true })];
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=example.com", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
    let posts = 0;
    // Counted when the body ends, before the reply: the exporter's request settles only after the count.
    const trap = https.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }, (req, res) => {
      req.resume(); req.on("end", () => { if (req.method === "POST" && req.url === "/v1/traces") posts += 1; res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    });
    const page = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>t</title><input name=q><button>go</button>"); });
    cleanups.unshift(() => trap.close(), () => page.close());
    const [trapPort, pagePort] = [await listen(trap), await listen(page)];
    // The certificate is self-signed, so Chrome takes it: an export that reached the trap is never hidden by a TLS
    // refusal.
    const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(dir, "profiles"), headless: true, args: [
      "--ignore-certificate-errors",
      `--host-resolver-rules=MAP example.com 127.0.0.1:${trapPort}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`,
    ] } });
    const signal = new AbortController().signal;
    const ref = await provider.create(spec("telemetry"), signal);
    cleanups.unshift(() => provider.release(ref));
    const close = await drive(await provider.attach(ref), `http://127.0.0.1:${pagePort}/`);
    await close();
    return posts;
  } finally {
    for (const cleanup of cleanups) await Promise.resolve().then(cleanup).catch(() => undefined);
  }
}

test("Stagehand's default exports its trace to example.com; the driver's sealed Stagehand keeps it on this host", { skip: SKIP, timeout: 120_000 }, async (t) => {
  let control;
  try { control = await exportsFor(bare); } catch (error) {
    if (skipIncapable(t, error)) return;
    throw error;
  }
  assert.ok(control > 0, "control: the default reaches the example.com trap, so the rig can see an export");
  assert.equal(await exportsFor(viaDriver), 0, "the driver's Stagehand leaves the trap silent");
});
