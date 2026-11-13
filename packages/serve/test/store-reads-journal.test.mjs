// A run's entries, timeline and hearing over the one store (store-reads/journal.ts): the server reads them from A now, not
// from each run's own database. Entries come back in log order across conversations; the timeline renderer runs over them
// unchanged; the hearing captures what the person said.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { runEntries, runHearing, runTimeline } = await import("../dist/store-reads/journal.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;

async function claimedJournal(store, runId = "run-1") {
  await agentWithRevision(store);
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" });
  const claim = await store.claim(runId, "runner-a", { leaseMs: 60_000 });
  return store.journal(claim);
}

test("runEntries, runHearing and runTimeline read a run from the one store", async (t) => {
  const { store } = await storeOn(t);
  const journal = await claimedJournal(store);
  const user = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.user", model: [{ role: "user", content: "Book the room." }] };
  const answer = { id: await journal.mintId(), conversationId: ROOT, kind: "pi.assistant", model: [{ role: "assistant", content: "Booked." }] };
  await commitWrites(journal, [{ type: "conversation", value: { id: ROOT } }, { type: "entry", value: user }, { type: "entry", value: answer }], context);

  assert.deepEqual((await runEntries(store, "run-1", context)).map((e) => e.kind), ["pi.user", "pi.assistant"], "in log order");
  const heard = await runHearing(store, "run-1", context);
  assert.deepEqual([...heard.heard.values()].map((h) => h.text), ["Book the room."], "the person's own message");
  const rows = await runTimeline(store, "run-1", context, { settled: true });
  assert.ok(Array.isArray(rows) && rows.length > 0, "the renderer produced rows over A's entries");
});

test("runEntries orders by id across conversations (global log order), not by conversation", async (t) => {
  const { store } = await storeOn(t);
  const journal = await claimedJournal(store);
  // Ids are one increasing namespace: a is on root, then a second conversation, then c back on root — so b's id sits
  // between a's and c's though it is in another conversation.
  const a = await journal.mintId();
  const second = await journal.mintId();
  const b = await journal.mintId();
  const c = await journal.mintId();
  await commitWrites(journal, [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: a, conversationId: ROOT, kind: "message", data: { mark: "a" } } },
    { type: "conversation", value: { id: second } },
    { type: "entry", value: { id: b, conversationId: second, kind: "message", data: { mark: "b" } } },
    { type: "entry", value: { id: c, conversationId: ROOT, kind: "message", data: { mark: "c" } } },
  ], context);

  assert.deepEqual((await runEntries(store, "run-1", context)).map((e) => e.data.mark), ["a", "b", "c"], "by id, not grouped by conversation");
});

test("a run with no journal reads as no entries, no hearing, no rows", async (t) => {
  const { store } = await storeOn(t);
  assert.deepEqual(await runEntries(store, "none", context), []);
  assert.equal((await runHearing(store, "none", context)).heard.size, 0);
  assert.deepEqual(await runTimeline(store, "none", context), []);
});

test("the paid-tools session's steps read as the run's charges: a step that names its tool folds as that tool's charge, a hold given back is no charge at all", async () => {
  const { withPaidCosts } = await import("../dist/store-reads/journal.js");
  const { KINDS } = await import("../dist/runner/journal-kinds.js");
  const conv = 23;
  const entries = [
    { kind: "pi.tool-result", conversationId: ROOT, model: [{ role: "toolResult", toolCallId: "c1" }] },
    { kind: KINDS.sessionKey, conversationId: ROOT, data: { key: "paid-tools", conversation: conv } },
    // A browser call's hold, given back when it returned; its charge, its own step; the session's reserve, given back.
    { kind: "runner.request", conversationId: conv, data: { turn: 1, model: "paid:this browser call", call: "c1", charged_by: "browserbase", tool: "browser", hold: true } },
    { kind: "runner.request", conversationId: conv, data: { turn: 2, model: "paid:this browser session's time", call: "c1", charged_by: "browserbase", tool: "browser", tag: "s1", owed: true } },
    { kind: "runner.turn", conversationId: conv, data: { turn: 2, usd: 0.0003 } },
    { kind: "runner.request", conversationId: conv, data: { turn: 3, model: "paid:this browser session's reserve", charged_by: "browserbase", tool: "browser", tag: "s1", hold: true } },
    { kind: "runner.turn", conversationId: conv, data: { turn: 1, usd: 0, givenBack: true } },
    { kind: "runner.turn", conversationId: conv, data: { turn: 3, usd: 0, givenBack: true } },
  ];
  const charges = withPaidCosts(entries).filter((e) => e.kind === "agentrun.tool_cost").map((e) => e.data);
  assert.deepEqual(charges, [{ tool: "browser", charged_by: "browserbase", call: "c1", tag: "s1", usd: 0.0003 }], "one charge, the browser's, under its call; the holds given back show nothing");
});
