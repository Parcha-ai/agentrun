// The write half of the run's server cut (runs-over-store.ts): start is an INSERT, and every act on a run is a command row,
// over a real one store (A) in a temp dir. Each act writes exactly the row or command the old runs.ts flow ended up with,
// and every refusal answers with the old code and words. The run view's live moment is passed in (RunMoment); these tests
// build it directly, as the switch wires the real view to it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { openSqliteStore, RunFinal } = await import("../dist/store/index.js");
const { archiveRun, approve, cancel, message, pause, raiseCap, resume, startRun, stop, WAITS_ON_A_PERSON } = await import("../dist/runs-over-store.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { momentOverStore } = await import("../dist/store-view.js");
const { readLaunchBody, learningStartOf } = await import("../dist/run-launch.js");
const { learnedParts } = await import("../dist/learning.js");

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

test("a message to a completed agentic run, its moment as the view reads it, is a follow-up turn that reopens the run", async () => {
  const store = await freshStore();
  await queuedRun(store);
  await store.runs.update(await store.claim("run-1", "runner-a", { leaseMs: 30_000 }), { state: "ended", summary: "The answer." });
  const read = await momentOverStore(store, "run-1");
  assert.deepEqual([read.terminal, read.terminalKind, read.working], [true, "completed", false], "the view reads it completed");
  const answer = await message(store, read, "again");
  assert.equal(answer.mode, "follow_up");
  assert.equal((await store.runs.get("run-1")).state, "running", "the store reopened it");
  assert.deepEqual((await commandsOf(store, "run-1")).map((one) => [one.kind, one.body.text, one.takenAt]), [["steer", "again", null]]);
});

test("a message to a working claude-agent run, its moment as the view reads it, is a steer; to a working codex run, a follow-up", async () => {
  const store = await freshStore();
  for (const harness of ["claude-agent", "codex"]) {
    await store.agents.create({ id: `a-${harness}`, name: harness }, { id: `r-${harness}`, kind: "agentic", body: { instructions: "Answer.", harness } });
    await store.runs.create({ id: `run-${harness}`, agentId: `a-${harness}`, revisionId: `r-${harness}` });
  }
  const steered = await momentOverStore(store, "run-claude-agent");
  assert.deepEqual([steered.working, steered.steers], [true, true], "claude-agent steers mid-turn");
  assert.equal((await message(store, steered, "check the totals")).mode, "steer");
  const followed = await momentOverStore(store, "run-codex");
  assert.deepEqual([followed.working, followed.steers], [true, false], "codex takes no message mid-turn");
  assert.equal((await message(store, followed, "check the totals")).mode, "follow_up");
});

/** `id` (queued first) claimed and ended with `patch`. */
async function endedRun(store, id, patch) {
  await queuedRun(store, id);
  await store.runs.update(await store.claim(id, "runner-a", { leaseMs: 30_000 }), patch);
}

test("a message to an agentic run a person stopped reopens it with the message as its next turn", async () => {
  const store = await freshStore();
  await endedRun(store, "run-1", { state: "stopped", summary: "stopped by a person", outcome: "stopped" });
  const answer = await message(store, moment({ working: false }), "Go on, then.");
  assert.equal(answer.mode, "follow_up");
  const row = await store.runs.get("run-1");
  assert.deepEqual([row.state, row.runner, row.endedAt, row.outcome], ["running", null, null, null], "opened again, for a runner to claim");
  assert.deepEqual((await commandsOf(store, "run-1")).map((one) => [one.kind, one.body.text, one.takenAt]), [["steer", "Go on, then.", null]]);
});

test("a message to a cancelled run answers 409 finished in today's words, nothing written", async () => {
  const store = await freshStore();
  await endedRun(store, "run-1", { state: "stopped", summary: "cancelled", outcome: "cancelled" });
  await assert.rejects(
    () => message(store, moment({ cancelled: true, terminal: true, terminalKind: "cancelled", working: false }), "Go on."),
    (e) => e.code === "not_continuable" && e.status === 409 && e.message === "This run was cancelled. Start a new run of the agent.",
  );
  assert.equal((await commandsOf(store, "run-1")).length, 0);
  assert.equal((await store.runs.get("run-1")).state, "stopped");
});

test("two messages racing at a completed agentic run are both taken as steers: one reopens it, the other lands on the reopened run, neither is refused", async () => {
  const store = await freshStore();
  await endedRun(store, "run-two", { state: "ended", summary: "The first answer." });
  const done = moment({ id: "run-two", working: false, terminal: true, terminalKind: "completed" });
  // Both read the run ended and are refused their steer; the other message's reopen lands between this one's refusal and
  // its own reopen, so this one's reopen finds the run running again.
  let raced = false;
  const racing = {
    runs: {
      ...store.runs,
      reopen: async (runId, command) => {
        if (!raced) {
          raced = true;
          await message(store, done, "first");
        }
        return store.runs.reopen(runId, command);
      },
    },
    command: (...args) => store.command(...args),
    commands: (...args) => store.commands(...args),
    runOfOrigin: (...args) => store.runOfOrigin(...args),
  };
  const answer = await message(racing, done, "second");
  assert.equal(answer.mode, "follow_up");
  assert.equal((await store.runs.get("run-two")).state, "running");
  const rows = await commandsOf(store, "run-two");
  assert.deepEqual(rows.map((row) => [row.kind, row.body.text, row.takenAt]), [["steer", "first", null], ["steer", "second", null]], "both steers, in the order the run took them");
});

test("a message racing a run's end (the moment read before it) is refused by the store's reopen in that end's words: cancelled or failed, nothing written", async () => {
  const store = await freshStore();
  for (const [id, patch, words] of [
    ["run-c", { state: "stopped", summary: "cancelled", outcome: "cancelled" }, "This run was cancelled. Start a new run of the agent."],
    ["run-f", { state: "failed", summary: "it broke" }, "This run failed. Start a new run of the agent."],
  ]) {
    await endedRun(store, id, patch);
    await assert.rejects(() => message(store, moment({ id, working: false }), "Go on."), (e) => e.code === "not_continuable" && e.status === 409 && e.message === words, id);
    assert.equal((await commandsOf(store, id)).length, 0, id);
    assert.equal((await store.runs.get(id)).state, patch.state, id);
  }
});

test("a message to a run that failed, or to a completed workflow run, answers 409 finished in today's words through the store's refusal, nothing written", async () => {
  const store = await freshStore();
  await endedRun(store, "run-1", { state: "failed", summary: "it broke" });
  await assert.rejects(
    () => message(store, moment({ terminal: true, terminalKind: "failed", working: false }), "Go on."),
    (e) => e.code === "not_continuable" && e.status === 409 && e.message === "This run failed. Start a new run of the agent.",
  );
  assert.equal((await commandsOf(store, "run-1")).length, 0);
  await store.agents.addRevision({ agentId: "a1", id: "r-wf", kind: "workflow", body: { workflow: { name: "w", nodes: [] } } });
  await store.runs.create({ id: "run-wf", agentId: "a1", revisionId: "r-wf" });
  await store.runs.update(await store.claim("run-wf", "runner-a", { leaseMs: 30_000 }), { state: "ended" });
  await assert.rejects(
    () => message(store, moment({ id: "run-wf", kind: "workflow", terminal: true, terminalKind: "completed", working: false }), "Go on."),
    (e) => e.code === "not_continuable" && e.status === 409 && e.message === "This run is finished. Start a new run of the agent.",
  );
  assert.equal((await commandsOf(store, "run-wf")).length, 0);
  assert.equal((await store.runs.get("run-wf")).state, "ended");
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

test("raiseCap of a run a person stopped is refused not_continuable in words, never a bare RunFinal, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  const claim = await store.claim(id, "runner-a");
  await store.runs.update(claim, { state: "stopped" });
  // A person-stopped run reads waiting on its next message (input_required), not ended: its moment is not terminal.
  await assert.rejects(
    () => raiseCap(store, moment({ maxCostUsd: 2, working: false, live: false }), 5),
    (error) => error?.code === "not_continuable" && error.message === "This run was stopped: send it a message to go on, then raise its cap.",
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});

test("raiseCap of a run paused at its cap reports resumed", async () => {
  const store = await freshStore();
  await queuedRun(store);
  const answer = await raiseCap(store, moment({ maxCostUsd: 2, paused: true, live: false }), 5);
  assert.equal(answer.resumed, true);
});

test("raiseCap of a live working run notes the raised cap holds from its next step, the step under way at the cap it was admitted at", async () => {
  const store = await freshStore();
  await queuedRun(store);
  const answer = await raiseCap(store, moment({ maxCostUsd: 2, live: true, paused: false }), 5);
  assert.equal(answer.resumed, false);
  assert.equal(answer.note, "The $5 cap holds from the run's next step; a step already under way keeps the $2 cap it was admitted at.");
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

for (const [ending, words] of [["stop", "withdrawn when its run was stopped"], ["cancel", "canceled with its run"]]) {
  test(`an answer to a waiting call after the run was given a ${ending} is 409 ${ending === "stop" ? "withdrawn" : "canceled"}, nothing written: the ${ending} comes first, so the call never runs`, async () => {
    for (const decision of ["allow", "deny"]) {
      const store = await freshStore();
      const id = await queuedRun(store);
      await sendCommand(store, id, { kind: ending, body: {} });
      await assert.rejects(
        () => approve(store, moment({ approvalIds: new Set(["call-1"]) }), "call-1", decision),
        (e) => e.code === "not_continuable" && e.message === `The tool call call-1 was already ${words}.` && e.extra.details.reason === "already_answered",
        decision,
      );
      assert.deepEqual((await commandsOf(store, id)).map((row) => row.kind), [ending], `${decision}: no answer written`);
    }
  });
}

test("an answer whose write lands just after a stop's is 409 withdrawn: the stop is read first, so the call never runs", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  // The stop is written between the answer's check and its own write.
  const racing = {
    runs: store.runs,
    agents: store.agents,
    commands: (...args) => store.commands(...args),
    runOfOrigin: (...args) => store.runOfOrigin(...args),
    command: async (runId, command) => {
      if (command.kind === "approve") await store.command(runId, { kind: "stop", body: {} });
      return store.command(runId, command);
    },
  };
  await assert.rejects(
    () => approve(racing, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "allow"),
    (e) => e.code === "not_continuable" && e.message === "The tool call call-1 was already withdrawn when its run was stopped.",
  );
  assert.deepEqual((await commandsOf(store, id)).map((row) => row.kind), ["stop", "approve"], "the stop is read first: its end refuses the answer");
});

test("an answer whose write lands just after a stop's, and whose run's stopped end is written before it is read back, is 409 withdrawn: the end refused it", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  // The stop is written between the answer's check and its own write, and the runner takes it (the run's stopped end,
  // which refuses every row left untaken) right after the answer's write, before the answer reads back.
  const racing = {
    runs: store.runs,
    agents: store.agents,
    commands: (...args) => store.commands(...args),
    runOfOrigin: (...args) => store.runOfOrigin(...args),
    command: async (runId, command) => {
      if (command.kind !== "approve") return store.command(runId, command);
      const stop = await store.command(runId, { kind: "stop", body: {} });
      const written = await store.command(runId, command);
      await store.runs.update(await store.claim(runId, "runner-a"), { state: "stopped", summary: "stopped by a person" }, { take: [stop.id] });
      return written;
    },
  };
  await assert.rejects(
    () => approve(racing, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "allow"),
    (e) => e.code === "not_continuable" && e.message === "The tool call call-1 was already withdrawn when its run was stopped.",
  );
  const rows = await commandsOf(store, id);
  assert.deepEqual(rows.map((row) => [row.kind, row.takenAt !== null, row.refused !== null]), [["stop", true, false], ["approve", true, true]], "the end took the stop and refused the answer (a refused row reads taken, with its refusal)");
});

test("a retry of an answer written behind a stop the runner has not taken yet is 409 withdrawn too, never settled as taken", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  // The first try's rows as its race left them: the stop, then the answer (that try was told 409).
  await sendCommand(store, id, { kind: "stop", body: {} });
  await sendCommand(store, id, { kind: "approve", body: { approval: "call-1" } });
  await assert.rejects(
    () => approve(store, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "allow"),
    (e) => e.code === "not_continuable" && e.message === "The tool call call-1 was already withdrawn when its run was stopped.",
  );
  assert.deepEqual((await commandsOf(store, id)).map((row) => row.kind), ["stop", "approve"], "nothing more written");
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

test("a stop or cancel written between approve's read and its answer's write still makes the answer 409, by the rows' order", async () => {
  for (const [kind, decision] of [["stop", "withdrawn"], ["cancel", "canceled"]]) {
    const store = await freshStore();
    const id = await queuedRun(store);
    // The stop lands just as the answer is written: after approve read the run, before its own row.
    const racing = { ...store, command: async (runId, row) => (await store.command(runId, { kind, body: {} }), store.command(runId, row)), commands: (...args) => store.commands(...args), runs: store.runs };
    await assert.rejects(
      () => approve(racing, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "allow"),
      (e) => e.code === "not_continuable" && e.extra.details.reason === "already_answered" && e.extra.details.decision === decision,
      `${kind}: the answer behind it is 409 ${decision}`,
    );
    assert.deepEqual((await commandsOf(store, id)).map((c) => c.kind), [kind, "approve"], `${kind}: the stop first, the answer after it (the runner refuses it at the stop)`);
  }
});

test("an answer behind a cancel then a stop reads canceled: the first end the runner reads is the one it applies", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await store.command(id, { kind: "cancel", body: {} });
  await store.command(id, { kind: "stop", body: {} });
  await assert.rejects(
    () => approve(store, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "allow"),
    (e) => e.code === "not_continuable" && e.extra.details.decision === "canceled",
  );
});

test("an answer to a run gone final since it was read (its runner took a stop) is 409 with how its end answered the call, never a 500", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  const stopped = await store.command(id, { kind: "stop", body: {} });
  // The run final: the store refuses a new row (RunFinal), and its stop row is taken.
  const final = { ...store, command: async () => { throw new RunFinal(id); }, commands: async () => (await store.commands(id, 0)).map((c) => (c.id === stopped.id ? { ...c, takenAt: Date.now() } : c)), runs: store.runs };
  await assert.rejects(
    () => approve(final, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "allow"),
    (e) => e.code === "not_continuable" && e.extra.details.reason === "already_answered" && e.extra.details.decision === "withdrawn",
  );
  const ended = { ...store, command: async () => { throw new RunFinal(id); }, commands: async () => [], runs: store.runs };
  await assert.rejects(
    () => approve(ended, moment({ approvalIds: new Set(["call-1"]) }), "call-1", "allow"),
    (e) => e.code === "not_continuable" && /withdrawn when its run ended/.test(e.message),
    "a run that ended on its own: withdrawn when its run ended",
  );
});

// ---- start ----------------------------------------------------------------------------------------------------------

/** An agentic revision as toolingOf/planeFor read it. */
const revisionOf = (over = {}) => ({ id: "r1", agentId: "a1", kind: "agentic", body: { instructions: "Answer.", tools: [], skills: {}, ...over }, createdAt: 0 });

/** An AgentEntry for agent a1 on revision r1. */
const entryOf = () => ({ agent: { id: "a1", name: "Agent one", description: null, currentRevision: "r1", createdAt: 0, archivedAt: null }, revision: revisionOf(), version: 1, revisions: 1, sizes: new Map() });

/** StartDeps whose leaf checks all pass; overrides take over (e.g. a runBodyIssues that refuses). */
const startDeps = (over = {}) => ({
  runBodyIssues: () => [],
  pinnedOf: async () => ({ revision: revisionOf(), version: 1 }),
  inputIssuesOf: async () => [],
  explainRun: async (issues) => issues,
  told: (error) => error,
  runnable: async () => {},
  readyFiles: async () => [],
  fallbackPlace: () => ({ mode: "runner" }),
  workflowTitle: (name) => `Workflow of ${name}`,
  serverSecrets: () => [],
  toolSettings: () => ({}),
  planeEnv: () => ({}),
  modelOf: () => ({ provider: "anthropic", modelId: "claude" }),
  ...over,
});

test("startRun inserts a queued run and its launch body with the run's cap", async () => {
  const store = await freshStore();
  const run = await startRun(store, startDeps(), entryOf(), { input: { content: "hi" }, max_cost_usd: 3, effort: "high" });
  assert.equal(run.state, "queued");
  assert.equal(run.agentId, "a1");
  assert.equal(run.revisionId, "r1");
  const launch = readLaunchBody((await store.runs.launch(run.id)).body);
  assert.equal(launch.maxCostUsd, 3);
  assert.equal(launch.effort, "high");
  assert.equal(launch.title, "hi");
  assert.deepEqual(launch.place, { mode: "runner" });
  assert.equal(launch.harness, "pi");
  assert.deepEqual(launch.model, { provider: "anthropic", modelId: "claude" });
});

// A run's effort is its own (the start body's), else its revision's thinking, else the host's AGENT_THINKING: the level its
// harness thinks at, its guidance and its metrics name. A saved setting is never dropped; nothing saved, no effort.
test("startRun's effort: the run's own, else its revision's thinking, else the host's AGENT_THINKING; none of them, none", async () => {
  const effortOf = async (body, { thinking, env = {} } = {}) => {
    const store = await freshStore();
    const revision = revisionOf(thinking ? { thinking } : {});
    const deps = startDeps({ pinnedOf: async () => ({ revision, version: 1 }), planeEnv: () => env });
    const run = await startRun(store, deps, { ...entryOf(), revision }, { input: { content: "hi" }, ...body });
    return readLaunchBody((await store.runs.launch(run.id)).body).effort;
  };
  assert.equal(await effortOf({ effort: "low" }, { thinking: "high", env: { AGENT_THINKING: "max" } }), "low", "the run's own wins");
  assert.equal(await effortOf({}, { thinking: "high", env: { AGENT_THINKING: "max" } }), "high", "else its revision's thinking");
  assert.equal(await effortOf({}, { env: { AGENT_THINKING: "xhigh" } }), "xhigh", "else the host's AGENT_THINKING");
  assert.equal(await effortOf({}, { env: { AGENT_THINKING: " high " } }), undefined, "a host setting that names no level exactly is no effort");
  assert.equal(await effortOf({}, { env: { AGENT_THINKING: "off" } }), undefined, "nor is off: thinking is never off");
  assert.equal(await effortOf({}), undefined, "none of them: none");
});

test("startRun names the run's ready files in its launch, in order, for the runner to copy", async () => {
  const store = await freshStore();
  const seen = [];
  const deps = startDeps({ readyFiles: async (ids) => { seen.push(...ids); return ids; } });
  const run = await startRun(store, deps, entryOf(), { input: { content: "hi" }, file_ids: ["f-2", "f-1"] });
  assert.deepEqual(seen, ["f-2", "f-1"]);
  assert.deepEqual(readLaunchBody((await store.runs.launch(run.id)).body).files, ["f-2", "f-1"]);
});

test("startRun takes the agent's default cap and cap mode when the body names none", async () => {
  const store = await freshStore();
  const deps = startDeps({ pinnedOf: async () => ({ revision: revisionOf({ maxCostUsd: 2, capMode: "expected" }), version: 1 }) });
  const run = await startRun(store, deps, entryOf(), { input: { content: "hi" } });
  const launch = readLaunchBody((await store.runs.launch(run.id)).body);
  assert.equal(launch.maxCostUsd, 2);
  assert.equal(launch.capMode, "expected");
});

test("startRun keeps the body's cap mode over the agent's default", async () => {
  const store = await freshStore();
  const deps = startDeps({ pinnedOf: async () => ({ revision: revisionOf({ maxCostUsd: 2, capMode: "expected" }), version: 1 }) });
  const run = await startRun(store, deps, entryOf(), { input: { content: "hi" }, max_cost_usd: 5, cap_mode: "strict" });
  const launch = readLaunchBody((await store.runs.launch(run.id)).body);
  assert.equal(launch.maxCostUsd, 5);
  assert.equal(launch.capMode, "strict");
});

test("startRun refuses an invalid body with its field issues, nothing written", async () => {
  const store = await freshStore();
  const deps = startDeps({ runBodyIssues: () => [{ field: "input", reason: "missing", message: "input is an object" }] });
  await assert.rejects(
    () => startRun(store, deps, entryOf(), {}),
    (e) => e.code === "input_invalid" && /input is an object/.test(e.message),
  );
  assert.equal((await store.runs.list({ agentId: "a1" })).length, 0);
});

test("startRun refuses a body naming an unknown revision, nothing written", async () => {
  const store = await freshStore();
  const deps = startDeps({ pinnedOf: async () => undefined });
  await assert.rejects(
    () => startRun(store, deps, entryOf(), { input: { content: "hi" }, revision: "rX" }),
    (e) => e.code === "input_invalid" && /rX is not a revision of the agent a1/.test(e.message),
  );
  assert.equal((await store.runs.list({ agentId: "a1" })).length, 0);
});

test("a trigger run with no cap and no agent default is refused (every trigger run is capped)", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => startRun(store, startDeps(), entryOf(), { input: { content: "hi" } }, { capped: true }),
    (e) => e.code === "input_invalid" && /Every run a trigger starts is capped/.test(e.message),
  );
  assert.equal((await store.runs.list({ agentId: "a1" })).length, 0);
});

