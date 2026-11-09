// A trigger source's sealed settings over the store (sealed-settings-store.ts): a given value is kept sealed in a row and
// read back, here and in the next store; one under its field's floor is refused (422) before anything is written; with no
// seal key none is read. And openServerSecretsOverStore wires each adapter's store settings into the server's redaction
// list, the deleted door token no longer a source. A real store on a temp file.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { sealedSettingsOverStore } from "../dist/sealed-settings-store.js";
import { openServerSecretsOverStore } from "../dist/server-secrets-store.js";
import { MIN_KEY_BYTES, signatureOf, verify } from "../dist/standard-webhooks.js";

const spec = { scope: "server", fields: { signing: { minBytes: MIN_KEY_BYTES }, token: {} } };
const KEY = randomBytes(32);

test("set keeps a value sealed in a row and reads it back, here and in the next store; a value under its floor is 422, nothing written", async (t) => {
  const { store } = await storeOn(t);
  const said = [];
  const settings = sealedSettingsOverStore(store, "slackish", spec, KEY, (f) => said.push(f));
  await settings.load();
  const signing = `whsec_${randomBytes(32).toString("base64")}`;
  await settings.set("server", "signing", signing);
  await settings.set("server", "token", "a-token-with-no-floor");
  assert.deepEqual([settings.get("server", "signing"), settings.get("server", "token")], [signing, "a-token-with-no-floor"]);
  const rows = await store.triggerSettings.get("slackish");
  assert.ok(!JSON.stringify(rows).includes(signing.slice("whsec_".length)) && !JSON.stringify(rows).includes("a-token-with-no-floor"), "only sealed in the rows");
  await assert.rejects(() => settings.set("server", "signing", `whsec_${randomBytes(MIN_KEY_BYTES - 1).toString("base64")}`), (e) => e.code === "input_invalid" && e.extra.fields[0].reason === "too_short");
  assert.equal(settings.get("server", "signing"), signing, "the kept value stands");
  const next = sealedSettingsOverStore(store, "slackish", spec, KEY, (f) => said.push(f));
  await next.load();
  assert.deepEqual([next.get("server", "signing"), next.get("server", "token")], [signing, "a-token-with-no-floor"], "the next store reads them back");
  assert.deepEqual(said, [], "nothing to say");
});

test("a verification key is kept only as a whsec_ secret: a raw key is 422; a whsec_ one verifies", async (t) => {
  const { store } = await storeOn(t);
  const settings = sealedSettingsOverStore(store, "slackish", spec, KEY, () => {});
  await settings.load();
  await assert.rejects(() => settings.set("server", "signing", randomBytes(32).toString("base64")), (e) => e.code === "input_invalid" && e.extra.fields[0].reason === "invalid");
  assert.equal(settings.get("server", "signing"), undefined, "nothing kept");
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  await settings.set("server", "signing", secret);
  const [id, at, body] = ["msg_1", String(Math.floor(Date.now() / 1000)), Buffer.from("{}")];
  assert.equal(verify(settings.get("server", "signing"), { "webhook-id": id, "webhook-timestamp": at, "webhook-signature": signatureOf(secret, id, at, body) }, body, Date.now()), undefined, "it verifies");
});

test("a given value the redaction would pass over is refused, 422: whitespace in it, or under 8 bytes", async (t) => {
  const { store } = await storeOn(t);
  const settings = sealedSettingsOverStore(store, "slackish", spec, KEY, () => {});
  await settings.load();
  for (const value of [" x", "short", "a token with spaces in it", "tab\there-and-long"]) {
    await assert.rejects(() => settings.set("server", "token", value), (e) => e.code === "input_invalid" && e.extra.fields[0].field === "token", JSON.stringify(value));
  }
  assert.equal(settings.get("server", "token"), undefined, "nothing kept");
});

test("mint writes a new secret sealed and returns it once; remove drops a scope's rows", async (t) => {
  const { store } = await storeOn(t);
  const triggerSpec = { scope: "trigger", fields: { secret: { mint: true, minBytes: MIN_KEY_BYTES }, token: {} } };
  const settings = sealedSettingsOverStore(store, "slackish", triggerSpec, KEY, () => {});
  await settings.load();
  const minted = await settings.mint("trg_1", "secret");
  assert.ok(minted.startsWith("whsec_"), "a Standard Webhooks secret");
  assert.equal(settings.get("trg_1", "secret"), minted);
  await settings.remove("trg_1");
  assert.equal(settings.get("trg_1", "secret"), undefined, "gone");
  assert.equal((await store.triggerSettings.get("slackish")).length, 0, "the row is gone");
  assert.ok(settings.values().includes(minted), "but the rotated value is still redacted this process's life");
});

