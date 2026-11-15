// The server's settings and sealed keys as store rows (design 2.1, the P1 ruling): the server keeps its tool settings and
// every model or provider key in the one store, not in files beside it. settings holds a JSON value per key; sealed_keys
// holds the bytes the server sealed (store/seal.ts), which the store never opens. Both are the server's own writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";
import { dropSchema, freshSchema, PG_URL, postgresOnly } from "./store-target.mjs";

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

test("sealed keys: replaceIf writes only while the row still holds the bytes read, so of two writers that read one row only one replaces it", async (t) => {
  const { store } = await storeOn(t);
  const first = Uint8Array.from([1, 2, 3]);
  assert.equal(await store.sealedKeys.replaceIf("chatgpt:plan", first, SEALED), false, "no row: nothing replaced");
  assert.equal(await store.sealedKeys.get("chatgpt:plan"), undefined, "and none made");
  await store.sealedKeys.put("chatgpt:plan", first);
  const read = await store.sealedKeys.get("chatgpt:plan");
  assert.equal(await store.sealedKeys.replaceIf("chatgpt:plan", Uint8Array.from([1, 2]), SEALED), false, "other bytes: nothing replaced");
  assert.equal(await store.sealedKeys.replaceIf("chatgpt:plan", read, SEALED), true, "the bytes as read: replaced");
  assert.equal(await store.sealedKeys.replaceIf("chatgpt:plan", read, Uint8Array.from([4])), false, "the same read again: the row changed since");
  assert.deepEqual([...(await store.sealedKeys.get("chatgpt:plan"))], [...SEALED]);
  await store.sealedKeys.remove("chatgpt:plan");
  assert.equal(await store.sealedKeys.replaceIf("chatgpt:plan", SEALED, first), false, "a removed row is not made again");
  assert.equal(await store.sealedKeys.get("chatgpt:plan"), undefined);
});

test("sealed keys: removeIf removes only while the row still holds the bytes read, so a write since it was read stays", async (t) => {
  const { store } = await storeOn(t);
  const first = Uint8Array.from([1, 2, 3]);
  assert.equal(await store.sealedKeys.removeIf("chatgpt:plan", first), false, "no row: nothing removed");
  await store.sealedKeys.put("chatgpt:plan", first);
  const read = await store.sealedKeys.get("chatgpt:plan");
  assert.equal(await store.sealedKeys.replaceIf("chatgpt:plan", read, SEALED), true, "another writer replaced it since");
  assert.equal(await store.sealedKeys.removeIf("chatgpt:plan", read), false, "the bytes read are not the row's now: it stays");
  assert.deepEqual([...(await store.sealedKeys.get("chatgpt:plan"))], [...SEALED]);
  assert.equal(await store.sealedKeys.removeIf("chatgpt:plan", await store.sealedKeys.get("chatgpt:plan")), true, "the bytes as read: removed");
  assert.equal(await store.sealedKeys.get("chatgpt:plan"), undefined);
});

test("sealed keys: the store's clock is what a lease in a sealed key is judged by: the store's own on SQLite, the database's on Postgres whatever the process's own clock says", async (t) => {
  const { store, clock } = await storeOn(t);
  // storeOn runs the deadlines on its test clock on either database (Postgres's testClock).
  assert.equal(await store.sealedKeys.clock(), clock.now);
  clock.now += 61_000;
  assert.equal(await store.sealedKeys.clock(), clock.now, "it moves with the store's clock");
});

test("sealed keys on Postgres: two processes whose own clocks are a minute apart read one clock, the database's", postgresOnly("the database's clock"), async (t) => {
  const { openPostgresStore } = await import("../dist/store/postgres/store.js");
  const schema = await freshSchema();
  let runner;
  const server = await openPostgresStore({ url: PG_URL, schema, role: "server" });
  t.after(async () => {
    await runner?.close();
    await server.close();
    await dropSchema(schema);
  });
  runner = await openPostgresStore({ url: PG_URL, schema, role: "runner", now: () => Date.now() + 61_000 });
  const [fromServer, fromRunner] = [await server.sealedKeys.clock(), await runner.sealedKeys.clock()];
  assert.ok(Math.abs(fromRunner - fromServer) < 5_000, `one clock for both: ${fromServer} and ${fromRunner}`);
  assert.ok(Math.abs(fromRunner - Date.now()) < 30_000, "the database's, not the runner's own (61 s ahead)");
});
