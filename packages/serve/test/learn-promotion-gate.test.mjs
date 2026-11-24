// The promotion gate (runner/promotion.ts promotionGate). A new revision is checked once (startCheck): one check at a
// time, only the folder's newest, on the inputs of the agent's last compile_after completed runs; reserved before its
// runs start.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";

const { promotionGate } = await import("../dist/runner/promotion.js");
const { putGrade, promotionOf, promotionsOf, PROMOTIONS_KEPT, recordPromotion } = await import("../dist/learn/promote.js");
const { secretsShown } = await import("../dist/learning.js");
const { workflowDigest } = await import("../dist/runner/workflow-first.js");

const flowOf = () => JSON.stringify({ v: 2, name: "answer", schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } } }, input: { schemaId: "In" }, output: { schemaId: "In", path: "question" },
  root: { node: "agent", label: "answer", instructions: "Answer.", out: "In", as: "answer", tools: [] } });

const { launchBody, readLaunchBody } = await import("../dist/run-launch.js");
const { StoreConstraint } = await import("../dist/store/store.js");
/** A launch's learning start as a run that learns is launched with (its seed commit "s"). */
const LEARNING = { given: [], seed: "s", section: "" };

/** A store of `graded` graded agent runs the workflow fits (each with its launch), runs created and commands sent kept, and
 *  `replaying`: a promotion record already replaying with its runs (rows given). For the challenger and deadline checks.
 *  `path`: the path each graded run took (`agent`, or `workflow`: one a learned workflow answered alone). Its runs list
 *  newest first (a check's inputs, runner/promotion.ts checkInputs), and its revision's definition says `learning`. */
async function replayStoreOf({ graded = 6, rows: given = [], records = [], newest, champion, raced = [], creating, path = "agent", learning = true, sourceBinding } = {}) {
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
      // Newest first, filtered and limited as the store's list is.
      list: async ({ state, archived, limit } = {}) => [...rows.values()].reverse().map((row) => ({ agentId: "a", outcome: null, importedFrom: null, ...row }))
        .filter((row) => (state === undefined || row.state === state) && (archived === undefined || ((row.archivedAt ?? null) !== null) === archived)).slice(0, limit),
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
    agents: { revision: async (id) => ({ id, body: { instructions: "Answer.", learning, ...(sourceBinding ? { sourceSync: sourceBinding } : {}) } }) },
    runOfOrigin: async () => undefined,
    command: async (runId, command) => (commands.push([runId, command.kind]), { id: `c-${commands.length}`, runId, ...command }),
  };
  const logs = [];
  const gateOf = (now = Date.now) => promotionGate({ store, shown: async () => secretsShown([]), agentId: "a", runId: "now", revisionId: "rev", launch: { input: { question: "Now" }, title: "", place: { mode: "runner" }, learning: LEARNING }, context: ctx, log: (line) => logs.push(line), now, ...(newest ? { newest: typeof newest === "function" ? newest : async () => newest } : {}), ...(champion ? { champion } : {}) });
  return { settings, created, commands, logs, gateOf, rows, launches };
}

// Review on #2644 (two challengers): two claims of different revisions of one workflow at once both read no revision
// replaying; the challenger is reserved before any replay run starts, the rival check in the same guarded write, so only
// one revision replays and only its runs start.
test("two revisions claimed at once: one challenger reserved, one set of replay runs", async () => {
  const older = flowOf();
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
  const flow = flowOf();
  const [two, three, four] = ["two", "three", "four"].map((n) => flow.replace("Answer.", `Answer, revision ${n}.`));
  const [TWO, THREE, FOUR] = [two, three, four].map((text) => workflowDigest({ workflow: text }));
  const at = new Date().toISOString();
  const running = { workflow: "answer", digest: TWO, at, decided: "replaying", reason: "checking", runs: ["r-0", "r-1"], inputs: ["graded-0", "graded-1"], replay_id: "check-two", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1 } };
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
  const flow = flowOf();
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
  assert.deepEqual(records.map(({ digest, decided }) => [digest, decided]), [[FOUR, "replaying"]], said);
  assert.equal(started.length, 6, said);
  assert.deepEqual([store.created, store.commands], [started, []], "the paused claim started nothing and cancelled nothing");
});

