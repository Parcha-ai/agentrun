import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  AgentHomeError, createAgentHome, localHostKey, MAX_SESSION_COOKIE_AGE_MS, packHome, projectForExport, SECRET_KINDS, sessionVault, startRun, VAULT_KEYS_FILE,
} from "../dist/index.js";
import { put, LeasesDoc, RunsDoc, VaultDoc } from "../dist/kinds.js";
import { documentKinds } from "../dist/pack-shared.js";
import { openStore, readFamily } from "../dist/store.js";
import { listTar } from "./pack-support.mjs";
import { DEFINITION, scratch } from "./support.mjs";

const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const A = "https://app.acme.example";
const B = "https://billing.acme.example";
const OTHER = "https://other.example";
const KEY = localHostKey("host-1", Buffer.alloc(32, 1));
/** The tests' clock: every vault reads the time from it, so no cookie's expiry depends on the day the tests run. */
const NOW = () => T0;

/** Secret markers: no file, document, log, message or pack may hold one, in UTF-8 or UTF-16. */
const marker = (name) => `vault-secret-${name}-7f3a`;
const holds = (bytes, text) => [Buffer.from(text, "utf8"), Buffer.from(text, "utf16le")].some((needle) => bytes.includes(needle));
/** Every file of the agent directory: the store, its WAL and the key file included. */
const dirBytes = (dir) => Buffer.concat(readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => readFileSync(path.join(dir, entry.name))));

const cookie = (name, value, domain, extra = {}) => ({ name, value, domain, path: "/", httpOnly: true, secure: true, ...extra });
/** A local Chrome's session for app.acme.example, with one cookie and one item for another origin that a capture drops. */
const chromeState = () => ({
  kind: "cdp", capturedAt: new Date(T0).toISOString(),
  cookies: [
    cookie("sid", marker("session"), "app.acme.example"),
    cookie("remember", marker("persistent"), ".acme.example", { expires: (T0 + 10 * HOUR) / 1000, sameSite: "Lax" }),
    cookie("track", marker("elsewhere"), "other.example"),
  ],
  localStorage: { [A]: { token: marker("storage") }, [OTHER]: { token: marker("other-storage") } },
});

async function home(name = "home") {
  return createAgentHome(path.join(await scratch(), name), { definition: DEFINITION });
}
const clock = (start = T0) => { const c = { at: start, now: () => c.at }; return c; };
/** The stored row of `sessionKey`, read past the vault. */
async function rowOf(h, sessionKey) {
  const store = await openStore(path.join(h.dir, "agent.sqlite"));
  try { return (await readFamily(store, VaultDoc))[sessionKey]; } finally { await store.close(); }
}
/** Write `record` as `sessionKey`'s row past the vault: an old revision brought back, or a row tampered with. */
async function writeRow(h, sessionKey, record) {
  const store = await openStore(path.join(h.dir, "agent.sqlite"));
  try { await store.session.commit(async (tx) => { put(await tx.doc(VaultDoc, sessionKey, null), record); }, ctx); } finally { await store.close(); }
}
const keysOf = (h) => JSON.parse(readFileSync(path.join(h.dir, VAULT_KEYS_FILE), "utf8"));

/** What a session's row holds at rest, opened here with the host key's bytes: the test's own reading of the format. */
async function atRest(h, sessionKey, hostKeyBytes) {
  const unseal = (key, sealed, aad) => {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12)).setAAD(Buffer.from(aad));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
  };
  const keys = keysOf(h);
  const record = await rowOf(h, sessionKey);
  const agentId = h.identity.id;
  const homeKey = unseal(hostKeyBytes, Buffer.from(keys.homeKey.wrapped, "base64"), `host-key|${keys.hostKeyId}|home-key|${agentId}|${keys.homeKey.id}`);
  const itemKey = unseal(homeKey, Buffer.from(keys.items[record.keyId], "base64"), `item-key|${agentId}|${keys.homeKey.id}|${record.keyId}`);
  const sealed = Buffer.concat([Buffer.from(record.iv, "base64"), Buffer.from(record.ciphertext, "base64")]);
  return JSON.parse(unseal(itemKey, sealed, `vault|v1|${agentId}|${sessionKey}|${record.keyId}|${record.kind}`).toString("utf8"));
}

