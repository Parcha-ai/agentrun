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

test("with no seal key the sealed settings are not read, said once; a set is refused no_sealing_key", async (t) => {
  const { store } = await storeOn(t);
  const kept = sealedSettingsOverStore(store, "slackish", spec, KEY, () => {});
  await kept.load();
  await kept.set("server", "token", "a-long-enough-token");
  const said = [];
  const noKey = sealedSettingsOverStore(store, "slackish", spec, undefined, (f) => said.push(f));
  await noKey.load();
  assert.deepEqual(said.map((s) => [s.condition, s.adapter]), [["trigger_settings_no_seal_key", "slackish"]], "one line, not a value");
  assert.equal(noKey.get("server", "token"), undefined, "not read");
  await assert.rejects(() => noKey.set("server", "token", "another-token"), (e) => e.code === "no_sealing_key");
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
