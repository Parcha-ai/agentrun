// Learn from a CSV (POST /v2/agents/{id}/learning/batches): rows in, the agent run on each in order with learning on, each
// run told the reference answer beside its own, progress kept by the server (a reload reads it; a restart takes it up),
// a cancel, and a cap on its runs (grades booked, uncapped, as on every run). The faux model answers "Job answer." and learns the note its instructions plan.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerValue, BATCH_ROWS_MAX, checkBatchBody, contentOf, LearningBatches, matches, reviewText, RUN_CAP_MIN_USD } from "../dist/learning-batch.js";
import { secretsShown } from "../dist/learning.js";
import { note } from "./fixtures/faux-learn.mjs";
import { LEARN, learner, made, sleep } from "./learn-support.mjs";
import { follow, serve, startInProcessRunner } from "./support.mjs";
import { holdRow } from "./fixtures/faux-learn-shutdown.mjs";
const HELD_LEARN = new URL("./fixtures/faux-learn-shutdown.mjs", import.meta.url).pathname;

const UNITS = note("Check units", "Convert every amount to one unit before comparing", "Amounts came in cents and in dollars.\n");
const rowsOf = (references) => references.map((reference, i) => ({ name: `Shop ${i + 1}`, site: `shop${i + 1}.example`, truth: reference }));
const body = (references, extra = {}) => ({ inputs: ["name", "site"], answer: "truth", rows: rowsOf(references), max_cost_usd: 5, ...extra });

/** The batch read until `until` holds of it (a deadline, never forever). */
async function until(api, id, batch, done, { ms = 120_000 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await api("GET", `/agents/${id}/learning/batches/${batch}`);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    if (done(got.body)) return got.body;
    assert.ok(Date.now() < deadline, `the batch did not get there: ${JSON.stringify({ ...got.body, rows: got.body.rows.map((r) => r.state) })}`);
    await sleep(100);
  }
}
const finished = (b) => b.status !== "running";
const money = (x) => Math.round(x * 1e6) / 1e6;
/** The learning routes' cut with no secret held: what a host with none shows. */
const OPEN = secretsShown([]);

test("the match is structural: trimmed, case-folded, whitespace-collapsed, numbers by value; a JSON answer's field by a dotted path", () => {
  assert.equal(matches("  Job   ANSWER. ", "job answer."), true);
  assert.equal(matches("5411.0", "5411"), true, "two numbers by value");
  assert.equal(matches("5412", "5411"), false);
  assert.equal(matches(null, "x"), false, "no answer is wrong");
  assert.equal(answerValue('{"result":{"code":5411},"n":1}', "result.code"), "5411");
  assert.equal(answerValue('Here it is:\n```json\n{"code":"A1"}\n```', "code"), "A1", "a fenced block");
  assert.equal(answerValue('{"result":{"code":5411}}', "result"), null, "an object is no answer");
  assert.equal(answerValue("plain words", "code"), null);
  assert.equal(answerValue("plain words", null), "plain words", "no field: the answer whole");
  assert.equal(contentOf(["name"], { name: "Acme", truth: "x" }), "Acme");
  assert.equal(contentOf(["name", "site"], { name: "Acme", site: "acme.example", truth: "x" }), "name: Acme\nsite: acme.example");
  assert.equal(reviewText("A", "B"), 'Review: the reference answer is "A"; you answered "B".');
  assert.equal(reviewText("A", null), 'Review: the reference answer is "A"; you answered "nothing".');
});

test("a batch's body is checked field by field: the columns, the answer column never an input, the cap required, the rows whole", () => {
  const ok = checkBatchBody(body(["a", "b"]));
  assert.ok(!Array.isArray(ok));
  assert.deepEqual(ok.rows[0], { input: { name: "Shop 1", site: "shop1.example" }, reference: "a" });
  const fields = (b) => checkBatchBody(b).map((i) => i.field);
  assert.deepEqual(fields({ ...body(["a"]), max_cost_usd: undefined }), ["max_cost_usd"]);
  assert.deepEqual(fields(body(["a"], { answer: "name" })), ["answer"], "the answer column is no input");
  assert.deepEqual(fields(body(["a"], { inputs: [] })), ["inputs"]);
  assert.deepEqual(fields(body(["a"], { inputs: ["name", "name"] })), ["inputs"]);
  assert.deepEqual(fields(body([], {})), ["rows"]);
  assert.deepEqual(fields(body(["a"], { extra: 1 })), ["extra"]);
  assert.deepEqual(fields({ ...body(["a"]), rows: [{ name: "x", site: "y", truth: " " }] }), ["rows[0].truth"], "a row with no reference");
  assert.deepEqual(fields({ ...body(["a"]), rows: [{ name: "x", truth: "t" }] }), ["rows[0].site"], "a row without an input column");
  assert.deepEqual(fields({ ...body(["a"]), rows: Array.from({ length: BATCH_ROWS_MAX + 1 }, () => ({})) }), ["rows"]);
  assert.deepEqual(fields(body(["a"], { answer_field: "a b" })), ["answer_field"]);
});