test("a local Chrome session and a provider context go in as ciphertext and come back for their origins; nothing readable is at rest", async (t) => {
  // An open umask, so the key file's mode is the vault's own choice.
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  const h = await home();
  const c = clock();
  const vault = sessionVault(h, { hostKey: KEY, now: c.now });
  await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  await vault.capture({ sessionKey: "acme-bb", origins: [A], state: { kind: "provider-context", capturedAt: new Date(T0).toISOString(), provider: "browserbase", contextId: marker("context") } });

  const restored = await vault.restore({ sessionKey: "acme", origins: [A] });
  assert.deepEqual(restored, {
    kind: "cdp", capturedAt: "2026-10-20T12:00:00.000Z",
    cookies: [cookie("sid", marker("session"), "app.acme.example"), cookie("remember", marker("persistent"), ".acme.example", { expires: (T0 + 10 * HOUR) / 1000, sameSite: "Lax" })],
    localStorage: { [A]: { token: marker("storage") } },
  }, "the cookie and the item of another origin were never kept");
  assert.deepEqual(await vault.restore({ sessionKey: "acme-bb", origins: [A] }), { kind: "provider-context", capturedAt: "2026-10-20T12:00:00.000Z", provider: "browserbase", contextId: marker("context") });
  assert.equal(await vault.restore({ sessionKey: "nobody", origins: [A] }), null);
  const kept = await atRest(h, "acme", Buffer.alloc(32, 1));
  assert.deepEqual([kept.cookies.map((k) => k.name), Object.keys(kept.localStorage)], [["sid", "remember"], [A]], "a capture keeps nothing of another origin");
  assert.deepEqual(new Set(vault.handedOut()), new Set([marker("session"), marker("persistent"), marker("storage"), marker("context")]));
  assert.deepEqual(await vault.list(), [
    { sessionKey: "acme", kind: "cdp", origins: [A], capturedAt: "2026-10-20T12:00:00.000Z" },
    { sessionKey: "acme-bb", kind: "provider-context", origins: [A], capturedAt: "2026-10-20T12:00:00.000Z", provider: "browserbase" },
  ]);

  const bytes = dirBytes(h.dir);
  for (const name of ["session", "persistent", "elsewhere", "storage", "other-storage", "context"]) assert.ok(!holds(bytes, marker(name)), `${name} is not in agent.sqlite, its WAL or ${VAULT_KEYS_FILE}`);
  assert.equal(statSync(path.join(h.dir, VAULT_KEYS_FILE)).mode & 0o777, 0o600);
  const keys = keysOf(h);
  assert.deepEqual(Object.keys(keys.items).sort(), [(await rowOf(h, "acme")).keyId, (await rowOf(h, "acme-bb")).keyId].sort(), "one item key per session");
  assert.equal(keys.hostKeyId, "host-1");
  assert.ok(SECRET_KINDS.includes("agent.vault"));
  assert.equal(projectForExport("agent.vault", await rowOf(h, "acme")), undefined);
});

