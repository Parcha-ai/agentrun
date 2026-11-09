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
const { archiveRun, approve, cancel, message, pause, raiseCap, resume, startRun, stop, WAITS_ON_A_PERSON } = await import("../dist/runs-over-store.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { readLaunchBody, learningStartOf } = await import("../dist/run-launch.js");
const { givenOf, learnedOf } = await import("../dist/learning.js");

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

test("a message to a run archived while a follow-up waited takes no message: 409 not_continuable, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  // Archived after the moment was read, as a run archived while its follow-up waited for a place: the write re-reads it.
  await store.runs.archive(id, true);
  await assert.rejects(
    () => message(store, moment({ working: false, awaitingAnswer: false }), "again"),
    (e) => e.code === "not_continuable" && /This run is archived: unarchive it to continue it\./.test(e.message),
  );
  assert.equal((await commandsOf(store, id)).length, 0, "nothing written");
});

test("a message to a completed agentic run opens it again: a follow-up steer, not a refusal", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  const answer = await message(store, moment({ working: false, awaitingAnswer: false, terminal: true, terminalKind: "completed", kind: "agentic" }), "one more");
  assert.equal(answer.mode, "follow_up");
  const rows = await commandsOf(store, id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "steer");
  assert.equal(rows[0].body.text, "one more");
});

test("a message to a failed run is refused, never reopened: 409 not_continuable, nothing written", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => message(store, moment({ working: false, awaitingAnswer: false, terminal: true, terminalKind: "failed", kind: "agentic" }), "again"),
    (e) => e.code === "not_continuable" && /This run failed\./.test(e.message),
  );
  assert.equal((await commandsOf(store, id)).length, 0, "nothing written");
});

test("a message to a completed workflow run is refused: only an agentic run opens again", async () => {
  const store = await freshStore();
  const id = await queuedRun(store);
  await assert.rejects(
    () => message(store, moment({ working: false, awaitingAnswer: false, terminal: true, terminalKind: "completed", kind: "workflow" }), "again"),
    (e) => e.code === "not_continuable" && /This run is finished\./.test(e.message),
  );
  assert.equal((await commandsOf(store, id)).length, 0, "nothing written");
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

test("a start of an agent archived while the start waited does not open a run: 409 agent_not_runnable, nothing written", async () => {
  const store = await freshStore();
  // Archived after the entry was fetched, as an agent archived while its start waited for a place: the write re-reads it.
  await store.agents.archive("a1", true);
  await assert.rejects(
    () => startRun(store, startDeps(), entryOf(), { input: { content: "hi" } }),
    (e) => e.code === "agent_not_runnable" && /The agent a1 is archived: unarchive it to run it\./.test(e.message),
  );
  assert.equal((await store.runs.list({ agentId: "a1" })).length, 0, "no run opened");
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
  const expected = { given: givenOf(learningSeed(), options), seed: "seed-abc", section: learnedOf(learningSeed(), options) ?? "", seedNotes: Object.keys(learningSeed().notes).length };
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
  assert.deepEqual(readLaunchBody((await store.runs.launch(run.id)).body).learning, { given: [], seed: null, section: "" });
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