test("POST /agents/{id}/learning/batches: each row's run, in order, with learning on; the review beside its answer; right and wrong, the path, the cost and what it learned, kept by the server", { timeout: 240_000 }, async (t) => {
  const { api, store } = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50 });
  const id = "csv-learner";
  await made(api, learner(id, { plan: [["check-units.md", UNITS]], once: true }));
  const refs = ["Job answer.", "Other", "job   ANSWER.", "Job answer"];
  const created = await api("POST", `/agents/${id}/learning/batches`, body(refs));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.match(created.headers.get("location"), new RegExp(`/agents/${id}/learning/batches/lb_[0-9a-f]{16}$`));
  const batch = created.body;
  assert.deepEqual([batch.total, batch.answer, batch.inputs, batch.max_cost_usd], [4, "truth", ["name", "site"], 5]);
  const end = await until(api, id, batch.id, finished);
  assert.equal(end.status, "completed", JSON.stringify(end));
  assert.deepEqual([end.finished, end.right, end.wrong, end.failed], [4, 2, 2, 0], "Job answer. twice (one by case and spaces); Other and Job answer (no stop) are wrong");
  assert.deepEqual(end.rows.map((r) => [r.n, r.state, r.right, r.reviewed]), [[1, "done", true, true], [2, "done", false, true], [3, "done", true, true], [4, "done", false, true]]);
  assert.deepEqual(end.rows.map((r) => r.answer), Array(4).fill("Job answer."));
  assert.equal(end.rows.every((r) => r.input === undefined), true, "the rows' inputs are in their runs, not repeated");
  assert.deepEqual(end.paths, { agent: 4, handed_back: 0, workflow: 0 });
  assert.equal(money(end.rows.reduce((sum, r) => sum + r.total_usd, 0)), end.spent_usd, "the header's cost is the rows'");
  assert.equal(end.cost_usd, end.spent_usd);
  assert.ok(end.spent_usd > 0 && end.spent_usd < end.max_cost_usd, "the faux model's runs cost a little, and the cap holds");
  assert.deepEqual(end.lessons.notes, ["Check units", "What the reviewer said"], "the first run's note, then the note its review taught, each once");
  assert.ok(end.rows[0].merged, "the merge of the first run's learning");
  assert.deepEqual(end.rows[0].learned.notes, ["Check units", "What the reviewer said"], "every round's");
  // What a row's learning cost is every round's: each round's look-back and each round's grade (the review opens round 2).
  let graded = 0;
  for (const row of end.rows) {
    let look = 0, grade = 0;
    for (const round of [1, 2]) {
      const kept = await store.learning.proposal(row.run_id, round);
      assert.ok(kept, `row ${row.n} kept round ${round}`);
      look += kept.proposal?.look_back_usd ?? 0;
      grade += kept.learningRunId ? ((await store.runs.get(kept.learningRunId))?.costUsd ?? 0) : 0;
    }
    graded += grade;
    assert.equal(row.learning_usd, money(look + grade), `row ${row.n}: every round's look-back and grade`);
  }
  assert.ok(graded > 0, "the rows' grades cost something");

  // Each run was given the chosen columns alone, in order, and was told the reference beside its own answer.
  const runs = (await api("GET", `/agents/${id}/runs?limit=20`)).body.runs.filter((r) => end.rows.some((row) => row.run_id === r.run_id));
  assert.equal(runs.length, 4);
  for (const row of end.rows) {
    const launch = await store.runs.launch(row.run_id);
    assert.equal(launch.body.input.content, `name: Shop ${row.n}\nsite: shop${row.n}.example`, "the chosen columns alone: the answer column is never given to the run");
    const timeline = (await follow(api, row.run_id, ["completed"])).rows;
    const reviews = timeline.filter((r) => r.kind === "user_message" && /^Review: /.test(r.text ?? ""));
    assert.deepEqual(reviews.map((r) => r.text), [reviewText(["Job answer.", "Other", "job   ANSWER.", "Job answer"][row.n - 1], "Job answer.")], `row ${row.n}: one review, the reference and its own answer`);
  }
  assert.deepEqual(end.rows.map((r) => r.run_id), [...end.rows].sort((a, b) => a.n - b.n).map((r) => r.run_id));
  const started = (await Promise.all(end.rows.map(async (r) => (await api("GET", `/runs/${r.run_id}`)).body.created_at)));
  assert.deepEqual(started, [...started].sort(), "run after run, in the rows' order");

  // The list, newest first, with no rows; an ended batch lets the agent start another.
  const list = (await api("GET", `/agents/${id}/learning/batches`)).body.batches;
  assert.deepEqual(list.map((b) => [b.id, b.status, b.rows]), [[batch.id, "completed", undefined]]);
  const again = await api("POST", `/agents/${id}/learning/batches`, body(["Job answer."]));
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal((await until(api, id, again.body.id, finished)).status, "completed");
  assert.equal((await api("GET", `/agents/${id}/learning/batches`)).body.batches.length, 2);
});

test("a batch refused: a body that is not whole is 422 by field; an agent that does not learn, or one with a batch running, is 409; an unknown batch is 404", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50 });
  const id = "csv-refused";
  await made(api, learner(id));
  const bad = await api("POST", `/agents/${id}/learning/batches`, { ...body(["a"]), max_cost_usd: undefined });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.deepEqual(bad.body.error.fields.map((f) => f.field), ["max_cost_usd"]);
  await made(api, { definition: { id: "no-learning", version: 1, name: "no-learning", instructions: "Answer.", skills: [], tools: [], learning: false } });
  const off = await api("POST", `/agents/no-learning/learning/batches`, body(["a"]));
  assert.equal(off.status, 409, JSON.stringify(off.body));
  assert.match(off.body.error.message, /does not learn/);
  assert.equal((await api("POST", `/agents/nobody/learning/batches`, body(["a"]))).status, 404);
  assert.equal((await api("GET", `/agents/${id}/learning/batches/lb_0123456789abcdef`)).status, 404);
  assert.equal((await api("GET", `/agents/${id}/learning/batches/nope`)).status, 404);
  const first = await api("POST", `/agents/${id}/learning/batches`, body(["Job answer.", "Job answer.", "Job answer."]));
  assert.equal(first.status, 202);
  const second = await api("POST", `/agents/${id}/learning/batches`, body(["a"]));
  assert.equal(second.status, 409, "one batch runs at a time: learning is ordered");
  assert.equal(second.body.error.details.batch_id, first.body.id);
  assert.equal((await api("GET", `/agents/${id}/learning/batches/${first.body.id}`)).body.status, "running");
  assert.equal((await api("GET", `/agents/other/learning/batches/${first.body.id}`)).status, 404, "a batch is its agent's");
  await api("POST", `/agents/${id}/learning/batches/${first.body.id}/cancel`, {});
});

test("a graceful server and runner shutdown drains the in-flight batch request and a restart continues without repeating a row", { timeout: 300_000 }, async (t) => {
  // Its runner drains at the stop as the CLI's runner beside the server does (beside.ts DRAIN_TIMEOUT): a turn in flight
  // finishes and is booked. A stop that cut a model request instead would leave that request's cost unknown for good
  // (metrics.ts bookedSpend: the provider may bill what it streamed), and the batch stops `cost_unknown` on that row.
  const first = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50, runnerTiming: { drainMs: 30_000 } });
  const id = "csv-reload";
  await made(first.api, learner(id));
  const refs = ["Job answer.", "Job answer.", "x", "Job answer.", "y"];
  const created = await first.api("POST", `/agents/${id}/learning/batches`, body(refs));
  assert.equal(created.status, 202);
  const mid = await until(first.api, id, created.body.id, (b) => b.finished >= 2 && b.status === "running");
  // The cost now is the rows booked and the row in flight as it will be booked (a run still going counts its live cost).
  assert.ok(typeof mid.cost_usd === "number" && mid.cost_usd >= mid.spent_usd, `cost now ${mid.cost_usd}, booked ${mid.spent_usd}`);
  // A second read, as a reloaded page makes, is the same progress.
  const reread = (await first.api("GET", `/agents/${id}/learning/batches/${created.body.id}`)).body;
  assert.ok(reread.finished >= mid.finished && reread.total === 5);
  assert.deepEqual(reread.rows.slice(0, mid.finished).map((r) => r.run_id), mid.rows.slice(0, mid.finished).map((r) => r.run_id));
  const done = mid.rows.filter((r) => r.state === "done").map((r) => r.run_id);
  // The whole start stopped (the runner drained, then the server), then a new one on the same data: the batch is still
  // running there.
  await first.stop();
  const second = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50, data: first.data });
  const end = await until(second.api, id, created.body.id, finished);
  assert.equal(end.status, "completed", JSON.stringify(end));
  assert.deepEqual([end.finished, end.right, end.wrong, end.failed], [5, 3, 2, 0]);
  assert.deepEqual(end.rows.filter((r) => done.includes(r.run_id)).map((r) => r.run_id), done, "the rows done before the stop are the same runs");
  const all = (await second.api("GET", `/agents/${id}/runs?limit=50`)).body.runs;
  assert.equal(all.length, 5, "one run a row: none was run twice");
});