// Review on #2970 (Greptile P1, "running replay can be forgotten"), on the check path: a champion, revision A being
// checked, then more drafts than the records kept, each the folder's newest in turn: each waits and records nothing (no
// queue), so A's record is never trimmed out, no second check starts while A's runs run, and once they end A's verdict
// lands and the newest draft is checked next.
test("drafts that come while a check runs never trim it out: no second check starts while its runs run, and its verdict lands", async () => {
  const flow = flowOf();
  const a = flow.replace("Answer.", "Answer, revision A.");
  const A = workflowDigest({ workflow: a });
  const at = new Date().toISOString();
  const champion = { workflow: "answer", digest: "champion", at, decided: "promote", reason: "promoted", commit: "commit-champion", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1, n: 6, agreed: 6, alone: 6 } };
  const running = { workflow: "answer", digest: A, at, decided: "replaying", reason: "checking", runs: ["r-0", "r-1"], inputs: ["graded-0", "graded-1"], replay_id: "check-a", commit: "commit-a", check: { compile_after: 20, agree_min: 0.8, alone_min: 0.7, attempt: 1 } };
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
  assert.deepEqual([promotionOf(records, "answer", main)?.decided], ["replaying"]);
  assert.equal(store.created.length, 6, "the newest draft's check runs start");
});

