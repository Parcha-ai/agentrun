import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createBrowserExtension } from "../dist/durable.js";
import { cdpProvider } from "../dist/providers/cdp.js";
import { connectCdp } from "../dist/providers/cdp-session.js";
import { captureFor, vaultRuntime } from "../dist/vault-session.js";
import { stagehandDriver } from "../dist/driver/stagehand.js";
import { CHROME, NO_CHROME, skipIncapable } from "./fixtures/local-chrome.mjs";
import { scratchSync } from "./fixtures/scratch.mjs";
import { call, openRig } from "./wire/rig.mjs";

// The durable adapter with a host's session vault on a real local Chrome: a kept sign-in is in the new browser's cookie jar when its driver attaches, and the browser is read
// for the vault while it still exists, at the release.
// A branded Chrome writes its url-fetcher directory straight under its TMPDIR, so each launcher's Chrome gets a TMPDIR of its own (short:
// its singleton socket path aborts past 107 bytes), removed with the test, and the file's own TMPDIR stays clean for the leak check.
const ownTmp = (t) => scratchSync(t, "vault-tmp-");
const text = (value) => { const content = [{ type: "text", text: JSON.stringify(value) }]; return { content, output: content }; };
const ORIGIN = "http://127.0.0.1:45871";
const KEPT = {
  kind: "cdp", capturedAt: new Date().toISOString(),
  cookies: [{ name: "kept", value: "v", domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false }, { name: "stranger", value: "x", domain: "stranger.test", path: "/", httpOnly: false, secure: false }],
  localStorage: {},
};
const CONFIG = { label: "node-a", run: "run-vault-chrome", vault: { sessionKey: "chrome-1", origins: [ORIGIN] }, policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } };

test("durable adapter, real Chrome: the kept cookie is in the jar when the driver attaches, a stranger's cookie is not put back, and the release captures the session", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const profileRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "vault-durable-"));
  t.after(() => fs.rmSync(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), { timeout: 30_000 });
  const provider = cdpProvider({ chrome: { executablePath: CHROME, profileRoot, args: [] } });
  const atDriver = []; const captured = []; const events = [];
  const driver = async (target, signal, options) => {
    const link = await connectCdp(target.sdkCdpUrl);
    try { atDriver.push((await link.send("Storage.getCookies", {})).cookies.map((c) => c.name).sort()); } finally { link.close(); }
    events.push("driver.attach");
    return stagehandDriver()(target, signal, options);
  };
  const dir = scratchSync(t, "wire-vault-chrome-");
  let rig;
  const browser = createBrowserExtension({
    provider: () => provider, driver, evidence: { file: async () => null },
    tools: { browser_read: async (_a, port) => { await port.session(); return text({ ok: true }); } },
    sessionVault: { restore: async () => { events.push("vault.restore"); return KEPT; }, capture: async (input) => { events.push("vault.capture"); captured.push(input); }, forget: async () => {} },
  });
  rig = await openRig({ dir, script: [[call("browser_read")]], install: (registry) => registry.install(browser.extension), rootOptions: { init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); } } });
  try {
    await browser.reconcile(rig.harness, () => true, rig.ctx);
    await rig.run();
    await browser.release(rig.root, "close", rig.ctx);
    for (let i = 0; i < 200 && (await rig.harness.inspect(rig.ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  } catch (error) { if (skipIncapable(t, error)) return; throw error; } finally { await browser.close(); await rig.close(); }
  assert.deepEqual(atDriver, [["kept"]], "the kept cookie was already in the jar when the driver attached, and the stranger's was not put back");
  assert.deepEqual(events.slice(0, 2), ["vault.restore", "driver.attach"]);
  assert.equal(captured.length, 1, "captured once, at the release");
  assert.equal(captured[0].state.kind, "cdp");
  assert.deepEqual(captured[0].state.cookies.map((c) => c.name), ["kept"], "and only the origin's cookies were captured");
});

test("durable adapter, a Chrome the run's launcher started and the host names as an OWN endpoint: it is offered to the vault, a kept cookie is in its jar when the driver attaches, the release is captured, and the drain after it finishes", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const userData = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "vault-endpoint-"));
  const child = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userData}`, "--no-first-run", "--password-store=basic", "--use-mock-keychain", "--remote-allow-origins=*", "about:blank"], { stdio: "ignore", detached: true, env: { ...process.env, TMPDIR: ownTmp(t) } });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, { timeout: 30_000 });
  t.after(() => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), { timeout: 30_000 });
  let port;
  for (const until = Date.now() + 20_000; !port && Date.now() < until;) { try { port = Number(fs.readFileSync(path.join(userData, "DevToolsActivePort"), "utf8").split("\n")[0]) || undefined; } catch { /* not up yet */ } if (!port) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(port, "the launcher's Chrome is listening");
  const provider = cdpProvider({ endpoint: `http://127.0.0.1:${port}`, ownBrowser: true });
  assert.deepEqual(provider.vault, { kind: "cdp" });
  const atDriver = []; const captured = []; const warnings = []; const onWarning = (w) => warnings.push(w.message); process.on("warning", onWarning); t.after(() => process.off("warning", onWarning), { timeout: 30_000 });
  const driver = async (target, signal, options) => {
    const link = await connectCdp(target.sdkCdpUrl);
    try { atDriver.push((await link.send("Storage.getCookies", {})).cookies.map((c) => c.name).sort()); } finally { link.close(); }
    return stagehandDriver()(target, signal, options);
  };
  const dir = scratchSync(t, "wire-vault-endpoint-");
  let rig;
  const browser = createBrowserExtension({
    provider: () => provider, driver, evidence: { file: async () => null },
    tools: { browser_read: async (_a, port2) => { await port2.session(); return text({ ok: true }); } },
    sessionVault: { restore: async () => KEPT, capture: async (input) => { captured.push(input); }, forget: async () => {} },
  });
  rig = await openRig({ dir, script: [[call("browser_read")]], install: (registry) => registry.install(browser.extension), rootOptions: { init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG); } } });
  let drained = "not run";
  try {
    await browser.reconcile(rig.harness, () => true, rig.ctx);
    await rig.run();
    await browser.release(rig.root, "close", rig.ctx);
    drained = await browser.drain(rig.harness, rig.ctx, AbortSignal.timeout(20_000)).then(() => "drained", (error) => `timed out: ${error?.message ?? error}`);
  } catch (error) { if (skipIncapable(t, error)) return; throw error; } finally { await browser.close(); await rig.close(); }
  assert.deepEqual(atDriver, [["kept"]]);
    assert.equal(captured.length, 1, "captured at the release");
  assert.equal(drained, "drained", "the release of an endpoint lease is confirmed, so the drain does not wait on it");
});