test("a server-only restart reads the persisted unfinished batch row while its separately owned runner stays alive", { timeout: 300_000 }, async (t) => {
  const held = holdRow(3);
  let closeRunner;
  t.after(() => held.release());
  t.after(async () => closeRunner?.());
  // The batch belongs to the server. Keep its separately owned runner alive across this server restart;
  // interrupting a paid request instead has an honestly unknown charge, covered by the next case.
  const first = await serve(t, { runner: false, learning: "on", faux: HELD_LEARN, batchPollMs: 50 });
  closeRunner = await startInProcessRunner(first.data, { learning: "on", faux: HELD_LEARN });
  const id = "csv-reload";
  await made(first.api, learner(id));
  const refs = ["Job answer.", "Job answer.", "x", "Job answer.", "y"];
  const created = await first.api("POST", `/agents/${id}/learning/batches`, body(refs));
  assert.equal(created.status, 202);
  const mid = await until(first.api, id, created.body.id, (b) => b.finished >= 2 && b.status === "running");
  // The cost now is the rows booked and the row in flight as it will be booked (a run still going counts its live cost).
  assert.ok(typeof mid.cost_usd === "number" && mid.cost_usd >= mid.spent_usd, `cost now ${mid.cost_usd}, booked ${mid.spent_usd}`);
  // A second read, as a reloaded page makes, is the same progress.
  const reread = (await first.api("GET", `/agents/${id}/learning/batches/${created.body.id}`)).body;
  assert.ok(reread.finished >= mid.finished && reread.total === 5);
  assert.deepEqual(reread.rows.slice(0, mid.finished).map((r) => r.run_id), mid.rows.slice(0, mid.finished).map((r) => r.run_id));
  const done = mid.rows.filter((r) => r.state === "done").map((r) => r.run_id);
  // Stop exactly while row three is unfinished, then resume the persisted batch on the new server.
  await held.started;
  await first.stop();
  const second = await serve(t, { runner: false, learning: "on", faux: HELD_LEARN, batchPollMs: 50, data: first.data });
  const resumed = (await second.api("GET", `/agents/${id}/learning/batches/${created.body.id}`)).body;
  assert.deepEqual([resumed.status, resumed.finished, resumed.current], ["running", 2, 3]);
  held.release();
  const end = await until(second.api, id, created.body.id, finished);
  assert.equal(end.status, "completed", JSON.stringify(end));
  assert.deepEqual([end.finished, end.right, end.wrong, end.failed], [5, 3, 2, 0]);
  assert.deepEqual(end.rows.filter((r) => done.includes(r.run_id)).map((r) => r.run_id), done, "the rows done before the stop are the same runs");
  const all = (await second.api("GET", `/agents/${id}/runs?limit=50`)).body.runs;
  assert.equal(all.length, 5, "one run a row: none was run twice");
});

test("a runner cut during a paid batch request keeps its charge unknown after restart and starts no later row", { timeout: 120_000 }, async t => {
  const held = holdRow(3);
  t.after(() => held.release());
  const first = await serve(t, { learning: "on", faux: HELD_LEARN, batchPollMs: 50 });
  const id = "csv-cut";
  await made(first.api, learner(id));
  const created = await first.api("POST", `/agents/${id}/learning/batches`, body(["Job answer.", "Job answer.", "x", "Job answer.", "y"]));
  assert.equal(created.status, 202);
  await held.started;
  const mid = (await first.api("GET", `/agents/${id}/learning/batches/${created.body.id}`)).body;
  assert.deepEqual([mid.finished, mid.current], [2, 3]);
  const prior = mid.rows.slice(0, 3).map(row => row.run_id);
  await first.stop();
  await held.aborted;
  const second = await serve(t, { learning: "on", faux: HELD_LEARN, batchPollMs: 50, data: first.data });
  const end = await until(second.api, id, created.body.id, finished);
  assert.deepEqual([end.status, end.stopped, end.finished, end.unknown_cost_rows], ["stopped", "cost_unknown", 3, 1]);
  assert.deepEqual([end.cost_usd, end.remaining_usd, end.rows[2].cost_usd, end.rows[2].total_usd], [null, null, null, null]);
  assert.deepEqual(end.rows.slice(0, 3).map(row => row.run_id), prior, "a restart resumes existing rows, never recreates them");
  assert.deepEqual(end.rows.slice(3).map(row => [row.state, row.run_id]), [["pending", undefined], ["pending", undefined]]);
  assert.equal((await second.api("GET", `/agents/${id}/runs?limit=50`)).body.runs.length, 3, "unknown spending cannot dispatch more rows");
});

test("cancel ends the loop, cancels the run in flight and keeps the rows done; a batch cancelled stays cancelled", { timeout: 240_000 }, async (t) => {
  const { api } = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50 });
  const id = "csv-cancel";
  await made(api, learner(id));
  const created = await api("POST", `/agents/${id}/learning/batches`, body(Array(6).fill("Job answer.")));
  assert.equal(created.status, 202);
  await until(api, id, created.body.id, (b) => b.finished >= 1);
  const cancelled = await api("POST", `/agents/${id}/learning/batches/${created.body.id}/cancel`, {});
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const b = cancelled.body;
  assert.equal(b.status, "cancelled");
  assert.ok(b.finished >= 1 && b.finished < 6);
  assert.equal(b.rows.filter((r) => r.state === "pending").length, 6 - b.finished, "no row after the cancel starts");
  assert.equal(b.rows.filter((r) => r.state === "running").length, 0);
  await sleep(500);
  const later = (await api("GET", `/agents/${id}/learning/batches/${created.body.id}`)).body;
  assert.deepEqual([later.status, later.finished], ["cancelled", b.finished], "it stays where the cancel left it");
  assert.equal((await api("POST", `/agents/${id}/learning/batches/${created.body.id}/cancel`, {})).body.status, "cancelled", "a second cancel answers it as it is");
});