test("a cap mode with no cap is refused", async () => {
  const store = await freshStore();
  await assert.rejects(
    () => startRun(store, startDeps(), entryOf(), { input: { content: "hi" }, cap_mode: "strict" }),
    (e) => e.code === "input_invalid" && /cap_mode says how a run's cap prices its requests, and this run has no cap/.test(e.message),
  );
});

test("startRun under an origin key starts one run; a retry under the same key gets that run", async () => {
  const store = await freshStore();
  const first = await startRun(store, startDeps(), entryOf(), { input: { content: "hi" } }, { origin: { key: "firing-1" } });
  const again = await startRun(store, startDeps(), entryOf(), { input: { content: "hi" } }, { origin: { key: "firing-1" } });
  assert.equal(again.id, first.id);
  assert.equal((await store.runs.list({ agentId: "a1" })).length, 1);
});

// ---- learning start -------------------------------------------------------------------------------------------------

const shown = () => ({ text: (t) => t, name: (n) => n, holds: () => false });
/** A learning seed with one active note. */
const learningSeed = () => ({ sha: "seed-abc", notes: { "a.md": "# A\n\nlearned a thing" }, files: [], skipped: [], recent: ["a.md"] });
const learningDeps = (over = {}) => startDeps({ learning: "on", learningBudget: 8000, shown, seedFor: async () => ({ seed: learningSeed() }), pinnedOf: async () => ({ revision: revisionOf({ learning: true, tools: ["read"] }), version: 1 }), ...over });

