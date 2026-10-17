import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installedExtension } from "../dist/driver/extension-worker.js";
import { SEALED_STAGEHAND, stagehandDriver } from "../dist/driver/stagehand.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { heldProxy } from "./fixtures/held-proxy.mjs";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { startSite } from "./fixtures/site.mjs";

const SPEC = { tag: "reinit", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} };

/** A browser, a proxy in front of it, and a driver whose connection, and so the extension's own, runs through the proxy.
 *  Null when this Chrome cannot run the extension. */
async function proxiedDriver(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-browser-reinit-"));
  let provider, ref, proxy, driver;
  t.after(async () => {
    await driver?.close().catch(() => undefined);
    await proxy?.close();
    if (ref) await provider.release(ref);
    await rm(dir, { recursive: true, force: true });
  }, { timeout: 30_000 });
  provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: dir } });
  const signal = new AbortController().signal;
  ref = await provider.create(SPEC, signal);
  const own = await provider.attach(ref);
  const address = new URL(own.sdkCdpUrl);
  proxy = await heldProxy({ host: address.hostname, port: Number(address.port), path: address.pathname });
  const viaProxy = { ...own, sdkCdpUrl: `ws://127.0.0.1:${proxy.port}${address.pathname}` };
  try {
    driver = await stagehandDriver()(viaProxy, signal);
  } catch (error) {
    if (skipIncapable(t, error)) return null;
    throw new Error(`setup: the first attach: ${error?.message}`, { cause: error });
  }
  return { provider, ref, own, proxy, viaProxy, driver, signal };
}

/** A browser whose reconnect is stuck in its init: a driver through a proxy set a value the page keeps, the proxy then
 *  dropped every connection, and the next init's own connection, the extension's, is held there. */
async function stalledReconnect(t) {
  const rig = await proxiedDriver(t);
  if (!rig) return null;
  const { provider, ref, own, proxy, viaProxy, driver, signal } = rig;
  const site = await startSite();
  t.after(() => site.close(), { timeout: 30_000 });
  try {
    // Before the drop: a value the page keeps. Only the same browser, profile and origin still hold it afterwards.
    await driver.run({ code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); await page.evaluate(() => localStorage.setItem("gre3649", "kept")); return true;` });

    // The drop cuts both. A reconnect then starts: its own connection gets through before the hold, and the
    // extension's, dialed again for its init, is held, so the init stays in flight.
    proxy.drop();
    const { localBrowser, Stagehand } = await import("@browserbasehq/stagehand");
    // As the driver's own reconnect does, the instance the drop left behind is closed first, over the browser's address.
    const extensionId = await installedExtension(own.sdkCdpUrl, signal, own.extensionId);
    const earlier = await localBrowser.connect({ cdpUrl: viaProxy.sdkCdpUrl, ...(extensionId ? { extensionId } : {}) });
    proxy.hold();
    const stalled = Stagehand.create({ browser: earlier, ...SEALED_STAGEHAND }).then((stagehand) => stagehand, (error) => error);
    t.after(async () => { const settled = await stalled; if (settled && typeof settled.close === "function") await settled.close().catch(() => undefined); }, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`setup: ${error?.message}`, { cause: error });
  }
  const deadline = Date.now() + 20_000;
  while (proxy.waiting() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(proxy.waiting(), 1, "setup: the reconnect's init is held at the extension's own connection");
  return { provider, ref, own, proxy, site };
}

test("an attach that arrives while an earlier init is still running in the extension waits for it, then runs on the same session with its state", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const rig = await stalledReconnect(t);
  if (!rig) return;
  const { provider, ref, own, proxy, site } = rig;
  // Sleep while the driver attaches, longer than its first close's 3 s wait plus another: the earlier init then gets its
  // connection and ends.
  const released = new Promise((resolve) => setTimeout(() => { proxy.release(); resolve(Date.now()); }, 15_000));
  const started = Date.now();
  const driver = await stagehandDriver()(own, new AbortController().signal)
    .catch((error) => { throw new Error(`the attach under test failed after ${Date.now() - started} ms: ${error?.message}`, { cause: error }); });
  t.after(() => driver.close().catch(() => undefined), { timeout: 30_000 });
  assert.ok(Date.now() - started >= 15_000 - 50, "the attach waited for the earlier init");
  await released;
  assert.ok((await driver.snapshot()).length > 0);
  const kept = await driver.run({ code: `await page.goto(${JSON.stringify(`${site.base}/a`)}); return await page.evaluate(() => localStorage.getItem("gre3649"));` });
  assert.equal(kept, "kept", "the page state from before the drop is still there");
  assert.equal(await provider.status(ref), "running", "the lease is untouched");
  assert.equal((await provider.attach(ref)).sdkCdpUrl, own.sdkCdpUrl, "the same browser");
});

test("an attach cancelled while it waits for the earlier init stops at once and starts no init of its own", { skip: NO_CHROME, timeout: 180_000 }, async (t) => {
  const rig = await stalledReconnect(t);
  if (!rig) return;
  const { own, proxy } = rig;
  const call = new AbortController();
  // Sleep past the first close's 3 s wait and the refusal, into the long wait, then cancel; the earlier init is held
  // until well after.
  setTimeout(() => call.abort(), 6_000);
  const release = setTimeout(() => proxy.release(), 20_000);
  t.after(() => { clearTimeout(release); proxy.release(); }, { timeout: 30_000 });
  const started = Date.now();
  await assert.rejects(stagehandDriver()(own, call.signal), (error) => error?.name === "AbortError");
  assert.ok(Date.now() - started < 15_000, "it stopped with the cancel, not when the earlier init ended");
});
