// The promotion gate (runner/promotion.ts promotionGate). A digest the old graded path promoted (source dry_run, over a
// store of graded runs): once per 20 graded runs it served, its thresholds refit (a new revision, promoted on the rows it
// was fit on, when they move within the bar) and it is held when its graded runs fall more than 2 points under the
// agent's by hand. Escalation never holds it. A new revision is checked once (startCheck): one check at a time, only the
// folder's newest, on the inputs of the agent's last compile_after completed runs; reserved before its runs start.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { promotionGate } = await import("../dist/runner/promotion.js");
const { GRADES_KEPT, gradesOf, putGrade, promotionOf, promotionsOf, PROMOTIONS_KEPT, recordPromotion, REFIT_EVERY } = await import("../dist/learn/promote.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");

const flowOf = (guard) => JSON.stringify({ v: 2, name: "answer", schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } } }, input: { schemaId: "In" }, output: { schemaId: "In", path: "question" },
  root: { node: "agent", label: "answer", instructions: "Answer.", out: "In", as: "answer", tools: [], ...(guard ? { guard } : {}) } });

/** A store of `served` graded runs at the workflow's digest (each `[correct, p]`, path workflow, or handed_back when p
 *  is under the guard's threshold) and `byHand` graded agent runs, all right; the workflow promoted at its digest. */
