// The trigger target policy (trigger-targets.ts) over a real one store (A): what a trigger may start or message, and the
// words each refusal answers with, rewritten over the run write half and the run readers. The run view (a run's moment, its
// status) and the agent reads are passed in; these tests build them directly, as the switch wires the real ones.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");
const { triggerTargets, previousCarriedWords, previousResultTooLarge } = await import("../dist/trigger-targets.js");
const { readLaunchBody } = await import("../dist/run-launch.js");
const { runnersRefused } = await import("../dist/runner/presence.js");
const { carriesPrevious } = await import("../dist/trigger-adapter.js");
const { TRIGGER_ADAPTERS } = await import("../dist/trigger-adapters.js");

const dirs = [];
after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshStore() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tt-"));
  dirs.push(dir);
  const store = await openSqliteStore({ file: join(dir, "store.sqlite"), role: "server" });
  after(() => store.close().catch(() => undefined));
  await store.agents.create({ id: "a1", name: "Agent one" }, { id: "r1", kind: "agentic", body: { instructions: "Answer." } });
  return store;
}

const revisionOf = (over = {}) => ({ id: "r1", agentId: "a1", kind: "agentic", body: { instructions: "Answer.", tools: [], skills: {}, ...over }, createdAt: 0 });
const entryOf = (over = {}) => ({ agent: { id: "a1", name: "Agent one", description: null, currentRevision: "r1", createdAt: 0, archivedAt: null }, revision: revisionOf(), version: 1, revisions: 1, sizes: new Map(), ...over });

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

const moment = (over = {}) => ({
  id: "run-1", agentId: "a1", kind: "agentic", cancelled: false, terminal: false, working: true,
  awaitingAnswer: false, steers: true, live: true, paused: false, waitsOnPerson: false, maxCostUsd: 5, ...over,
});

const deps = (over = {}) => {
  const { start: startOver, ...rest } = over;
  return {
    start: startDeps(startOver),
    getAgent: async () => entryOf(),
    needAgent: async () => entryOf(),
    momentOf: async () => moment(),
    runStatus: async () => "working",
    ...rest,
  };
};

const from = { kind: "trigger", trigger_id: "t1", source: "schedule", owner: true };
/** A message_run trigger t1 to run-1, holding firings `keys` due: what a trigger's message is queued under. */
async function dueFirings(store, keys = ["f1"]) {
  await store.triggers.create({ id: "t1", agentId: "a1", name: "poke", enabled: true, source: { kind: "schedule" }, target: { kind: "message_run", run_id: "run-1", input: { content: "hi" } }, nextAt: null, catchupWindowS: 3600 });
  await store.triggers.record("t1", keys.map((key) => ({ key, by: "schedule", nominalAt: 0, status: "due" })));
}
const BOUND = { max: 1, reason: "A message from this trigger is already waiting." };

// ---- targetIssues ---------------------------------------------------------------------------------------------------

test("a message_run target with a cap is allowed", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps());
  assert.deepEqual(await t.targetIssues({ kind: "message_run", run_id: "run-1", input: { content: "hi" } }), []);
});

test("a message_run target to an unknown run is not_found", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ momentOf: async () => undefined }));
  const issues = await t.targetIssues({ kind: "message_run", run_id: "run-x", input: { content: "hi" } });
  assert.equal(issues[0].reason, "not_found");
});

test("a message_run target to a run with no cap is refused with the cap words", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ momentOf: async () => moment({ maxCostUsd: undefined }) }));
  const issues = await t.targetIssues({ kind: "message_run", run_id: "run-1", input: { content: "hi" } });
  assert.equal(issues[0].reason, "not_allowed");
  assert.match(issues[0].message, /only messages a run with one/);
});

test("a message_run target to a workflow run is not_allowed", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ momentOf: async () => moment({ kind: "workflow" }) }));
  const issues = await t.targetIssues({ kind: "message_run", run_id: "run-1", input: { content: "hi" } });
  assert.match(issues[0].message, /A workflow run takes no messages here\./);
});

test("a start_run target for an unknown agent is not_found", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ getAgent: async () => undefined }));
  const issues = await t.targetIssues({ kind: "start_run", agent_id: "aX", input: { content: "hi" }, max_cost_usd: 1 });
  assert.equal(issues[0].reason, "not_found");
});

test("a start_run target for an agent with no current revision is invalid", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ getAgent: async () => entryOf({ revision: null }) }));
  const issues = await t.targetIssues({ kind: "start_run", agent_id: "a1", input: { content: "hi" }, max_cost_usd: 1 });
  assert.match(issues[0].message, /has no current revision/);
});