test("the cap holds the runs: a row starts only while what is left covers a run's smallest cap and the mean of the rows done, no run passes what is left (strict), and the batch stops `cap`, its rows done kept", { timeout: 240_000 }, async (t) => {
  const { api } = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50 });
  const id = "csv-cap";
  await made(api, learner(id));
  // One row first, to know what a row costs here.
  const probe = await api("POST", `/agents/${id}/learning/batches`, body(["Job answer."]));
  const one = await until(api, id, probe.body.id, finished);
  assert.equal(one.status, "completed");
  const row = one.rows[0].total_usd;
  assert.ok(row > 0 && row < 0.02, `a faux row's cost: ${row}`);
  // Room for a row or two (a cent and a half a row), never six. Each run is capped strict at what is left, so a run whose
  // next request could pass it parks (its row failed, booked) instead: how many rows end depends on the faux prices, the
  // rule does not (the exact room rule: "the cap's rule on its own" below).
  const cap = money(RUN_CAP_MIN_USD + row * 1.5);
  const created = await api("POST", `/agents/${id}/learning/batches`, body(Array(6).fill("Job answer."), { max_cost_usd: cap }));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const end = await until(api, id, created.body.id, finished);
  const seen = JSON.stringify({ row, cap, spent: end.spent_usd, rows: end.rows.map((r) => [r.state, r.total_usd, r.error]) });
  assert.deepEqual([end.status, end.stopped], ["stopped", "cap"], seen);
  assert.ok(end.spent_usd <= cap, `no run passes what is left: ${seen}`);
  const started = end.rows.filter((r) => r.state !== "pending").length;
  assert.ok(started >= 1 && started < 6 && end.finished === started, seen);
  assert.deepEqual(end.rows.slice(started).map((r) => r.state), Array(6 - started).fill("pending"), `the rows left never started: ${seen}`);
  assert.ok(money(cap - end.spent_usd) < Math.max(money(end.spent_usd / end.finished), RUN_CAP_MIN_USD), `it stops only once what is left covers no row: ${seen}`);
  assert.equal(end.remaining_usd, money(cap - end.spent_usd));
  assert.deepEqual([end.rows[0].state, end.rows[0].reviewed], ["done", true], seen);
});

/** A batch host with no server: settings in memory, each run answering at once with a cost the test names. A run is
 *  started under the row's key (found again by it); its answer is "A" until it is reviewed, then `after` (the reply to the
 *  review, never the row's answer). */
function fakeHost({ costs, cancelled = [], after = "A" }) {
  const settings = new Map();
  const runs = new Map();
  const keys = new Map();
  let n = 0;
  return {
    runs,
    keys,
    settings: {
      get: async (k) => (settings.has(k) ? structuredClone(settings.get(k)) : undefined),
      put: async (k, v) => void settings.set(k, structuredClone(v)),
      all: async () => [...settings].map(([key, value]) => ({ key, value: structuredClone(value), updatedAt: 0 })),
    },
    learning: async () => ({ learns: true }),
    find: async (key) => keys.get(key),
    start: async (agentId, b, key) => {
      const id = `run-${++n}`;
      runs.set(id, { b, key, cost: n - 1 in costs ? costs[n - 1] : 0.4, messages: [] });
      keys.set(key, id);
      return id;
    },
    view: async (id) => {
      const r = runs.get(id);
      return { status: r.cancelled ? "cancelled" : "completed", ended_at: `e${r.messages.length}`, answer: r.messages.length ? after : "A", cost_usd: r.cost, learning_state: "merged", error: null };
    },
    sent: async (id, text) => runs.get(id).messages.includes(text),
    message: async (id, text) => void runs.get(id).messages.push(text),
    cancel: async (id) => { cancelled.push(id); if (runs.has(id)) runs.get(id).cancelled = true; },
    figures: async (id) => ({ path: "agent", cost_usd: runs.get(id).cost === null ? null : runs.get(id).cost, learning_usd: 0, total_usd: runs.get(id).cost, learned: { notes: [], skills: [], workflows: [] }, merged: null, revisions: [] }),
    shown: async () => OPEN,
    pollMs: 1,
  };
}
/** A batch body with one row per reference and a cap that never stops it. */
const oneEach = (references) => ({ inputs: ["q"], answer: "a", rows: references.map((a, i) => ({ q: `q${i + 1}`, a })), max_cost_usd: 50 });
const asked = (extra = {}) => ({ inputs: ["q"], answer: "a", rows: Array.from({ length: 6 }, (_, i) => ({ q: `q${i}`, a: "A" })), max_cost_usd: 1.2, ...extra });

test("the cap's rule on its own: with $0.40 a row and $1.20, a third row is started (what is left, $0.40, covers the mean) and a fourth is not", async () => {
  const host = fakeHost({ costs: [] });
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked());
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual([end.status, end.stopped, end.finished, end.spent_usd], ["stopped", "cap", 3, 1.2]);
  assert.deepEqual(end.rows.map((r) => r.state), ["done", "done", "done", "pending", "pending", "pending"]);
  assert.equal(host.runs.get("run-3").b.max_cost_usd, 0.4, "a run's own cap is what the batch has left");
  assert.deepEqual([...host.runs.values()].map((r) => r.b.cap_mode), ["strict", "strict", "strict"], "a row's run is capped strict: every input token priced uncached, so no request (a cache miss included) passes what the batch has left");
  assert.ok([...host.runs.values()].every((r) => r.messages.length === 1 && /^Review: the reference answer is "A"; you answered "A"\.$/.test(r.messages[0])));
});

test("a row whose cost is not known stops the batch: a cap is never guessed at", async () => {
  const host = fakeHost({ costs: [0.1, null] });
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked({ max_cost_usd: 50 }));
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual([end.status, end.stopped, end.finished, end.unknown_cost_rows], ["stopped", "cost_unknown", 2, 1]);
  assert.deepEqual([end.cost_usd, end.remaining_usd], [null, null], "a cost with a row's unknown is unknown, never the known part shown as all");
  const listed = (await batches.list("a1")).batches[0];
  assert.deepEqual([listed.cost_usd, listed.remaining_usd], [null, null]);
});

test("a server that stops leaves the batch running, and one that starts takes up at the first unfinished row without running a finished row again", async () => {
  const host = fakeHost({ costs: [0.01] });
  let release;
  const gate = new Promise((r) => (release = r));
  const view = host.view;
  // The second row's run never ends until the gate opens.
  host.view = async (id) => (id === "run-2" ? await Promise.race([gate.then(() => view(id)), sleep(20).then(() => ({ status: "working", ended_at: null, answer: null, cost_usd: 0, learning_state: null, error: null }))]) : view(id));
  const first = new LearningBatches(host);
  const made = await first.create("a1", asked({ max_cost_usd: 50 }));
  for (let i = 0; i < 200 && host.runs.size < 2; i++) await sleep(10);
  await first.halt();
  const mid = await first.read("a1", made.id);
  assert.deepEqual([mid.status, mid.finished, mid.current], ["running", 1, 2]);
  release();
  const second = new LearningBatches(host);
  assert.equal(await second.resume(), 1);
  await second.idle(made.id);
  const end = await second.read("a1", made.id);
  assert.deepEqual([end.status, end.finished, host.runs.size], ["completed", 6, 6], "six rows, six runs: row 2's run was waited for, not started again");
  assert.equal(host.runs.get("run-2").messages.length, 1, "its review was sent once");
});

