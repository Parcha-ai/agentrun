// A run patch (a park, an end) and the rows beside it are staged with the record that is their effect (stage({ effect })),
// and written only by the commit that stores that record: never by a storage call where pi coalesced a stored batch with
// the effect's refused one. Otherwise a run could read parked or ended without the ask or end entry that caused it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { runRow, scratchConnection } from "./store-support.mjs";

const { RunStorage } = await import("../dist/store/index.js");
const context = BACKGROUND_CONTEXT;
const ROOT = 1;

test("a patch staged with its effect never lands on a storage call whose effect batch was refused, though another batch of it was stored; it lands with its effect", async (t) => {
  const db = await scratchConnection(t);
  const storage = await RunStorage.open(db.connection, await runRow(db, "run-1", 1));
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const other = await storage.mintId();
  const ask = await storage.mintId();
  storage.stage({ run: { state: "parked" }, effect: ask });
  // One storage call, as pi's Writer coalesces it: a stored batch, then the ask's batch refused (it reuses the root's id).
  const result = await storage.commit([
    [{ type: "entry", value: { id: other, conversationId: ROOT, kind: "message", mark: "other" } }],
    [{ type: "entry", value: { id: ask, conversationId: ROOT, kind: "agentrun.ask" } }, { type: "entry", value: { id: ROOT, conversationId: ROOT, kind: "message" } }],
  ], () => {}, context);
  assert.equal(result.stored, 1, "the first batch stored, the ask's refused");
  assert.equal((await db.get("SELECT state FROM runs WHERE id = ?", "run-1")).state, "running", "not parked without its ask");
  // The ask's own commit: the patch lands with it.
  await commitWrites(storage, [{ type: "entry", value: { id: ask, conversationId: ROOT, kind: "agentrun.ask" } }], context);
  assert.equal((await db.get("SELECT state FROM runs WHERE id = ?", "run-1")).state, "parked", "parked with its ask");
});

// The effect may be a document the commit changes or retires, not only a record it creates (the effect matcher is A's
// effectId, which takes and patches share). When the store keys a take or a patch only to a freshly minted id or marker
// (the store follow-up after A), this must still hold through that marker: a document's change or retire carries it.
test("a run patch keyed to a document lands with that document's change, or its retire, and not with a commit without it", async (t) => {
  const db = await scratchConnection(t);
  const storage = await RunStorage.open(db.connection, await runRow(db, "run-doc", 1));
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const doc = await storage.mintId();
  await commitWrites(storage, [{ type: "document.create", record: { id: doc, kind: "test.notes", scope: { kind: "conversation", conversationId: ROOT }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value: { n: 1 } } }], context);
  const state = async () => (await db.get("SELECT state FROM runs WHERE id = ?", "run-doc")).state;

  storage.stage({ run: { state: "parked" }, effect: doc });
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(await state(), "running", "not parked by a commit without the document's change");
  await commitWrites(storage, [{ type: "document.change", id: doc, content: { kind: "base", version: 1, value: { n: 2 } } }], context);
  assert.equal(await state(), "parked", "parked with the document's change");

  storage.stage({ run: { state: "ended" }, effect: doc });
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(await state(), "parked", "not ended by a commit without the document's retire");
  await commitWrites(storage, [{ type: "document.retire", id: doc }], context);
  assert.equal(await state(), "ended", "ended with the document's retire");
});

test("a run patch or rows staged with no effect are refused at stage", async (t) => {
  const db = await scratchConnection(t);
  const storage = await RunStorage.open(db.connection, await runRow(db, "run-1", 1));
  assert.throws(() => storage.stage({ run: { state: "ended" } }), /effect/);
});