async function storeOf({ text, served, byHand = 10, byHandWrong = 0, threshold = 0.5, other = [] }) {
  const kv = new Map();
  const settings = {
    get: async (key) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
    putIfAbsent: async (key, value) => (kv.has(key) ? kv.get(key) : (kv.set(key, structuredClone(value)), value)),
    replaceIf: async (key, was, value) => (JSON.stringify(kv.get(key)) === JSON.stringify(was) ? (kv.set(key, structuredClone(value)), true) : false),
  };
  const digest = workflowDigest({ workflow: text });
  const rows = new Map();
  let at = 0;
  for (let i = 0; i < byHand; i++) await putGrade(settings, "a", { run: `hand-${i}`, correct: i >= byHandWrong, source: "eval", at: `t${at++}`, path: "agent" });
  for (const [i, [correct, p]] of served.entries()) {
    const path = p < threshold ? "handed_back" : "workflow";
    // `other[i]`: guards of another workflow recorded on the same run (the agent called it after a hand-back).
    rows.set(`served-${i}`, { id: `served-${i}`, state: "ended", metrics: { path, workflow: "answer", workflow_digest: digest, guards: [{ node: "answer", signal: "self", self: p, p, threshold, escalated: p < threshold }, ...(other[i] ?? [])] } });
    await putGrade(settings, "a", { run: `served-${i}`, correct, source: "eval", at: `t${at++}`, path, workflow: "answer", digest });
  }
  await recordPromotion(settings, "a", { workflow: "answer", digest, at: new Date(0).toISOString(), decided: "promote", source: "dry_run", reason: "no graded input it fits: promoted on its passing dry run" }, (was) => was === undefined);
  const store = { settings, runs: { get: async (id) => rows.get(id) } };
  const commits = [];
  const logs = [];
  const gate = promotionGate({ store, agentId: "a", runId: "now", revisionId: "rev", launch: { input: {}, title: "", place: { mode: "runner" } }, context: ctx, log: (line) => logs.push(line), commit: async (files, reason, id) => (commits.push({ files, reason, id }), `commit-${commits.length}`) });
  // The gate answers the workflow that serves: this one, or none (the agent takes the run).
  const serves = async (workflow, at) => { const got = (await gate(workflow, at))?.workflow; assert.ok(got === undefined || got === workflow, "no champion here: the laid workflow or none"); return got === workflow; };
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
  // The same 20 again: not checked twice. The refit is the champion now: the revision it was fit from never serves again
  // (the refit's text serves from its commit; this store reads none, so the agent takes the run).
  assert.equal(await gate({ name: "answer", workflow: text }, digest), false);
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

// Review on #2833 (Greptile P1): the graded check reads the outcomes recorded on the served runs, never a rescore of every
// guard on the run: guards on a run can belong to other workflows, and they would turn a right answer into a hand-back
// counted at the agent's lower accuracy.
test("another workflow's escalated guard on a served run never holds it: the graded check reads the recorded outcomes", async () => {
  const text = flowOf(undefined);
  const b = { node: "other", signal: "self", self: 0.1, p: 0.1, threshold: 0.5, escalated: true };
  // 19 right workflow answers, each run also carrying the other workflow's escalated guard; 1 wrong. By hand 9 of 10 right.
  const served = Array.from({ length: REFIT_EVERY }, (_, i) => [i !== 0, 0.9]);
  const other = served.map((_, i) => (i === 0 ? [] : [b]));
  const { gate, settings, digest } = await storeOf({ text, served, byHand: 10, byHandWrong: 1, other });
  assert.equal(await gate({ name: "answer", workflow: text }, digest), true);
  assert.equal((await promotionsOf(settings, "a")).at(-1).decided, "promote");
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
 *  `replaying`: a promotion record already replaying with its runs (rows given). For the challenger and deadline checks.
 *  `path`: the path each graded run took (`agent`, or `workflow`: one a learned workflow answered alone). Its runs list
 *  newest first (a check's inputs, runner/promotion.ts checkInputs), and its revision's definition says `learning`. */
async function replayStoreOf({ graded = 6, rows: given = [], records = [], newest, champion, raced = [], creating, path = "agent", learning = true } = {}) {
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
    rows.set(id, { id, state: "ended", metrics: { path }, archivedAt: null });
    launches.set(id, { input: { question: `Question ${i}` }, title: `Question ${i}`, place: { mode: "runner" }, learning: LEARNING });
    await putGrade(settings, "a", { run: id, correct: true, expected: { question: `Question ${i}` }, source: "eval", at: `t${i}`, path });
  }
  for (const record of records) await recordPromotion(settings, "a", record, () => true);
  const created = [];
  const commands = [];
  const store = {
    settings,
    runs: {
      get: async (id) => rows.get(id),
      list: async () => [...rows.values()].reverse().map((row) => ({ agentId: "a", outcome: null, importedFrom: null, ...row })),
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
    agents: { revision: async (id) => ({ id, body: { instructions: "Answer.", learning } }) },
    runOfOrigin: async () => undefined,
    command: async (runId, command) => (commands.push([runId, command.kind]), { id: `c-${commands.length}`, runId, ...command }),
  };
  const logs = [];
  const gateOf = (now = Date.now) => promotionGate({ store, agentId: "a", runId: "now", revisionId: "rev", launch: { input: { question: "Now" }, title: "", place: { mode: "runner" }, learning: LEARNING }, context: ctx, log: (line) => logs.push(line), now, ...(newest ? { newest: typeof newest === "function" ? newest : async () => newest } : {}), ...(champion ? { champion } : {}) });
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

// Chain13 (11-15): each draft that came while the previous one's replay ran cancelled it, so no draft after the second got
// a verdict. A running check finishes: a newer revision that comes meanwhile waits, recording nothing (no queue: S3a,
// promote once), sends no cancel and starts no run; a claim pinned to an older commit lays an older revision and starts
// nothing either.
test("a revision that comes while another is checked waits, recording nothing and cancelling nothing; an older claim's revision starts nothing", async () => {
  const flow = flowOf(undefined);
  const [two, three, four] = ["two", "three", "four"].map((n) => flow.replace("Answer.", `Answer, revision ${n}.`));
  const [TWO, THREE, FOUR] = [two, three, four].map((text) => workflowDigest({ workflow: text }));
  const at = new Date().toISOString();
  const running = { workflow: "answer", digest: TWO, at, decided: "replaying", source: "check", reason: "checking", runs: ["r-0", "r-1"], inputs: ["graded-0", "graded-1"], replay_id: "check-two", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1 } };
  const rows = [{ id: "r-0", state: "running", metrics: null, archivedAt: null }, { id: "r-1", state: "queued", metrics: null, archivedAt: null }];
  const first = await replayStoreOf({ rows, records: [running], newest: THREE });
  assert.equal(await first.gateOf()({ name: "answer", workflow: three }, THREE), undefined, "it does not serve while it waits");
  assert.deepEqual((await promotionsOf(first.settings, "a")).map(({ digest, decided }) => [digest, decided]), [[TWO, "replaying"]], first.logs.join("\n"));
  assert.ok(first.logs.some((line) => line.includes(`answer at ${THREE} waits: ${TWO} is being checked (one check at a time)`)), first.logs.join("\n"));
  assert.deepEqual([first.created, first.commands], [[], []], "no check run started, none cancelled");
  // Revision four lands; a claim pinned to revision three's commit lays three: not the newest, nothing recorded or started.
  const second = await replayStoreOf({ rows, records: [running], newest: FOUR });
  assert.equal(await second.gateOf()({ name: "answer", workflow: three }, THREE), undefined);
  assert.deepEqual((await promotionsOf(second.settings, "a")).map(({ digest, decided }) => [digest, decided]), [[TWO, "replaying"]], second.logs.join("\n"));
  assert.deepEqual([second.created, second.commands], [[], []]);
});

// Review on #2970 (Greptile P1), on the check path: a claim paused after reading an older main (revision three) as the
// newest starts nothing once a claim that read the newer main (four) began four's check meanwhile: one check at a time,
// in the reservation's guarded write, so four's check stands and three is never checked.
test("a claim paused after its newest check never starts a check once a later claim began the newer revision's", async () => {
  const flow = flowOf(undefined);
  const [three, four] = ["three", "four"].map((n) => flow.replace("Answer.", `Answer, revision ${n}.`));
  const [THREE, FOUR] = [three, four].map((text) => workflowDigest({ workflow: text }));
  // The folder's main as each claim's newest check reads it; three's claim pauses right after its read.
  let main = THREE;
  let reached;
  let release;
  const paused = new Promise((resolve) => (reached = resolve));
  const gateOpen = new Promise((resolve) => (release = resolve));
  let hold = true;
  const newest = async () => {
    const read = main;
    if (hold) {
      hold = false;
      reached();
      await gateOpen;
    }
    return read;
  };
  const store = await replayStoreOf({ newest });
  const stale = store.gateOf()({ name: "answer", workflow: three }, THREE);
  await paused;
  main = FOUR;
  assert.equal(await store.gateOf()({ name: "answer", workflow: four }, FOUR), undefined, "four is checked before it serves");
  const started = [...store.created];
  release();
  assert.equal(await stale, undefined);
  const records = await promotionsOf(store.settings, "a");
  const said = `${JSON.stringify(records.map(({ digest, decided }) => [digest, decided]))}\n${store.logs.join("\n")}`;
  assert.deepEqual(records.map(({ digest, decided, source }) => [digest, decided, source]), [[FOUR, "replaying", "check"]], said);
  assert.equal(started.length, 6, said);
  assert.deepEqual([store.created, store.commands], [started, []], "the paused claim started nothing and cancelled nothing");
});

// Review on #2970 (Greptile P1, "running replay can be forgotten"), on the check path: a champion, revision A being
// checked, then more drafts than the records kept, each the folder's newest in turn: each waits and records nothing (no
// queue), so A's record is never trimmed out, no second check starts while A's runs run, and once they end A's verdict
// lands and the newest draft is checked next.
test("drafts that come while a check runs never trim it out: no second check starts while its runs run, and its verdict lands", async () => {
  const flow = flowOf(undefined);
  const a = flow.replace("Answer.", "Answer, revision A.");
  const A = workflowDigest({ workflow: a });
  const at = new Date().toISOString();
  const champion = { workflow: "answer", digest: "champion", at, decided: "promote", source: "check", reason: "promoted", commit: "commit-champion", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 6, agreed: 6, alone: 6 } };
  const running = { workflow: "answer", digest: A, at, decided: "replaying", source: "check", reason: "checking", runs: ["r-0", "r-1"], inputs: ["graded-0", "graded-1"], replay_id: "check-a", commit: "commit-a", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1 } };
  const rows = ["r-0", "r-1"].map((id, i) => ({ id, state: "running", metrics: null, archivedAt: null, launch: { input: { question: `Question ${i}` }, title: `Question ${i}`, place: { mode: "runner" }, replay: { of: `graded-${i}`, workflow: "answer", digest: A } } }));
  let main = A;
  const store = await replayStoreOf({ rows, records: [champion, running], newest: async () => main, champion: async (name, commit) => (name === "answer" && commit === "commit-a" ? { name: "answer", workflow: a } : undefined) });
  const gate = store.gateOf();
  const drafts = Array.from({ length: PROMOTIONS_KEPT / 2 + 2 }, (_, i) => flow.replace("Answer.", `Answer, draft ${i}.`));
  for (const text of drafts) {
    main = workflowDigest({ workflow: text });
    await gate({ name: "answer", workflow: text }, main);
  }
  const last = { name: "answer", workflow: drafts.at(-1) };
  let records = await promotionsOf(store.settings, "a");
  assert.deepEqual(records.map(({ digest, decided }) => [digest, decided]), [["champion", "promote"], [A, "replaying"]], "the drafts waited, recording nothing");
  assert.deepEqual(store.created, [], `no second check while A's runs run: ${store.logs.slice(-3).join("\n")}`);
  await gate(last, main);
  assert.deepEqual([store.created, store.commands], [[], []], "the newest draft's next claim still waits");
  // A's runs end (each handed back): its verdict lands, then the newest draft is checked next.
  for (const row of store.rows.values()) if (row.id.startsWith("r-")) Object.assign(row, { state: "ended", costUsd: 0.01, metrics: { path: "replay", replay: { outcome: "handed_back" } } });
  await gate(last, main);
  records = await promotionsOf(store.settings, "a");
  assert.equal(promotionOf(records, "answer", A)?.decided, "hold", `A's verdict lands, handed back on both: ${store.logs.slice(-4).join("\n")}`);
  assert.deepEqual([promotionOf(records, "answer", main)?.decided, promotionOf(records, "answer", main)?.source], ["replaying", "check"]);
  assert.equal(store.created.length, 6, "the newest draft's check runs start");
});

// A draft whose record the PROMOTIONS_KEPT trim dropped (a held one, say) must never be checked again for it: only the
// folder's newest revision is checked, so a claim pinned to a revision with no record that is not the newest starts
// nothing, with the records at the cap or under it; the newest one with no record is checked.
test("a revision with no record that is not the folder's newest starts no check, at the trim's cap or under it", async () => {
  const flow = flowOf(undefined);
  const [three, four] = ["three", "four"].map((n) => flow.replace("Answer.", `Answer, revision ${n}.`));
  const [THREE, FOUR] = [three, four].map((text) => workflowDigest({ workflow: text }));
  const at = new Date().toISOString();
  const others = Array.from({ length: PROMOTIONS_KEPT }, (_, i) => ({ workflow: "other", digest: `other-${i}`, at, decided: "hold", source: "replay", reason: "held" }));
  for (const records of [others, others.slice(1)]) {
    const store = await replayStoreOf({ records, newest: FOUR });
    assert.equal(await store.gateOf()({ name: "answer", workflow: three }, THREE), undefined);
    assert.equal(promotionOf(await promotionsOf(store.settings, "a"), "answer", THREE), undefined, store.logs.join("\n"));
    assert.deepEqual(store.created, []);
    await store.gateOf()({ name: "answer", workflow: four }, FOUR);
    assert.equal(promotionOf(await promotionsOf(store.settings, "a"), "answer", FOUR)?.decided, "replaying", store.logs.join("\n"));
  }
});

// A check's label is the agent's own recorded answer: a run a learned workflow answered alone (path workflow) has none
// of the agent's, so it is never a check input. With only those, the check has nothing to run on: its passing dry run
// promotes it, its record saying the check ran on none; with the agent's own runs, each is an input.
test("runs a workflow answered alone are no check input; the agent's own completed runs each get a check run", async () => {
  const text = flowOf(undefined);
  const digest = workflowDigest({ workflow: text });
  const served = await replayStoreOf({ path: "workflow" });
  assert.equal((await served.gateOf()({ name: "answer", workflow: text }, digest))?.workflow?.workflow, text, "nothing to check it on: it serves on its dry run");
  const promoted = (await promotionsOf(served.settings, "a")).at(-1);
  assert.deepEqual([promoted.decided, promoted.source, promoted.check?.n, served.created], ["promote", "check", 0, []], `${JSON.stringify(promoted)}\n${served.logs.join("\n")}`);
  const { settings, created, logs, gateOf } = await replayStoreOf({ path: "agent" });
  assert.equal(await gateOf()({ name: "answer", workflow: text }, digest), undefined, "it does not serve while it is checked");
  const record = (await promotionsOf(settings, "a")).at(-1);
  assert.deepEqual([record.decided, record.source], ["replaying", "check"], `${JSON.stringify(record)}\n${logs.join("\n")}`);
  assert.deepEqual([...record.inputs].sort(), Array.from({ length: 6 }, (_, i) => `graded-${i}`), "every completed run of the agent's own is an input");
  assert.deepEqual([...created].sort(), [...record.runs].sort());
  assert.match(record.replay_id, /^[0-9a-f-]{36}$/, "the reservation mints the replay's id");
});

// The check's inputs: the agent's last compile_after completed runs (its definition's), newest first, never the claimed
// run or an archived one; one with an uploaded file is one of them but has no input a replay can run, so it is left out.
test("a check picks the inputs of the agent's last compile_after completed runs, newest first: never the claimed run, an archived one or one with a file", async () => {
  const text = flowOf(undefined);
  const digest = workflowDigest({ workflow: text });
  const { settings, logs, gateOf, rows, launches } = await replayStoreOf({ graded: 25, learning: { compile_after: 10 } });
  const newest = (id, launch, row = {}) => {
    rows.set(id, { id, state: "ended", metrics: { path: "agent" }, archivedAt: null, ...row });
    launches.set(id, { input: { question: id }, title: id, place: { mode: "runner" }, learning: LEARNING, ...launch });
  };
  newest("archived", {}, { archivedAt: 1 });
  newest("with-file", { files: ["file-1"] });
  newest("now", {});
  assert.equal(await gateOf()({ name: "answer", workflow: text }, digest), undefined);
  const record = (await promotionsOf(settings, "a")).at(-1);
  assert.equal(record.decided, "replaying", `${JSON.stringify(record)}\n${logs.join("\n")}`);
  assert.deepEqual(record.inputs, Array.from({ length: 9 }, (_, i) => `graded-${24 - i}`), "with-file and the newest 9 graded ones: the 10 last, the file's left out");
  assert.equal(record.reason, "checking it on 9 inputs of the agent's last 10 completed runs against its own answers");
  assert.deepEqual(record.check, { compile_after: 10, agree_min: 0.8, alone_min: 0.7, attempt: 1 }, "the bar its definition says now");
  assert.equal(record.held_on, undefined, "a check owes nothing");
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
  // Its launch, chosen when it was reserved (PromotionRecord.launch): what a later claim creates its missing runs from.
  const launch = { revision: "rev", body: { input: null, title: "", place: { mode: "runner" }, learning: LEARNING } };
  const record = { workflow: "answer", digest, at: new Date(0).toISOString(), decided: "replaying", source: "replay", reason: "replaying", runs: ids, inputs: ids.map((_, i) => `graded-${i}`), launch, commit: "s" };
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
  assert.equal(got?.workflow.workflow, b.workflow, `B serves, never A's old promote record: ${logs.join("\n")}`);
  assert.equal((await gate.champion(a, da))?.workflow, b, "the champion alone, for a revision that does not take the input: B too");
});

test("A promoted, then B, then B held: a run queued on A is the agent's, never A's", async () => {
  const { gate, a, da, logs } = await twoChampionsOf({ held: true });
  assert.equal(await gate(a, da), undefined, `the champion is held: the agent takes it: ${logs.join("\n")}`);
  assert.equal(await gate.champion(a, da), undefined);
});

test("a run already executing on A (an earlier claim of it served A) keeps A after B is promoted, and after B is held", async () => {
  for (const held of [false, true]) {
    const { gate, a, da, logs } = await twoChampionsOf({ held, kept: { workflow: "answer", digest: workflowDigest({ workflow: flowOf(undefined) }), outcome: "answered" } });
    assert.equal((await gate(a, da))?.workflow, a, `it keeps the revision it started on: ${logs.join("\n")}`);
  }
  // Executing on B (it served B's text in place of a laid A), re-claimed once B is held: still B.
  const { gate, a, b, da, db, logs } = await twoChampionsOf({ held: true, kept: { workflow: "answer", digest: workflowDigest({ workflow: flowOf(undefined).replace("Answer.", "Answer, revision B.") }), outcome: "handed_back" } });
  assert.equal((await gate(a, da))?.workflow.workflow, b.workflow, `${db}: ${logs.join("\n")}`);
});