/** A host whose runs take a while, as a server's do: a run is working on its first look and has answered ("A") on its
 *  second; the review reopens it (working, then its turn ends `reviewTurn`, its reply "B"); a cancel ends a working run
 *  cancelled at its next look, and is nothing to a run that has ended. A run costs $0.10 a turn. */
function lifeHost({ reviewTurn = "completed", unknown = [] } = {}) {
  const settings = new Map();
  const runs = new Map();
  const keys = new Map();
  let n = 0;
  const look = (r) => {
    if (r.status === "working") {
      if (r.stop) r.status = "cancelled";
      else if (++r.looks >= 2) r.status = r.turn === 1 ? "completed" : reviewTurn;
    }
    return r;
  };
  return {
    runs,
    keys,
    settings: {
      get: async (k) => (settings.has(k) ? structuredClone(settings.get(k)) : undefined),
      put: async (k, v) => void settings.set(k, structuredClone(v)),
      all: async () => [...settings].map(([key, value]) => ({ key, value: structuredClone(value), updatedAt: 0 })),
    },
    learning: async () => ({ learns: true }),
    find: async (key) => keys.get(key),
    start: async (agentId, b, key) => {
      const id = `run-${++n}`;
      runs.set(id, { id, key, turn: 1, looks: 0, status: "working", stop: false, messages: [] });
      keys.set(key, id);
      return id;
    },
    view: async (id) => {
      const r = runs.get(id);
      if (!r) return undefined;
      look(r);
      const ended = r.status !== "working";
      return { status: r.status, ended_at: ended ? `t${r.turn}` : null, answer: r.turn === 1 ? "A" : "B", cost_usd: money(0.1 * r.turn), learning_state: ended ? "merged" : null, error: r.status === "failed" ? "the turn failed" : null };
    },
    sent: async (id, text) => runs.get(id).messages.includes(text),
    message: async (id, text) => {
      const r = runs.get(id);
      if (r.status !== "completed") throw new Error(`the run is ${r.status}`);
      r.messages.push(text);
      Object.assign(r, { turn: r.turn + 1, looks: 0, status: "working" });
    },
    cancel: async (id) => { const r = runs.get(id); if (r?.status === "working") r.stop = true; },
    // A run named in `unknown` has no known cost (its learning's figures were not kept).
    figures: async (id) => { const r = runs.get(id); const known = !unknown.includes(id); return { path: "agent", cost_usd: money(0.1 * r.turn), learning_usd: known ? 0 : null, total_usd: known ? money(0.1 * r.turn) : null, learned: { notes: [], skills: [], workflows: [] }, merged: null, revisions: [] }; },
    shown: async () => OPEN,
    pollMs: 0,
  };
}

/** The host as server processes see it, with faults: every call is numbered (`calls`), and every effect (a write, a start,
 *  a review, a cancel) too (`effects`). `crashAt`: the process dies once that effect is done (every call it makes after
 *  hangs, as a dead process makes none; the next process, `bound` again, has the same store and runs). `errorAt`: that
 *  call fails once, before it does anything (`errorAfter`: after it did). `cancelAt`: a person's cancel arrives once that
 *  effect is done (`onCancel`). */
function faults(host) {
  const s = { epoch: 0, effects: 0, calls: 0, crashAt: Infinity, errorAt: Infinity, errorAfter: false, cancelAt: Infinity, onCancel: null };
  let dead;
  s.died = new Promise((r) => (dead = r));
  const hang = () => new Promise(() => {});
  const bound = () => {
    const epoch = s.epoch;
    const call = (fn, effect) => async (...a) => {
      if (s.epoch !== epoch) return hang();
      const at = ++s.calls;
      if (at === s.errorAt && !s.errorAfter) throw new Error("the store is busy");
      const out = await fn(...a);
      if (s.epoch !== epoch) return hang();
      if (at === s.errorAt) throw new Error("the store is busy");
      if (effect) {
        const e = ++s.effects;
        if (e === s.crashAt) { s.epoch++; dead(); return hang(); }
        if (e === s.cancelAt) s.onCancel?.();
      }
      return out;
    };
    return {
      ...host,
      settings: { get: call(host.settings.get), all: call(host.settings.all), put: call(host.settings.put, true) },
      learning: call(host.learning), find: call(host.find), view: call(host.view), sent: call(host.sent), figures: call(host.figures),
      start: call(host.start, true), message: call(host.message, true), cancel: call(host.cancel, true),
    };
  };
  return { s, bound };
}

const HEAD_KEY = /^learning_batch\/lb_[0-9a-f]{16}$/;
/** What every batch on `host` must be once a process has taken it up and let it end: listed (never hidden), ended, no row
 *  left mid-way, a row done only when its run answered and was told the reference and that turn completed, the header the
 *  fold of its rows, one run a row and every run stopped and owned by its row. */
async function legal(host, batches, why) {
  const heads = (await host.settings.all()).filter(({ key }) => HEAD_KEY.test(key)).map(({ value }) => value);
  const owned = new Map();
  for (const h of heads) {
    const listed = (await batches.list(h.agent_id)).batches.map((b) => b.id);
    assert.ok(listed.includes(h.id), `${why} | batch ${h.id} (${h.status}) is hidden from its agent's list`);
    const b = await batches.read(h.agent_id, h.id);
    assert.notEqual(b.status, "running", `${why} | the batch is still running once its loop let go: ${JSON.stringify(b)}`);
    for (const r of b.rows) {
      assert.ok(["pending", "done", "failed"].includes(r.state), `${why} | row ${r.n} left ${r.state}`);
      if (r.run_id) owned.set(r.run_id, (owned.get(r.run_id) ?? 0) + 1);
      if (r.state !== "done") continue;
      const run = host.runs.get(r.run_id);
      assert.deepEqual([run.status, run.turn, run.messages.length], ["completed", 2, 1], `${why} | row ${r.n} counted done, but its run is ${run.status} after ${run.messages.length} review(s)`);
      assert.deepEqual([r.answer, r.right], ["A", r.reference === "A"], `${why} | row ${r.n}'s answer is the one before its review`);
    }
    const ended = b.rows.filter((r) => r.state === "done" || r.state === "failed");
    if (ended.some((r) => r.run_id && r.total_usd === null)) {
      assert.notEqual(b.status, "completed", `${why} | a batch with a row whose cost is not known reads completed`);
      assert.deepEqual([b.cost_usd, b.remaining_usd], [null, null], `${why} | a batch with a row whose cost is not known shows a cost`);
    }
    assert.deepEqual([b.finished, b.right, b.wrong, b.failed, b.spent_usd], [ended.length, ended.filter((r) => r.state === "done" && r.right).length, ended.filter((r) => r.state === "done" && !r.right).length, ended.filter((r) => r.state === "failed").length, money(ended.reduce((sum, r) => sum + (r.total_usd ?? 0), 0))], `${why} | the header is its rows' fold`);
  }
  const byKey = new Map();
  for (const run of host.runs.values()) {
    byKey.set(run.key, (byKey.get(run.key) ?? 0) + 1);
    assert.notEqual(run.status, "working", `${why} | ${run.id} is left running`);
    assert.equal(owned.get(run.id), 1, `${why} | ${run.id} is no row's run`);
    assert.ok(run.messages.length <= 1, `${why} | ${run.id} was reviewed ${run.messages.length} times`);
  }
  assert.ok([...byKey.values()].every((c) => c === 1), `${why} | a row ran twice`);
}

