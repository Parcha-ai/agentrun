// A command row carries its answer, and a write wakes the readers in this process.
//   - the commit that takes a row writes its answer (StagedTake.answer): answerOf reads it once and clears it; a take with
//     no answer, a refused row, an untaken row and another run's row answer nothing;
//   - a computer_call row keeps its params (a typed secret) only until it settles, however it settles;
//   - watchCommands: a command() on one handle wakes the listener of another handle on the same data with "written", a
//     take or a journal commit that takes wakes "answered", and unsubscribing stops it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { queued, storeOn } from "./store-helpers.mjs";
import { until } from "./runner-support.mjs";

const context = BACKGROUND_CONTEXT;

/** A journal commit by `claim` that takes `command`, with `answer` when given: one entry, the take keyed to it. */
async function commitTaking(store, claim, command, answer) {
  const journal = store.journal(claim);
  const id = await journal.mintId();
  journal.stage({ take: [{ command, effect: id, ...(answer === undefined ? {} : { answer }) }] });
  await commitWrites(journal, [{ type: "conversation", value: { id: 1 } }, { type: "entry", value: { id, conversationId: 1, kind: "message" } }], context);
}

test("a journal commit whose staged take carries an answer takes the row, and answerOf reads the value once, then nothing", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const row = await store.command("run-1", { kind: "computer_call", body: { call: "screenshot" } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  assert.equal(await store.answerOf("run-1", row.id), undefined, "untaken: no answer yet");
  const value = { png: "iVBORw0KGgo=", nested: { n: [1, 2, 3] } };
  await commitTaking(store, claim, row.id, value);
  const taken = (await store.commands("run-1", 0)).find((one) => one.id === row.id);
  assert.ok(taken.takenAt !== null && taken.refused === null, JSON.stringify(taken));
  assert.equal("answer" in taken, false, "the command read the runner polls never carries an answer");
  assert.equal(await store.answerOf("other-run", row.id), undefined, "not the run's row");
  assert.deepEqual(await store.answerOf("run-1", row.id), { value });
  assert.equal(await store.answerOf("run-1", row.id), undefined, "read once: its bytes do not stay in the store");
});

test("a take with no answer, and a refused row, answer nothing", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const plain = await store.command("run-1", { kind: "computer_call", body: {} });
  const refused = await store.command("run-1", { kind: "computer_call", body: {} });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await commitTaking(store, claim, plain.id);
  assert.equal(await store.answerOf("run-1", plain.id), undefined, "taken with no answer");
  await store.take(claim, refused.id, "refused", "no such call");
  assert.equal(await store.answerOf("run-1", refused.id), undefined, "refused");
});

test("a computer_call row's params go when it settles, taken with an answer, taken bare or refused; another kind keeps its body", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const call = (text) => store.command("run-1", { kind: "computer_call", body: { method: "keyboard.type", params: { text }, answers: false } });
  const answered = await call("secret-1");
  const bare = await call("secret-2");
  const refused = await call("secret-3");
  const steer = await store.command("run-1", { kind: "steer", body: { content: "kept" } });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await commitTaking(store, claim, answered.id, { ok: true });
  await store.take(claim, bare.id);
  await store.take(claim, refused.id, "refused", "no such call");
  await store.take(claim, steer.id);
  const rows = new Map((await store.commands("run-1", 0)).map((one) => [one.id, one]));
  for (const row of [answered, bare, refused]) assert.deepEqual(rows.get(row.id).body, { method: "keyboard.type", answers: false }, JSON.stringify(rows.get(row.id)));
  assert.deepEqual(rows.get(steer.id).body, { content: "kept" });
});

test("watchCommands across two handles on one data directory: command() wakes written, a take wakes answered, unsubscribe stops it", async (t) => {
  const first = await storeOn(t);
  const second = await storeOn(t, { file: first.file, role: "runner" });
  await queued(first.store, "run-1");
  const events = [];
  const stop = second.store.watchCommands((event) => events.push(event));
  const row = await first.store.command("run-1", { kind: "steer", body: { content: "hi" } });
  await until(() => events.length >= 1, "a written wake");
  assert.deepEqual(events[0], { runId: "run-1", what: "written" });
  const claim = await second.store.claim("run-1", "runner-a", { leaseMs: 30_000 });
  await second.store.take(claim, row.id);
  await until(() => events.length >= 2, "an answered wake");
  assert.deepEqual(events[1], { runId: "run-1", what: "answered" });
  const next = await first.store.command("run-1", { kind: "steer", body: { content: "again" } });
  await commitTaking(second.store, claim, next.id, { ok: true });
  await until(() => events.length >= 4, "a written wake and the journal commit's answered wake");
  assert.deepEqual(events.slice(2).map((event) => event.what).sort(), ["answered", "written"]);
  stop();
  const before = events.length;
  await first.store.command("run-1", { kind: "steer", body: { content: "after" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.length, before, "an unsubscribed listener hears nothing");
});

test("a listener that throws never fails the write, nor stops the others", async (t) => {
  const { store } = await storeOn(t);
  await queued(store, "run-1");
  const heard = [];
  const stopThrowing = store.watchCommands(() => {
    throw new Error("a listener's own failure");
  });
  const stopHearing = store.watchCommands((event) => heard.push(event));
  t.after(() => (stopThrowing(), stopHearing()));
  await store.command("run-1", { kind: "steer", body: {} });
  await until(() => heard.length === 1, "the second listener hears it");
});
