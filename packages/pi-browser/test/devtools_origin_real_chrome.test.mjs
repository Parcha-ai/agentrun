// The local Chrome's DevTools socket is the whole browser: whoever opens it drives every tab. A page the agent visits runs
// in that same Chrome, so the socket must refuse a web page's Origin, while Stagehand's own clients (the driver in this
// process and the extension's loopback inside the browser) keep working.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { extensionOrigin } from "../dist/providers/chrome-args.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";

const SPEC = { tag: "ar-origin-1-1", maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: {} };

/** The answer to a WebSocket upgrade of the DevTools socket sent with `origin` (or none): 101 when Chrome takes it. */
function upgradeStatus(wsUrl, origin) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...(origin ? { origin } : {}) } });
    req.on("upgrade", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
}

/** A page whose script tries the browser's DevTools socket and writes what happened into its title. */
function startProbePage() {
  const server = http.createServer((req, res) => {
    const asked = new URL(req.url, "http://x");
    const target = asked.searchParams.get("ws") ?? "";
    res.writeHead(200, { "content-type": "text/html" });
    // The second page asks Chrome's HTTP endpoint for the socket's URL, which is what a page that knows only the port would need.
    if (asked.searchParams.has("json")) return res.end(`<!doctype html><title>pending</title><script>
      fetch(${JSON.stringify(asked.searchParams.get("json"))}).then((r) => r.json()).then((v) => { document.title = v.webSocketDebuggerUrl ? "READ" : "EMPTY"; }, () => { document.title = "BLOCKED"; });
    </script>`);
    res.end(`<!doctype html><title>pending</title><script>
      try {
        const ws = new WebSocket(${JSON.stringify(target)});
        ws.onopen = () => { document.title = "OPEN"; ws.close(); };
        ws.onerror = () => { if (document.title === "pending") document.title = "REFUSED"; };
        ws.onclose = () => { if (document.title === "pending") document.title = "REFUSED"; };
      } catch { document.title = "REFUSED"; }
    </script>`);
  });
  // Chrome keeps its connection to the page alive: close it too, or close() waits for it.
  const close = () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close })));
}

test("a page the agent visits cannot open the browser's DevTools socket, and Stagehand still drives the page", { skip: NO_CHROME, timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "devtools-origin-"));
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot: path.join(dir, "profiles") } });
  let ref, driver, page;
  // One teardown, registered before anything can fail, in order: the driver lets go of the browser before the browser is
  // released, and the directory goes whatever the release does.
  t.after(async () => {
    try {
      await driver?.close().catch(() => undefined);
      await page?.close();
      if (ref) await provider.release(ref);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });
  const signal = new AbortController().signal;
  ref = await provider.create(SPEC, signal);
  const target = await provider.attach(ref);
  try { driver = await stagehandDriver()(target, signal); }
  catch (error) { if (skipIncapable(t, error)) return; throw error; }
  page = await startProbePage();
  const probe = `${page.url}?ws=${encodeURIComponent(target.sdkCdpUrl)}`;
  const title = await driver.run({ code: `await page.goto(${JSON.stringify(probe)}); for (let i = 0; i < 50 && (await page.title()) === "pending"; i += 1) await new Promise((r) => setTimeout(r, 100)); return await page.title();` });
  const port = new URL(target.sdkCdpUrl).port;
  const read = await driver.run({ code: `await page.goto(${JSON.stringify(`${probe}&json=${encodeURIComponent(`http://127.0.0.1:${port}/json/version`)}`)}); for (let i = 0; i < 50 && (await page.title()) === "pending"; i += 1) await new Promise((r) => setTimeout(r, 100)); return await page.title();` });
  assert.deepEqual({ socket: title, endpoint: read }, { socket: "REFUSED", endpoint: "BLOCKED" }, "a web page reached the browser's DevTools socket or read its endpoint");
  // Chrome's own check, origin by origin: a Node client (no Origin, as Stagehand's sends) and the extension's Origin are taken; a
  // web page's Origin is refused.
  assert.deepEqual({
    none: await upgradeStatus(target.sdkCdpUrl, null),
    extension: await upgradeStatus(target.sdkCdpUrl, extensionOrigin()),
    page: await upgradeStatus(target.sdkCdpUrl, page.url.replace(/\/$/, "")),
  }, { none: 101, extension: 101, page: 403 });
  // Stagehand's own connections are unaffected: the same driver still reads the page.
  assert.equal(await driver.run({ code: "return 1 + 1;" }), 2);
});
