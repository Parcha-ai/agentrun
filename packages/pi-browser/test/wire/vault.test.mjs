import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserExtension } from "@parcha/pi-browser/durable";
import { FakeBackend, fakeDriver, sentinelPages } from "@parcha/pi-browser/testing";
import { call, collect, openRig } from "./rig.mjs";
import { Scan } from "./scan.mjs";
import { ALLOW, hostRegistered, makeSentinels } from "./sentinels.mjs";
import { scratchSync } from "../fixtures/scratch.mjs";

// A host's session vault, through the durable adapter, on a provider whose browser state is a context id (Browserbase and Kernel keep it on their side). The id is a
// capability: it reaches the provider and the host's vault port, and nothing else: no document, entry, model request, tool result, failure detail or log line.
const text = (value) => { const content = [{ type: "text", text: JSON.stringify(value) }]; return { content, output: content }; };
const CTX = "ctx_7f3a91c2d4e85b06a1";
const CONFIG = (vault) => ({ label: "node-a", run: "run-vault", ...(vault ? { vault } : {}), policy: { proxies: false, verified: false, captcha: false, geolocation: null, region: null, contextId: null, sessionTimeoutS: 1800, idleReleaseS: 0, batchTimeoutMs: 60_000 } });

async function runVault(t, { kept, vault = { sessionKey: "local-chrome", origins: ["https://app.example.com"] }, script, tools = {}, providerExtras = {}, handoff }) {
  const sentinels = makeSentinels();
  const backend = new FakeBackend({ sentinels: { ...sentinels, bbSessionId: "bbs-id" }, pages: sentinelPages(sentinels), start: "https://example.test/start" });
  const events = []; const created = []; const captured = []; const warnings = [];
  const onWarning = (warning) => warnings.push(`${warning.name}: ${warning.message}`);
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  const provider = {
    ...backend.provider,
    vault: { kind: "context", provider: "browserbase", contextIdsInClear: false, contextOf: () => CTX },
    ...providerExtras,
    create: async (spec, signal) => { events.push("provider.create"); created.push({ contextId: spec.contextId, profile: spec.profile }); return backend.provider.create(spec, signal); },
    attach: async (ref, signal) => { events.push("provider.attach"); return backend.provider.attach(ref, signal); },
    release: async (ref, signal) => { events.push("provider.release"); return backend.provider.release(ref, signal); },
  };
  const port = {
    restore: async (input) => { events.push("vault.restore"); events.push(JSON.stringify(input)); return kept ?? null; },
    capture: async (input) => { events.push("vault.capture"); captured.push(input); },
    forget: async () => {},
  };
  const dir = scratchSync(t, "wire-vault-");
  let rig;
  const browser = createBrowserExtension({
    provider: () => provider, driver: (target, signal, options) => { events.push("driver.attach"); return fakeDriver(backend)(target, signal, options); },
    tools, evidence: { file: async () => null }, sessionVault: port, ...(handoff ? { handoff } : {}), redact: { values: () => hostRegistered(sentinels) },
    onSession: (row, change) => rig.host({ label: row.label, session: row.session, liveView: row.liveView }, change),
  });
  rig = await openRig({ dir, script, install: (registry) => registry.install(browser.extension), rootOptions: { init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG(vault)); } } });
  await browser.reconcile(rig.harness, () => true, rig.ctx);
  await rig.run();
  await browser.release(rig.root, "close", rig.ctx);
  for (let i = 0; i < 200 && (await rig.harness.inspect(rig.ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  const scan = new Scan({ ...sentinels, vaultContextId: CTX }, { allow: ALLOW });
  await collect(rig, scan);
  const entries = JSON.stringify(await rig.entries());
  await browser.close(); await rig.close();
  return { events, created, captured, warnings, scan, entries, backend };
}

const KEPT = { kind: "provider-context", capturedAt: "2026-10-21T00:00:00.000Z", provider: "browserbase", contextId: CTX, origins: ["https://app.example.com"] };

test("a kept context is asked for before the session is created and given to the provider, captured before the release, and never stored", async (t) => {
  const tools = { browser_read: async (_a, port) => { await port.session(); return text({ ok: true, note: `the provider says context ${CTX} is signed in` }); } };
  const r = await runVault(t, { kept: KEPT, script: [[call("browser_read")]], tools });
  const order = r.events.filter((e) => /^(vault|provider|driver)\./.test(e));
  assert.deepEqual(order.slice(0, 4), ["vault.restore", "provider.create", "provider.attach", "driver.attach"], "restore, then the browser, then the driver");
  assert.ok(order.indexOf("vault.capture") > order.indexOf("driver.attach") && order.indexOf("vault.capture") < order.lastIndexOf("provider.release"), "capture while the browser exists, before its release");
  assert.deepEqual(JSON.parse(r.events[r.events.indexOf("vault.restore") + 1]), { sessionKey: "local-chrome", origins: ["https://app.example.com"] });
  assert.deepEqual(r.created, [{ contextId: CTX, profile: undefined }], "the provider was asked to run on the kept context");
  assert.deepEqual(r.captured.map((c) => [c.sessionKey, c.origins, c.state.kind, c.state.provider, c.state.contextId]), [["local-chrome", ["https://app.example.com"], "provider-context", "browserbase", CTX]]);
  assert.ok(r.entries.includes("[redacted]") && !r.entries.includes(CTX), "a tool result that named the id came out redacted");
  assert.equal(r.scan.report(), "no sentinel found", "the id is in no document, entry, model request, host row or process log");
  assert.ok(!r.warnings.some((w) => w.includes(CTX)), "and in no warning");
});

test("with nothing kept, the provider is asked for a new persisted context, and its id goes to the vault right after the create (a restart then still finds it) and again at release", async (t) => {
  const r = await runVault(t, { kept: null, script: [[call("browser_read")]], tools: { browser_read: async (_a, port) => { await port.session(); return text({ ok: true }); } } });
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].contextId, undefined);
  assert.match(r.created[0].profile.name, /^vault-[0-9a-f]{18}$/);
  assert.equal(r.created[0].profile.save, true);
  assert.deepEqual(r.captured.map((c) => c.state.contextId), [CTX, CTX]);
  assert.equal(r.events.indexOf("vault.capture") < r.events.indexOf("provider.release"), true);
  assert.equal(r.scan.report(), "no sentinel found");
});

