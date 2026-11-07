// A trigger source's sealed settings (sealed-settings.ts): a given value is kept sealed and read back; one under its
// field's floor is refused (422) before anything is written; a file that does not read is never written over.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SealedSettings, settingsFile } from "../dist/sealed-settings.js";
import { openServerSecrets } from "../dist/server-secrets.js";
import { MIN_KEY_BYTES, signatureOf, verify } from "../dist/standard-webhooks.js";
import { TRIGGER_ADAPTERS } from "../dist/trigger-adapters.js";

const spec = { scope: "server", fields: { signing: { minBytes: MIN_KEY_BYTES }, token: {} } };

async function dir(t) {
  const data = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "sealed-settings-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  return data;
}

test("set keeps a given value sealed and reads it back, here and in the next store; one under its field's floor is refused, 422, and nothing is written", async (t) => {
  const data = await dir(t);
  const key = randomBytes(32);
  const said = [];
  const store = new SealedSettings(data, "slackish", spec, key, (fields) => said.push(fields));
  const signing = `whsec_${randomBytes(32).toString("base64")}`;
  store.set("server", "signing", signing);
  store.set("server", "token", "a-token-with-no-floor");
  assert.deepEqual([store.get("server", "signing"), store.get("server", "token")], [signing, "a-token-with-no-floor"]);
  const file = join(data, settingsFile("slackish"));
  const written = await readFile(file, "utf8");
  assert.ok(!written.includes(signing.slice("whsec_".length)) && !written.includes("a-token-with-no-floor"), "only sealed");
  assert.throws(() => store.set("server", "signing", `whsec_${randomBytes(MIN_KEY_BYTES - 1).toString("base64")}`), (error) => error.code === "input_invalid" && error.extra.fields[0].reason === "too_short");
  assert.equal(await readFile(file, "utf8"), written, "nothing written for the refused value");
  assert.equal(store.get("server", "signing"), signing, "the kept value stands");
  const next = new SealedSettings(data, "slackish", spec, key, (fields) => said.push(fields));
  assert.deepEqual([next.get("server", "signing"), next.get("server", "token")], [signing, "a-token-with-no-floor"]);
  assert.deepEqual(said, [], "nothing to say");
});

test("a settings file that does not read is said, never written over: set and mint are refused, store_unreadable", async (t) => {
  const data = await dir(t);
  const file = join(data, settingsFile("slackish"));
  await writeFile(file, "{ not json");
  const said = [];
  const store = new SealedSettings(data, "slackish", { scope: "trigger", fields: { secret: { mint: true, minBytes: MIN_KEY_BYTES }, token: {} } }, randomBytes(32), (fields) => said.push(fields));
  assert.equal(said[0]?.condition, "trigger_settings_unreadable");
  assert.throws(() => store.set("trg_1", "token", "a-long-enough-token"), (error) => error.code === "store_unreadable");
  assert.throws(() => store.mint("trg_1", "secret"), (error) => error.code === "store_unreadable");
  store.remove("trg_1");
  assert.equal(await readFile(file, "utf8"), "{ not json", "byte for byte");
});

test("a verification key is kept only as a whsec_ secret: a raw key is refused, 422, so none is stored that would refuse every request; a whsec_ one verifies", async (t) => {
  const data = await dir(t);
  const store = new SealedSettings(data, "slackish", spec, randomBytes(32), () => {});
  const raw = randomBytes(32).toString("base64");
  assert.throws(() => store.set("server", "signing", raw), (error) => error.code === "input_invalid" && error.extra.fields[0].reason === "invalid");
  assert.equal(store.get("server", "signing"), undefined, "nothing kept");
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  store.set("server", "signing", secret);
  const [id, at, body] = ["msg_1", String(Math.floor(Date.now() / 1000)), Buffer.from("{}")];
  assert.equal(verify(store.get("server", "signing"), { "webhook-id": id, "webhook-timestamp": at, "webhook-signature": signatureOf(secret, id, at, body) }, body, Date.now()), undefined, "it verifies");
});

test("a given value the redaction of the server's secrets would pass over is refused, 422: whitespace in it, or under 8 bytes", async (t) => {
  const data = await dir(t);
  const store = new SealedSettings(data, "slackish", spec, randomBytes(32), () => {});
  for (const value of [" x", "short", "a token with spaces in it", "tab\there-and-long"]) {
    assert.throws(() => store.set("server", "token", value), (error) => error.code === "input_invalid" && error.extra.fields[0].field === "token", JSON.stringify(value));
  }
  assert.equal(store.get("server", "token"), undefined, "nothing kept");
});

test("at the open, a server with no seal key says once that the sealed settings it holds are not read, and a leftover trigger-secrets.json is said with what to do", async (t) => {
  const data = await dir(t);
  const key = randomBytes(32);
  const kept = new SealedSettings(data, "slackish", spec, key, () => {});
  kept.set("server", "token", "a-long-enough-token");
  kept.set("server", "signing", `whsec_${randomBytes(32).toString("base64")}`);
  const said = [];
  new SealedSettings(data, "slackish", spec, undefined, (fields) => said.push(fields));
  assert.deepEqual(said.map((s) => [s.condition, s.adapter]), [["trigger_settings_no_seal_key", "slackish"]], "one line for the store, not one a value");
  await writeFile(join(data, "trigger-secrets.json"), `${JSON.stringify({ v: 1, secrets: { trg_1: "sealed" } })}\n`);
  const opened = [];
  openServerSecrets(data, { AGENTRUN_SEAL_KEY: key.toString("base64") }, TRIGGER_ADAPTERS, (fields) => opened.push(fields));
  const leftover = opened.filter((s) => s.condition === "trigger_secrets_left_over");
  assert.equal(leftover.length, 1, JSON.stringify(opened));
  assert.match(leftover[0].file, /trigger-secrets\.json$/);
  assert.match(leftover[0].effect, /POST \/v2\/triggers\/\{id\}\/secret/);
});