test("startRun records the exact given notes, seed, # Learned section and seedNotes a learning agent's start would", async () => {
  const store = await freshStore();
  const run = await startRun(store, learningDeps(), entryOf(), { input: { content: "hi" }, max_cost_usd: 1 });
  const launch = readLaunchBody((await store.runs.launch(run.id)).body);
  const options = { budget: 8000, read: true, shown: shown() };
  const expected = { given: learnedParts(learningSeed(), options).given.map(({ file, name }) => ({ file, name })), seed: "seed-abc", section: learnedParts(learningSeed(), options).section ?? "", seedNotes: Object.keys(learningSeed().notes).length };
  assert.deepEqual(launch.learning, expected);
  assert.deepEqual(learningStartOf(launch), expected);
  // Each given entry carries its name, not just a file.
  assert.ok(launch.learning.given.every((n) => typeof n.file === "string" && typeof n.name === "string"));
});

test("seedNotes counts the whole seed, so a seed over the budget has seedNotes above given.length", async () => {
  const store = await freshStore();
  // Several notes, each sizeable; a small budget admits fewer than all into given.
  const bigSeed = () => ({ sha: "seed-big", notes: { "a.md": `# A\n\n${"x".repeat(400)}`, "b.md": `# B\n\n${"y".repeat(400)}`, "c.md": `# C\n\n${"z".repeat(400)}` }, files: [], skipped: [], recent: ["a.md", "b.md", "c.md"] });
  const run = await startRun(store, learningDeps({ learningBudget: 300, seedFor: async () => ({ seed: bigSeed() }) }), entryOf(), { input: { content: "hi" } });
  const learning = readLaunchBody((await store.runs.launch(run.id)).body).learning;
  assert.equal(learning.seedNotes, 3);
  assert.ok(learning.seedNotes > learning.given.length, "the budget narrowed given below the whole seed's note count");
});

