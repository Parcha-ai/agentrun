// The turn-end marker a claude-agent or codex run's root gets (turn-end.ts) is inert everywhere but decide(): the same
// entries with it and without it give the same timeline rows, the same metrics and the same spend the cap reads.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { REQUEST_STARTED, runMetricsOf, timelineOf } from "@parcha/pi-durable-agent/timeline";
import { spentIn } from "../dist/cap.js";
import { ADAPTER_API, MESSAGE, MESSAGE_END, TURN_END } from "../dist/turn-end.js";
import { Turns } from "../dist/turns.js";

const ROOT = mkdtempSync(join(tmpdir(), "agentrun-turn-end-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const key = "run:r1";
const usage = (usd) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usd } });
const assistant = (id, content, stopReason, usd) => ({ kind: "pi.assistant", id, conversationId: 1, model: [{ role: "assistant", content, api: ADAPTER_API, provider: "claude-agent", model: "m", usage: usage(usd), stopReason, timestamp: 1_000 + id }] });
const user = (id, text) => ({ kind: "pi.user", id, conversationId: 1, model: [{ role: "user", content: [{ type: "text", text }], timestamp: 1_000 + id }] });
const marker = (id, status) => ({ kind: TURN_END, id, conversationId: 1, data: { key, status } });
/** Two turns as the bridge writes them, with each turn's end or without it. */
function entries(withMarkers) {
  return [
    user(1, "Write it."),
    { kind: REQUEST_STARTED, id: 2, conversationId: 1, data: { key, request: 1 } },
    assistant(3, [{ type: "text", text: "On it." }, { type: "toolCall", id: "c1", name: "write", arguments: { path: "a.md", content: "a" } }], "toolUse", 0.001),
    { kind: "pi.tool-result", id: 4, conversationId: 1, model: [{ role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "Successfully wrote to a.md" }], isError: false, timestamp: 1_004 }] },
    { kind: REQUEST_STARTED, id: 5, conversationId: 1, data: { key, request: 2 } },
    assistant(6, [{ type: "text", text: "Wrote a.md." }], "stop", 0.002),
    ...(withMarkers ? [marker(7, "completed")] : []),
    user(8, "/compact"),
    { kind: REQUEST_STARTED, id: 9, conversationId: 1, data: { key, request: 3 } },
    assistant(10, [], "stop", 0.0005),
    ...(withMarkers ? [marker(11, "completed")] : []),
  ];
}

