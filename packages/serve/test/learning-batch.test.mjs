// Learn from a CSV (POST /v2/agents/{id}/learning/batches): rows in, the agent run on each in order with learning on, each
// run told the reference answer beside its own, progress kept by the server (a reload reads it; a restart takes it up),
// a cancel, and a cap that is never gone past. The faux model answers "Job answer." and learns the note its instructions plan.
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerValue, BATCH_ROWS_MAX, checkBatchBody, contentOf, LearningBatches, matches, reviewText, RUN_CAP_MIN_USD } from "../dist/learning-batch.js";
import { note } from "./fixtures/faux-learn.mjs";
import { LEARN, learner, made, sleep } from "./learn-support.mjs";
import { follow, serve } from "./support.mjs";

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

test("a reload reads the batch from the server: the same figures mid-run and after, and a server that stops mid-batch and starts again takes it up at its first unfinished row, never running a row twice", { timeout: 300_000 }, async (t) => {
  const first = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50 });
  const id = "csv-reload";
  await made(first.api, learner(id));
  const refs = ["Job answer.", "Job answer.", "x", "Job answer.", "y"];
  const created = await first.api("POST", `/agents/${id}/learning/batches`, body(refs));
  assert.equal(created.status, 202);
  const mid = await until(first.api, id, created.body.id, (b) => b.finished >= 2 && b.status === "running");
  // A second read, as a reloaded page makes, is the same progress.
  const reread = (await first.api("GET", `/agents/${id}/learning/batches/${created.body.id}`)).body;
  assert.ok(reread.finished >= mid.finished && reread.total === 5);
  assert.deepEqual(reread.rows.slice(0, mid.finished).map((r) => r.run_id), mid.rows.slice(0, mid.finished).map((r) => r.run_id));
  const done = mid.rows.filter((r) => r.state === "done").map((r) => r.run_id);
  // The whole start stopped, then a new one on the same data: the batch is still running there.
  await first.stop();
  const second = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50, data: first.data });
  const end = await until(second.api, id, created.body.id, finished);
  assert.equal(end.status, "completed", JSON.stringify(end));
  assert.deepEqual([end.finished, end.right, end.wrong, end.failed], [5, 3, 2, 0]);
  assert.deepEqual(end.rows.filter((r) => done.includes(r.run_id)).map((r) => r.run_id), done, "the rows done before the stop are the same runs");
  const all = (await second.api("GET", `/agents/${id}/runs?limit=50`)).body.runs;
  assert.equal(all.length, 5, "one run a row: none was run twice");
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

test("the cap is never gone past: a row starts only when what is left covers a run's smallest cap and the mean of the rows done, and the batch stops `cap`, its rows done kept", { timeout: 240_000 }, async (t) => {
  const { api } = await serve(t, { learning: "on", faux: LEARN, batchPollMs: 50 });
  const id = "csv-cap";
  await made(api, learner(id));
  // One row first, to know what a row costs here.
  const probe = await api("POST", `/agents/${id}/learning/batches`, body(["Job answer."]));
  const one = await until(api, id, probe.body.id, finished);
  assert.equal(one.status, "completed");
  const row = one.rows[0].total_usd;
  assert.ok(row > 0 && row < 0.02, `a faux row's cost: ${row}`);
  // Room for a second row (a cent and a half a row left after the first), and not for a third.
  const cap = money(RUN_CAP_MIN_USD + row * 1.5);
  const created = await api("POST", `/agents/${id}/learning/batches`, body(Array(6).fill("Job answer."), { max_cost_usd: cap }));
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const end = await until(api, id, created.body.id, finished);
  assert.equal(end.status, "stopped", JSON.stringify(end));
  assert.equal(end.stopped, "cap");
  assert.equal(end.finished, 2, `finished ${end.finished}`);
  assert.ok(end.spent_usd <= cap, `spent ${end.spent_usd} of ${cap}`);
  assert.deepEqual(end.rows.map((r) => r.state), ["done", "done", "pending", "pending", "pending", "pending"], "the rows left never started");
  assert.equal(end.remaining_usd, money(cap - end.spent_usd));
  assert.equal(end.rows[0].reviewed, true);
});

/** A batch host with no server: settings in memory, each run answering at once with a cost the test names. */
function fakeHost({ costs, cancelled = [] }) {
  const settings = new Map();
  const runs = new Map();
  let n = 0;
  return {
    runs,
    settings: {
      get: async (k) => (settings.has(k) ? structuredClone(settings.get(k)) : undefined),
      put: async (k, v) => void settings.set(k, structuredClone(v)),
      all: async () => [...settings].map(([key, value]) => ({ key, value: structuredClone(value), updatedAt: 0 })),
    },
    learning: async () => ({ learns: true }),
    start: async (agentId, b) => {
      const id = `run-${++n}`;
      runs.set(id, { b, cost: n - 1 in costs ? costs[n - 1] : 0.4, messages: [] });
      return id;
    },
    view: async (id) => {
      const r = runs.get(id);
      return { status: "completed", ended_at: `e${r.messages.length}`, answer: "A", cost_usd: r.cost, learning_state: "merged", error: null };
    },
    message: async (id, text) => void runs.get(id).messages.push(text),
    cancel: async (id) => void cancelled.push(id),
    figures: async (id) => ({ path: "agent", cost_usd: runs.get(id).cost === null ? null : runs.get(id).cost, learning_usd: 0, total_usd: runs.get(id).cost, learned: { notes: [], skills: [], workflows: [] }, merged: null }),
    pollMs: 1,
  };
}
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
  assert.ok([...host.runs.values()].every((r) => r.messages.length === 1 && /^Review: the reference answer is "A"; you answered "A"\.$/.test(r.messages[0])));
});

test("a row whose cost is not known stops the batch: a cap is never guessed at", async () => {
  const host = fakeHost({ costs: [0.1, null] });
  const batches = new LearningBatches(host);
  const made = await batches.create("a1", asked({ max_cost_usd: 50 }));
  await batches.idle(made.id);
  const end = await batches.read("a1", made.id);
  assert.deepEqual([end.status, end.stopped, end.finished, end.unknown_cost_rows], ["stopped", "cost_unknown", 2, 1]);
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
