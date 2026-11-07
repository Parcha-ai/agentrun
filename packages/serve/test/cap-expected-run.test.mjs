// Expected-cost admission on another harness (claude-agent, the faux harness standing in for it): the run's requests
// report the cache as Claude Sonnet 5.5 reports a growing conversation (faux-harness.mjs `grown`), priced so
// (faux-sonnet-priced.mjs). A $0.50 cap spends nearly all of itself before the run pauses; a cache miss passes the cap by
// no more than the bound served while it was in flight, booked whole and said on one row; a restart mid-request reads
// the request in flight at the expected figure this process held it at. One server for the file: each test makes its own
// agent and run on it, and kills only that run's own process.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { REQUEST_STARTED } from "@parcha/pi-durable-agent/timeline";
import { grown } from "./fixtures/faux-harness.mjs";
import { agent, follow, letGo, runDir, runRecordOf, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SONNET_PRICED = new URL("./fixtures/faux-sonnet-priced.mjs", import.meta.url).pathname;
/** The faux model's output ceiling, and the least output a request is sent with ($10 a million). */
const CEILING = 16_384;
const FLOOR_USD = 1_024 * 10 / 1e6;
const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;
/** Request k's expected input, by the rule (cap.ts expectedInput): request k-1's prompt read from the cache at $0.20 a
 *  million, its input after the breakpoint and the bytes the body grew by since it at $2.50. */
const expectedInput = (k) => {
  const previous = grown(k - 1);
  return (previous.tokens.cacheRead + previous.tokens.cacheWrite) * 0.2 / 1e6 + (previous.tokens.input + grown(k).inputTokensMax - previous.inputTokensMax) * 2.5 / 1e6;
};
/** Request k's input uncached: its whole bound at the cache write's $2.50. */
const worstInput = (k) => grown(k).inputTokensMax * 2.5 / 1e6;
/** An amount in a row's words: up to the cent above. */
const centsUp = (usd) => `$${(Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2)}`;
const sum = (n) => Array.from({ length: n }, (_, k) => grown(k).usd).reduce((a, b) => a + b, 0);

let server;
const stops = [];
before(async () => {
  server = await serve({ after: (stop) => stops.push(stop) }, { fauxHarness: FAUX_HARNESS, faux: SONNET_PRICED });
});
after(async () => {
  for (const stop of stops.reverse()) await stop();
});

/** The run's store's entries of `kind`, read once its process has let it go. */
function records(runId, kind) {
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(runDir(server.data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === kind);
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}

/** A run of a new claude-agent agent `id` told `instructions`, under `cap`. */
async function started(id, instructions, cap) {
  const { api } = server;
  assert.equal((await api("POST", "/agents", agent(id, { harness: "claude-agent", instructions }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "go" }, max_cost_usd: cap });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("claude-agent: a $0.50 cap on a Sonnet-priced model whose requests read ~90% of their input from the cache spends at least 90% of it before the run pauses at its cap", { timeout: 180_000 }, async () => {
  const { api } = server;
  const runId = await started("grow", "Grow a cached context.", 0.5);
  await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 150_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.pending?.kind, run.cap_mode], ["input_required", "budget", "expected"], JSON.stringify(run.error));
  assert.ok(run.cost.usd >= 0.45, `spent $${run.cost.usd} of the $0.50 cap before it paused`);
  assert.ok(run.cost.usd <= 0.5, `never past it: $${run.cost.usd}`);
});

test("claude-agent: a cache miss passes the cap by no more than the bound served while it was in flight; its real cost is booked, and one row says so", { timeout: 180_000 }, async (t) => {
  const { api } = server;
  const go = join(await scratch(t), "go");
  // Request 25 misses the cache. The cap leaves room for the 25 before it, its expected input and least output, and a
  // fifth of a cent more: its cost uncached passes it.
  const M = 25;
  const cap = sum(M) + expectedInput(M) + FLOOR_USD + 0.002;
  const runId = await started("miss", `Grow a cached context, missing the cache at request ${M} until ${go}.`, cap);
  // While it is in flight: the most it can pass the cap by, served.
  let served = 0;
  for (let i = 0; !(served > 0); i++) {
    assert.ok(i < 1_200, "the request in flight's bound is served on the run's cost");
    await new Promise((resolve) => setTimeout(resolve, 100));
    served = (await api("GET", `/runs/${runId}`)).body.cost?.overshoot_bound_usd ?? 0;
  }
  assert.ok(Math.abs(served - (worstInput(M) - expectedInput(M))) < 1e-6, `served: ${served}`);
  await writeFile(go, "");
  await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 120_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.pending?.kind], ["input_required", "budget"], JSON.stringify(run.error));
  const booked = sum(M) + grown(M, { miss: true }).usd;
  assert.ok(Math.abs(run.cost.usd - booked) < 1e-6, `its real cost booked, never clipped: ${run.cost.usd} vs ${booked}`);
  const over = run.cost.usd - cap;
  assert.ok(over > 0 && over <= served + 1e-6, `over by $${over}, at most $${served}`);
  assert.equal(run.cost.overshoot_bound_usd, 0, "no request in flight: nothing more can pass it");
  const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows.filter((row) => row.id.endsWith(":over_cap"));
  assert.deepEqual(rows.map((row) => row.summary), [`Went ${centsUp(over)} over its cap on a cache miss (at most ${centsUp(served)}).`]);
});