test("a failure whose detail carries the id, and a vault warning that does, come out redacted", async (t) => {
  const tools = {
    browser_read: async (_a, port) => { await port.session(); throw new Error(`context ${CTX} was refused by the provider`); },
  };
  const r = await runVault(t, { kept: KEPT, script: [[call("browser_read")]], tools });
  assert.ok(!r.entries.includes(CTX), "the failure detail has no id");
  assert.equal(r.scan.report(), "no sentinel found");
});

test("a vault whose capture throws does not fail the browser: a warning names the kind of error and no value", async (t) => {
  const sentinels = makeSentinels();
  const backend = new FakeBackend({ sentinels: { ...sentinels, bbSessionId: "bbs-id" }, pages: sentinelPages(sentinels), start: "https://example.test/start" });
  const warnings = []; const onWarning = (w) => warnings.push(w.message); process.on("warning", onWarning); t.after(() => process.off("warning", onWarning));
  const provider = { ...backend.provider, vault: { kind: "context", provider: "browserbase", contextIdsInClear: false, contextOf: () => CTX } };
  const dir = scratchSync(t, "wire-vault-");
  let rig;
  const boom = Object.assign(new Error(`the vault said no about ${CTX}`), { name: `VaultError_${CTX}` });
  const browser = createBrowserExtension({
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null },
    tools: { browser_read: async (_a, port) => { await port.session(); return text({ ok: true }); } },
    sessionVault: { restore: async () => KEPT, capture: async () => { throw boom; }, forget: async () => {} },
    redact: { values: () => hostRegistered(sentinels) },
    onSession: (row, change) => rig.host({ label: row.label, session: row.session, liveView: row.liveView }, change),
  });
  rig = await openRig({ dir, script: [[call("browser_read")]], install: (registry) => registry.install(browser.extension), rootOptions: { init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG({ sessionKey: "k", origins: ["https://app.example.com"] })); } } });
  await browser.reconcile(rig.harness, () => true, rig.ctx);
  const settled = await rig.run();
  await browser.release(rig.root, "close", rig.ctx);
  for (let i = 0; i < 200 && (await rig.harness.inspect(rig.ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
  const scan = new Scan({ ...sentinels, vaultContextId: CTX }, { allow: ALLOW });
  await collect(rig, scan);
  await browser.close(); await rig.close();
  assert.notEqual(settled.status, "timeout");
  assert.ok(warnings.some((m) => /could not capture/.test(m)), "a warning said the capture failed");
  assert.ok(!warnings.some((m) => m.includes(CTX)), "the warning carries no id, even though the error's own name did");
  assert.equal(scan.report(), "no sentinel found", "and neither does the process log");
});

test("a provider that writes its context ids to a clear file is refused for a vault, before any session starts", async (t) => {
  const r = await runVault(t, { kept: KEPT, script: [[call("browser_read")]], tools: { browser_read: async (_a, port) => { await port.session(); return text({ ok: true }); } }, providerExtras: { vault: { kind: "context", provider: "browserbase", contextIdsInClear: true, contextOf: () => CTX } } });
  assert.equal(r.created.length, 0, "no session was created");
  assert.ok(/clear file|memoryProfileStore/.test(r.entries), "the model was told why");
  assert.equal(r.scan.report(), "no sentinel found");
});

test("a vault target the host got wrong (a path in an origin, a bad key) is refused with its reason, before any session starts", async (t) => {
  for (const vault of [{ sessionKey: "k", origins: ["https://app.example.com/path"] }, { sessionKey: "has space", origins: ["https://app.example.com"] }, { sessionKey: "k", origins: [] }]) {
    const r = await runVault(t, { kept: KEPT, vault, script: [[call("browser_read")]], tools: { browser_read: async (_a, port) => { await port.session(); return text({ ok: true }); } } });
    assert.equal(r.created.length, 0, JSON.stringify(vault));
    assert.ok(/browser vault/.test(r.entries), "the failure names the vault");
  }
});

test("a bad session-cookie age cap is refused when the extension is made, and a host value above 24 h is clamped", () => {
  const base = { provider: () => { throw new Error("unused"); }, driver: () => { throw new Error("unused"); }, evidence: { file: async () => null }, sessionVault: { restore: async () => null, capture: async () => {}, forget: async () => {} } };
  for (const bad of [0, -5, NaN]) assert.throws(() => createBrowserExtension({ ...base, sessionVaultMaxSessionCookieAgeMs: bad }), RangeError, String(bad));
  assert.doesNotThrow(() => createBrowserExtension({ ...base, sessionVaultMaxSessionCookieAgeMs: 48 * 3600_000 }));
  assert.doesNotThrow(() => createBrowserExtension({ ...base, sessionVaultMaxSessionCookieAgeMs: 3600_000 }));
});

test("a handoff's end captures the session once, before the release captures it again", async (t) => {
  const handoff = { request: async () => ({ interactionId: "i1" }), outcome: async () => "done" };
  const ask = { request_id: "11111111-2222-4333-8444-555555555555", instruction: "Sign in.", completion_condition: "The account page shows." };
  const r = await runVault(t, { kept: KEPT, handoff, script: [[call("browser_read")], [call("browser_request_handoff", ask)]], tools: { browser_read: async (_a, port) => { await port.session(); return text({ ok: true }); } } });
  const order = r.events.filter((e) => /^(vault\.capture|provider\.release)$/.test(e));
  assert.deepEqual(order, ["vault.capture", "vault.capture", "provider.release"], "one capture when the person handed back, one at the release, both before the browser went");
  assert.equal(r.captured.length, 2);
  assert.equal(r.scan.report(), "no sentinel found");
});

async function changingTarget(t, { initial, later, laterIsAbsent = false }) {
  const sentinels = makeSentinels();
  const backend = new FakeBackend({ sentinels: { ...sentinels, bbSessionId: "bbs-id" }, pages: sentinelPages(sentinels), start: "https://example.test/start" });
  const captured = []; const warnings = [];
  const onWarning = (warning) => warnings.push(warning.message);
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning), { timeout: 30_000 });
  const provider = { ...backend.provider, vault: { kind: "context", provider: "browserbase", contextIdsInClear: false, contextOf: () => CTX } };
  const dir = scratchSync(t, "wire-vault-");
  let rig;
  const browser = createBrowserExtension({
    provider: () => provider, driver: fakeDriver(backend), evidence: { file: async () => null },
    tools: { browser_read: async (_a, port) => { await port.session(); return text({ ok: true }); } },
    sessionVault: { restore: async () => null, capture: async (input) => { captured.push(input); }, forget: async () => {} },
    redact: { values: () => hostRegistered(sentinels) },
    onSession: (row, change) => rig.host({ label: row.label, session: row.session, liveView: row.liveView }, change),
  });
  rig = await openRig({ dir, script: [[call("browser_read")]], install: (registry) => registry.install(browser.extension), rootOptions: { init: async (tx, id) => { Object.assign(await tx.doc(browser.docs.Config, id), CONFIG(initial)); } } });
  try {
    await browser.reconcile(rig.harness, () => true, rig.ctx);
    await rig.run();
    const atStart = captured.length;
    await rig.root.commit(async (tx) => { const doc = await tx.doc(browser.docs.Config, rig.root.id); if (laterIsAbsent) delete doc.vault; else Object.assign(doc, { vault: later }); }, rig.ctx);
    await browser.release(rig.root, "close", rig.ctx);
    for (let i = 0; i < 200 && (await rig.harness.inspect(rig.ctx)).tasks.length > 0; i += 1) await new Promise((r) => setTimeout(r, 50));
    return { captured, atStart, warnings };
  } finally { await browser.close(); await rig.close(); }
}

test("a context session that started with no vault target is not captured when the host sets one later: its provider holds no context for it, and a warning says so", async (t) => {
  const r = await changingTarget(t, { initial: undefined, later: { sessionKey: "learned-site", origins: ["https://learned.example.com"] } });
  assert.equal(r.captured.length, 0, "nothing is written under a target the session was not created for");
  assert.ok(r.warnings.some((w) => /started with no vault target/.test(w)), "the warning names the cause");
});

test("a host that removes the vault target mid-run stops the capture: the session is not kept under the target it was created with", async (t) => {
  const r = await changingTarget(t, { initial: { sessionKey: "old-key", origins: ["https://old.example.com"] }, laterIsAbsent: true });
  assert.equal(r.atStart, 1, "the id was given to the vault at create, under the target then in force");
  assert.equal(r.captured.length, 1, "and nothing more at the release");
});

test("a host that changes the vault target mid-run is captured at the release under the one set last", async (t) => {
  const r = await changingTarget(t, { initial: { sessionKey: "old-key", origins: ["https://old.example.com"] }, later: { sessionKey: "new-key", origins: ["https://new.example.com"] } });
  assert.deepEqual(r.captured.map((c) => c.sessionKey), ["old-key", "new-key"]);
});