const headOf = (all) => all.find(({ key }) => HEAD_KEY.test(key))?.value;
const rowsOfOnly = (b) => [b.status, b.stopped, ...b.rows.map((r) => [r.state, r.answer, r.right ?? null, r.reviewed ?? null, r.total_usd ?? null])];
const TWO = () => asked({ rows: [{ q: "q1", a: "A" }, { q: "q2", a: "B" }], max_cost_usd: 50 });

/** One fault, then a server that starts again on the same store and runs whatever it finds running to its end. */
async function scenario({ reviewTurn, unknown = [], crashAt = Infinity, errorAt = Infinity, errorAfter = false, cancelAt = Infinity }) {
  const host = lifeHost({ reviewTurn, unknown });
  const p = faults(host);
  Object.assign(p.s, { crashAt, errorAt, errorAfter, cancelAt });
  const first = new LearningBatches(p.bound());
  let id = null;
  let cancelling = null;
  p.s.onCancel = () => { if (id) cancelling = first.cancel("a1", id).catch((error) => ({ error })); };
  const making = first.create("a1", TWO()).then((b) => (id = b.id), () => null);
  await Promise.race([p.s.died, (async () => {
    await making;
    if (id) await first.idle(id);
    if (cancelling) await cancelling;
  })()]);
  // The faults are the first process's: the one that starts again meets none.
  Object.assign(p.s, { onCancel: null, errorAt: Infinity, crashAt: Infinity });
  const answered = cancelling && p.s.epoch === 0 ? await cancelling : null;
  const second = new LearningBatches(p.bound());
  await second.resume();
  for (const { key, value } of await host.settings.all()) if (HEAD_KEY.test(key)) await second.idle(value.id);
  return { host, second, answered, s: p.s };
}

test("the batch and its rows are one machine: a crash, a failed call or a cancel at any step, then a restart, ends in a legal state (every batch listed and ended, no run left running or unowned, nothing counted done that is not, the header its rows' fold)", { timeout: 600_000 }, async () => {
  let cases = 0;
  // Every case runs; what is not legal is collected (the first of each kind kept), so a red names every gap at once.
  const gaps = new Map();
  const check = async (fn) => {
    try { await fn(); } catch (error) {
      const kind = String(error.message).replace(/^.*? \| /s, "").replace(/lb_[0-9a-f]+|run-\d+|row \d+|\d+ review\(s\)/g, "#").slice(0, 120);
      if (!gaps.has(kind)) gaps.set(kind, String(error.message).slice(0, 400));
    }
  };
  // Each kind of row ending: the review's turn completed, failed or was cancelled; and the last row's cost not known.
  for (const [reviewTurn, unknown] of [["completed", []], ["failed", []], ["cancelled", []], ["completed", ["run-2"]]]) {
    const clean = await scenario({ reviewTurn, unknown });
    await check(() => legal(clean.host, clean.second, `${reviewTurn}, no fault`));
    const { effects, calls } = clean.s;
    assert.ok(effects >= 10 && calls > effects, `steps in a two-row batch: ${effects} effects, ${calls} calls`);
    const done = await clean.second.read("a1", headOf(await clean.host.settings.all()).id);
    await check(async () => {
      assert.deepEqual(done.rows.map((r) => r.state), reviewTurn === "completed" ? ["done", "done"] : ["failed", "failed"], `${reviewTurn}, no fault | a row whose review's turn did not complete is failed, never done`);
      if (unknown.length) assert.deepEqual([done.status, done.stopped], ["stopped", "cost_unknown"], `${reviewTurn}, last cost unknown | the batch stops cost_unknown`);
      if (reviewTurn !== "completed") assert.match(done.rows[0].error ?? "", /review/);
    });
    for (let at = 1; at <= effects; at++) {
      for (const fault of [{ crashAt: at }, { cancelAt: at }, { cancelAt: at, crashAt: at + 1 }]) {
        const why = `${reviewTurn}${unknown.length ? " (last cost unknown)" : ""}, ${JSON.stringify(fault)} of ${effects} effects`;
        const run = await scenario({ reviewTurn, unknown, ...fault });
        await check(() => legal(run.host, run.second, why));
        // A crash alone loses nothing: the next start runs a batch that was made to its end, as if none had come.
        const made = headOf(await run.host.settings.all());
        if (!fault.cancelAt && made) await check(async () => assert.deepEqual(rowsOfOnly(await run.second.read("a1", made.id)), rowsOfOnly(done), `${why} | a crash changed how the batch ended`));
        if (run.answered && !run.answered.error) {
          await check(async () => {
            const end = await run.second.read("a1", run.answered.id);
            assert.equal(end.status, run.answered.status, `${why} | the status a cancel answered is the batch's for good`);
            assert.notEqual(run.answered.status, "running", `${why} | a cancel answers once the batch has ended`);
          });
        }
        cases++;
      }
    }
    for (let at = 1; at <= calls; at++) {
      for (const errorAfter of [false, true]) {
        const run = await scenario({ reviewTurn, unknown, errorAt: at, errorAfter });
        await check(() => legal(run.host, run.second, `${reviewTurn}${unknown.length ? " (last cost unknown)" : ""}, call ${at} of ${calls} fails ${errorAfter ? "after" : "before"} its effect`));
        cases++;
      }
    }
  }
  assert.deepEqual([...gaps.values()], [], `of ${cases} cases`);
  assert.ok(cases > 100, `cases: ${cases}`);
});

