// A trigger source's sealed settings as store rows (design 2.1, the P1 ruling): each adapter keeps a value per (scope,
// field), the scope "server" for the one server-wide set or a trigger's id for its own. The value is sealed (store/seal.ts,
// AAD trigger_settings|<adapter>|<scope>|<field>): TEXT the store never opens. The server writes them; a deleted trigger's
// scope goes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

test("a trigger setting reads back by adapter, sorted by scope then field; replaced in place", async (t) => {
  const { store, clock } = await storeOn(t);
  assert.deepEqual(await store.triggerSettings.get("slack"), [], "none before the first put");
  await store.triggerSettings.put({ adapter: "slack", scope: "server", field: "signing_secret", sealed: "sealed-a" });
  await store.triggerSettings.put({ adapter: "slack", scope: "server", field: "bot_token", sealed: "sealed-b" });
  await store.triggerSettings.put({ adapter: "slack", scope: "trigger-1", field: "signing_secret", sealed: "sealed-c" });
  await store.triggerSettings.put({ adapter: "github", scope: "server", field: "webhook_secret", sealed: "sealed-d" });
  const slack = await store.triggerSettings.get("slack");
  assert.deepEqual(slack.map((row) => [row.scope, row.field, row.sealed]), [
    ["server", "bot_token", "sealed-b"],
    ["server", "signing_secret", "sealed-a"],
    ["trigger-1", "signing_secret", "sealed-c"],
  ], "only slack's, by scope then field");
  assert.equal(slack[0].updatedAt, clock.now);
  clock.now += 1_000;
  await store.triggerSettings.put({ adapter: "slack", scope: "server", field: "bot_token", sealed: "sealed-b2" });
  const after = await store.triggerSettings.get("slack");
  assert.equal(after.find((row) => row.field === "bot_token").sealed, "sealed-b2", "replaced in place");
  assert.equal(after.find((row) => row.field === "bot_token").updatedAt, clock.now);
  assert.equal(after.length, 3, "no new row");
});

test("removeScope drops one scope's fields for the adapter, leaving its other scopes and other adapters", async (t) => {
  const { store } = await storeOn(t);
  await store.triggerSettings.put({ adapter: "slack", scope: "server", field: "signing_secret", sealed: "s1" });
  await store.triggerSettings.put({ adapter: "slack", scope: "trigger-1", field: "signing_secret", sealed: "s2" });
  await store.triggerSettings.put({ adapter: "github", scope: "trigger-1", field: "webhook_secret", sealed: "s3" });
  await store.triggerSettings.removeScope("slack", "trigger-1");
  assert.deepEqual((await store.triggerSettings.get("slack")).map((row) => row.scope), ["server"], "slack's trigger-1 gone, server kept");
  assert.deepEqual((await store.triggerSettings.get("github")).map((row) => row.scope), ["trigger-1"], "github's trigger-1 untouched");
});
