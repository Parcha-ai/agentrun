// The write half of the run's server cut (runs-over-store.ts): start is an INSERT, and every act on a run is a command row,
// over a real one store (A) in a temp dir. Each act writes exactly the row or command the old runs.ts flow ended up with,
// and every refusal answers with the old code and words. The run view's live moment is passed in (RunMoment); these tests
// build it directly, as the switch wires the real view to it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");
const { archiveRun, approve, message, raiseCap, stop, WAITS_ON_A_PERSON } = await import("../dist/runs-over-store.js");

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshStore() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-ros-"));
  dirs.push(dir);
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  after(() => store.close().catch(() => undefined));
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: { instructions: "Answer." } });
  return store;
}

/** A queued run of agent a1, revision r1. */
async function queuedRun(store, id = "run-1") {
  await store.runs.create({ id, agentId: "a1", revisionId: "r1" });
  return id;
}

/** A RunMoment with safe defaults (an agentic run working now, not imported, not ended); overrides take over. */
const moment = (over = {}) => ({
  id: "run-1",
  agentId: "a1",
  kind: "agentic",
  cancelled: false,
  terminal: false,
  working: true,
  awaitingAnswer: false,
  steers: true,
  live: true,
  paused: false,
  waitsOnPerson: false,
  ...over,
});

const commandsOf = async (store, id) => store.commands(id, 0);

// ---- archive --------------------------------------------------------------------------------------------------------

test("archiveRun sets the run's own archive time; unarchive clears it", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  assert.equal((await store.runs.get(id)).archivedAt, null);
  await archiveRun(store, id, true);
  assert.notEqual((await store.runs.get(id)).archivedAt, null);
  await archiveRun(store, id, false);
  assert.equal((await store.runs.get(id)).archivedAt, null);
});

// ---- stop -----------------------------------------------------------------------------------------------------------

test("stop writes one stop command and returns true for a live run", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  assert.equal(await stop(store, id), true);
  const rows = await commandsOf(store, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "stop");
});

test("stop returns false and writes nothing for an imported run", async () => {
  const store = await freshStore();
  await store.importRun({
    id: "imp-1", agentId: "a1", revisionId: "r1", importedFrom: { source: "codex", session: "s1" },
    launch: { body: { input: { content: "hi" }, title: "t", place: { mode: "runner" } } }, startedAt: Date.now(), transcript: [],
  });
  assert.equal(await stop(store, "imp-1"), false);
  assert.equal((await commandsOf(store, "imp-1")).length, 0);
});

test("stop returns false and writes nothing for a run already ended (RunFinal)", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  const claim = await store.claim(id, "runner-a");
  await store.runs.update(claim, { state: "ended" });
  assert.equal(await stop(store, id), false);
  assert.equal((await commandsOf(store, id)).length, 0);
});

// ---- message --------------------------------------------------------------------------------------------------------

test("a person's message to a working run writes a steer command, mode steer", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  const answer = await message(store, moment(), "do the thing");
  assert.deepEqual(answer.mode, "steer");
  const rows = await commandsOf(store, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "steer");
  assert.equal(rows[0].body.text, "do the thing");
  assert.equal(rows[0].body.answers, undefined);
});

test("a message to an idle run that asked a question answers it (mode answer), as a steer command", async () => {
  const store = await freshStore();
  await queuedRun(store);
  const answer = await message(store, moment({ working: false, awaitingAnswer: true }), "yes");
  assert.equal(answer.mode, "answer");
  assert.equal((await commandsOf(store, "run-1"))[0].kind, "steer");
});

test("a message to an idle completed-and-reopenable run is a follow-up turn", async () => {
  const store = await freshStore();
  await queuedRun(store);
  const answer = await message(store, moment({ working: false, awaitingAnswer: false }), "again");
  assert.equal(answer.mode, "follow_up");
});

test("a message to a run whose harness takes no mid-turn steer follows the turn", async () => {
  const store = await freshStore();
  await queuedRun(store);
  const answer = await message(store, moment({ steers: false }), "note");
  assert.equal(answer.mode, "follow_up");
});

test("a person's message while a tool call waits for approval declines it: a deny with the words", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  const answer = await message(store, moment({ waitingApprovalId: "call-7" }), "no, don't");
  assert.equal(answer.mode, "answer");
  const rows = await commandsOf(store, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "deny");
  assert.equal(rows[0].body.approval, "call-7");
  assert.equal(rows[0].body.note, "no, don't");
});

test("a trigger message (answers false) to a working run writes a steer marked answers false", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await message(store, moment(), "from the schedule", { answers: false, requestId: "firing-1" });
  const rows = await commandsOf(store, id);
  assert.equal(rows[0].kind, "steer");
  assert.equal(rows[0].body.answers, false);
});

