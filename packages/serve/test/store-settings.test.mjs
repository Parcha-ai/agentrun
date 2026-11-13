// The server's settings and sealed keys as store rows (design 2.1, the P1 ruling): the server keeps its tool settings and
// every model or provider key in the one store, not in files beside it. settings holds a JSON value per key; sealed_keys
// holds the bytes the server sealed (store/seal.ts), which the store never opens. Both are the server's own writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

test("settings: a value reads back as it was put, replaced in place, removed; a key with no row reads undefined", async (t) => {
  const { store, clock } = await storeOn(t);
  assert.equal(await store.settings.get("tools"), undefined, "no row before the first put");
  await store.settings.put("tools", { web_search: { provider: "parallel" } });
  assert.deepEqual(await store.settings.get("tools"), { web_search: { provider: "parallel" } });
  clock.now += 1_000;
  await store.settings.put("tools", { web_search: { provider: "off" } });
  assert.deepEqual(await store.settings.get("tools"), { web_search: { provider: "off" } }, "replaced in place");
  await store.settings.put("other", 42);
  assert.deepEqual((await store.settings.all()).map((row) => [row.key, row.value, row.updatedAt]), [["other", 42, clock.now], ["tools", { web_search: { provider: "off" } }, clock.now]]);
  await store.settings.remove("tools");
  assert.equal(await store.settings.get("tools"), undefined, "removed");
  assert.deepEqual((await store.settings.all()).map((row) => row.key), ["other"]);
});

test("settings: a value saved as null reads back as null, not undefined (told apart from no row)", async (t) => {
  const { store } = await storeOn(t);
  await store.settings.put("maybe", null);
  assert.equal(await store.settings.get("maybe"), null, "stored null is null");
  assert.equal(await store.settings.get("absent"), undefined, "no row is undefined");
});

test("settings: replaceIf and removeIf write only while the row still holds the value read, and a row read back compares equal", async (t) => {
  const { store } = await storeOn(t);
  const held = { v: 1, run: "run-1", at: "2026-11-12T00:00:00.000Z" };
  assert.equal(await store.settings.replaceIf("hold", held, { v: 1, run: "run-2" }), false, "no row: nothing replaced");
  assert.equal(await store.settings.get("hold"), undefined);
  await store.settings.put("hold", held);
  const read = await store.settings.get("hold");
  assert.equal(await store.settings.replaceIf("hold", { ...read, run: "run-0" }, { v: 1, run: "run-2" }), false, "another value: nothing replaced");
  assert.equal(await store.settings.replaceIf("hold", read, { v: 1, run: "run-2" }), true, "the row as read: replaced");
  assert.equal(await store.settings.replaceIf("hold", read, { v: 1, run: "run-3" }), false, "the same read again: the row changed since");
  assert.deepEqual(await store.settings.get("hold"), { v: 1, run: "run-2" });
  assert.equal(await store.settings.removeIf("hold", read), false, "a stale value removes nothing");
  assert.equal(await store.settings.removeIf("hold", await store.settings.get("hold")), true);
  assert.equal(await store.settings.get("hold"), undefined);
});

const SEALED = Uint8Array.from([7, 0, 255, 128, 1]);

test("sealed keys: the bytes in are the bytes out, replaced in place, removed; the store never needs to open them", async (t) => {
  const { store, clock } = await storeOn(t);
  assert.equal(await store.sealedKeys.get("ANTHROPIC_API_KEY"), undefined, "no key before the first put");
  await store.sealedKeys.put("ANTHROPIC_API_KEY", SEALED);
  assert.deepEqual([...(await store.sealedKeys.get("ANTHROPIC_API_KEY"))], [...SEALED], "sealed bytes in, the same bytes out");
  clock.now += 1_000;
  const next = Uint8Array.from([9, 9]);
  await store.sealedKeys.put("ANTHROPIC_API_KEY", next);
  assert.deepEqual([...(await store.sealedKeys.get("ANTHROPIC_API_KEY"))], [...next], "replaced in place");
  await store.sealedKeys.put("OPENAI_API_KEY", SEALED);
  const all = await store.sealedKeys.all();
  assert.deepEqual(all.map((row) => row.name), ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"], "by name");
  assert.deepEqual([...all[0].sealed], [...next]);
  assert.equal(all[0].updatedAt, clock.now);
  await store.sealedKeys.remove("ANTHROPIC_API_KEY");
  assert.equal(await store.sealedKeys.get("ANTHROPIC_API_KEY"), undefined, "removed");
  assert.deepEqual((await store.sealedKeys.all()).map((row) => row.name), ["OPENAI_API_KEY"]);
});
