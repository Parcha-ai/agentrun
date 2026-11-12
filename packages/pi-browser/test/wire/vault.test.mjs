import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver, sentinelPages } from "@parcha/pi-browser/testing";
import { call, collect, openRig } from "./rig.mjs";
import { Scan } from "./scan.mjs";
import { ALLOW, hostRegistered, makeSentinels } from "./sentinels.mjs";
import { scratchSync } from "../fixtures/scratch.mjs";

// A host's session vault, through the durable adapter, on a provider whose browser state the vault may keep (a local Chrome's): a target the host got
// wrong, or an age cap out of bounds, is refused before any session starts, and nothing it held reaches a document, entry, model request or log line.
const text = (value) => { const content = [{ type: "text", text: JSON.stringify(value) }]; return { content, output: content }; };
const CONFIG = (vault) => ({ label: "node-a", run: "run-vault", ...(vault ? { vault } : {}), policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } });

async function runVault(t, { vault, script, tools = {} }) {
  const sentinels = makeSentinels();
  const backend = new FakeBackend({ sentinels: { ...sentinels, bbSessionId: "bbs-id" }, pages: sentinelPages(sentinels), start: "https://example.test/start" });
  const created = [];
  const provider = {
    ...backend.provider,
    vault: { kind: "cdp" },
    create: async (spec, signal) => { created.push(spec.tag); return backend.provider.create(spec, signal); },
  };
  const port = { restore: async () => null, capture: async () => {}, forget: async () => {} };
  const dir = scratchSync(t, "wire-vault-");
  let rig;
  const browser = createBrowserExtension({
    provider: () => provider, driver: (target, signal, options) => fakeDriver(backend)(target, signal, options),
    tools, evidence: { file: async () => null }, sessionVault: port, redact: { values: () => hostRegistered(sentinels) },
    onSession: (row, change) => rig.host({ label: row.label, session: row.session, liveView: row.liveView }, change),
  });
  rig = await openRig({ dir, script, install: (registry) => registry.install(browser.extension), rootOptions: { init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG(vault)); } } });
  await browser.reconcile(rig.harness, () => true, rig.ctx);
  await rig.run();
  await browser.release(rig.root, "close", rig.ctx);
  for (let i = 0; i < 200 && (await rig.harness.inspect(rig.ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  const scan = new Scan(sentinels, { allow: ALLOW });
  await collect(rig, scan);
  const entries = JSON.stringify(await rig.entries());
  await browser.close(); await rig.close();
  return { created, scan, entries };
}

test("a vault target the host got wrong (a path in an origin, a bad key) is refused with its reason, before any session starts", async (t) => {
  for (const vault of [{ sessionKey: "k", origins: ["https://app.example.com/path"] }, { sessionKey: "has space", origins: ["https://app.example.com"] }, { sessionKey: "k", origins: [] }]) {
    const r = await runVault(t, { vault, script: [[call("browser_read")]], tools: { browser_read: async (_a, port) => { await port.session(); return text({ ok: true }); } } });
    assert.equal(r.created.length, 0, JSON.stringify(vault));
    assert.ok(/browser vault/.test(r.entries), "the failure names the vault");
    assert.equal(r.scan.report(), "no sentinel found");
  }
});

test("a bad session-cookie age cap is refused when the extension is made, and a host value above 24 h is clamped", () => {
  const base = { provider: () => { throw new Error("unused"); }, driver: () => { throw new Error("unused"); }, evidence: { file: async () => null }, sessionVault: { restore: async () => null, capture: async () => {}, forget: async () => {} } };
  for (const bad of [0, -5, NaN]) assert.throws(() => createBrowserExtension({ ...base, sessionVaultMaxSessionCookieAgeMs: bad }), RangeError, String(bad));
  assert.doesNotThrow(() => createBrowserExtension({ ...base, sessionVaultMaxSessionCookieAgeMs: 48 * 3600_000 }));
  assert.doesNotThrow(() => createBrowserExtension({ ...base, sessionVaultMaxSessionCookieAgeMs: 3600_000 }));
});