test("a start_run target with no cap and no agent default is refused (every trigger run is capped)", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps());
  const issues = await t.targetIssues({ kind: "start_run", agent_id: "a1", input: { content: "hi" } });
  assert.equal(issues[0].field, "target.max_cost_usd");
  assert.match(issues[0].message, /Every run a trigger starts is capped/);
});

test("a start_run target with the agent's default cap is allowed", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps({ start: { pinnedOf: async () => ({ revision: revisionOf({ maxCostUsd: 2 }), version: 1 }) } }));
  assert.deepEqual(await t.targetIssues({ kind: "start_run", agent_id: "a1", input: { content: "hi" } }), []);
});

// ---- the previous result -------------------------------------------------------------------------------------------

test("only the schedule's runs are handed their trigger's last result: every other source's firings are different events", () => {
  assert.deepEqual(TRIGGER_ADAPTERS.filter(carriesPrevious).map((a) => a.id), ["schedule"]);
});

test("a source that says nothing about the previous result hands none", () => {
  assert.equal(carriesPrevious({}), false);
});

// A previous result over the limit (32 KiB as JSON.stringify(x, null, 2) lays it out, in UTF-8 bytes) whose run's output
// schema names x-carried: only those fields, the ones the output holds; its carried arrays give up entries from the front
// (a template keeps them oldest first) until the carried fields fit, from the array largest in bytes right then, a tie to
// the first in x-carried order. The expected texts are the source's own words (previousCarriedWords,
// previousResultTooLarge): a test pins the fields, the whole result's bytes and the counts dropped. The expected counts
// were worked out apart from the source, by laying the picked JSON out again after every drop.
const entry = (list, i, words = 20) => `https://jobs.example.com/${list}/${String(i).padStart(3, "0")} ${"word ".repeat(words).trim()}`;
const entries = (list, n) => Array.from({ length: n }, (_, i) => entry(list, i));
const NOISE = "word ".repeat(7 * 1024).trim();
const PREVIOUS_RUN = "run-prev";
const ENDED = "2026-11-19T09:00:00.000Z";
const OVER = previousResultTooLarge(PREVIOUS_RUN);
/** The words a run is handed `picked` in, the carried fields of `output` (its whole bytes), `dropped` from the front. */
const carriedText = (output, picked, dropped) =>
  previousCarriedWords(PREVIOUS_RUN, ENDED, Object.keys(picked), Buffer.byteLength(JSON.stringify(output, null, 2)), JSON.stringify(picked, null, 2), dropped);

/** What a schedule's run is handed when its trigger's last completed run (run-prev) ended with `output`, its pinned
 *  schema naming `carried` in x-carried (none when undefined): the text after the run's message. */
async function handedAfter(output, carried) {
  const store = await freshStore();
  await store.runs.create({ id: PREVIOUS_RUN, agentId: "a1", revisionId: "r1" });
  await dueFirings(store, ["f0"]);
  await store.triggers.settle("t1", "f0", { status: "started", runId: PREVIOUS_RUN });
  const completedOutput = async (runId) => (runId === PREVIOUS_RUN ? { output, endedAt: ENDED, ...(carried ? { carried } : {}) } : undefined);
  const t = triggerTargets(store, deps({ completedOutput }));
  const { run_id } = await t.start({ kind: "start_run", agent_id: "a1", input: { content: "Go." }, max_cost_usd: 1 }, { content: "Go." }, { id: "t1", firing_key: "f1" }, from, undefined, true);
  const content = readLaunchBody((await store.runs.launch(run_id)).body).input.content;
  assert.ok(content.startsWith("Go."), "the run's own message comes first");
  return content.slice("Go.".length);
}

test("over the limit with no x-carried: the too-large line; beside it, the same result carrying seen is handed seen", async () => {
  const output = { seen: entries("seen", 2), noise: NOISE };
  assert.equal(await handedAfter(output, ["seen"]), carriedText(output, { seen: output.seen }, []), "the control is handed its carried field");
  assert.equal(await handedAfter(output, undefined), OVER, "no x-carried, the too-large line and nothing of the result");
});

