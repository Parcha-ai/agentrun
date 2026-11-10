// A run's end-of-run turn is labelled learning on the runner's readers, as the server labels its rows (learning-run.ts
// labelled): the replayed timeline (store-reads/journal.ts runTimeline), the kernel's one reader (runner/journal-reader.ts
// messagesOf) and the live stream (live/translate.ts). The tag is the reader's, read from the turn's own submission (its
// request id, runner/end-of-run.ts reflectRequestId): the run writes nothing for it. On the timeline the turn's message
// reads as the host's words (said.asked) and its answer is never the run's answer; the job's own rows carry no label.
// Each run here is written commit by commit into the store's journal, as a pi run's would be: no runner, no clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const { runTimeline } = await import("../dist/store-reads/journal.js");
const { journalRecords, messagesOf } = await import("../dist/runner/journal-reader.js");
const { emptyState, snapshotOf, translate } = await import("../dist/live/translate.js");
const { reflectRequestId, REFLECT_LABEL } = await import("../dist/runner/end-of-run.js");
const { said } = await import("../dist/learning-words.js");
const { LEARNING_LABEL } = await import("../dist/learning.js");

const ROOT = 1;
const ASKED = "The task is done. What did you learn?";
const user = (content) => [{ role: "user", content }];
/** A model's answer that ends its turn, as pi writes it. */
const assistant = (text) => [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }];

/** Run run-1's journal, commit by commit: the person's input and the job's answer, then the end-of-run turn (its input
 *  under the turn's request id, placed, then answered), then the run's end. `upTo` stops after that many commits (a run
 *  still in its turn). */
async function journaled(t, upTo = Infinity) {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" });
  const journal = store.journal(await store.claim("run-1", "runner-a", { leaseMs: 60_000 }));
  const id = () => journal.mintId();
  const [input, inputEntry, answer, turn, turnEntry, turnAnswer, end] = [await id(), await id(), await id(), await id(), await id(), await id(), await id()];
  const commits = [
    // The job's input has a request id of its own (the launch's): only the turn's prefix makes an input the turn's.
    [{ type: "conversation", value: { id: ROOT } }, { type: "submission", value: { id: input, conversationId: ROOT, type: "input", requestId: "launch-run-1", status: "placed", entry: inputEntry } }, { type: "entry", value: { id: inputEntry, conversationId: ROOT, kind: "pi.user", model: user("Follow the script.") } }],
    [{ type: "entry", value: { id: answer, conversationId: ROOT, kind: "pi.assistant", model: assistant("the job's answer") } }, { type: "submission", value: { id: input, conversationId: ROOT, type: "input", requestId: "launch-run-1", status: "done", entry: inputEntry, answer } }],
    [{ type: "submission", value: { id: turn, conversationId: ROOT, type: "input", requestId: reflectRequestId("run-1"), status: "placed", entry: turnEntry } }, { type: "entry", value: { id: turnEntry, conversationId: ROOT, kind: "pi.user", model: user(ASKED) } }],
    [{ type: "entry", value: { id: turnAnswer, conversationId: ROOT, kind: "pi.assistant", model: assistant("a note") } }, { type: "submission", value: { id: turn, conversationId: ROOT, type: "input", requestId: reflectRequestId("run-1"), status: "done", entry: turnEntry, answer: turnAnswer } }],
    [{ type: "entry", value: { id: end, conversationId: ROOT, kind: "agentrun.end", data: { state: "ended" } } }],
  ];
  for (const writes of commits.slice(0, upTo)) await commitWrites(journal, writes, context);
  return { store, journal, turnEntry };
}

/** The live stream's events for run-1's commits so far, and its state after them (live/stream.ts's fold). */
async function streamed(store) {
  const state = emptyState();
  const events = [];
  for (const commit of (await store.readJournal("run-1").commitsAfter(0, 100, context)).commits) events.push(...translate(state, commit));
  return { state, events };
}

test("the label is the server's: the turn's request id under the server's prefix, and the learning label", () => {
  assert.equal(REFLECT_LABEL, LEARNING_LABEL);
  assert.ok(reflectRequestId("run-1").startsWith("learn-reflect-"));
});

test("the replayed timeline labels the end-of-run turn's rows learning: its message in the host's words, its answer no final answer; the job's rows carry none", async (t) => {
  const { store } = await journaled(t);
  const rows = await runTimeline(store, "run-1", context, { settled: true });
  const shown = rows.map((row) => [row.kind, row.agent_label, row.text]);
  const turn = rows.filter((row) => row.agent_label === LEARNING_LABEL);
  assert.deepEqual(turn.map((row) => [row.kind, row.text]), [["user_message", said.asked], ["text_block", "a note"]], JSON.stringify(shown));
  assert.equal(rows.some((row) => row.text === ASKED), false, "what the model was asked shows on no row");
  assert.ok(rows.some((row) => row.kind === "final_answer" && row.agent_label !== LEARNING_LABEL && row.text === "the job's answer"), JSON.stringify(shown));
});

test("the kernel's reader marks the end-of-run turn's messages learning, and the job's not", async (t) => {
  const { store } = await journaled(t);
  const records = await journalRecords(store.readJournal("run-1"), context);
  assert.deepEqual(messagesOf(records).map((message) => [message.role, message.text, message.learning === true]), [
    ["person", "Follow the script.", false],
    ["model", "the job's answer", false],
    ["person", ASKED, true],
    ["model", "a note", true],
  ]);
});

test("the live stream tags the end-of-run turn's messages learning as they come; a reader that joins during the turn is told where it began, as the server's Reflect says it", async (t) => {
  const during = await journaled(t, 3);
  const joined = await streamed(during.store);
  assert.deepEqual(snapshotOf(joined.state).reflect, { after: during.turnEntry - 1 }, "the turn's input is the first of its entries");
  const { store } = await journaled(t);
  const { events } = await streamed(store);
  const ends = events.filter((event) => event.type === "message_end").map((event) => [event.entry?.model?.[0]?.role, event.agent_label ?? null]);
  assert.deepEqual(ends, [["user", null], ["assistant", null], ["user", LEARNING_LABEL], ["assistant", LEARNING_LABEL]]);
  const starts = events.filter((event) => event.type === "message_start").map((event) => [event.message?.role, event.agent_label ?? null]);
  assert.deepEqual(starts.slice(-2), [["user", LEARNING_LABEL], ["assistant", LEARNING_LABEL]]);
});
