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

// A patch's effect is matched as a take's is (#1967): an id its batch newly allocates. A patch whose effect is a
// document's change or retire is keyed to a marker entry minted for it in that batch: it lands with that batch, and
// never with another path's change of the same document, nor with a commit without its marker.
test("a run patch keyed to a marker lands with the document change or retire that carries it, and with nothing else", async (t) => {
  const db = await scratchConnection(t);
  const storage = await RunStorage.open(db.connection, await runRow(db, "run-doc", 1));
  await commitWrites(storage, [{ type: "conversation", value: { id: ROOT } }], context);
  const doc = await storage.mintId();
  await commitWrites(storage, [{ type: "document.create", record: { id: doc, kind: "test.notes", scope: { kind: "conversation", conversationId: ROOT }, history: "rewindable", fork: "asOf" }, content: { kind: "base", version: 1, value: { n: 1 } } }], context);
  const state = async () => (await db.get("SELECT state FROM runs WHERE id = ?", "run-doc")).state;
  const marker = async () => ({ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "agentrun.command", data: { patch: true } } });

  const parked = await marker();
  storage.stage({ run: { state: "parked" }, effect: parked.value.id });
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(await state(), "running", "not parked by a commit without its marker");
  await commitWrites(storage, [{ type: "document.change", id: doc, content: { kind: "base", version: 1, value: { n: 2, by: "another path" } } }], context);
  assert.equal(await state(), "running", "nor by another path's change of the same document");
  await commitWrites(storage, [{ type: "document.change", id: doc, content: { kind: "base", version: 1, value: { n: 3 } } }, parked], context);
  assert.equal(await state(), "parked", "parked with the change that carries its marker");

  const ended = await marker();
  storage.stage({ run: { state: "ended" }, effect: ended.value.id });
  await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId(), conversationId: ROOT, kind: "message" } }], context);
  assert.equal(await state(), "parked", "not ended by a commit without its marker");
  await commitWrites(storage, [{ type: "document.retire", id: doc }, ended], context);
  assert.equal(await state(), "ended", "ended with the retire that carries its marker");
});

test("a run patch or rows staged with no effect are refused at stage", async (t) => {
  const db = await scratchConnection(t);
  const storage = await RunStorage.open(db.connection, await runRow(db, "run-1", 1));
  assert.throws(() => storage.stage({ run: { state: "ended" } }), /effect/);
});