test("a carried field absent from the output is left out, never a null in its place; a pick with none of them present is the too-large line", async () => {
  const output = { seen: entries("seen", 2), noise: NOISE };
  assert.equal(await handedAfter(output, ["seen", "tag"]), carriedText(output, { seen: output.seen }, []), "x-carried [seen, tag], no tag: seen alone, named alone");
  assert.equal(await handedAfter(output, ["tag"]), OVER, "x-carried [tag], no tag: nothing to pick, the too-large line, never {}");
});

test("carried fields over the limit: the first entries of a carried array are dropped until they fit, the rest handed in order, said per field", async () => {
  const seen = entries("seen", 300);
  const output = { seen, tag: "newer" };
  assert.equal(await handedAfter(output, ["seen"]), carriedText(output, { seen: seen.slice(68) }, [["seen", 68]]), "the first 68 are dropped, the last 232 kept in their order");
  assert.ok(Buffer.byteLength(JSON.stringify({ seen: seen.slice(68) }, null, 2)) <= 32768 && Buffer.byteLength(JSON.stringify({ seen: seen.slice(67) }, null, 2)) > 32768, "no more dropped than it takes");
  assert.equal(output.seen.length, 300, "the run's output itself is left whole");
});

test("the largest carried array gives up its entries: a small ranked array beside it is handed whole", async () => {
  const ranked = ["theme one: 12", "theme two: 7", "theme three: 3"];
  const seen = entries("seen", 300);
  const output = { ranked, seen, tag: "newer" };
  assert.equal(await handedAfter(output, ["ranked", "seen"]), carriedText(output, { ranked, seen: seen.slice(69) }, [["seen", 69]]), "only the largest array is trimmed, and only it is named");
});

test("two carried arrays the same size: the first in x-carried order gives up an entry, then the larger one, measured again after each drop", async () => {
  const a = entries("a", 120);
  const b = entries("b", 120);
  const output = { a, b };
  // b first (the tie, by x-carried order, never the output's key order), then a (now larger), then b (the tie again).
  assert.equal(await handedAfter(output, ["b", "a"]), carriedText(output, { b: b.slice(2), a: a.slice(1) }, [["b", 2], ["a", 1]]), "the tie goes to b, then each drop to the larger, named in x-carried order");
});

test("carried fields are measured in UTF-8 bytes: non-ASCII entries a character count says fit still give up their first", async () => {
  const seen = Array.from({ length: 280 }, (_, i) => `https://jobs.example.com/${String(i).padStart(3, "0")} café crème brûlée 日本語の求人 `.repeat(2).trim());
  const picked = JSON.stringify({ seen }, null, 2);
  assert.ok(picked.length <= 32768 && Buffer.byteLength(picked) > 32768, `the setup: ${picked.length} characters, ${Buffer.byteLength(picked)} bytes`);
  const output = { seen, noise: "x" };
  assert.equal(await handedAfter(output, ["seen"]), carriedText(output, { seen: seen.slice(58) }, [["seen", 58]]), "the first 58 are dropped, by bytes");
});

test("a carried scalar or object is never cut: over the limit with no entry left to drop, the too-large line; beside it a drop that fits", async () => {
  const fits = { seen: entries("seen", 300), noise: NOISE };
  assert.equal(await handedAfter(fits, ["seen"]), carriedText(fits, { seen: fits.seen.slice(68) }, [["seen", 68]]), "the control trims to fit");
  assert.equal(await handedAfter({ noise: NOISE, seen: entries("seen", 10) }, ["noise", "seen"]), OVER, "a carried string over the limit is never cut; dropping every entry of seen does not fit");
  const meta = { found: entries("meta", 300) };
  assert.equal(await handedAfter({ seen: entries("seen", 20), meta }, ["seen", "meta"]), OVER, "an object is never cut, nor an array inside it");
  assert.equal(meta.found.length, 300);
});

test("carried fields under the limit are handed as they are, nothing dropped; beside it a drop", async () => {
  const over = { seen: entries("seen", 300), tag: "newer" };
  assert.equal(await handedAfter(over, ["seen", "tag"]), carriedText(over, { seen: over.seen.slice(68), tag: "newer" }, [["seen", 68]]), "the control trims to fit");
  const seen = entries("seen", 50);
  const output = { seen, noise: NOISE, tag: "newer" };
  assert.equal(await handedAfter(output, ["seen", "tag"]), carriedText(output, { seen, tag: "newer" }, []), "under the limit the carried fields are whole, no drop named");
});

// ---- start / message / statusOf / runOf -----------------------------------------------------------------------------

