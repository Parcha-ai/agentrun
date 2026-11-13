// The store's paired computers (spec/computer/attach.md): a pairing code is kept as its hash, good once until it expires,
// and burned in the same transaction that writes the computer; a computer is found by its token's hash until it is
// revoked, and a revoked one is no longer listed. On SQLite, and on Postgres when AGENTRUN_TEST_PG_URL is set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const HELLO = { protocol: "0.2", version: "0.2.0", os: "macos", kind: "desktop", arch: "arm64", groups: ["screen", "input.pointer", "input.keys"] };
const computer = (id, token = `token-${id}`) => ({ id, name: `${id}'s Mac`, hello: HELLO, labels: {}, tokenSha256: token });

test("a code pairs once, before it expires: a used, expired or unknown code pairs nothing, and two pairs at once with one code make one computer", async (t) => {
  const { store, clock } = await storeOn(t);
  const paired = store.pairedComputers;
  await paired.addCode("code-a", clock.now + 60_000);
  assert.equal(await paired.pair("code-a", computer("cmp_a")), true, "a good code pairs");
  assert.equal(await paired.pair("code-a", computer("cmp_b")), false, "a used code pairs nothing");
  assert.equal(await paired.pair("code-unknown", computer("cmp_c")), false, "an unknown code pairs nothing");
  await paired.addCode("code-old", clock.now + 1_000);
  clock.now += 1_000;
  assert.equal(await paired.pair("code-old", computer("cmp_d")), false, "a code at its expiry pairs nothing");
  await paired.addCode("code-race", clock.now + 60_000);
  const both = await Promise.all([paired.pair("code-race", computer("cmp_e")), paired.pair("code-race", computer("cmp_f"))]);
  assert.deepEqual(both.filter(Boolean).length, 1, `one of two pairs at once wins: ${JSON.stringify(both)}`);
  assert.deepEqual((await paired.list()).map((row) => row.id).sort(), ["cmp_a", both[0] ? "cmp_e" : "cmp_f"].sort());
});

test("a paired computer is found by its token's hash and listed with what it paired as, until it is revoked; seen records its driver's last hello and build", async (t) => {
  const { store, clock } = await storeOn(t);
  const paired = store.pairedComputers;
  await paired.addCode("code-1", clock.now + 60_000);
  await paired.pair("code-1", computer("cmp_one", "hash-one"));
  const row = await paired.byToken("hash-one");
  assert.deepEqual({ ...row }, { id: "cmp_one", name: "cmp_one's Mac", hello: HELLO, driver: "0.2.0", labels: {}, createdAt: clock.now, seenAt: null, revokedAt: null });
  assert.equal(await paired.byToken("hash-other"), undefined, "another token finds none");
  clock.now += 5_000;
  const later = { ...HELLO, version: "0.2.1", groups: [...HELLO.groups, "apps"] };
  await paired.seen("cmp_one", later);
  const seen = await paired.get("cmp_one");
  assert.deepEqual([seen.seenAt, seen.driver, seen.hello], [clock.now, "0.2.1", later], "its last hello is kept, and its build as its driver");
  clock.now += 5_000;
  assert.equal(await paired.revoke("cmp_one"), true, "revoked");
  assert.equal(await paired.revoke("cmp_one"), false, "once");
  assert.equal(await paired.byToken("hash-one"), undefined, "a revoked token finds none");
  assert.deepEqual(await paired.list(), [], "a revoked computer is not listed");
  assert.equal((await paired.get("cmp_one")).revokedAt, clock.now, "get still reads it, revoked");
  assert.equal(await paired.revoke("cmp_none"), false, "an unknown id revokes nothing");
});