test("startRun records the learned skills the seed offers the run: each with its files and no host secret, none held by its size", async () => {
  const store = await freshStore();
  const seed = () => ({
    ...learningSeed(),
    skills: [
      { name: "weekly-report", bytes: 10, files: { "SKILL.md": "---\nname: weekly-report\ndescription: d\n---\nSteps." } },
      { name: "too-big", bytes: 999999 },
      { name: "leaky", bytes: 10, files: { "SKILL.md": "---\nname: leaky\ndescription: d\n---\nUse secret-value-0001." } },
    ],
  });
  const holds = { text: (t) => t, name: (n) => n, holds: (t) => t.includes("secret-value-0001") };
  const run = await startRun(store, learningDeps({ seedFor: async () => ({ seed: seed() }), shown: () => holds }), entryOf(), { input: { content: "hi" } });
  assert.deepEqual(readLaunchBody((await store.runs.launch(run.id)).body).learning.skills, ["weekly-report"]);
  // A seed with no skill records none.
  const plain = await startRun(store, learningDeps(), entryOf(), { input: { content: "hi" } });
  assert.equal("skills" in readLaunchBody((await store.runs.launch(plain.id)).body).learning, false);
});

test("startRun records no learning for a non-learning run", async () => {
  const store = await freshStore();
  // The same deps, but the revision does not learn.
  const run = await startRun(store, learningDeps({ pinnedOf: async () => ({ revision: revisionOf({ learning: false, tools: ["read"] }), version: 1 }) }), entryOf(), { input: { content: "hi" } });
  assert.equal(readLaunchBody((await store.runs.launch(run.id)).body).learning, undefined);
});