test("a capture of a local Chrome is discarded when a person begins driving while it is read, and kept when no one does", { skip: NO_CHROME, timeout: 150_000 }, async (t) => {
  const userData = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "vault-gate-"));
  const child = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userData}`, "--no-first-run", "--password-store=basic", "--use-mock-keychain", "--remote-allow-origins=*", "about:blank"], { stdio: "ignore", detached: true, env: { ...process.env, TMPDIR: ownTmp(t) } });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, { timeout: 30_000 });
  t.after(() => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }), { timeout: 30_000 });
  let port;
  for (const until = Date.now() + 20_000; !port && Date.now() < until;) { try { port = Number(fs.readFileSync(path.join(userData, "DevToolsActivePort"), "utf8").split("\n")[0]) || undefined; } catch { /* not up yet */ } if (!port) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(port, "Chrome is listening");
  const provider = cdpProvider({ endpoint: `http://127.0.0.1:${port}`, ownBrowser: true });
  const written = []; const warnings = [];
  const rt = vaultRuntime({ sessionVault: { restore: async () => null, capture: async (input) => { written.push(input); }, forget: async () => {} } }, () => {}, (m) => warnings.push(m));
  const ref = await provider.create({ tag: "gate-1", maxLifetimeS: 60, idleTimeoutS: 30, proxies: false, verified: false, captcha: false, viewport: { width: 800, height: 600 }, metadata: { run: "r", label: "l" } }, AbortSignal.timeout(20_000));
  const target = { sessionKey: "k", origins: [ORIGIN] };
  const gate = (fires) => ({ state: () => "idle", viewing: () => false, onChange: (listener) => { if (fires) listener("person"); return () => {}; } });
  await captureFor(rt, target, provider, ref, { vaulted: true, gate: () => gate(true) })();
  assert.equal(written.length, 0, "input began during the read: nothing is written");
  assert.match(warnings.join("\n"), /began driving while the session was being read/);
  await captureFor(rt, async () => target, provider, ref, { vaulted: true, gate: () => gate(false) })();
  assert.equal(written.length, 1, "with no input, the same read is written");
  assert.equal(written[0].state.kind, "cdp");
});