test("the vault is bound to its host key: another key, or the right id with other bytes, opens nothing and says so by id only; a copied folder with the key works", async () => {
  const h = await home();
  await sessionVault(h, { hostKey: KEY, now: NOW }).capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  const other = localHostKey("host-2", Buffer.alloc(32, 1));
  await assert.rejects(sessionVault(h, { hostKey: other, now: NOW }).restore({ sessionKey: "acme", origins: [A] }), refused("key", /^the vault is bound to host key host-1; this host gave host-2$/));
  await assert.rejects(sessionVault(h, { hostKey: other, now: NOW }).capture({ sessionKey: "acme", origins: [A], state: chromeState() }), refused("key"));
  const forged = localHostKey("host-1", Buffer.alloc(32, 2));
  await assert.rejects(sessionVault(h, { hostKey: forged, now: NOW }).restore({ sessionKey: "acme", origins: [A] }), refused("key", /^the host key host-1 does not open this home's vault key$/));
  for (const bad of [undefined, {}, { id: "x" }, { id: "has space", wrap() {}, unwrap() {} }]) assert.throws(() => sessionVault(h, { hostKey: bad, now: NOW }), refused("invalid", /the host key is not/));
  assert.throws(() => localHostKey("k", Buffer.alloc(31)), refused("invalid", /32 bytes/));

  const copy = path.join(await scratch(), "copied");
  cpSync(h.dir, copy, { recursive: true });
  const moved = { dir: copy, identity: h.identity };
  assert.equal((await sessionVault(moved, { hostKey: KEY, now: NOW }).restore({ sessionKey: "acme", origins: [A] })).cookies.length, 2, "the folder and the host key are all another machine needs");
  await assert.rejects(sessionVault(moved, { hostKey: forged, now: NOW }).restore({ sessionKey: "acme", origins: [A] }), refused("key"));
});

test("forget destroys the session's key: its row goes, and its old revision, brought back, no longer decrypts; a recapture gets a new key and destroys the one before", async () => {
  const h = await home();
  const vault = sessionVault(h, { hostKey: KEY, now: NOW });
  await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  const first = await rowOf(h, "acme");
  await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  const second = await rowOf(h, "acme");
  assert.notEqual(second.keyId, first.keyId);
  assert.ok(!Object.hasOwn(keysOf(h).items, first.keyId), "a recapture destroys the key before it");
  await vault.capture({ sessionKey: "billing", origins: [B], state: { ...chromeState(), cookies: [cookie("sid", marker("billing"), "billing.acme.example")], localStorage: {} } });

  await vault.forget("acme");
  assert.equal(await rowOf(h, "acme"), undefined);
  assert.equal(await vault.restore({ sessionKey: "acme", origins: [A] }), null);
  assert.deepEqual(Object.keys(keysOf(h).items), [(await rowOf(h, "billing")).keyId], "only the key of the session that is left");
  assert.equal((await vault.restore({ sessionKey: "billing", origins: [B] })).cookies[0].value, marker("billing"));
  for (const old of [first, second]) {
    await writeRow(h, "acme", old);
    await assert.rejects(vault.restore({ sessionKey: "acme", origins: [A] }), refused("format", /the key of acme is not in vault.keys/), "the old revision is ciphertext with no key");
  }
  await vault.forget("never-saved");
});

test("forgetAll destroys every key and the home's vault key: nothing old decrypts, and the next capture binds a new vault key", async () => {
  const h = await home();
  const vault = sessionVault(h, { hostKey: KEY, now: NOW });
  await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  const old = await rowOf(h, "acme");
  const homeKeyId = keysOf(h).homeKey.id;
  await vault.forgetAll();
  assert.deepEqual(await vault.list(), []);
  assert.equal(existsSync(path.join(h.dir, VAULT_KEYS_FILE)), false);
  await writeRow(h, "acme", old);
  await assert.rejects(vault.restore({ sessionKey: "acme", origins: [A] }), refused("format", /vault.keys is missing/));
  await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  assert.notEqual(keysOf(h).homeKey.id, homeKeyId);
  await vault.forgetAll();
  await vault.forgetAll();
});

test("a session cookie comes back for at most 24 hours after its capture, or the host's lower cap; a persistent cookie keeps its own expiry", async () => {
  const h = await home();
  const c = clock();
  const vault = sessionVault(h, { hostKey: KEY, now: c.now });
  const state = { ...chromeState(), localStorage: {} };
  await vault.capture({ sessionKey: "acme", origins: [A], state });
  const names = async (v = vault) => (await v.restore({ sessionKey: "acme", origins: [A] }))?.cookies.map((k) => k.name) ?? null;
  c.at = T0 + 9 * HOUR;
  assert.deepEqual(await names(), ["sid", "remember"]);
  c.at = T0 + 23 * HOUR;
  assert.deepEqual(await names(), ["sid"], "the persistent cookie expired at 10 hours");
  c.at = T0 + MAX_SESSION_COOKIE_AGE_MS;
  assert.deepEqual(await names(), ["sid"], "24 hours to the millisecond");
  c.at = T0 + 25 * HOUR;
  assert.equal(await names(), null, "nothing left");
  c.at = T0 + 2 * HOUR;
  assert.deepEqual(await names(sessionVault(h, { hostKey: KEY, now: c.now, maxSessionCookieAgeMs: HOUR })), ["remember"], "a host's cap of one hour");
  assert.equal(MAX_SESSION_COOKIE_AGE_MS, 24 * HOUR);
  for (const cap of [0, -1, MAX_SESSION_COOKIE_AGE_MS + 1, Infinity, Number.NaN, "3600000"]) assert.throws(() => sessionVault(h, { hostKey: KEY, maxSessionCookieAgeMs: cap }), refused("invalid", /at most 86400000 \(24 hours\)/), String(cap));
  await vault.capture({ sessionKey: "cdp-minus-one", origins: [A], state: { ...state, cookies: [cookie("sid", "x", "app.acme.example", { expires: -1 })] } });
  c.at = T0 + 3 * HOUR;
  assert.deepEqual((await vault.restore({ sessionKey: "cdp-minus-one", origins: [A] })).cookies, [cookie("sid", "x", "app.acme.example")], "CDP's -1 is a session cookie: no expiry");
  c.at = T0 + 27 * HOUR;
  assert.equal(await vault.restore({ sessionKey: "cdp-minus-one", origins: [A] }), null, "and the cap ends it");
});

test("a restore never widens origins: the captured ones met by the requested ones; origins are scheme, host and port", async () => {
  const h = await home();
  const vault = sessionVault(h, { hostKey: KEY, now: NOW });
  const state = {
    kind: "cdp", capturedAt: new Date(T0).toISOString(),
    cookies: [cookie("a", "1", "app.acme.example"), cookie("b", "2", "billing.acme.example"), cookie("both", "3", ".acme.example")],
    localStorage: { [A]: { k: "a" }, [B]: { k: "b" } },
  };
  await vault.capture({ sessionKey: "acme", origins: [A, B], state });
  const only = await vault.restore({ sessionKey: "acme", origins: [A] });
  assert.deepEqual([only.cookies.map((k) => k.name), only.localStorage], [["a", "both"], { [A]: { k: "a" } }]);
  const wider = await vault.restore({ sessionKey: "acme", origins: [A, OTHER] });
  assert.deepEqual(wider, only, "another origin asked for adds nothing");
  assert.equal(await vault.restore({ sessionKey: "acme", origins: [OTHER] }), null);
  await vault.capture({ sessionKey: "narrow", origins: [A], state });
  assert.deepEqual((await vault.restore({ sessionKey: "narrow", origins: [A, B] })).cookies.map((k) => k.name), ["a", "both"], "only what was captured for A");
  for (const origins of [[], ["https://app.acme.example/path"], ["ftp://acme.example"], [""], "https://a.example", Array.from({ length: 65 }, (_, i) => `https://h${i}.example`)]) {
    await assert.rejects(vault.capture({ sessionKey: "x", origins, state }), refused("invalid"), JSON.stringify(origins).slice(0, 60));
  }
});

test("nothing of a saved session reaches a pack, a run's store or work files", async () => {
  const h = await home();
  await sessionVault(h, { hostKey: KEY, now: NOW }).capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  const run = await startRun(h, { runId: "r1", host: "laptop" });
  assert.ok(!(documentKinds(run.storePath) ?? []).includes("agent.vault"), "startRun seeds nothing from the vault");
  const runBytes = Buffer.concat([readFileSync(run.storePath), ...readdirSync(run.workspace, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(path.join(e.parentPath ?? e.path, e.name)))]);
  for (const name of ["session", "persistent", "storage"]) assert.ok(!holds(runBytes, marker(name)), name);

  const out = path.join(await scratch(), "home.agentpack");
  const { manifest } = await packHome(h, { out });
  assert.deepEqual(manifest.vault, [{ name: "acme" }], "the manifest names the session, nothing more");
  const members = listTar(out);
  assert.ok(!members.some((member) => path.basename(member.name) === VAULT_KEYS_FILE), "no key file in the pack");
  const packBytes = readFileSync(out);
  for (const name of ["session", "persistent", "storage"]) assert.ok(!holds(packBytes, marker(name)), name);
  const packedStore = path.join(await scratch(), "packed.sqlite");
  writeFileSync(packedStore, members.find((member) => member.name === "agent.sqlite").data);
  assert.ok(!documentKinds(packedStore).includes("agent.vault"), "the pack's agent store has no vault row");
});

test("no secret value reaches a log, an error's message or its stack, on any path, failing ones included", async () => {
  const h = await home();
  const said = [];
  const original = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((name) => [name, console[name]]));
  for (const name of Object.keys(original)) console[name] = (...args) => said.push(args.map(String).join(" "));
  const errors = [];
  const attempt = async (fn) => { try { await fn(); } catch (error) { errors.push(`${error.message}\n${error.stack}`); } };
  try {
    const vault = sessionVault(h, { hostKey: KEY, now: NOW });
    await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
    await vault.restore({ sessionKey: "acme", origins: [A] });
    await attempt(() => sessionVault(h, { hostKey: localHostKey("host-1", Buffer.alloc(32, 9)) }).restore({ sessionKey: "acme", origins: [A] }));
    const row = await rowOf(h, "acme");
    await writeRow(h, "acme", { ...row, ciphertext: Buffer.from(Buffer.from(row.ciphertext, "base64").map((b, i) => (i === 5 ? b ^ 1 : b))).toString("base64") });
    await attempt(() => vault.restore({ sessionKey: "acme", origins: [A] }));
    await attempt(() => vault.capture({ sessionKey: "bad", origins: [A], state: { ...chromeState(), cookies: [{ name: "sid", value: marker("session"), path: "/", httpOnly: true, secure: true }] } }));
    await attempt(() => vault.capture({ sessionKey: "bad", origins: [A], state: { ...chromeState(), cookies: [cookie("sid", marker("session"), "app.acme.example", { sameSite: marker("persistent") })] } }));
    await attempt(() => vault.capture({ sessionKey: "bad", origins: [A], state: { ...chromeState(), localStorage: { [A]: { token: 7, other: marker("storage") } } } }));
    await attempt(() => vault.capture({ sessionKey: "bad", origins: [A], state: { kind: "provider-context", provider: "browserbase", contextId: marker("context").repeat(40) } }));
    await attempt(() => vault.capture({ sessionKey: "big", origins: [A], state: { ...chromeState(), localStorage: { [A]: { big: marker("storage").repeat(60_000) } } } }));
    await vault.forget("acme");
  } finally {
    Object.assign(console, original);
  }
  assert.equal(errors.length, 7, errors.join("\n---\n"));
  const text = [...said, ...errors].join("\n");
  for (const name of ["session", "persistent", "storage", "context"]) assert.ok(!text.includes(marker(name)), `${name} is not in any log or error`);
});

test("a session key is 1 to 128 of letters, digits, _, ., : or -, starting with a letter or digit, as pi-browser's vault side takes one; anything else is refused before the home is touched", async () => {
  const h = await home();
  const vault = sessionVault(h, { hostKey: KEY, now: NOW });
  for (const sessionKey of ["local-chrome", "acme.example", "profile:1", "a_b", "x".repeat(128)]) await vault.capture({ sessionKey, origins: [A], state: chromeState() });
  for (const sessionKey of ["", "x".repeat(129), "-lead", "_lead", ".lead", ":lead", "has space", "a/b", "ü", "tab\there", "new\nline", 7, undefined]) {
    await assert.rejects(vault.capture({ sessionKey, origins: [A], state: chromeState() }), refused("invalid", /the session key is not 1 to 128 of letters, digits/), JSON.stringify(sessionKey));
    await assert.rejects(vault.restore({ sessionKey, origins: [A] }), refused("invalid"), JSON.stringify(sessionKey));
    await assert.rejects(vault.forget(sessionKey), refused("invalid"), JSON.stringify(sessionKey));
  }
  assert.equal((await vault.list()).length, 5);
});

test("a capture is dated by its state's capturedAt: an older one never replaces a newer session, an equal one does, a time to come counts as now, and one that is not a time is refused", async () => {
  const h = await home();
  const c = clock(T0 + 2 * HOUR);
  const vault = sessionVault(h, { hostKey: KEY, now: c.now });
  const at = (ms, value) => ({ ...chromeState(), capturedAt: new Date(ms).toISOString(), cookies: [cookie("sid", value, "app.acme.example")], localStorage: {} });
  const value = async () => (await vault.restore({ sessionKey: "acme", origins: [A] })).cookies[0].value;
  await vault.capture({ sessionKey: "acme", origins: [A], state: at(T0 + HOUR, "newer") });
  const kept = await rowOf(h, "acme");
  assert.equal(kept.capturedAt, new Date(T0 + HOUR).toISOString(), "dated when the browser was read, not when the capture arrived");
  const keys = readFileSync(path.join(h.dir, VAULT_KEYS_FILE), "utf8");
  await vault.capture({ sessionKey: "acme", origins: [A], state: at(T0, "older") });
  assert.deepEqual(await rowOf(h, "acme"), kept, "the older capture changed nothing");
  assert.equal(readFileSync(path.join(h.dir, VAULT_KEYS_FILE), "utf8"), keys, "not even the key file");
  assert.equal(await value(), "newer");
  await vault.capture({ sessionKey: "acme", origins: [A], state: at(T0 + HOUR, "same time") });
  assert.equal(await value(), "same time", "a capture as new as the kept one replaces it");
  await vault.capture({ sessionKey: "acme", origins: [A], state: at(T0 + 50 * HOUR, "future") });
  assert.equal((await rowOf(h, "acme")).capturedAt, new Date(T0 + 2 * HOUR).toISOString(), "a time still to come counts as now, so no cookie outlives the cap");
  for (const capturedAt of ["yesterday", "7", undefined, 7, "2026-13-45T99:99"]) {
    await assert.rejects(vault.capture({ sessionKey: "acme", origins: [A], state: { ...at(T0, "x"), capturedAt } }), refused("invalid", /capturedAt is not an ISO 8601 time/), String(capturedAt));
  }
  assert.equal(await value(), "future");
});

test("a changed ciphertext, or one moved to another session's row, is refused and never decrypts to the wrong session", async () => {
  const h = await home();
  const vault = sessionVault(h, { hostKey: KEY, now: NOW });
  await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  await vault.capture({ sessionKey: "billing", origins: [A], state: { ...chromeState(), cookies: [cookie("sid", marker("billing"), "app.acme.example")], localStorage: {} } });
  const acme = await rowOf(h, "acme");
  await writeRow(h, "billing", { ...(await rowOf(h, "billing")), keyId: acme.keyId, iv: acme.iv, ciphertext: acme.ciphertext });
  await assert.rejects(vault.restore({ sessionKey: "billing", origins: [A] }), refused("format", /does not decrypt: it was changed, or moved from another row/));
  await writeRow(h, "acme", { ...acme, kind: "provider-context" });
  await assert.rejects(vault.restore({ sessionKey: "acme", origins: [A] }), refused("format", /does not decrypt/), "the kind is bound too");
  await writeRow(h, "acme", { ...acme, iv: Buffer.alloc(12).toString("base64") });
  await assert.rejects(vault.restore({ sessionKey: "acme", origins: [A] }), refused("format", /does not decrypt/));
});

test("a key no session names, left by a write that stopped between the key file and the store, is dropped at the next write", async () => {
  const h = await home();
  const vault = sessionVault(h, { hostKey: KEY, now: NOW });
  await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  const keys = keysOf(h);
  writeFileSync(path.join(h.dir, VAULT_KEYS_FILE), JSON.stringify({ ...keys, items: { ...keys.items, orphan: keys.items[(await rowOf(h, "acme")).keyId] } }), { mode: 0o600 });
  assert.equal((await vault.restore({ sessionKey: "acme", origins: [A] })).cookies.length, 2, "an orphan changes nothing that is read");
  await vault.capture({ sessionKey: "billing", origins: [B], state: { ...chromeState(), cookies: [cookie("sid", "b", "billing.acme.example")], localStorage: {} } });
  assert.ok(!Object.hasOwn(keysOf(h).items, "orphan"));
  writeFileSync(path.join(h.dir, VAULT_KEYS_FILE), "{ not json");
  await assert.rejects(vault.restore({ sessionKey: "acme", origins: [A] }), refused("format", /vault.keys is not JSON/));
});

test("with a run id, a capture is refused while another live run holds the session's save lease, and goes on once that run has ended", async () => {
  const h = await home();
  await startRun(h, { runId: "mine", host: "laptop" });
  const store = await openStore(path.join(h.dir, "agent.sqlite"));
  try {
    await store.session.commit(async (tx) => {
      put(await tx.doc(RunsDoc, "theirs", null), { path: "runs/theirs", host: "laptop", startedAt: new Date().toISOString() });
      put(await tx.doc(LeasesDoc, "acme", null), { runId: "theirs", expiresAt: new Date(T0 + HOUR).toISOString() });
    }, ctx);
  } finally { await store.close(); }
  const capture = (runId) => sessionVault(h, { hostKey: KEY, runId, now: NOW }).capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  await assert.rejects(capture("mine"), refused("busy", /^the save lease for acme is held by run theirs$/));
  await assert.rejects(capture("ghost"), refused("invalid", /ghost is not a run of this agent/));
  await capture("theirs");
  await capture(undefined);
  await sessionVault(h, { hostKey: KEY, runId: "mine", now: NOW }).capture({ sessionKey: "free", origins: [A], state: chromeState() });
  const ended = await openStore(path.join(h.dir, "agent.sqlite"));
  try {
    await ended.session.commit(async (tx) => { put(await tx.doc(RunsDoc, "theirs", null), { path: "runs/theirs", host: "laptop", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), outcome: "completed" }); }, ctx);
  } finally { await ended.close(); }
  await capture("mine");
  assert.deepEqual((await sessionVault(h, { hostKey: KEY, now: NOW }).list()).map((entry) => entry.sessionKey).sort(), ["acme", "free"]);
});