test("a value sealed under another seal key does not open here: unset, marked unopened and said once, until it is set again; removing its scope drops its rows", async (t) => {
  const { store } = await storeOn(t);
  const minting = { scope: "trigger", fields: { secret: { mint: true, minBytes: MIN_KEY_BYTES } } };
  const before = sealedSettingsOverStore(store, "hookish", minting, randomBytes(32), () => {});
  await before.load();
  await before.mint("trg_one", "secret");
  await before.mint("trg_two", "secret");
  const said = [];
  const here = sealedSettingsOverStore(store, "hookish", minting, KEY, (f) => said.push(f));
  await here.load();
  assert.equal(here.get("trg_one", "secret"), undefined, "unset here");
  assert.deepEqual([here.unopenedAt("trg_one", "secret"), here.unopenedAt("trg_none", "secret")], [true, false]);
  assert.deepEqual(said.map((f) => [f.condition, f.scope]), [["trigger_setting_unopened", "trg_one"], ["trigger_setting_unopened", "trg_two"]]);
  const fresh = await here.mint("trg_one", "secret");
  assert.deepEqual([here.get("trg_one", "secret"), here.unopenedAt("trg_one", "secret")], [fresh, false], "a new one opens");
  await here.remove("trg_two");
  assert.equal(here.unopenedAt("trg_two", "secret"), false);
  assert.deepEqual((await store.triggerSettings.get("hookish")).map((row) => row.scope), ["trg_one"], "the unopened scope's rows went with it");
});

test("openServerSecretsOverStore wires each adapter's store settings into the redaction list", async (t) => {
  const { store } = await storeOn(t);
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "server-secrets-store-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const adapters = [{ id: "slackish", settings: spec }];
  const { secrets, settings } = await openServerSecretsOverStore(store, data, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, adapters, () => {});
  const slack = settings.get("slackish");
  assert.ok(slack, "the adapter's settings are returned");
  await slack.set("server", "token", "a-secret-bot-token-value");
  assert.ok(secrets.values().includes("a-secret-bot-token-value"), "the set value is in the redaction list");
});

const { privateKey: PEM_KEY } = (await import("node:crypto")).generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const appSpec = { scope: "server", fields: { app_id: { public: true }, installations: { public: true }, private_key: { format: "pem" }, webhook_secret: {} } };

test("a public field is kept sealed of any length and whitespace, and never listed as a secret; a PEM field takes only a PEM key and lists it whole and by its lines", async (t) => {
  const { store } = await storeOn(t);
  const settings = sealedSettingsOverStore(store, "github", appSpec, KEY, () => {});
  await settings.load();
  await settings.set("server", "app_id", "42");
  await settings.set("server", "installations", '[{"id":7, "account":"acme"}]');
  await settings.set("server", "private_key", PEM_KEY);
  await settings.set("server", "webhook_secret", "a-webhook-secret-of-the-app");
  await assert.rejects(() => settings.set("server", "private_key", "not a key"), (e) => e.code === "input_invalid" && e.extra.fields[0].field === "private_key");
  assert.equal(settings.get("server", "app_id"), "42");
  assert.deepEqual(settings.values(), ["a-webhook-secret-of-the-app"], "public fields and the PEM key are not in the floored list");
  const lines = PEM_KEY.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("-----"));
  assert.deepEqual(settings.pemValues(), [PEM_KEY, ...lines], "the key whole and each base64 line, the short last one too");
  const next = sealedSettingsOverStore(store, "github", appSpec, KEY, () => {});
  await next.load();
  assert.equal(next.get("server", "private_key"), PEM_KEY, "read back in the next store");
  await next.remove("server");
  assert.deepEqual(next.pemValues(), [PEM_KEY, ...lines], "a removed key is still listed");
});

test("openServerSecretsOverStore lists a PEM key whole and by its lines, with no floor", async (t) => {
  const { store } = await storeOn(t);
  const data = await mkdtemp(join(tmpdir(), "sss-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const adapters = [{ id: "github", settings: appSpec }];
  const { secrets, settings } = await openServerSecretsOverStore(store, data, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, adapters, () => {});
  await settings.get("github").set("server", "private_key", PEM_KEY);
  const last = PEM_KEY.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("-----")).at(-1);
  assert.ok(secrets.values().includes(PEM_KEY) && secrets.values().includes(last), "whole, and the short last line");
});