test("startRun records the server's learning off as no learning", async () => {
  const store = await freshStore();
  const run = await startRun(store, learningDeps({ learning: "off" }), entryOf(), { input: { content: "hi" } });
  assert.equal(readLaunchBody((await store.runs.launch(run.id)).body).learning, undefined);
});

test("a learning run whose seed cannot be read starts with nothing (given empty, seed null, section empty)", async () => {
  const store = await freshStore();
  const run = await startRun(store, learningDeps({ seedFor: async () => ({ failed: "no git here" }) }), entryOf(), { input: { content: "hi" } });
  assert.deepEqual(readLaunchBody((await store.runs.launch(run.id)).body).learning, { given: [], seed: null, section: "", seedFailed: "unreadable" });
});

test("a learning run whose start can't be made from the seed it read starts with nothing, saying it was not copied", async () => {
  const store = await freshStore();
  // A seed read whole whose notes can't be read into the start (here, a notes field that is no object).
  const run = await startRun(store, learningDeps({ seedFor: async () => ({ seed: { ...learningSeed(), notes: null } }) }), entryOf(), { input: { content: "hi" } });
  const learning = readLaunchBody((await store.runs.launch(run.id)).body).learning;
  assert.deepEqual(learning, { given: [], seed: null, section: "", seedFailed: "not_copied" });
});