test("a trigger message is refused while the run waits on a person, nothing written (the hazard)", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => message(store, moment({ waitsOnPerson: true, waitingApprovalId: "call-7" }), "from the schedule", { answers: false }),
    (e) => e.code === "not_continuable" && e.message === WAITS_ON_A_PERSON && e.extra.details.reason === "waiting",
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});

test("a message to an imported run is refused, nothing written", async () => {
  const store = await freshStore();
  await store.importRun({
    id: "imp-1", agentId: "a1", revisionId: "r1", importedFrom: { source: "claude-code", session: "s1" },
    launch: { body: { input: { content: "hi" }, title: "t", place: { mode: "runner" } } }, startedAt: Date.now(), transcript: [],
  });
  await assert.rejects(
    () => message(store, moment({ id: "imp-1", importedSource: "claude-code" }), "go on"),
    (e) => e.code === "not_continuable" && /imported from claude-code/.test(e.message) && e.extra.details.reason === "imported",
  );
  assert.equal((await commandsOf(store, "imp-1")).length, 0);
});

test("a message to a run paused at its cap is refused budget_reached, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => message(store, moment({ working: false, maxCostUsd: 2, paused: true, pausedWords: "It reached $2.00." }), "go on"),
    (e) => e.code === "budget_reached" && /paused at its \$2 cap: raise the cap first\. It reached \$2\.00\./.test(e.message) && e.extra.details.cap_usd === 2,
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});

// ---- raiseCap -------------------------------------------------------------------------------------------------------

test("raiseCap above the run's cap writes one raise command with the new cap", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  const answer = await raiseCap(store, moment({ maxCostUsd: 2 }), 5);
  assert.equal(answer.resumed, false);
  const rows = await commandsOf(store, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "raise");
  assert.equal(rows[0].body.capUsd, 5);
});

test("raiseCap of a run paused at its cap reports resumed", async () => {
  const store = await freshStore();
  await queuedRun(store);
  const answer = await raiseCap(store, moment({ maxCostUsd: 2, paused: true, live: false }), 5);
  assert.equal(answer.resumed, true);
});

test("raiseCap of a live working run notes the cap holds from its next process", async () => {
  const store = await freshStore();
  await queuedRun(store);
  const answer = await raiseCap(store, moment({ maxCostUsd: 2, live: true, paused: false }), 5);
  assert.equal(answer.resumed, false);
  assert.match(answer.note, /keeps the \$2 cap it was opened with; the \$5 cap holds from its next process/);
});

test("raiseCap of a run with no cap is refused not_allowed, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => raiseCap(store, moment({ maxCostUsd: undefined }), 5),
    (e) => e.code === "input_invalid" && /This run has no cap to raise: a cap is named when a run starts\./.test(e.message),
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});

test("raiseCap not above the run's cap is refused, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => raiseCap(store, moment({ maxCostUsd: 5 }), 5),
    (e) => e.code === "input_invalid" && /A cap is only raised: name more than the run's \$5\./.test(e.message),
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});

test("raiseCap repeated with the same cap is idempotent: one row, resumed stands", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await raiseCap(store, moment({ maxCostUsd: 2 }), 5);
  // The run now reads cap 5 (the view folds the raise); the same raise again changes nothing.
  const again = await raiseCap(store, moment({ maxCostUsd: 5, paused: true, live: false }), 5);
  assert.equal(again.resumed, true);
  assert.equal((await commandsOf(store, id)).filter((c) => c.kind === "raise").length, 1);
});

// ---- approve --------------------------------------------------------------------------------------------------------

test("approve of a waiting tool call writes an approve command naming it", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await approve(store, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "allow");
  const rows = await commandsOf(store, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "approve");
  assert.equal(rows[0].body.approval, "call-1");
});

test("deny of a waiting tool call writes a deny command with the note", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await approve(store, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "deny", "nope");
  const rows = await commandsOf(store, id);
  assert.equal(rows[0].kind, "deny");
  assert.equal(rows[0].body.note, "nope");
});

test("approve of a call the run never had is 404, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => approve(store, moment({ approvalIds: new Set() }), "call-x", "allow"),
    (e) => e.code === "not_found" && /has no tool call call-x waiting for approval\./.test(e.message),
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});

test("the same answer again changes nothing (first wins), no new command", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await approve(store, moment({ answeredApprovals: { "call-1": { decision: "allow" } } }), "call-1", "allow");
  assert.equal((await commandsOf(store, id)).length, 0);
});

test("a different answer to an answered call is 409 already-answered", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => approve(store, moment({ answeredApprovals: { "call-1": { decision: "allow" } } }), "call-1", "deny"),
    (e) => e.code === "not_continuable" && /The tool call call-1 was already answered: allow\./.test(e.message) && e.extra.details.reason === "already_answered",
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});
