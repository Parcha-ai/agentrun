// A serving digest's check (runner/promotion.ts promotionGate), over a store of graded runs: once per 20 graded runs it
// served, its thresholds refit (a new revision, promoted on the rows it was fit on, when they move within the bar) and it
// is held when its graded runs fall more than 2 points under the agent's by hand. Escalation never holds it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { promotionGate } = await import("../dist/runner/promotion.js");
const { GRADES_KEPT, gradesOf, putGrade, promotionsOf, recordPromotion, REFIT_EVERY } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");

const flowOf = (guard) => JSON.stringify({ v: 2, name: "answer", schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } } }, input: { schemaId: "In" }, output: { schemaId: "In", path: "question" },
  root: { node: "agent", label: "answer", instructions: "Answer.", out: "In", as: "answer", tools: [], ...(guard ? { guard } : {}) } });

/** A store of `served` graded runs at the workflow's digest (each `[correct, p]`, path workflow, or handed_back when p
 *  is under the guard's threshold) and `byHand` graded agent runs, all right; the workflow promoted at its digest. */
async function storeOf({ text, served, byHand = 10, threshold = 0.5 }) {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  const digest = workflowDigest({ workflow: text });
  const rows = new Map();
  let at = 0;
  for (let i = 0; i < byHand; i++) await putGrade(settings, "a", { run: `hand-${i}`, correct: true, source: "eval", at: `t${at++}`, path: "agent" });
  for (const [i, [correct, p]] of served.entries()) {
    const path = p < threshold ? "handed_back" : "workflow";
    rows.set(`served-${i}`, { id: `served-${i}`, state: "ended", metrics: { path, workflow: "answer", workflow_digest: digest, guards: [{ node: "answer", signal: "self", self: p, p, threshold, escalated: p < threshold }] } });
    await putGrade(settings, "a", { run: `served-${i}`, correct, source: "eval", at: `t${at++}`, path, workflow: "answer", digest });
  }
  await recordPromotion(settings, "a", { workflow: "answer", digest, at: new Date(0).toISOString(), decided: "promote", source: "dry_run", reason: "no graded input it fits: promoted on its passing dry run" }, (was) => was === undefined);
  const store = { settings, runs: { get: async (id) => rows.get(id) } };
  const commits = [];
  const logs = [];
  const gate = promotionGate({ store, agentId: "a", runId: "now", revisionId: "rev", launch: { input: {}, title: "", place: { mode: "runner" } }, context: ctx, log: (line) => logs.push(line), commit: async (files, reason, id) => (commits.push({ files, reason, id }), `commit-${commits.length}`) });
  // The gate answers the workflow that serves: this one, or none (the agent takes the run).
  const serves = async (workflow, at) => { const got = await gate(workflow, at); assert.ok(got === undefined || got === workflow, "no champion here: the laid workflow or none"); return got === workflow; };
  return { gate: serves, settings, digest, commits, logs };
}

test("a serving digest under REFIT_EVERY graded runs is not checked: it serves", async () => {
  const text = flowOf({ signal: "self", threshold: 0.5 });
  const { gate, settings, commits } = await storeOf({ text, served: Array.from({ length: REFIT_EVERY - 1 }, () => [false, 0.9]) });
  assert.equal(await gate({ name: "answer", workflow: text }, workflowDigest({ workflow: text })), true);
  assert.deepEqual(commits, []);
  assert.equal((await promotionsOf(settings, "a")).length, 1);
});

test("20 graded runs it served: its guard refit to the cheapest threshold within the bar lands as a new revision, once", async () => {
  const text = flowOf({ signal: "self", threshold: 0.5 });
  // Wrong exactly when its own confidence is under 0.7: a threshold of 0.5 lets some serve wrong.
  const served = Array.from({ length: REFIT_EVERY }, (_, i) => { const p = 0.5 + (i % 5) * 0.1; return [p >= 0.7, p]; });
  const { gate, settings, digest, commits, logs } = await storeOf({ text, served });
  assert.equal(await gate({ name: "answer", workflow: text }, digest), true, "it still serves this run; the refit serves from the next");
  assert.equal(commits.length, 1, logs.join("\n"));
  const written = JSON.parse(commits[0].files[0].text);
  assert.equal(commits[0].files[0].path, "workflows/answer/workflow.json");
  assert.equal(written.root.guard.threshold, 0.7);
  const records = await promotionsOf(settings, "a");
  const refit = records.at(-1);
  assert.deepEqual({ decided: refit.decided, source: refit.source, digest: refit.digest, from: refit.refit.from, guards: refit.refit.guards, commit: refit.commit }, { decided: "promote", source: "refit", digest: workflowDigest({ workflow: commits[0].files[0].text }), from: digest, guards: [{ node: "answer", was: 0.5, threshold: 0.7 }], commit: "commit-1" }, "the refit's record names the learning commit its text landed as");
  assert.equal(records.filter((one) => one.digest === digest).at(-1).checked, 10 + REFIT_EVERY, "checked through its newest grade's seq: 10 by hand, then the 20 it served");
  // The same 20 again: not checked twice.
  assert.equal(await gate({ name: "answer", workflow: text }, digest), true);
  assert.equal(commits.length, 1);
});