/** A run store holding `list` as its entries, as spentIn reads one. */
function storeOf(name, list) {
  const file = join(ROOT, `${name}.sqlite`);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE entries (record TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO entries (record) VALUES (?)");
  for (const entry of list) insert.run(JSON.stringify(entry));
  db.close();
  return file;
}

test("a store with the turn-end markers reads the same rows, the same metrics and the same spend as one without", () => {
  const [plain, marked] = [entries(false), entries(true)];
  const rows = (list) => timelineOf(list, { settled: true }).map((r) => [r.id, r.kind, r.summary, r.usage ?? null]);
  assert.deepEqual(rows(marked), rows(plain), "no row for a marker, and every other row the same");
  assert.ok(rows(plain).some(([, kind]) => kind === "usage"), "the timeline has its usage row");
  assert.deepEqual(runMetricsOf(marked), runMetricsOf(plain), "the metrics");
  assert.equal(spentIn(storeOf("marked", marked)), spentIn(storeOf("plain", plain)), "the spend the cap reads");
  assert.ok(Math.abs(spentIn(storeOf("marked-2", marked)) - 0.0035) < 1e-12, "and the spend is the requests' own");
});

// ---- How a run's messages and their turns' ends are read (turns.ts) ------------------------------------------------------

const message = (id, ref, ends = true) => ({ kind: MESSAGE, id, conversationId: 1, data: { key, id: ref, content: "hi", ...(ends ? { ends: true } : {}) } });
const sent = (id, ref, yes = true) => ({ kind: MESSAGE_END, id, conversationId: 1, data: { key, id: ref, sent: yes } });
const ended = (id, data) => ({ kind: TURN_END, id, conversationId: 1, data: { key, ...data } });
const read = (list, submissions = [], skip) => {
  const turns = new Turns();
  turns.note(list, submissions, skip, 1_000);
  return turns;
};
const answerOf = (turns) => {
  const end = turns.end();
  return end?.status === "answered" ? (end.answer === null ? "" : turns.text(end.answer)) : end?.status;
};

test("a bridge's message is open from its MESSAGE until the TURN_END naming it, which says how its turn ended and which entry answered", () => {
  const first = [message(1, "a"), user(2, "hi"), sent(3, "a"), assistant(4, [{ type: "text", text: "Answer 1." }], "stop", 0.001)];
  assert.deepEqual([read(first).open, read(first).end()], [1, undefined], "open until its turn's end");
  const done = read([...first, ended(5, { message: "a", status: "completed", answer: 4, cost: "booked" })]);
  assert.deepEqual([done.open, answerOf(done)], [0, "Answer 1."]);
  // /compact: the turn's end names no answer, so the run's answer is "", never the earlier turn's.
  const compact = read([...first, ended(5, { message: "a", status: "completed", answer: 4 }), message(6, "b"), user(7, "/compact"), sent(8, "b"), assistant(9, [], "stop", 0.0005), ended(10, { message: "b", status: "completed", answer: null })]);
  assert.equal(answerOf(compact), "");
  // A follow-up accepted while the turn works is open from its MESSAGE, whatever comes before its own turn.
  const queued = read([...first, message(5, "b"), ended(6, { message: "a", status: "completed", answer: 4 })]);
  assert.deepEqual([queued.open, queued.end()], [1, undefined], "the queued follow-up keeps the run open");
  const failed = read([...first, ended(5, { message: "a", status: "failed", answer: null, error: "codex: the turn failed" })]);
  assert.deepEqual(failed.end(), { status: "failed", answer: null, error: "codex: the turn failed" });
  assert.equal(read([...first, ended(5, { message: "a", status: "interrupted", answer: null })]).end()?.status, "interrupted");
  // A message a stop dropped before it was sent had no turn.
  const dropped = read([...first, ended(5, { message: "a", status: "interrupted", answer: null }), message(6, "b"), sent(7, "b", false)]);
  assert.deepEqual([dropped.open, dropped.end()?.status], [0, "interrupted"]);
});

test("records read twice read the same, a turn's first end stands, and the end-of-run turn's entries are no turn of the run's", () => {
  const list = [message(1, "a"), user(2, "hi"), sent(3, "a"), assistant(4, [{ type: "text", text: "Answer 1." }], "stop", 0.001), ended(5, { message: "a", status: "completed", answer: 4 }), ended(6, { message: "a", status: "failed", answer: null })];
  const turns = read(list);
  turns.note(list, [], undefined, 2_000);
  assert.deepEqual([turns.open, answerOf(turns)], [0, "Answer 1."]);
  // A follow-up whose turn runs: a snapshot reads every record again, the earlier message's send among them, and the
  // follow-up stays open (records read in place move only when new).
  const working = [...list, message(7, "b"), user(8, "and then?"), sent(9, "b"), { kind: REQUEST_STARTED, id: 10, conversationId: 1, data: { key, request: 3 } }];
  const live = read(working);
  live.note(working, [], undefined, 3_000);
  assert.deepEqual([live.open, live.end()], [1, undefined], "the follow-up is still open");
  const reflected = read([...list, message(7, "r"), sent(8, "r"), assistant(9, [{ type: "text", text: "Noted." }], "stop", 0.001)], [], (id) => id > 6);
  assert.deepEqual([reflected.open, answerOf(reflected)], [0, "Answer 1."], "the end-of-run turn opens no message and answers nothing");
});

test("an older bridge's records still read: #1424's turn end with no message, and no turn end at all", () => {
  // #1424's first form: { key, status }, for the message sent last; its answer, the newest bridge stop with text since.
  const first = [message(1, "a", false), user(2, "hi"), sent(3, "a"), assistant(4, [{ type: "text", text: "Answer 1." }], "stop", 0.001)];
  const old = read([...first, ended(5, { status: "completed" })]);
  assert.deepEqual([old.open, old.legacy, answerOf(old)], [0, false, "Answer 1."]);
  // Before #1424 no turn end was written: the newest message is read by the run's rows (legacy), and a later message
  // sent closes the one before it (the turns are taken one at a time).
  const none = read(first);
  assert.deepEqual([none.open, none.legacy], [1, true]);
  const next = read([...first, message(5, "b", false), user(6, "and?"), sent(7, "b")]);
  assert.deepEqual([next.open, next.legacy], [1, true], "the newest is open and read by its rows");
  next.note([ended(8, { message: "b", status: "completed", answer: null })]);
  assert.deepEqual([next.open, next.legacy, answerOf(next)], [0, false, ""], "and a new bridge's end closes it");
  assert.equal(new Turns().known, false, "no message named: the run is read by its rows");
});

test("pi's input submissions: open while queued or placed, closed by their settlement in the answer's commit; one withdrawn before it was placed had no turn", () => {
  const answer = assistant(5, [{ type: "thinking", thinking: "Nothing to add." }], "stop", 0.001);
  const queued = { id: 2, conversationId: 1, type: "input", status: "queued", requestId: "first-r1" };
  const placed = { ...queued, status: "placed", entry: 3 };
  assert.deepEqual([read([], [queued]).open, read([], [placed]).open], [1, 1]);
  const done = read([user(3, "hi"), answer], [placed, { ...placed, status: "done", answer: 5 }]);
  assert.deepEqual([done.open, answerOf(done)], [0, ""], "a stop with only thinking is answered, with no text");
  // A stop at the length limit is its turn's answer, with its own text.
  const cut = { kind: "pi.assistant", id: 7, conversationId: 1, model: [{ role: "assistant", content: [{ type: "text", text: "Cut short" }], api: "faux", stopReason: "length" }] };
  assert.equal(answerOf(read([user(3, "hi"), cut], [{ ...placed, status: "done", answer: 7 }])), "Cut short");
  // ask_person ends the turn on the entry that asked for it: the person is asked, and the run waits, not answered.
  const ask = assistant(6, [{ type: "toolCall", id: "c1", name: "ask_person", arguments: { question: "Which?" } }], "toolUse", 0.001);
  assert.deepEqual(read([user(3, "hi"), ask], [{ ...placed, status: "done", answer: 6 }]).end(), { status: "asked", answer: null });
  assert.equal(read([], [{ ...placed, status: "done", answer: 6, answer_calls: true }]).end()?.status, "asked", "and so when the snapshot says it");
  // The door's snapshot carries a settled one with its answer's text.
  assert.equal(answerOf(read([], [{ ...placed, status: "done", answer: 9, answer_text: "From the snapshot." }])), "From the snapshot.");
  assert.equal(read([], [{ ...placed, status: "unanswered", reason: "aborted" }]).end()?.status, "interrupted");
  assert.deepEqual(read([], [{ ...placed, status: "unanswered", reason: "model_error", detail: "spend_cap_reached: no room" }]).end(), { status: "failed", answer: null, error: "spend_cap_reached: no room" });
  const withdrawn = read([], [placed, { ...placed, status: "done", answer: 5 }, { id: 7, conversationId: 1, type: "input", status: "queued" }, { id: 7, conversationId: 1, type: "input", status: "unanswered", reason: "aborted" }]);
  assert.deepEqual([withdrawn.open, withdrawn.end()?.status], [0, "answered"]);
  assert.equal(read([], [{ ...queued, requestId: "learn-reflect-r1" }]).known, false, "the end-of-run turn's message is the server's");
});

test("a working turn's last progress: when its message was taken, then each entry since; none once every message is closed", () => {
  const turns = new Turns();
  turns.note([message(1, "a")], [], undefined, 1_000);
  assert.equal(turns.progressAt(), 1_000);
  turns.note([user(2, "hi"), sent(3, "a")], [], undefined, 2_000);
  turns.note([message(1, "a"), user(2, "hi")], [], undefined, 3_000);
  assert.equal(turns.progressAt(), 2_000, "entries read again are no progress");
  turns.note([{ kind: REQUEST_STARTED, id: 4, conversationId: 1, data: { key, request: 1 } }], [], undefined, 4_000);
  assert.equal(turns.progressAt(), 4_000);
  turns.note([ended(5, { message: "a", status: "completed", answer: null })], [], undefined, 5_000);
  assert.equal(turns.progressAt(), undefined);
});