test("claude-agent: a restart mid-request reads the request in flight at the expected figure its process held it at, and the run's spend after it is the same", { timeout: 180_000 }, async (t) => {
  const { api, data } = server;
  const go = join(await scratch(t), "go");
  // Request 1 is held at its expected input and the faux model's whole output ceiling; the cap leaves $0.10 after it,
  // less than request 2's input uncached (a new process has no previous request in hand), so the run pauses there.
  const plain = expectedInput(1) + CEILING * 10 / 1e6;
  const cap = grown(0).usd + plain + 0.1;
  // No wrap-up for request 1: request 0 is priced ($0.053) when request 1 takes the note, so the measured typical and
  // request 1's least read from the cache decide, and $0.279 left is over 3 x $0.053 and over 2 x that least (at most
  // $0.025). Its body carries no note, so it is held at `plain`.
  const held = plain;
  const runId = await started("restart", `Grow a cached context, cut at request 1 until ${go}.`, cap);
  for (let i = 0; usageOf((await api("GET", `/runs/${runId}/timeline`)).body.rows)?.requests !== 2; i++) {
    assert.ok(i < 600, "the second request is admitted and recorded");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(go, "");
  const { holder } = runRecordOf(data, runId);
  assert.ok(Number.isInteger(holder.pid) && holder.pid !== process.pid, JSON.stringify(holder));
  process.kill(holder.pid, "SIGKILL");
  await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 120_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.pending?.kind], ["input_required", "budget"], JSON.stringify(run));
  await letGo(data, runId);
  assert.deepEqual(records(runId, "faux.note").map((r) => r.data.text), [], "request 1 carried no note: at its take $0.279 was left, over 3 x the typical $0.053 ($0.159) and over 2 x the cached least of at most $0.025 ($0.051)");
  const holds = records(runId, "runner.request").map((r) => r.data.heldUsd);
  assert.ok(Math.abs(holds[1] - held) < 1e-9, `the cut request's record holds its expected figure: ${JSON.stringify(holds)} vs ${held}`);
  assert.ok(Math.abs(run.pending.spent_usd - (grown(0).usd + held)) < 1e-6, `after the restart the spend reads the same: ${run.pending.spent_usd}`);
  const start = records(runId, REQUEST_STARTED).find((entry) => entry.data?.request === 2);
  assert.ok(Math.abs(start?.data?.boundUsd - (worstInput(1) - expectedInput(1))) < 1e-9, `its start mark keeps its bound: ${JSON.stringify(start)}`);
  // Nothing is in flight: the cut request was booked by the next process, and the server's reads of the whole store (its
  // settle, a reconnect's snapshot) read each entry once.
  assert.equal(run.cost.overshoot_bound_usd, 0, "paused, nothing in flight");
  // Raised as offered, the run goes on in a new process and ends: still nothing in flight.
  assert.equal((await api("PATCH", `/runs/${runId}`, { max_cost_usd: run.pending.suggested_cap_usd })).status, 200);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 120_000 });
  const ended = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([ended.status, ended.cost.overshoot_bound_usd], ["completed", 0], JSON.stringify(ended.error));
});

test("claude-agent strict (cap_mode \"strict\" on the run): every input priced uncached, as before: the run pauses far short of its cap, serves no bound, and its view says its mode", { timeout: 180_000 }, async () => {
  const { api } = server;
  assert.equal((await api("POST", "/agents", agent("grow-strict", { harness: "claude-agent", instructions: "Grow a cached context." }))).status, 201);
  const started = await api("POST", "/agents/grow-strict/runs", { input: { content: "go" }, max_cost_usd: 0.5, cap_mode: "strict" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 150_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.pending?.kind, run.cap_mode], ["input_required", "budget", "strict"], JSON.stringify(run.error));
  // Today's rule, by hand: the first request whose input uncached ($2.50 a million, a token a byte) and least output do
  // not fit beside what was spent.
  let paid = 0;
  let k = 0;
  while (paid + worstInput(k) + FLOOR_USD <= 0.5 + 1e-12) paid += grown(k++).usd;
  assert.ok(Math.abs(run.cost.usd - paid) < 1e-6, `paused where the worst case says: $${run.cost.usd} vs $${paid} after ${k} requests`);
  assert.equal(run.cost.overshoot_bound_usd, 0);
  assert.equal(run.pending.overshoot_bound_usd, 0, "strict: the refused request has no bound");
});