test("start inserts a queued, capped run under the firing's key", async () => {
  const store = await freshStore();
  const t = triggerTargets(store, deps());
  const { run_id } = await t.start({ kind: "start_run", agent_id: "a1", input: { content: "hi" }, max_cost_usd: 3 }, { content: "hi" }, { id: "t1", firing_key: "f1" }, from, undefined, false);
  const row = await store.runs.get(run_id);
  assert.equal(row.state, "queued");
  assert.equal(readLaunchBody((await store.runs.launch(run_id)).body).maxCostUsd, 3);
  // The firing's key found the run: a retry gets the same one.
  assert.equal((await store.runOfOrigin("f1")).runId, run_id);
});

test("message to a working run writes a steer that answers no person, its firing marked sent in the same write; past the trigger's bound for the run a firing is skipped in words, nothing written", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  await dueFirings(store, ["f1", "f2"]);
  const t = triggerTargets(store, deps());
  const target = { kind: "message_run", run_id: "run-1", input: { content: "from the schedule" } };
  assert.equal(await t.message(target, { content: "from the schedule" }, "f1", from, BOUND), undefined);
  const rows = await store.commands("run-1", 0);
  assert.deepEqual(rows.map((row) => [row.kind, row.body.text, row.body.answers, row.body.origin]), [["steer", "from the schedule", false, from]]);
  assert.deepEqual([(await store.triggers.firing("t1", "f1")).status, (await store.triggers.firing("t1", "f1")).runId], ["sent", "run-1"], "sent with its row, in one transaction");
  assert.deepEqual(await t.message(target, { content: "from the schedule" }, "f2", from, BOUND), { skipped: BOUND.reason });
  assert.equal((await store.commands("run-1", 0)).length, 1, "the second waits for nothing: skipped");
  assert.equal((await store.triggers.firing("t1", "f2")).status, "skipped");
});

test("message to a run waiting on a person is skipped, nothing written", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const t = triggerTargets(store, deps({ momentOf: async () => moment({ waitsOnPerson: true }) }));
  const answer = await t.message({ kind: "message_run", run_id: "run-1", input: { content: "hi" } }, { content: "hi" }, "f1", from, BOUND);
  assert.deepEqual(answer, { skipped: "The run is waiting on a person." });
  assert.equal((await store.commands("run-1", 0)).length, 0);
});

test("message to a run with no cap is refused with the cap words", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  const t = triggerTargets(store, deps({ momentOf: async () => moment({ maxCostUsd: undefined }) }));
  await assert.rejects(
    () => t.message({ kind: "message_run", run_id: "run-1", input: { content: "hi" } }, { content: "hi" }, "f1", from, BOUND),
    (e) => e.code === "not_continuable" && /only messages a run with one/.test(e.message),
  );
});

test("message while every runner here refused to claim is refused runner_refused in their words, nothing written and the firing left for the engine to fail; a start alike", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1" });
  await dueFirings(store, ["f1"]);
  // The refusal is the store's (a refused runner's row): a message reads it in message(), a start through its deps, as the
  // server wires them (server.ts refusedNow).
  await store.runners.put({ runner: "r1", incarnation: "a", refused: "set AGENTRUN_RUN_USER=same." });
  const words = "No runner of this server can take a run: set AGENTRUN_RUN_USER=same.";
  const t = triggerTargets(store, deps({ start: { runnersRefused: () => runnersRefused(store.runners) } }));
  await assert.rejects(
    () => t.message({ kind: "message_run", run_id: "run-1", input: { content: "hi" } }, { content: "hi" }, "f1", from, BOUND),
    (e) => e.code === "runner_refused" && e.message === words,
  );
  assert.equal((await store.commands("run-1", 0)).length, 0, "no message waits on a runner that never comes");
  assert.equal((await store.triggers.firing("t1", "f1")).status, "due", "not marked sent");
  await assert.rejects(
    () => t.start({ kind: "start_run", agent_id: "a1", input: { content: "hi" }, max_cost_usd: 1 }, { content: "hi" }, { id: "t1", firing_key: "f2" }, from),
    (e) => e.code === "runner_refused" && e.message === words,
  );
});

test("runOf finds a run started under a key: a run is inserted whole, so a found run started", async () => {
  const store = await freshStore();
  await store.runs.create({ id: "run-1", agentId: "a1", revisionId: "r1", origin: { key: "f1" } });
  const t = triggerTargets(store, deps());
  assert.deepEqual(await t.runOf("f1"), { run_id: "run-1" });
  assert.equal(await t.runOf("nope"), null);
});