test("on a home reached through an access (a disk), the key file lives in the claimed directory beside agent.sqlite and changes only inside the claim", async () => {
  const h = await home();
  const file = path.join(h.dir, VAULT_KEYS_FILE);
  const snapshot = () => (existsSync(file) ? `${readFileSync(file, "utf8")}@${statSync(file).mtimeMs}` : "absent");
  let claims = 0;
  let atExit = null;
  const access = {
    claim: async (fn) => {
      claims++;
      if (atExit !== null) assert.equal(snapshot(), atExit, "the key file did not change between claims");
      try { return await fn(h.dir); } finally { atExit = snapshot(); }
    },
    runStore: async (run) => path.join(h.dir, run.path, "store", "run.sqlite"),
  };
  const elsewhere = { dir: path.join(await scratch(), "not-the-home"), identity: h.identity };
  const vault = sessionVault(elsewhere, { hostKey: KEY, access, now: NOW });
  await vault.capture({ sessionKey: "acme", origins: [A], state: chromeState() });
  const written = snapshot();
  assert.notEqual(written, "absent");
  assert.equal((await vault.restore({ sessionKey: "acme", origins: [A] })).cookies.length, 2);
  await vault.forget("acme");
  assert.notEqual(snapshot(), written, "the forget rewrote it, inside its claim");
  await vault.list();
  assert.equal(claims, 4, "every call went through the claim");
  assert.equal(existsSync(path.join(elsewhere.dir, VAULT_KEYS_FILE)), false, "nothing is written at home.dir");
});