test("a launch's seedFailed outside its list is read as none", () => {
  assert.equal(readLaunchBody({ input: { content: "x" }, title: "t", place: { mode: "runner" }, learning: { given: [], seed: null, section: "", seedFailed: "elsewhere" } }).learning.seedFailed, undefined);
});

// ---- cancel ---------------------------------------------------------------------------------------------------------

test("cancel writes one cancel command and returns true for a live run", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  assert.equal(await cancel(store, moment()), true);
  const rows = await commandsOf(store, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "cancel");
});

test("cancel returns false and writes nothing for an imported run", async () => {
  const store = await freshStore();
  await store.importRun({
    id: "run-1", agentId: "a1", revisionId: "r1", importedFrom: { source: "pi", session: "s1" },
    launch: { body: { input: { content: "hi" }, title: "t", place: { mode: "runner" } } }, startedAt: Date.now(), transcript: [],
  });
  assert.equal(await cancel(store, moment({ importedSource: "pi" })), false);
  assert.equal((await commandsOf(store, "run-1")).length, 0);
});

test("cancel returns false and writes nothing for a run already ended or ending", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  assert.equal(await cancel(store, moment({ terminal: true, terminalKind: "completed" })), false);
  assert.equal(await cancel(store, moment({ cancelled: true })), false);
  assert.equal((await commandsOf(store, id)).length, 0);
});

