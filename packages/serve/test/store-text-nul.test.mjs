// Text with a NUL in it (a model's stray \u0000 in a summary, a refusal's reason, an MCP server's instructions): Postgres's
// TEXT cannot hold one and SQLite's can, so both stores write it the same way, the NUL as U+FFFD, a visible mark. A run's
// end with such a summary ends the run on either store, never fails its end commit on one alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";

test("a run's end whose summary holds a NUL ends the run, and the summary reads back with U+FFFD in its place", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const row = await store.runs.update(claim, { state: "ended", summary: "done\u0000 and \u0000\u0000 said" });
  assert.equal(row.state, "ended");
  assert.equal(row.summary, "done� and �� said");
  assert.equal((await store.runs.get("run-1")).summary, "done� and �� said", "as stored");
});

test("a command refused with a reason holding a NUL is refused, the reason marked the same way", async (t) => {
  const { store } = await storeOn(t);
  await queued(store);
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  const steer = await store.command("run-1", { kind: "steer", body: { text: "go" } });
  await store.take(claim, steer.id, "refused", "no\u0000pe");
  const [row] = await store.commands("run-1", 0);
  assert.equal(row.refused, "no�pe");
});

test("an id holding a NUL finds its row: a read binds the same marked text as the write", async (t) => {
  const { store } = await storeOn(t);
  await store.settings.put("key\u0000one", { on: true });
  assert.deepEqual(await store.settings.get("key\u0000one"), { on: true });
  assert.deepEqual((await store.settings.all()).map((row) => row.key), ["key�one"]);
});