test("a loop that keeps failing ends its batch stopped on the error's words, and only once its row's run has stopped and been booked", async () => {
  const host = lifeHost();
  const put = host.settings.put;
  // The store refuses every write of row 1 once it has answered (its `right`), and nothing else.
  host.settings.put = async (k, v) => { if (/\/row\/1$/.test(k) && v.right !== undefined) throw new Error("the store is busy"); return put(k, v); };
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", TWO());
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual([end.status, end.stopped, end.rows[0].state, end.rows[1].state, host.runs.size], ["stopped", null, "failed", "pending", 1]);
  assert.match(end.error, /store is busy/);
  assert.equal(host.runs.get("run-1").status, "completed", "its run had ended: nothing left running");
  assert.equal(end.rows[0].total_usd, 0.1, "and it is booked");
  assert.equal((await batches.list("a1")).batches[0].status, "stopped");
});

test("a review quotes the answer it compares: an answer past 2,000 characters is quoted to there and the review says it was cut and where the whole one is", async () => {
  const long = `${"x".repeat(2_400)} A`;
  const host = fakeHost({ costs: [] });
  const view = host.view;
  host.view = async (id) => ({ ...(await view(id)), answer: host.runs.get(id).messages.length ? "B" : long });
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked({ rows: [{ q: "q1", a: long }], max_cost_usd: 50 }));
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual([end.rows[0].right, end.rows[0].answer.length], [true, 2_000], "compared whole, shown cut");
  const sent = host.runs.get("run-1").messages[0];
  assert.ok(sent === reviewText(long, long), `the review sent is built from the whole answer: ${sent.slice(-200)}`);
  assert.ok(sent.includes(`you answered "${long.slice(0, 2_000)}…" (cut here: your answer runs to 2402 characters, and the whole of it is your last answer in this run)`), sent.slice(-300));
  assert.equal(reviewText("A", "A"), 'Review: the reference answer is "A"; you answered "A".', "a short answer is quoted whole");
});

test("the live cost is the booked one's function: a row in flight adds what its run and its learning have spent so far, grades included", async () => {
  const host = fakeHost({ costs: [] });
  // Row 1's run looks working at $0.10 (its view); its figures, the booked function, count $0.25 with a grade that ended.
  host.view = async () => ({ status: "working", ended_at: null, answer: null, cost_usd: 0.1, learning_state: "graded", error: null });
  host.figures = async () => ({ path: "agent", cost_usd: 0.1, learning_usd: 0.15, total_usd: 0.25, learned: { notes: [], skills: [], workflows: [] }, merged: null, revisions: [] });
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked({ max_cost_usd: 50 }));
  for (let i = 0; i < 200 && host.runs.size < 1; i++) await sleep(5);
  await sleep(20);
  const mid = await batches.read("a1", made.id);
  assert.deepEqual([mid.current, mid.cost_usd], [1, 0.25]);
  await batches.halt();
});

test("a cancel while a row's run is starting stops that run once it has an id, and the row ends failed with it", async () => {
  const cancelled = [];
  const host = fakeHost({ costs: [0.1], cancelled });
  let release;
  const gate = new Promise((r) => (release = r));
  const start = host.start;
  host.start = async (...a) => { await gate; return start(...a); };
  // The run works on until it is stopped.
  const view = host.view;
  host.view = async (id) => (host.runs.get(id).cancelled ? view(id) : { status: "working", ended_at: null, answer: null, cost_usd: 0.05, learning_state: null, error: null });
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked({ max_cost_usd: 50 }));
  await sleep(5);
  const cancelling = batches.cancel("a1", made.id);
  await sleep(5);
  release();
  const end = await cancelling;
  assert.equal(end.status, "cancelled");
  assert.deepEqual(cancelled, ["run-1"], "the run that started is stopped");
  assert.deepEqual([end.rows[0].state, end.rows[0].run_id, end.failed], ["failed", "run-1", 1]);
});

test("a row that ends failed is booked once its run and its grade have stopped: a timed-out run's cost is what it spent to its end", async () => {
  const host = fakeHost({ costs: [] });
  let polls = 0;
  // The first row's run never ends by itself; cancelled, it spends on for a few looks, then ends at $0.30 with its learning settled.
  host.view = async (id) => {
    const r = host.runs.get(id);
    if (id !== "run-1") return { status: "completed", ended_at: `e${r.messages.length}`, answer: "A", cost_usd: 0.1, learning_state: "merged", error: null };
    if (!r.cancelled) return { status: "working", ended_at: null, answer: null, cost_usd: 0.1, learning_state: null, error: null };
    return ++polls < 5 ? { status: "working", ended_at: null, answer: null, cost_usd: 0.2, learning_state: null, error: null } : { status: "cancelled", ended_at: "x", answer: null, cost_usd: 0.3, learning_state: "dropped", error: null };
  };
  host.figures = async (id) => {
    const total = id === "run-1" ? (polls >= 5 ? 0.3 : 0.1) : 0.1;
    return { path: "agent", cost_usd: total, learning_usd: 0, total_usd: total, learned: { notes: [], skills: [], workflows: [] }, merged: null, revisions: [] };
  };
  host.rowTimeoutMs = 20;
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked({ rows: [{ q: "q1", a: "A" }, { q: "q2", a: "A" }], max_cost_usd: 50 }));
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual(end.rows.map((r) => [r.state, r.total_usd]), [["failed", 0.3], ["done", 0.1]]);
  assert.equal(end.spent_usd, 0.4);
});

test("a review that is not sent fails its row: a row is done only when its run was told the reference", async () => {
  const host = fakeHost({ costs: [] });
  host.message = async () => { throw new Error("the store is busy"); };
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked({ rows: [{ q: "q1", a: "A" }], max_cost_usd: 50 }));
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual([end.status, end.finished, end.failed, end.right, end.rows[0].state], ["completed", 1, 1, 0, "failed"]);
  assert.match(end.rows[0].error, /review was not sent/);
});

test("learning turned off while a batch runs stops it before the next row starts: no row runs unlearned", async () => {
  const host = fakeHost({ costs: [] });
  let learns = true;
  host.learning = async () => (learns ? { learns: true } : { learns: false, why: "this server's learning is off (--learning)." });
  const message = host.message;
  host.message = async (...a) => { learns = false; return message(...a); };
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked({ max_cost_usd: 50 }));
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual([end.status, end.stopped, end.finished, host.runs.size], ["stopped", "learning_off", 1, 1]);
  assert.match(end.error, /learning is off/);
});