// A draft whose record the PROMOTIONS_KEPT trim dropped (a held one, say) must never be checked again for it: only the
// folder's newest revision is checked, so a claim pinned to a revision with no record that is not the newest starts
// nothing, with the records at the cap or under it; the newest one with no record is checked.
test("a revision with no record that is not the folder's newest starts no check, at the trim's cap or under it", async () => {
  const flow = flowOf();
  const [three, four] = ["three", "four"].map((n) => flow.replace("Answer.", `Answer, revision ${n}.`));
  const [THREE, FOUR] = [three, four].map((text) => workflowDigest({ workflow: text }));
  const at = new Date().toISOString();
  const others = Array.from({ length: PROMOTIONS_KEPT }, (_, i) => ({ workflow: "other", digest: `other-${i}`, at, decided: "hold", reason: "held" }));
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
// of the agent's, so it is never a check input. With only those, the check has nothing to run on: it is never promoted
// unchecked (review on #3032: the no-input promotion raced a newer revision's check), it stops, its record naming why;
// with the agent's own runs, each is an input.
test("runs a workflow answered alone are no check input; the agent's own completed runs each get a check run", async () => {
  const text = flowOf();
  const digest = workflowDigest({ workflow: text });
  const served = await replayStoreOf({ path: "workflow" });
  assert.equal(await served.gateOf()({ name: "answer", workflow: text }, digest), undefined, "nothing to check it on: it never serves");
  const stopped = (await promotionsOf(served.settings, "a")).at(-1);
  assert.deepEqual([stopped.decided, stopped.check?.n, stopped.check?.stopped, served.created], ["hold", 0, true, []], `${JSON.stringify(stopped)}\n${served.logs.join("\n")}`);
  assert.equal(stopped.reason, "nothing to check it on: the agent has no completed run of its own to check it against. It is not promoted, and it stops: nothing compiles again until a hold or its owner acts");
  const { settings, created, logs, gateOf } = await replayStoreOf({ path: "agent" });
  assert.equal(await gateOf()({ name: "answer", workflow: text }, digest), undefined, "it does not serve while it is checked");
  const record = (await promotionsOf(settings, "a")).at(-1);
  assert.deepEqual([record.decided], ["replaying"], `${JSON.stringify(record)}\n${logs.join("\n")}`);
  assert.deepEqual([...record.inputs].sort(), Array.from({ length: 6 }, (_, i) => `graded-${i}`), "every completed run of the agent's own is an input");
  assert.deepEqual([...created].sort(), [...record.runs].sort());
  assert.match(record.replay_id, /^[0-9a-f-]{36}$/, "the reservation mints the replay's id");
});

// The check's inputs: the agent's last compile_after completed runs (its definition's), newest first, never the claimed
// run or an archived one; one with an uploaded file is one of them but has no input a replay can run, so it is left out.
test("a check picks the inputs of the agent's last compile_after completed runs, newest first: never the claimed run, an archived one or one with a file", async () => {
  const text = flowOf();
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

// Review on #3032 (PRRT_kwDOUmdVMs64I-7V): the agent's own runs are picked before anything limits the read. After more
// served runs than one page of the agent's runs holds, the agent's answers are still the check's inputs: never pushed out
// of the window (which would leave the check nothing to run on, though the agent's runs are there).
test("after 250 runs its workflow served, a check still finds the agent's last compile_after runs as its inputs", async () => {
  const text = flowOf(undefined);
  const digest = workflowDigest({ workflow: text });
  const { settings, logs, gateOf, rows, launches } = await replayStoreOf({ graded: 8, learning: { compile_after: 5 } });
  for (let i = 0; i < 250; i++) {
    rows.set(`served-${i}`, { id: `served-${i}`, state: "ended", metrics: { path: "workflow", workflow: "answer", workflow_digest: "older" }, archivedAt: null });
    launches.set(`served-${i}`, { input: { question: `Served ${i}` }, title: `Served ${i}`, place: { mode: "runner" }, learning: LEARNING });
  }
  assert.equal(await gateOf()({ name: "answer", workflow: text }, digest), undefined, "it does not serve while it is checked");
  const record = (await promotionsOf(settings, "a")).at(-1);
  assert.deepEqual([record.decided], ["replaying"], `${JSON.stringify(record)}\n${logs.join("\n")}`);
  assert.deepEqual(record.inputs, ["graded-7", "graded-6", "graded-5", "graded-4", "graded-3"], "the agent's own 5 newest, newest first");
});

// Review on #2644 (expired replays): a replay decided past REPLAY_DEADLINE_MS with a run still at work cancels that run as
// its decision is kept: what it would go on to spend is never read.
test("a replay decided past its deadline cancels its runs still at work", async () => {
  const text = flowOf();
  const digest = workflowDigest({ workflow: text });
  const { REPLAY_DEADLINE_MS } = await import("../dist/runner/promotion.js");
  const replayRun = (i, state) => ({ id: `replay-${i}`, state, metrics: state === "ended" ? { path: "replay", replay: { of: `graded-${i}`, outcome: "answered" } } : null, archivedAt: null, costUsd: state === "ended" ? 0.01 : null,
    launch: { input: { question: `Question ${i}` }, title: "", place: { mode: "runner" }, learning: LEARNING, replay: { of: `graded-${i}`, workflow: "answer", digest } } });
  const given = [...Array.from({ length: 5 }, (_, i) => replayRun(i, "ended")), replayRun(5, "working")];
  const at = new Date(0).toISOString();
  const { settings, commands, logs, gateOf } = await replayStoreOf({ rows: given, records: [{ workflow: "answer", digest, at, decided: "replaying", reason: "replaying", runs: given.map((row) => row.id), commit: "s" }] });
  await gateOf(() => REPLAY_DEADLINE_MS + 60_000)({ name: "answer", workflow: text }, digest);
  const decided = (await promotionsOf(settings, "a")).at(-1);
  assert.notEqual(decided.decided, "replaying", logs.join("\n"));
  assert.deepEqual(commands, [["replay-5", "cancel"]], "the run still at work is cancelled once the decision is kept");
});

// Review on #2644 r3 (replay held before it starts): the challenger's record is reserved before its runs are created. A
// claim of the same digest that reads the record in between finds runs that do not exist yet: they are not ended, so it
// decides nothing; the runs, once created, replay and are scored.
test("a second claim between the reservation and its runs' creation decides nothing: the reserved runs are pending", async () => {
  const text = flowOf();
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
  const text = flowOf();
  const digest = workflowDigest({ workflow: text });
  const ids = Array.from({ length: 6 }, (_, i) => `replay-${i}`);
  const given = ids.slice(0, made).map((id, i) => ({ id, state: "ended", metrics: { path: "replay", replay: { of: `graded-${i}`, outcome: "answered" } }, archivedAt: null, costUsd: 0.01,
    launch: { input: { question: `Question ${i}` }, title: "", place: { mode: "runner" }, learning: LEARNING, replay: { of: `graded-${i}`, workflow: "answer", digest } } }));
  // Its launch, chosen when it was reserved (PromotionRecord.launch): what a later claim creates its missing runs from.
  const launch = { revision: "rev", body: { input: null, title: "", place: { mode: "runner" }, learning: LEARNING } };
  const record = { workflow: "answer", digest, at: new Date(0).toISOString(), decided: "replaying", reason: "replaying", runs: ids, inputs: ids.map((_, i) => `graded-${i}`), launch, commit: "s" };
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
  const a = { name: "answer", workflow: flowOf() };
  const b = { name: "answer", workflow: a.workflow.replace("Answer.", "Answer, revision B.") };
  const [da, db] = [workflowDigest(a), workflowDigest(b)];
  const at = (n) => new Date(n * 1000).toISOString();
  await recordPromotion(settings, "a", { workflow: "answer", digest: da, at: at(1), decided: "promote", reason: "promoted", commit: "commit-a" }, () => true);
  await recordPromotion(settings, "a", { workflow: "answer", digest: db, at: at(2), decided: "promote", reason: "promoted", commit: "commit-b" }, () => true);
  if (held) await recordPromotion(settings, "a", { workflow: "answer", digest: db, at: at(3), decided: "hold", reason: "held on its graded runs" }, () => true);
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
    const { gate, a, da, logs } = await twoChampionsOf({ held, kept: { workflow: "answer", digest: workflowDigest({ workflow: flowOf() }), outcome: "answered" } });
    assert.equal((await gate(a, da))?.workflow, a, `it keeps the revision it started on: ${logs.join("\n")}`);
  }
  // Executing on B (it served B's text in place of a laid A), re-claimed once B is held: still B.
  const { gate, a, b, da, db, logs } = await twoChampionsOf({ held: true, kept: { workflow: "answer", digest: workflowDigest({ workflow: flowOf().replace("Answer.", "Answer, revision B.") }), outcome: "handed_back" } });
  assert.equal((await gate(a, da))?.workflow.workflow, b.workflow, `${db}: ${logs.join("\n")}`);
});

// Review on #3032 r4 (PRRT_kwDOUmdVMs64MQC5): a check's disagreement texts are redacted whole, then cut: a saved secret that
// straddles the cut at CHECK_TEXT_MAX never leaves its prefix in the record (cut first, the redactor no longer matched it).
test("a saved secret straddling the cut of a disagreement text leaves no part of it in the record or the promotions read", async () => {
  const { decideCheck } = await import("../dist/runner/promotion.js");
  const { CHECK_TEXT_MAX, promotionsShown } = await import("../dist/learn/promote.js");
  const secret = ["Zq81Trb", "N4wX7cV", "2mKp09L", "dHy5aEg", "3UfJxQ"].join("");
  const straddling = (what) => `${what} `.repeat(300).slice(0, CHECK_TEXT_MAX - 20) + secret + " and then more words after it";
  const { settings, logs } = await replayStoreOf({ graded: 0 });
  const shown = secretsShown([secret]);
  const row = { of: "r-1", input: straddling("input"), agent: straddling("agent"), outcome: "answered", answer: straddling("draft") };
  const handed = { of: "r-2", input: "short", agent: "x", outcome: "handed_back", answer: null, escalated: straddling("escalated") };
  const read = { rows: [row, handed], cost: 0, outcomes: { answered: 1, handed_back: 1, skipped_write: 0, failed: 0 }, unstarted: 0 };
  const bar = { compile_after: 5, agree_min: 0.8, alone_min: 0.7, attempt: 1 };
  const deps = { store: { settings }, agentId: "a", runId: "now", revisionId: "rev", launch: {}, context: ctx, log: (line) => logs.push(line), shown: async () => shown };
  const decided = await decideCheck(deps, "answer", "dig", bar, read, () => true, {});
  assert.equal(decided.record.decided, "hold", JSON.stringify(decided.record));
  const everyText = (value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(everyText) : value && typeof value === "object" ? Object.values(value).flatMap(everyText) : []);
  const leaks = (texts) => texts.filter((text) => { for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true; return false; });
  const stored = (await promotionsOf(settings, "a")).at(-1);
  assert.ok(stored.check.disagreements.length >= 2, JSON.stringify(stored.check));
  assert.deepEqual(leaks(everyText(stored.check.disagreements)), [], "the stored disagreements");
  assert.deepEqual(leaks(everyText(promotionsShown([stored], shown))), [], "the promotions read");
});


test("a moved project's replay check refuses before reservation or auxiliary admission without changing learning", async () => {
  const sourceBinding = { id: "a".repeat(64), snapshot: "b".repeat(64), project: "b".repeat(64), configuration: "c".repeat(64) };
  const f = await replayStoreOf({ sourceBinding });
  const text = flowOf(), digest = workflowDigest({ workflow: text });
  assert.equal(await f.gateOf()({ name: "answer", workflow: text }, digest), undefined);
  assert.deepEqual(f.created, []); assert.deepEqual(await promotionsOf(f.settings, "a"), []);
  assert.match(f.logs.join("\n"), /project placement/i);
});
