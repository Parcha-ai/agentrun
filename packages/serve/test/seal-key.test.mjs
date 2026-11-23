// The server never starts without a seal key (seal-key.ts): AGENTRUN_SEAL_KEY, or the one in seal/seal.key in the data
// directory, beside the store, made there at the first start, 32 random bytes in base64, 0600 in a 0700 directory, with
// only its path printed. A key file or directory another user can read is refused, never changed; a linked directory is
// refused; the file is made whole beside its name, then linked, so two starts read one key. (What the store records of
// the key, and the refusals it brings: seal-key-store.test.mjs.)
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scratch } from "./support.mjs";

async function sealKey() {
  try {
    return await import("../dist/seal-key.js");
  } catch {
    return undefined;
  }
}

test("a given AGENTRUN_SEAL_KEY is the key; nothing is written", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const home = await scratch(t);
  const given = randomBytes(32).toString("base64");
  const got = mod.ensureSealKey(given, { dataDir: home });
  assert.deepEqual([got.text, got.path, got.generated], [given, null, false]);
  assert.equal(got.key.length, 32);
  assert.throws(() => mod.ensureSealKey("not-base64-32", { dataDir: home }), mod.SealKeyRefused, "a key that isn't 32 bytes in base64 is refused");
});

test("with none given: made in the data directory at the first start, 0600 in a 0700 directory, path only; the same key read at the next", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const home = await scratch(t);
  const first = mod.ensureSealKey(undefined, { dataDir: home });
  assert.equal(first.generated, true);
  assert.equal(first.path, join(home, "seal", "seal.key"));
  assert.equal(statSync(first.path).mode & 0o777, 0o600, "the file is 0600");
  assert.equal(statSync(join(home, "seal")).mode & 0o777, 0o700, "its directory is 0700");
  assert.equal(readFileSync(first.path, "utf8").trim(), first.text);
  assert.equal(first.key.length, 32);
  const again = mod.ensureSealKey(undefined, { dataDir: home });
  assert.deepEqual([again.text, again.generated], [first.text, false], "the next start reads it, makes none");
  assert.equal(mod.sealKeyLine(first).includes(first.text), false, "the line printed names the path, never the key");
  assert.ok(mod.sealKeyLine(first).includes(first.path), "it names the path");
  assert.match(mod.sealKeyLine(first), /back it up with the data/i, "it says to back it up with the data, never apart from it");
});

test("a plain mkdir's directory (0755) with no key yet is tightened to 0700 before the key is made", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const home = await scratch(t);
  mkdirSync(join(home, "seal"), { mode: 0o755 });
  chmodSync(join(home, "seal"), 0o755);
  const got = mod.ensureSealKey(undefined, { dataDir: home });
  assert.equal(got.generated, true);
  assert.equal(statSync(join(home, "seal")).mode & 0o777, 0o700);
});

test("a key another user can read, or one in a directory they can, is refused, never changed; a linked directory is refused", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const home = await scratch(t);
  const dir = join(home, "seal");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "seal.key"), `${randomBytes(32).toString("base64")}\n`, { mode: 0o644 });
  chmodSync(join(dir, "seal.key"), 0o644);
  assert.throws(() => mod.ensureSealKey(undefined, { dataDir: home }), mod.SealKeyRefused, "a group- or world-readable key");
  assert.equal(statSync(join(dir, "seal.key")).mode & 0o777, 0o644, "never changed");
  chmodSync(join(dir, "seal.key"), 0o600);
  chmodSync(dir, 0o750);
  assert.throws(() => mod.ensureSealKey(undefined, { dataDir: home }), mod.SealKeyRefused, "a key in a directory another user can read");
  chmodSync(dir, 0o700);
  const linked = await scratch(t);
  mkdirSync(join(linked, "real"), { mode: 0o700 });
  symlinkSync(join(linked, "real"), join(linked, "seal"));
  assert.throws(() => mod.ensureSealKey(undefined, { dataDir: linked }), mod.SealKeyRefused, "a linked directory");
});

test("no seal key and nowhere to keep one: refused in words, never a start without one", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  // A data directory that is a file: no directory can be made in it.
  const file = join(await scratch(t), "not-a-dir");
  writeFileSync(file, "x");
  assert.throws(() => mod.ensureSealKey(undefined, { dataDir: file }), (error) => error instanceof mod.SealKeyRefused && /AGENTRUN_SEAL_KEY/.test(error.message));
  // Its key's place a file: refused the same.
  const data = await scratch(t);
  writeFileSync(join(data, "seal"), "x");
  assert.throws(() => mod.ensureSealKey(undefined, { dataDir: data }), mod.SealKeyRefused);
});

test("a key of the wrong shape is refused with the length it wants and the length it has, never its value", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const wants = "43 characters, or 44 ending in =";
  // What a host's generator makes when it counts bytes, not characters: 43 random bytes are 60 base64 characters.
  const long = randomBytes(43).toString("base64");
  const short = randomBytes(24).toString("base64");
  const wrongForm = `${randomBytes(32).toString("base64").slice(0, 42)}.`;
  const said = (error) => String(error.message);
  const refusedFor = (key, length) => (error) => {
    assert.ok(error instanceof mod.SealKeyRefused, said(error));
    assert.ok(said(error).includes(`AGENTRUN_SEAL_KEY is set but is not 32 bytes in base64 (${wants}; it has ${length}`), said(error));
    assert.equal(said(error).split(key).length - 1, 0, "the key's value is never in the refusal");
    return true;
  };
  const home = await scratch(t);
  assert.throws(() => mod.ensureSealKey(long, { dataDir: home }), refusedFor(long, 60));
  assert.throws(() => mod.ensureSealKey(short, { dataDir: home }), refusedFor(short, 32));
  assert.throws(() => mod.ensureSealKey(wrongForm, { dataDir: home }), refusedFor(wrongForm, "43, but not in that form"));
  // The start's path, over a store that holds nothing yet: the same words.
  const empty = { settings: { get: async () => undefined }, sealedSecrets: { all: async () => [] } };
  await assert.rejects(mod.bootSealKey(empty, await scratch(t), { given: long, say: () => {} }), refusedFor(long, 60));
  // A kept key file that holds no key: its length too, never its text.
  const data = await scratch(t);
  mkdirSync(join(data, "seal"), { mode: 0o700 });
  writeFileSync(join(data, "seal", "seal.key"), `${long}\n`, { mode: 0o600 });
  assert.throws(() => mod.ensureSealKey(undefined, { dataDir: data }), (error) => {
    assert.ok(error instanceof mod.SealKeyRefused, said(error));
    assert.ok(said(error).includes(`seal.key holds a key that is not 32 bytes in base64 (${wants}; it has 60)`), said(error));
    assert.equal(said(error).split(long).length - 1, 0, "the key's value is never in the refusal");
    return true;
  });
});