const SUB = "https://sub.app.acme.example";

test("a host-only cookie is kept and restored for its own host only; a domain cookie (a leading dot) for its host and every host under it", async () => {
  const h = await home();
  const vault = sessionVault(h, { hostKey: KEY, now: NOW });
  const state = {
    kind: "cdp", capturedAt: new Date(T0).toISOString(),
    cookies: [cookie("parent", marker("parent"), "app.acme.example"), cookie("wide", "w", ".app.acme.example"), cookie("own", "o", "sub.app.acme.example")],
    localStorage: {},
  };
  await vault.capture({ sessionKey: "sub", origins: [SUB], state });
  assert.deepEqual((await atRest(h, "sub", Buffer.alloc(32, 1))).cookies.map((k) => k.name), ["wide", "own"], "the parent's host-only cookie is never kept for a child origin");
  assert.deepEqual((await vault.restore({ sessionKey: "sub", origins: [SUB] })).cookies.map((k) => k.name), ["wide", "own"]);

  await vault.capture({ sessionKey: "both", origins: [A, SUB], state });
  assert.deepEqual((await vault.restore({ sessionKey: "both", origins: [SUB] })).cookies.map((k) => k.name), ["wide", "own"], "nor restored to one");
  assert.deepEqual((await vault.restore({ sessionKey: "both", origins: [A] })).cookies.map((k) => k.name), ["parent", "wide"], "a host-only cookie goes to its own host, and a child's does not go up");
});
