// A run whose cost no one knows because requests were cut (a crash) or stopped before their end (a drain, a stop), with or
// without a spend cap: each request carries its worst case to its marks, so its cost reads `usd: null`, never $0, and
// `at_most_usd`, the known costs plus those worst cases, on the run, its timeline's usage row and its timeline page. The
// amount is the one a cap counts (spentIn), rounded as the cost is. A model with no price gets no figure, and no bound
// (cap-measure.test).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { spentIn } from "../dist/cap.js";
import { agent, follow, serve } from "./support.mjs";

const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const SIGNAL = new URL("./fixtures/faux-signal.mjs", import.meta.url).pathname;
/** One request's worst case on the faux models: 16,384 output tokens at $100 a million. */
const FAUX_WORST = 16_384 * 100 / 1e6;
const round = (usd) => Math.round(usd * 1e6) / 1e6;
const storeFileOf = (data, runId) => join(data, "runs", runId, "store", "run.sqlite");
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const finished = async (api, runId) => (await follow(api, runId, ["completed", "failed", "cancelled"]), view(api, runId));

/** Waits for `check`, up to `ms`. */
async function until(what, check, ms = 30_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 50))) assert.ok(Date.now() < end, what);
}

/** A run of a new agent `id` asked `content` (under a cap of `cap`, unless it is undefined), once its first request is in flight. */
async function inFlight(api, id, content, cap) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content }, ...(cap === undefined ? {} : { max_cost_usd: cap }) })).body;
  await until("the run starts working", async () => {
    const { status, state } = await view(api, run_id);
    return status === "working" && state === "working";
  });
  return run_id;
}

/** A run whose turn is stopped while its first request is in flight, then asked to go on, to its end. */
async function stoppedThenDone(api, id, cap) {
  const runId = await inFlight(api, id, "Take your time.", cap);
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "go on" })).body.mode, "follow_up");
  return { runId, run: await finished(api, runId) };
}

/** The usage row of the run's whole timeline, and its timeline page's cost. */
async function timelineCost(api, runId) {
  const page = (await api("GET", `/runs/${runId}/timeline`)).body;
  return { usage: page.rows.findLast((row) => row.kind === "usage")?.usage, cost: page.cost };
}

test("a capped pi run stopped mid-answer reads its cost unknown, at most the known cost plus the worst case held for the stopped request", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  const { runId, run } = await stoppedThenDone(api, "stopped", 10);
  assert.deepEqual([run.status, run.result.final_answer], ["completed", "On go on: done."]);
  const spent = spentIn(storeFileOf(data, runId));
  assert.ok(spent >= FAUX_WORST && spent < FAUX_WORST * 1.5, `the cap counts the stopped request at its held worst case: $${spent}`);
  assert.deepEqual([run.cost.usd, run.cost.at_most_usd], [null, round(spent)], JSON.stringify(run.cost));
  const { usage, cost } = await timelineCost(api, runId);
  assert.deepEqual([usage.usd, usage.at_most_usd, cost.usd, cost.at_most_usd], [null, round(spent), null, round(spent)]);
  // The list, and /stats over every run and under its analytics filter, say it too: a run of unknown cost with a bound.
  const listed = (await api("GET", "/runs")).body.runs.find((r) => r.run_id === runId);
  assert.deepEqual([listed.cost.usd, listed.cost.at_most_usd], [null, round(spent)], JSON.stringify(listed.cost));
  const stats = (await api("GET", "/stats")).body;
  assert.deepEqual(stats.cost.bounded_unknown, { runs: 1, at_most_usd: round(spent) });
  assert.deepEqual((await api("GET", "/stats?agent=stopped")).body.analytics.totals.bounded_unknown, { runs: 1, at_most_usd: round(spent) });
  assert.deepEqual((await api("GET", "/stats?agent=nobody")).body.analytics.totals.bounded_unknown, { runs: 0, at_most_usd: null });
});

test("a capped pi run whose process is killed mid-request reads its cost unknown, at most the known cost plus the worst case held for the cut request", { timeout: 120_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cost-bound-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [signal, go] = [join(dir, "signal"), join(dir, "go")];
  const { api, data } = await serve(t, { faux: SIGNAL });
  assert.equal((await api("POST", "/agents", agent("crashed"))).status, 201);
  const runId = (await api("POST", "/agents/crashed/runs", { input: { content: `Signal ${signal}, then answer once ${go} exists.` }, max_cost_usd: 10 })).body.run_id;
  await until("the first request is in flight", () => existsSync(signal));
  const pid = Number(readFileSync(signal, "utf8"));
  rmSync(signal);
  process.kill(pid, "SIGKILL");
  // The next process reads the cut request from the store and sends the turn's request again.
  await until("the request is sent again", async () => existsSync(signal) || ["failed", "cancelled"].includes((await view(api, runId)).status));
  writeFileSync(go, "");
  const run = await finished(api, runId);
  assert.deepEqual([run.status, run.result?.final_answer], ["completed", "Answered after the crash."], JSON.stringify(run.error));
  const spent = spentIn(storeFileOf(data, runId));
  assert.ok(spent >= FAUX_WORST && spent < FAUX_WORST * 1.5, `the cap counts the cut request at its held worst case: $${spent}`);
  assert.deepEqual([run.cost.usd, run.cost.at_most_usd], [null, round(spent)], JSON.stringify(run.cost));
  const { usage } = await timelineCost(api, runId);
  assert.deepEqual([usage.usd, usage.at_most_usd], [null, round(spent)]);
});

