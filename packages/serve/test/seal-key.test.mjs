// The server never starts without a seal key (seal-key.ts): AGENTRUN_SEAL_KEY, or the one in agentrun/seal.key under
// the config home (XDG_CONFIG_HOME, else ~/.config), made there at the first start, 32 random bytes in base64, 0600 in a
// 0700 directory, with only its path printed. The launcher's rules (launcher/agentrun-serve): a key file or directory
// another user can read is refused, never changed; a linked directory is refused; the file is made whole beside its name,
// then linked, so two starts read one key.
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
  const got = mod.ensureSealKey(given, { configHome: home });
  assert.deepEqual([got.text, got.path, got.generated], [given, null, false]);
  assert.equal(got.key.length, 32);
  assert.throws(() => mod.ensureSealKey("not-base64-32", { configHome: home }), mod.SealKeyRefused, "a key that isn't 32 bytes in base64 is refused");
});

test("with none given: made at the first start, 0600 in a 0700 directory, path only; the same key read at the next", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const home = await scratch(t);
  const first = mod.ensureSealKey(undefined, { configHome: home });
  assert.equal(first.generated, true);
  assert.equal(first.path, join(home, "agentrun", "seal.key"));
  assert.equal(statSync(first.path).mode & 0o777, 0o600, "the file is 0600");
  assert.equal(statSync(join(home, "agentrun")).mode & 0o777, 0o700, "its directory is 0700");
  assert.equal(readFileSync(first.path, "utf8").trim(), first.text);
  assert.equal(first.key.length, 32);
  const again = mod.ensureSealKey(undefined, { configHome: home });
  assert.deepEqual([again.text, again.generated], [first.text, false], "the next start reads it, makes none");
  assert.equal(mod.sealKeyLine(first).includes(first.text), false, "the line printed names the path, never the key");
  assert.ok(mod.sealKeyLine(first).includes(first.path), "it names the path");
});

test("a plain mkdir's directory (0755) with no key yet is tightened to 0700 before the key is made", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const home = await scratch(t);
  mkdirSync(join(home, "agentrun"), { mode: 0o755 });
  chmodSync(join(home, "agentrun"), 0o755);
  const got = mod.ensureSealKey(undefined, { configHome: home });
  assert.equal(got.generated, true);
  assert.equal(statSync(join(home, "agentrun")).mode & 0o777, 0o700);
});

test("a key another user can read, or one in a directory they can, is refused, never changed; a linked directory is refused", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const home = await scratch(t);
  const dir = join(home, "agentrun");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "seal.key"), `${randomBytes(32).toString("base64")}\n`, { mode: 0o644 });
  chmodSync(join(dir, "seal.key"), 0o644);
  assert.throws(() => mod.ensureSealKey(undefined, { configHome: home }), mod.SealKeyRefused, "a group- or world-readable key");
  assert.equal(statSync(join(dir, "seal.key")).mode & 0o777, 0o644, "never changed");
  chmodSync(join(dir, "seal.key"), 0o600);
  chmodSync(dir, 0o750);
  assert.throws(() => mod.ensureSealKey(undefined, { configHome: home }), mod.SealKeyRefused, "a key in a directory another user can read");
  chmodSync(dir, 0o700);
  const linked = await scratch(t);
  mkdirSync(join(linked, "real"), { mode: 0o700 });
  symlinkSync(join(linked, "real"), join(linked, "agentrun"));
  assert.throws(() => mod.ensureSealKey(undefined, { configHome: linked }), mod.SealKeyRefused, "a linked directory");
});

test("no seal key and nowhere to keep one: refused in words, never a start without one", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  assert.throws(() => mod.ensureSealKey(undefined, { configHome: undefined }), (error) => error instanceof mod.SealKeyRefused && /AGENTRUN_SEAL_KEY/.test(error.message));
  // A config home that is a file: no directory can be made in it.
  const file = join(await scratch(t), "not-a-dir");
  writeFileSync(file, "x");
  assert.throws(() => mod.ensureSealKey(undefined, { configHome: file }), mod.SealKeyRefused);
});

test("the server does not start without a seal key it can keep: in words, naming AGENTRUN_SEAL_KEY", async (t) => {
  const mod = await sealKey();
  assert.ok(mod, "seal-key.js exists");
  const { startServe } = await import("../dist/server.js");
  const base = await scratch(t);
  const file = join(base, "not-a-dir");
  writeFileSync(file, "x");
  const keep = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, AGENTRUN_SEAL_KEY: process.env.AGENTRUN_SEAL_KEY };
  process.env.XDG_CONFIG_HOME = file;
  delete process.env.AGENTRUN_SEAL_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(keep)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  });
  await assert.rejects(startServe({ data: join(base, "data"), port: 0 }), (error) => /seal key/i.test(String(error.message)) && /AGENTRUN_SEAL_KEY/.test(String(error.message)));
});