test("graded runs it served more than 2 points under the agent by hand, nothing to refit: held; hand-backs graded right never hold it", async () => {
  const text = flowOf(undefined);
  const wrong = await storeOf({ text, served: Array.from({ length: REFIT_EVERY }, (_, i) => [i % 4 !== 0, 0.9]) });
  assert.equal(await wrong.gate({ name: "answer", workflow: text }, wrong.digest), false);
  const held = (await promotionsOf(wrong.settings, "a")).at(-1);
  assert.deepEqual({ decided: held.decided, source: held.source }, { decided: "hold", source: "graded" });
  assert.match(held.reason, /20 graded runs it served were right 75\.0% of the time, more than 2 pts under the agent's 100\.0% by hand/);
  // Every one handed back (its guard under threshold) and graded right: the agent's answers, all right. It serves on.
  const guarded = flowOf({ signal: "self", threshold: 0.5 });
  const handed = await storeOf({ text: guarded, served: Array.from({ length: REFIT_EVERY }, () => [true, 0.2]) });
  assert.equal(await handed.gate({ name: "answer", workflow: guarded }, handed.digest), true);
  assert.equal((await promotionsOf(handed.settings, "a")).at(-1).decided, "promote");
  // Nor do they bring its guard down: what it would have answered past 0.2 nobody read, so no refit lands.
  assert.deepEqual(handed.commits, [], `no refit over hand-backs with no answer: ${handed.logs.join("\n")}`);
  assert.equal((await promotionsOf(handed.settings, "a")).at(-1).digest, handed.digest);
});

test("the graded check keeps coming past the grades kept: new wrong grades that push old right ones out still hold it", async () => {
  const text = flowOf(undefined);
  const { gate, settings, digest } = await storeOf({ text, served: Array.from({ length: REFIT_EVERY }, () => [true, 0.9]) });
  const grade = (run, correct, path = "workflow") => putGrade(settings, "a", { run, correct, source: "eval", at: run, path, ...(path === "workflow" ? { workflow: "answer", digest } : {}) });
  assert.equal(await gate({ name: "answer", workflow: text }, digest), true, "checked at its first 20, all right");
  // Up to the grades kept (500: 10 by hand, 490 it served, all right): checked again.
  for (let i = 0; i < GRADES_KEPT - 10 - REFIT_EVERY; i++) await grade(`more-${i}`, true);
  assert.equal(await gate({ name: "answer", workflow: text }, digest), true);
  // Ten more by hand, all right, and 20 it served wrong: the oldest 30 grades fall out of the 500 kept, so the count it
  // served stays 490. The 20 are new all the same: checked, 470 of 490 right is more than 2 pts under the agent's 100%.
  for (let i = 0; i < 10; i++) await grade(`hand-new-${i}`, true, "agent");
  for (let i = 0; i < REFIT_EVERY; i++) await grade(`wrong-${i}`, false);
  assert.equal((await gradesOf(settings, "a")).length, GRADES_KEPT);
  assert.equal(await gate({ name: "answer", workflow: text }, digest), false, "held on its new wrong grades");
  const held = (await promotionsOf(settings, "a")).at(-1);
  assert.deepEqual({ decided: held.decided, source: held.source }, { decided: "hold", source: "graded" });
});

// Review on #2644 (refit races): two claims checking the same window at once compute the same cursor; only the claim whose
// write marked it checked refits, never the one that lost that write and read the winner's record back.
test("two claims checking the same 20 graded runs at once: one refit, never two", async () => {
  const text = flowOf({ signal: "self", threshold: 0.5 });
  const served = Array.from({ length: REFIT_EVERY }, (_, i) => { const p = 0.5 + (i % 5) * 0.1; return [p >= 0.7, p]; });
  const { gate, digest, commits, logs } = await storeOf({ text, served });
  const both = await Promise.all([gate({ name: "answer", workflow: text }, digest), gate({ name: "answer", workflow: text }, digest)]);
  assert.deepEqual(both, [true, true]);
  assert.equal(commits.length, 1, `one refit for the window: ${logs.join("\n")}`);
});

const { launchBody, readLaunchBody } = await import("../dist/run-launch.js");
const { StoreConstraint } = await import("../dist/store/store.js");
/** A launch's learning start as a run that learns is launched with (its seed commit "s"). */
const LEARNING = { given: [], seed: "s", section: "" };

/** A store of `graded` graded agent runs the workflow fits (each with its launch), runs created and commands sent kept, and
 *  `replaying`: a promotion record already replaying with its runs (rows given). For the challenger and deadline checks. */
async function replayStoreOf({ graded = 6, rows: given = [], records = [], newest, raced = [], creating } = {}) {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  const rows = new Map(given.map((row) => [row.id, row]));
  const launches = new Map(given.filter((row) => row.launch).map((row) => [row.id, row.launch]));
  for (let i = 0; i < graded; i++) {
    const id = `graded-${i}`;
    rows.set(id, { id, state: "ended", metrics: { path: "agent" }, archivedAt: null });
    launches.set(id, { input: { question: `Question ${i}` }, title: `Question ${i}`, place: { mode: "runner" }, learning: LEARNING });
    await putGrade(settings, "a", { run: id, correct: true, expected: { question: `Question ${i}` }, source: "eval", at: `t${i}`, path: "agent" });
  }
  for (const record of records) await recordPromotion(settings, "a", record, () => true);
  const created = [];
  const commands = [];
  const store = {
    settings,
    runs: {
      get: async (id) => rows.get(id),
      launch: async (id) => (launches.has(id) ? { runId: id, body: launchBody(launches.get(id)), sealed: null } : Promise.reject(new Error(`no run ${id}`))),
      // A run id is the row's key: a second create under it is refused, as the store's primary key does. `raced`: ids
      // another claim creates at the same moment, its row written first.
      create: async (row, launch) => {
        await creating?.();
        if (raced.includes(row.id) && !rows.has(row.id)) rows.set(row.id, { id: row.id, state: "queued", metrics: null, archivedAt: null });
        if (rows.has(row.id)) throw new StoreConstraint(`run ${row.id} exists`, { rule: "unique", unique: { table: "runs", columns: ["id"] } });
        created.push(row.id);
        rows.set(row.id, { id: row.id, state: "queued", metrics: null, archivedAt: null });
        if (launch) launches.set(row.id, readLaunchBody(launch.body));
        return { id: row.id };
      },
    },
    runOfOrigin: async () => undefined,
    command: async (runId, command) => (commands.push([runId, command.kind]), { id: `c-${commands.length}`, runId, ...command }),
  };
  const logs = [];
  const gateOf = (now = Date.now) => promotionGate({ store, agentId: "a", runId: "now", revisionId: "rev", launch: { input: { question: "Now" }, title: "", place: { mode: "runner" }, learning: LEARNING }, context: ctx, log: (line) => logs.push(line), now, ...(newest ? { newest: async () => newest } : {}) });
  return { settings, created, commands, logs, gateOf, rows, launches };
}

// Review on #2644 (two challengers): two claims of different revisions of one workflow at once both read no revision
// replaying; the challenger is reserved before any replay run starts, the rival check in the same guarded write, so only
// one revision replays and only its runs start.
test("two revisions claimed at once: one challenger reserved, one set of replay runs", async () => {
  const older = flowOf(undefined);
  const newer = older.replace("Answer.", "Answer, revision two.");
  const { settings, created, logs, gateOf } = await replayStoreOf({ newest: workflowDigest({ workflow: newer }) });
  const gate = gateOf();
  const both = await Promise.all([gate({ name: "answer", workflow: older }, workflowDigest({ workflow: older })), gate({ name: "answer", workflow: newer }, workflowDigest({ workflow: newer }))]);
  assert.deepEqual(both, [undefined, undefined], "neither serves while it replays");
  const replaying = (await promotionsOf(settings, "a")).filter((one) => one.decided === "replaying");
  assert.equal(replaying.length, 1, `one challenger: ${JSON.stringify(await promotionsOf(settings, "a"))}\n${logs.join("\n")}`);
  assert.equal(created.length, 6, "only the reserved challenger's replay runs start");
  assert.deepEqual([...created].sort(), [...replaying[0].runs].sort(), "the runs started are the ones its record reserved");
});

// Review on #2644 (expired replays): a replay decided past REPLAY_DEADLINE_MS with a run still at work cancels that run as
// its decision is kept: what it would go on to spend is never read.
test("a replay decided past its deadline cancels its runs still at work", async () => {
  const text = flowOf(undefined);
  const digest = workflowDigest({ workflow: text });
  const { REPLAY_DEADLINE_MS } = await import("../dist/runner/promotion.js");
  const replayRun = (i, state) => ({ id: `replay-${i}`, state, metrics: state === "ended" ? { path: "replay", replay: { of: `graded-${i}`, outcome: "answered" } } : null, archivedAt: null, costUsd: state === "ended" ? 0.01 : null,
    launch: { input: { question: `Question ${i}` }, title: "", place: { mode: "runner" }, learning: LEARNING, replay: { of: `graded-${i}`, workflow: "answer", digest } } });
  const given = [...Array.from({ length: 5 }, (_, i) => replayRun(i, "ended")), replayRun(5, "working")];
  const at = new Date(0).toISOString();
  const { settings, commands, logs, gateOf } = await replayStoreOf({ rows: given, records: [{ workflow: "answer", digest, at, decided: "replaying", source: "replay", reason: "replaying", runs: given.map((row) => row.id), commit: "s" }] });
  await gateOf(() => REPLAY_DEADLINE_MS + 60_000)({ name: "answer", workflow: text }, digest);
  const decided = (await promotionsOf(settings, "a")).at(-1);
  assert.notEqual(decided.decided, "replaying", logs.join("\n"));
  assert.deepEqual(commands, [["replay-5", "cancel"]], "the run still at work is cancelled once the decision is kept");
});

// Review on #2644 r3 (replay held before it starts): the challenger's record is reserved before its runs are created. A
// claim of the same digest that reads the record in between finds runs that do not exist yet: they are not ended, so it
// decides nothing; the runs, once created, replay and are scored.
test("a second claim between the reservation and its runs' creation decides nothing: the reserved runs are pending", async () => {
  const text = flowOf(undefined);
  const digest = workflowDigest({ workflow: text });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let first = true;
  const { settings, created, logs, gateOf } = await replayStoreOf({ creating: async () => { if (first) { first = false; await held; } } });
  const gate = gateOf();
  const launching = gate({ name: "answer", workflow: text }, digest);
  // The first claim reserved and is creating its first run; the second claim reads the record now.
  while ((await promotionsOf(settings, "a")).length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await gate({ name: "answer", workflow: text }, digest), undefined, "the second claim does not serve it");
  release();
  assert.equal(await launching, undefined);
  const record = (await promotionsOf(settings, "a")).at(-1);
  assert.equal(record.decided, "replaying", `never held on zero inputs: ${JSON.stringify(record)}\n${logs.join("\n")}`);
  assert.deepEqual([...created].sort(), [...record.runs].sort(), "every reserved run was created");
});

/** A replaying record reserved at time 0 for six replay runs on graded-0..5, `made` of them created (ended, answered). */
async function reservedOf({ made = 0, raced = [] } = {}) {
  const text = flowOf(undefined);
  const digest = workflowDigest({ workflow: text });
  const ids = Array.from({ length: 6 }, (_, i) => `replay-${i}`);
  const given = ids.slice(0, made).map((id, i) => ({ id, state: "ended", metrics: { path: "replay", replay: { of: `graded-${i}`, outcome: "answered" } }, archivedAt: null, costUsd: 0.01,
    launch: { input: { question: `Question ${i}` }, title: "", place: { mode: "runner" }, learning: LEARNING, replay: { of: `graded-${i}`, workflow: "answer", digest } } }));
  const record = { workflow: "answer", digest, at: new Date(0).toISOString(), decided: "replaying", source: "replay", reason: "replaying", runs: ids, inputs: ids.map((_, i) => `graded-${i}`), commit: "s" };
  return { text, digest, ids, ...(await replayStoreOf({ rows: given, records: [record], raced })) };
}

test("reserved replay runs not created yet are pending until their launch grace: nothing decided, nothing started", async () => {
  const { text, digest, settings, created, logs, gateOf } = await reservedOf({ made: 2 });
  assert.equal(await gateOf(() => 1_000)({ name: "answer", workflow: text }, digest), undefined);
  assert.equal((await promotionsOf(settings, "a")).at(-1).decided, "replaying", logs.join("\n"));
  assert.deepEqual(created, [], "the claim that reserved them is still creating them");
});

// An interrupted launch (the reserving claim crashed, or a create failed) is recovered: a claim past the launch grace
// creates each reserved run still missing, under its reserved id, on the graded input the record names for it. A run
// another claim created at once is left to it.
test("an interrupted launch is recovered: a later claim creates the reserved runs still missing, under their ids", async () => {
  const { REPLAY_LAUNCH_GRACE_MS } = await import("../dist/runner/promotion.js");
  const { text, digest, ids, settings, created, logs, gateOf, launches } = await reservedOf({ made: 2, raced: ["replay-3"] });
  assert.equal(await gateOf(() => REPLAY_LAUNCH_GRACE_MS + 1_000)({ name: "answer", workflow: text }, digest), undefined, logs.join("\n"));
  assert.deepEqual(created, [ids[2], ids[4], ids[5]], "the missing ones, the raced one left to the claim that made it");
  for (const id of created) assert.deepEqual(launches.get(id).replay, { of: `graded-${id.at(-1)}`, workflow: "answer", digest }, "on the input the record names for it");
  assert.equal((await promotionsOf(settings, "a")).at(-1).decided, "replaying");
  assert.ok(!logs.some((line) => line.includes("could not be read")), logs.join("\n"));
});

// Review on #2644 r5 (older workflows still answer): who serves is the champion, read at each run's claim (championOf),
// never a digest's own old record. A run queued on revision A (its seed holds A) and claimed after B was promoted is
// served by B; once B is held (its graded runs), by the agent. A run already executing on A (an earlier claim of it
// served or handed back with A, its WORKFLOW_FIRST entry) keeps A.
async function twoChampionsOf({ held = false, kept } = {}) {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  const a = { name: "answer", workflow: flowOf(undefined) };
  const b = { name: "answer", workflow: a.workflow.replace("Answer.", "Answer, revision B.") };
  const [da, db] = [workflowDigest(a), workflowDigest(b)];
  const at = (n) => new Date(n * 1000).toISOString();
  await recordPromotion(settings, "a", { workflow: "answer", digest: da, at: at(1), decided: "promote", source: "dry_run", reason: "promoted", commit: "commit-a" }, () => true);
  await recordPromotion(settings, "a", { workflow: "answer", digest: db, at: at(2), decided: "promote", source: "replay", reason: "promoted", commit: "commit-b" }, () => true);
  if (held) await recordPromotion(settings, "a", { workflow: "answer", digest: db, at: at(3), decided: "hold", source: "graded", reason: "held on its graded runs" }, () => true);
  const texts = new Map([["commit-a", a], ["commit-b", b]]);
  const logs = [];
  const gate = promotionGate({ store: { settings, runs: { get: async () => undefined } }, agentId: "a", runId: "queued", revisionId: "rev", launch: { input: { question: "Q" }, title: "", place: { mode: "runner" }, learning: LEARNING }, context: ctx, log: (line) => logs.push(line),
    champion: async (name, commit) => (texts.get(commit)?.name === name ? texts.get(commit) : undefined), ...(kept ? { kept: async () => kept } : {}) });
  return { gate, a, b, da, db, logs };
}

test("A promoted, then B: a run queued on A and claimed now is served by B, the champion", async () => {
  const { gate, a, b, da, logs } = await twoChampionsOf();
  const got = await gate(a, da);
  assert.equal(got?.workflow, b.workflow, `B serves, never A's old promote record: ${logs.join("\n")}`);
  assert.equal(await gate.champion(a, da), b, "the champion alone, for a revision that does not take the input: B too");
});

test("A promoted, then B, then B held: a run queued on A is the agent's, never A's", async () => {
  const { gate, a, da, logs } = await twoChampionsOf({ held: true });
  assert.equal(await gate(a, da), undefined, `the champion is held: the agent takes it: ${logs.join("\n")}`);
  assert.equal(await gate.champion(a, da), undefined);
});

test("a run already executing on A (an earlier claim of it served A) keeps A after B is promoted, and after B is held", async () => {
  for (const held of [false, true]) {
    const { gate, a, da, logs } = await twoChampionsOf({ held, kept: { workflow: "answer", digest: workflowDigest({ workflow: flowOf(undefined) }), outcome: "answered" } });
    assert.equal(await gate(a, da), a, `it keeps the revision it started on: ${logs.join("\n")}`);
  }
  // Executing on B (it served B's text in place of a laid A), re-claimed once B is held: still B.
  const { gate, a, b, da, db, logs } = await twoChampionsOf({ held: true, kept: { workflow: "answer", digest: workflowDigest({ workflow: flowOf(undefined).replace("Answer.", "Answer, revision B.") }), outcome: "handed_back" } });
  assert.equal((await gate(a, da))?.workflow, b.workflow, `${db}: ${logs.join("\n")}`);
});
