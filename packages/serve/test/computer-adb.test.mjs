// The phone provider's adb (serve/src/computer-adb.ts phoneAdb) is built from a fixed, minimal env (PATH, HOME, TMPDIR),
// never this process's: a secret in this process's env never reaches the env adb is spawned from.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adbEnv, phoneAdb } from "../dist/computer-adb.js";

test("adb is given PATH, HOME and TMPDIR alone, and a sentinel secret in this process's env never reaches it", () => {
  const SENTINEL = "sentinel-secret-value-that-must-not-reach-adb";
  const saved = { key: process.env.PHONE_HARNESS_API_KEY, seal: process.env.AGENTRUN_SEAL_KEY };
  process.env.PHONE_HARNESS_API_KEY = SENTINEL;
  process.env.AGENTRUN_SEAL_KEY = SENTINEL;
  try {
    const handed = [];
    const adb = phoneAdb((path, options) => (handed.push([path, options.env]), { adb: path }), "/opt/adb/adb", { home: "/home/phone", tmpdir: "/tmp/phone" });
    assert.deepEqual(adb, { adb: "/opt/adb/adb" });
    assert.equal(handed.length, 1);
    const [path, env] = handed[0];
    assert.equal(path, "/opt/adb/adb");
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "TMPDIR"]);
    assert.equal(env.HOME, "/home/phone");
    assert.equal(env.TMPDIR, "/tmp/phone");
    assert.ok(!JSON.stringify(env).includes(SENTINEL), "no secret of this process reaches adb");
    assert.ok(Object.isFrozen(adbEnv()), "a fixed env");
  } finally {
    for (const [name, value] of [["PHONE_HARNESS_API_KEY", saved.key], ["AGENTRUN_SEAL_KEY", saved.seal]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