// ---- pause / resume -------------------------------------------------------------------------------------------------

test("pause writes a pause command for a workflow run; resume writes a resume command", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  assert.deepEqual(await pause(store, moment({ kind: "workflow" })), { run_id: id, paused: true });
  assert.deepEqual(await resume(store, moment({ kind: "workflow" })), { run_id: id, paused: false });
  const rows = await commandsOf(store, id);
  assert.deepEqual(rows.map((r) => r.kind), ["pause", "resume"]);
});

test("pause of an agentic run is 501 unsupported here, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => pause(store, moment({ kind: "agentic" })),
    (e) => e.code === "unsupported_here" && /Only a workflow run pauses here: an agentic run's turn is stopped with POST \/runs\/\{id\}\/stop\./.test(e.message),
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});

test("pause of an ended run is 409 not_continuable, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => pause(store, moment({ kind: "workflow", terminal: true, terminalKind: "completed" })),
    (e) => e.code === "not_continuable",
  );
  assert.equal((await commandsOf(store, id)).length, 0);
});

// ---- command shapes pinned against the runner's parser --------------------------------------------------------------

test("every command this module writes is one the runner's parser accepts", async () => {
  const store = await freshStore();
  // The runner reads commands through sendCommand's parser (runner/commands.ts); each kind/body a writer here emits must
  // pass it, so the runner takes exactly what we write.
  await queuedRun(store, "steer-run");
  await queuedRun(store, "steer-trg");
  await queuedRun(store, "deny-run");
  await queuedRun(store, "approve-run");
  await queuedRun(store, "raise-run");
  await queuedRun(store, "stop-run");
  await queuedRun(store, "cancel-run");
  await sendCommand(store, "steer-run", { kind: "steer", body: { text: "hi" } });
  await sendCommand(store, "steer-trg", { kind: "steer", body: { text: "hi", answers: false, origin: { kind: "trigger", trigger_id: "t1", source: "schedule", owner: true } } });
  await sendCommand(store, "deny-run", { kind: "deny", body: { approval: "call-1", note: "no" } });
  await sendCommand(store, "approve-run", { kind: "approve", body: { approval: "call-1" } });
  await sendCommand(store, "raise-run", { kind: "raise", body: { capUsd: 5 } });
  await sendCommand(store, "stop-run", { kind: "stop", body: {} });
  await sendCommand(store, "cancel-run", { kind: "cancel", body: {} });
  for (const id of ["steer-run", "steer-trg", "deny-run", "approve-run", "raise-run", "stop-run", "cancel-run"]) {
    assert.equal((await commandsOf(store, id)).length, 1);
  }
});
