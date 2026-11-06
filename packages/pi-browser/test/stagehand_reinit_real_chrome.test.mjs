// Reattaching after a connection drop, with a proxy between the driver and the browser that cuts or holds connections as a
// network would. Stagehand 4.4 lets one client attach to a browser at a time, and its extension sees a client leave only
// through its own connection to the browser: the cdp provider names the browser's own URL for that connection, so a drop
// on the driver's side never cuts it, and the next attach finds the browser free.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { heldProxy } from "./fixtures/held-proxy.mjs";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";

const SPEC = { tag: "reinit", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} };

/** A browser (its extension confined, as in production), a proxy in front of it, and a driver attached through the proxy
 *  that has set a value the page keeps. Null when this Chrome cannot run the extension. */
async function proxiedDriver(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-browser-reinit-"));
  const drivers = [];
  let provider, ref, proxy;
  t.after(async () => {
    for (const driver of drivers) await driver.close().catch(() => undefined);
    await proxy?.close();
    if (ref) await provider.release(ref);
    await rm(dir, { recursive: true, force: true });
  }, { timeout: 60_000 });
  provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: dir } });
  ref = await provider.create(SPEC, new AbortController().signal);
  const own = await provider.attach(ref);
  assert.equal(own.extensionCdpUrl, own.sdkCdpUrl, "the extension dials the browser's own URL");
  const address = new URL(own.sdkCdpUrl);
  proxy = await heldProxy({ host: address.hostname, port: Number(address.port), path: address.pathname });
  const viaProxy = { ...own, sdkCdpUrl: `ws://127.0.0.1:${proxy.port}${address.pathname}` };
  const attach = async (signal = new AbortController().signal) => { const driver = await stagehandDriver()(viaProxy, signal); drivers.push(driver); return driver; };
  let first;
  try { first = await attach(); } catch (error) {
    if (skipIncapable(t, error)) return null;
    throw new Error(`setup: the first attach: ${error?.message}`, { cause: error });
  }
  const site = await startSite();
  t.after(() => site.close(), { timeout: 30_000 });
  await first.run({ code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); await page.evaluate(() => localStorage.setItem("gre3649", "kept")); return true;` });
  return { provider, ref, own, proxy, attach, site };
}

const KEPT = (site) => `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.evaluate(() => localStorage.getItem("gre3649"));`;

test("a drop that cuts the driver's connection leaves the extension's own: the next attach runs at once on the same session with its state", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const rig = await proxiedDriver(t);
  if (!rig) return;
  const { provider, ref, own, proxy, attach, site } = rig;
  proxy.drop();
  const started = Date.now();
  const again = await attach();
  assert.ok(Date.now() - started < 15_000, `the attach after the drop took ${Date.now() - started} ms: it waited on something`);
  assert.equal(await again.run({ code: KEPT(site) }), "kept", "the page state from before the drop is still there");
  assert.equal(await provider.status(ref), "running", "the lease is untouched");
  assert.equal((await provider.attach(ref)).sdkCdpUrl, own.sdkCdpUrl, "the same browser");
});

test("an attach cancelled while its connection is held stops at once, and lets go of the connection that arrives later", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const rig = await proxiedDriver(t);
  if (!rig) return;
  const { proxy, attach, site } = rig;
  proxy.drop();
  proxy.hold();
  const call = new AbortController();
  const started = Date.now();
  const cancelled = attach(call.signal);
  const deadline = Date.now() + 20_000;
  while (proxy.waiting() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(proxy.waiting(), 1, "the attach's connection is held at the proxy");
  call.abort();
  await assert.rejects(cancelled, (error) => error?.name === "AbortError");
  assert.ok(Date.now() - started < 15_000, "it stopped with the cancel");
  // The held connection now goes through and attaches; the cancelled attach lets it go, so the next is not refused.
  proxy.release();
  let next = null;
  for (const until = Date.now() + 30_000; !next && Date.now() < until; ) {
    next = await attach().catch((error) => { if (!/already connected/.test(String(error?.message))) throw error; return null; });
    if (!next) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(next, "an attach after the late connection was let go");
  assert.equal(await next.run({ code: KEPT(site) }), "kept");
});