test("a pi run with no cap stopped mid-answer, then followed up to its end, reads its cost unknown, at most the known cost plus the stopped request's worst case", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  const { runId, run } = await stoppedThenDone(api, "uncapped");
  assert.deepEqual([run.status, run.result.final_answer, run.cost.cap_usd], ["completed", "On go on: done.", null], "no cap; the follow-up completes");
  // With no cap each request still carries its worst case to its marks: the cap's own reading of them is the bound.
  const spent = spentIn(storeFileOf(data, runId));
  assert.ok(spent >= FAUX_WORST && spent < FAUX_WORST * 1.5, `the stopped request at its worst case, and the answer since: $${spent}`);
  assert.deepEqual([run.cost.usd, run.cost.at_most_usd], [null, round(spent)], "the stopped request is still unknown after the follow-up");
  const { usage } = await timelineCost(api, runId);
  assert.deepEqual([usage.usd, usage.at_most_usd], [null, round(spent)]);
});

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;

/** The root's start marks of a run, once its process has let it go. */
function startMarks(data, runId) {
  const db = new DatabaseSync(storeFileOf(data, runId), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === "agentrun.request_started");
  } finally {
    db.close();
  }
}

/** A run on `harness` (under `cap`, unless it is undefined) whose second request is cut by a SIGKILL of its own process, as
 *  harness-cap.test cuts one: the faux harness answers the first request ($0.002), holds the second until `go` exists, and
 *  answers the turn's next request ($0.004). Its end. */
async function harnessCutByCrash(t, harness, cap) {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
  const go = join(mkdtempSync(join(tmpdir(), "cost-bound-go-")), "go");
  t.after(() => rmSync(dirname(go), { recursive: true, force: true }));
  assert.equal((await api("POST", "/agents", agent("cut", { harness, instructions: `Cut until ${go}.` }))).status, 201);
  const run = await api("POST", "/agents/cut/runs", { input: { content: "hi" }, ...(cap === undefined ? {} : { max_cost_usd: cap }) });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await until("the second request is admitted and recorded", async () => (await timelineCost(api, runId)).usage?.requests === 2, 60_000);
  writeFileSync(go, "");
  const { holder } = JSON.parse(readFileSync(join(data, "runs", runId, "run.json"), "utf8"));
  assert.ok(Number.isInteger(holder.pid) && holder.pid !== process.pid, JSON.stringify(holder));
  process.kill(holder.pid, "SIGKILL");
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  return { api, data, runId, run: await view(api, runId) };
}

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a capped run whose request a crash cut reads its cost unknown, at most the known costs plus the worst case held for the cut request`, { timeout: 150_000 }, async (t) => {
    const { api, data, runId, run } = await harnessCutByCrash(t, harness, 10);
    assert.deepEqual([run.status, run.result?.final_answer], ["completed", "After the cut."], JSON.stringify(run.error));
    // Each request's start mark on the run's root carries what the cap held for it, as a pi run's does.
    const held = startMarks(data, runId).map((mark) => mark.data.heldUsd);
    assert.equal(held.length, 3, "the first, the cut one, and the one after it");
    assert.ok(held.every((usd) => Math.abs(usd - FAUX_WORST) < 1e-9), JSON.stringify(held));
    assert.equal(run.cost.usd, null, "the cut request's own price never came in");
    assert.ok(Math.abs(run.cost.at_most_usd - round(0.002 + 0.004 + FAUX_WORST)) < 1e-9, `the known $0.006 and the cut request at $${FAUX_WORST}: ${JSON.stringify(run.cost)}`);
    const { usage } = await timelineCost(api, runId);
    assert.deepEqual([usage.usd, usage.at_most_usd], [null, run.cost.at_most_usd]);
  });

  test(`${harness}: a run with no cap whose request a crash cut reads its cost unknown, at most the known costs plus the cut request's worst case`, { timeout: 150_000 }, async (t) => {
    const { api, data, runId, run } = await harnessCutByCrash(t, harness);
    assert.deepEqual([run.status, run.result?.final_answer, run.cost.cap_usd], ["completed", "After the cut.", null], JSON.stringify(run.error));
    // With no cap each request's start mark still carries its worst case, measured as a cap's guard measures it.
    const held = startMarks(data, runId).map((mark) => mark.data.heldUsd);
    assert.equal(held.length, 3, "the first, the cut one, and the one after it");
    assert.ok(held.every((usd) => Math.abs(usd - FAUX_WORST) < 1e-9), JSON.stringify(held));
    assert.equal(run.cost.usd, null, "the cut request's own price never came in");
    assert.ok(Math.abs(run.cost.at_most_usd - round(0.002 + 0.004 + FAUX_WORST)) < 1e-9, JSON.stringify(run.cost));
    const { usage } = await timelineCost(api, runId);
    assert.deepEqual([usage.usd, usage.at_most_usd], [null, run.cost.at_most_usd]);
  });
}
