// A provider whose sessions carry no labels of their own (the phone provider) takes a ledger serve backs by the store
// (workspace/computer-ledger.ts): put, get, list and remove a session's labels by its id, one provider's rows only, and
// still there after a restart (a new store over the same file).
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeLedger } from "../dist/workspace/index.js";
import { storeOn } from "./store-helpers.mjs";

test("the ledger keeps a provider's session labels by session id, its rows only", async (t) => {
  const { store } = await storeOn(t);
  const phone = storeLedger(store.computerLedger, "phone-harness");
  const other = storeLedger(store.computerLedger, "other");
  await phone.put("sess-a", { "agentrun.run": "run-1", "agentrun.epoch": "2" });
  await phone.put("sess-b", { "agentrun.run": "run-2" });
  await other.put("sess-a", { "agentrun.run": "run-9" });
  assert.deepEqual(await phone.get("sess-a"), { "agentrun.run": "run-1", "agentrun.epoch": "2" });
  assert.equal(await phone.get("sess-none"), undefined);
  assert.deepEqual(await phone.list(), [{ sessionId: "sess-a", labels: { "agentrun.run": "run-1", "agentrun.epoch": "2" } }, { sessionId: "sess-b", labels: { "agentrun.run": "run-2" } }]);
  await phone.remove("sess-b");
  assert.deepEqual((await phone.list()).map((row) => row.sessionId), ["sess-a"]);
  assert.deepEqual(await other.list(), [{ sessionId: "sess-a", labels: { "agentrun.run": "run-9" } }], "another provider's rows are its own");
});

test("a restart keeps the ledger: a new store over the same file still lists the session", async (t) => {
  const first = await storeOn(t);
  await storeLedger(first.store.computerLedger, "phone-harness").put("sess-a", { "agentrun.run": "run-1" });
  await first.store.flush();
  await first.store.close();
  const again = await storeOn(t, { file: first.file });
  assert.deepEqual(await storeLedger(again.store.computerLedger, "phone-harness").list(), [{ sessionId: "sess-a", labels: { "agentrun.run": "run-1" } }]);
});