/** A refusal that names the one handed by its length, never its value. */
const saysHanded = (words, key) => (error) => {
  const said = String(error.message);
  assert.ok(said.includes(words), said);
  assert.equal(said.split(key).length - 1, 0, "the key's value is never in the refusal");
  return true;
};
const SHAPE_60 = "the one handed is not 32 bytes in base64 (43 characters, or 44 ending in =; it has 60)";

test("tool keys' store tells a malformed AGENTRUN_SEAL_KEY from none, by length, never value", async () => {
  const { toolKeysOverStore } = await import("../dist/tool-keys-store.js");
  // The key is checked before the store is touched.
  for (const env of [{}, { AGENTRUN_SEAL_KEY: " " }]) {
    assert.throws(() => toolKeysOverStore({}, env, () => {}), /tool keys are kept under the server's seal key \(AGENTRUN_SEAL_KEY\), and none was handed over: the server does not start without one/);
  }
  const long = randomBytes(43).toString("base64");
  assert.throws(() => toolKeysOverStore({}, { AGENTRUN_SEAL_KEY: long }, () => {}), saysHanded(`tool keys are kept under the server's seal key (AGENTRUN_SEAL_KEY), and ${SHAPE_60}: the server does not start with it`, long));
});

test("the server's own secrets' store tells a malformed AGENTRUN_SEAL_KEY from none, by length, never value", async () => {
  const { openServerSecretsOverStore } = await import("../dist/server-secrets-store.js");
  for (const env of [{}, { AGENTRUN_SEAL_KEY: "" }]) {
    await assert.rejects(openServerSecretsOverStore({}, "/nowhere", env, []), /the server starts with its seal key \(AGENTRUN_SEAL_KEY\), made at the first start when none is handed over/);
  }
  const long = randomBytes(43).toString("base64");
  await assert.rejects(openServerSecretsOverStore({}, "/nowhere", { AGENTRUN_SEAL_KEY: long }, []), saysHanded(`the server starts with its seal key (AGENTRUN_SEAL_KEY), and ${SHAPE_60}`, long));
});

test("a runner tells a malformed AGENTRUN_SEAL_KEY from none, by length, never value", async () => {
  const { runnerLoop } = await import("../dist/runner/main.js");
  // No seal key booted and none on the launcher's pipe: the environment's is the one read.
  assert.throws(() => runnerLoop({}, "/nowhere", {}), /A runner needs the server's seal key \(AGENTRUN_SEAL_KEY\): start it through the server's launcher, which hands it over\./);
  const long = randomBytes(43).toString("base64");
  assert.throws(() => runnerLoop({}, "/nowhere", { AGENTRUN_SEAL_KEY: long }), saysHanded(`A runner needs the server's seal key (AGENTRUN_SEAL_KEY), and ${SHAPE_60}`, long));
});

test("an import's read of the server's own secrets tells a malformed AGENTRUN_SEAL_KEY from none, by length, never value", async () => {
  const { ownSecrets } = await import("../dist/import.js");
  // The key is checked before the store is read, so no store is needed to see the refusal.
  const store = {};
  for (const env of [{}, { AGENTRUN_SEAL_KEY: "" }, { AGENTRUN_SEAL_KEY: " \n" }]) {
    await assert.rejects(ownSecrets(store, "/nowhere", env), /the server's own secrets open only under its seal key \(AGENTRUN_SEAL_KEY\), and none was handed$/);
  }
  const long = randomBytes(43).toString("base64");
  await assert.rejects(ownSecrets(store, "/nowhere", { AGENTRUN_SEAL_KEY: long }), (error) => {
    const said = String(error.message);
    assert.ok(said.includes("the server's own secrets open only under its seal key (AGENTRUN_SEAL_KEY), and the one handed is not 32 bytes in base64 (43 characters, or 44 ending in =; it has 60)"), said);
    assert.equal(said.split(long).length - 1, 0, "the key's value is never in the refusal");
    return true;
  });
});

test("the server does not start without a seal key it can keep: in words, naming AGENTRUN_SEAL_KEY", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const { startServe } = await import("../dist/server.js");
  const base = await scratch(t);
  const data = join(base, "data");
  mkdirSync(data, { mode: 0o700 });
  // Where its key would be made is a file: no key can be kept there.
  writeFileSync(join(data, "seal"), "x");
  const keep = { AGENTRUN_SEAL_KEY: process.env.AGENTRUN_SEAL_KEY };
  delete process.env.AGENTRUN_SEAL_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(keep)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  await assert.rejects(startServe({ data, port: 0 }), (error) => /seal key/i.test(String(error.message)) && /AGENTRUN_SEAL_KEY/.test(String(error.message)));
});
