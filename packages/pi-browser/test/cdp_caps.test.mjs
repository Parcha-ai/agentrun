import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { cdpProvider } from "../dist/providers/cdp.js";

test("a cdp provider on an endpoint the host names shares that one browser across its sessions; one that starts its own Chrome per session does not (#1078)", () => {
  assert.equal(cdpProvider({ endpoint: "ws://127.0.0.1:9/devtools/browser/shared" }).caps.sharedBrowser, true);
  assert.equal(cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: os.tmpdir() } }).caps.sharedBrowser ?? false, false);
});

test("a cdp provider offers its sessions to a session vault only when it starts the Chrome, or the host says the endpoint is the run's own browser", () => {
  assert.deepEqual(cdpProvider({ chrome: { executablePath: "/nonexistent/chrome", profileRoot: os.tmpdir() } }).vault, { kind: "cdp" });
  assert.equal(cdpProvider({ endpoint: "ws://127.0.0.1:9/devtools/browser/shared" }).vault, undefined, "a shared endpoint is not offered");
  assert.equal(cdpProvider({ endpoint: "ws://127.0.0.1:9/devtools/browser/shared", ownBrowser: false }).vault, undefined);
  const own = cdpProvider({ endpoint: "ws://127.0.0.1:9/devtools/browser/own", ownBrowser: true });
  assert.deepEqual(own.vault, { kind: "cdp" });
  assert.equal(own.caps.sharedBrowser, true, "it is still one browser for all of the run's sessions");
});

test("an endpoint lease is running until it is released and gone after: a release that leaves the browser up still confirms, so a drain does not wait on it", async () => {
  const provider = cdpProvider({ endpoint: "ws://127.0.0.1:9/devtools/browser/own", ownBrowser: true });
  const signal = new AbortController().signal;
  const spec = { tag: "ep-1", maxLifetimeS: 60, idleTimeoutS: 30, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: { run: "r", label: "l" } };
  const ref = await provider.create(spec, signal);
  assert.equal(await provider.status(ref), "running");
  await provider.release(ref);
  assert.equal(await provider.status(ref), "gone");
  await provider.release(ref);
  assert.equal(await provider.status(ref), "gone", "idempotent");
  assert.equal(await provider.status(await provider.create({ ...spec, tag: "ep-2" }, signal)), "running", "another lease is its own");
});