test("the person's text is kept whole: an effort is one a run takes, a column named __proto__ keeps its cell, and numbers compare by every digit", () => {
  assert.deepEqual(checkBatchBody(body(["a"], { effort: "hgh" })).map((i) => [i.field, i.reason]), [["effort", "not_an_option"]]);
  assert.equal(checkBatchBody(body(["a"], { effort: "high" })).effort, "high");
  const proto = checkBatchBody(JSON.parse('{"inputs":["__proto__","b"],"answer":"a","max_cost_usd":1,"rows":[{"__proto__":"cell","b":"two","a":"x"}]}'));
  assert.ok(!Array.isArray(proto), JSON.stringify(proto));
  assert.equal(contentOf(proto.inputs, proto.rows[0].input), "__proto__: cell\nb: two");
  const single = checkBatchBody(JSON.parse('{"inputs":["__proto__"],"answer":"a","max_cost_usd":1,"rows":[{"__proto__":"cell","a":"x"}]}'));
  assert.equal(contentOf(single.inputs, single.rows[0].input), "cell");
  assert.equal(matches("9007199254740993", "9007199254740992"), false, "past a double's digits");
  assert.equal(matches("1.50", "1.5"), true);
  assert.equal(matches("-0", "0"), true);
  assert.equal(matches("+007", "7"), true);
  assert.equal(matches("0.1000000000000000000001", "0.1"), false);
});

test("a batch's text is read through the learning routes' cut as it is now: an answer, a reference, an error or a lesson's name holding a value saved as a secret after its row finished reads cut on read, list and cancel; a cut that can't be made withholds them all", async () => {
  const SECRET = `batch-secret-${"7f3a".repeat(8)}`;
  const host = fakeHost({ costs: [] });
  let held = [];
  const cuts = [];
  host.shown = async (agentId) => {
    cuts.push(agentId);
    if (held === "unreadable") throw new Error("withheld: the agent's sign-in can't be read here");
    return secretsShown(held);
  };
  const view = host.view;
  host.view = async (id) => ({ ...(await view(id)), answer: host.runs.get(id).messages.length ? "B" : `A ${SECRET}` });
  host.figures = async () => ({ path: "agent", cost_usd: 0.1, learning_usd: 0, total_usd: 0.1, learned: { notes: [`Sign in with ${SECRET}`], skills: [], workflows: [`flow-${SECRET}`] }, merged: "c1", revisions: [{ commit: "c1", workflows: [`flow-${SECRET}`] }] });
  // The second row's review is refused in words that quote the value.
  const message = host.message;
  host.message = async (id, text) => { if (id === "run-2") throw new Error(`the store refused ${SECRET}`); return message(id, text); };
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", oneEach([`A ${SECRET}`, "B"]));
  await batches.idle(made.id);
  // The rows finished while the value was no secret; it is one now.
  held = [SECRET];
  const shownBy = { read: await batches.read("a1", made.id), list: await batches.list("a1"), cancel: await batches.cancel("a1", made.id) };
  for (const [route, got] of Object.entries(shownBy)) {
    const text = JSON.stringify(got);
    assert.ok(!text.includes(SECRET), `${route} shows the secret: ${text.slice(0, 600)}`);
    assert.ok(text.includes("[redacted]"), `${route}: ${text.slice(0, 600)}`);
  }
  const row = shownBy.read.rows[0];
  assert.deepEqual([row.right, row.state, shownBy.read.rows[1].state], [true, "done", "failed"], "compared whole, as saved: only what is shown is cut");
  assert.match(shownBy.read.rows[1].error, /review was not sent/);
  assert.ok(cuts.length >= 3 && cuts.every((agentId) => agentId === "a1"), "each read asks the agent's own cut");
  held = "unreadable";
  for (const read of [() => batches.read("a1", made.id), () => batches.list("a1"), () => batches.cancel("a1", made.id)]) await assert.rejects(read, /withheld/);
});

test("a row's path is its job's, read before its review: a run a learned workflow answered alone stays `workflow` after its review's turn, done or failed", async () => {
  // The path as the server measures it: `workflow` for the job alone, `handed_back` once the review's message is in the run.
  const host = fakeHost({ costs: [] });
  host.figures = async (id) => ({ path: host.runs.get(id).messages.length ? "handed_back" : "workflow", cost_usd: 0.1, learning_usd: 0, total_usd: 0.1, learned: { notes: [], skills: [], workflows: [] }, merged: null, revisions: [] });
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", oneEach(["A", "A"]));
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual(end.rows.map((r) => [r.state, r.path]), [["done", "workflow"], ["done", "workflow"]]);
  assert.deepEqual(end.paths, { agent: 0, handed_back: 0, workflow: 2 });
  // A review's turn that fails: the row is failed, its path still its job's.
  const life = lifeHost({ reviewTurn: "failed" });
  const figures = life.figures;
  life.figures = async (id) => ({ ...(await figures(id)), path: life.runs.get(id).turn === 1 ? "workflow" : "handed_back" });
  const second = new LearningBatches(life);
  const failed = await second.create("a1", TWO());
  await second.idle(failed.id);
  const after = await second.read("a1", failed.id);
  assert.deepEqual(after.rows.map((r) => [r.state, r.path]), [["failed", "workflow"], ["failed", "workflow"]]);
});

test("every round's merge is a revision of its own: a row whose job and review each merged workflows counts two, in order, each with its commit and its workflows; a round dropped leaves the other's commit", async () => {
  const { figuresOf } = await import("../dist/learning-batch.js");
  const cost = { path: "agent", cost_usd: 0.1, learning_usd: 0.02, total_usd: 0.12 };
  const flows = (...names) => names.map((name) => ({ file: `workflows/${name}/workflow.json`, name }));
  const both = figuresOf(cost, [{ merged: "c1", learned: [{ name: "n1" }], workflows: flows("lookup") }, { merged: "c2", learned: [], workflows: flows("lookup", "check") }]);
  assert.deepEqual(both.revisions, [{ commit: "c1", workflows: ["lookup"] }, { commit: "c2", workflows: ["lookup", "check"] }]);
  assert.deepEqual([both.merged, both.learned.workflows, both.learned.notes], ["c2", ["lookup", "check"], ["n1"]]);
  const dropped = figuresOf(cost, [{ merged: "c3", workflows: flows("verify") }, { state: "dropped" }]);
  assert.deepEqual([dropped.revisions, dropped.merged], [[{ commit: "c3", workflows: ["verify"] }], "c3"], "the review's round dropped: the job's merge keeps its commit");
  assert.deepEqual(figuresOf(cost, [null]).revisions, [], "a run that kept no learning made no revision");
  // The batch keeps every row's every revision, in row order.
  const host = fakeHost({ costs: [] });
  host.figures = async (id) => ({ ...(id === "run-1" ? both : dropped), cost_usd: 0.1, total_usd: 0.1 });
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", oneEach(["A", "A"]));
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual(end.revisions, [{ row: 1, commit: "c1", workflows: ["lookup"] }, { row: 1, commit: "c2", workflows: ["lookup", "check"] }, { row: 2, commit: "c3", workflows: ["verify"] }]);
  assert.deepEqual(end.lessons.workflows, ["lookup", "check", "verify"]);
});
