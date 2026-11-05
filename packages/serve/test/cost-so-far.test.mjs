// A run whose cost isn't fully known (a stop, a cancel, a crash cut a request or a paid tool call) says what it cost so far
// and how many charges have no price (costsofar/1): `cost.usd` stays null, `so_far_usd` is the sum of the charges whose
// cost is known, `unpriced` how many have none, on the run, its timeline's usage row and its list row (read back from the
// run's meta once the server no longer holds the run). No ceiling is claimed. A run whose every cost is known has neither.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { metersIn } from "../dist/cap.js";
import { startServe } from "../dist/index.js";
import { agent, client, follow, scratch, serve, withEnv } from "./support.mjs";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";

const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const usageRow = async (api, runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows.findLast((r) => r.kind === "usage")?.usage;
const round = (usd) => Math.round(usd * 1e6) / 1e6;

/** Waits for `check`, up to `ms`. */
async function until(what, check, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < end, what);
}

/** A pi run whose first turn completes at a known cost, then whose follow-up ("Take your time.") is in flight. */
async function piFollowUpInFlight(api, id) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const runId = (await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"]);
  const first = (await view(api, runId)).cost.usd;
  assert.ok(typeof first === "number" && first > 0, `the first turn's cost is known: ${first}`);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Take your time." })).status, 202);
  await until("the follow-up is in flight", async () => {
    const { status, state } = await view(api, runId);
    return status === "working" && state === "working";
  });
  // Its request is marked as sent: a cancel before that withdraws it unsent, at no cost, and a stop cuts it either way.
  await until("the follow-up's request is marked", async () => (await usageRow(api, runId))?.requests === 2);
  return { runId, first };
}

test("pi: a follow-up stopped mid-answer reads what the run cost so far and 1 charge with no price, on the run and its usage row; never $0, never the known sum as its cost", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const { runId, first } = await piFollowUpInFlight(api, "stop-pi");
  assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
  await follow(api, runId, ["input_required"]);
  const run = await view(api, runId);
  assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, first, 1], JSON.stringify(run.cost));
  assert.deepEqual(await usageRow(api, runId), { usd: null, requests: 2, so_far_usd: first, unpriced: 1 });
});

test("pi: a run cancelled mid-request reads what it cost so far and 1 charge with no price, on the run, and on its list row from a server started anew", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const options = { data: join(dir, "agents"), port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" };
  const one = await startServe(options);
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  const api = client(one.baseUrl, one.token);
  const { runId, first } = await piFollowUpInFlight(api, "cancel-pi");
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
  await follow(api, runId, ["cancelled"]);
  const run = await view(api, runId);
  assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, first, 1], JSON.stringify(run.cost));
  closed = true;
  await one.close();
  // A server that never held the run reads its list row from the store, and what it cost so far from its meta.
  const two = await startServe(options);
  t.after(() => two.close());
  const listed = (await client(two.baseUrl, two.token)("GET", "/runs?agent=cancel-pi")).body.runs.find((r) => r.run_id === runId);
  assert.deepEqual([listed.cost.usd, listed.cost.so_far_usd, listed.cost.unpriced], [null, first, 1], JSON.stringify(listed.cost));
});

for (const harness of ["claude-agent", "codex"]) {
  /** A run on `harness` whose first request is answered ($0.002) and whose second is admitted and never answered. */
  async function secondOut(api, id, go) {
    assert.equal((await api("POST", "/agents", agent(id, { harness, instructions: `Cut until ${go}.` }))).status, 201);
    const runId = (await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } })).body.run_id;
    await until("the second request is admitted and marked", async () => (await usageRow(api, runId))?.requests === 2);
    return runId;
  }

  test(`${harness}: a turn stopped mid-request, with nothing after, reads $0.002 so far and 1 charge with no price while its process is alive, as a settled read would`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
    const runId = await secondOut(api, `stop-live-${harness}`, join(await scratch(t), "go"));
    assert.equal((await api("POST", `/runs/${runId}/stop`)).body.stopped, true);
    await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
    // The stopped turn is over: the request it cut is no request in flight, though the run's process is still there.
    // Given a moment for the stop's last events to be read; then what the run says, whatever it says.
    for (const end = Date.now() + 15_000; (await view(api, runId)).cost.unpriced !== 1 && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 200));
    const run = await view(api, runId);
    assert.deepEqual([run.status, run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], ["input_required", null, 0.002, 1], JSON.stringify(run.cost));
    assert.deepEqual(await usageRow(api, runId), { usd: null, requests: 2, so_far_usd: 0.002, unpriced: 1 });
  });

  test(`${harness}: a run cancelled mid-request reads $0.002 so far and 1 charge with no price`, { timeout: 120_000 }, async (t) => {
    const { api } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
    const runId = await secondOut(api, `cancel-${harness}`, join(await scratch(t), "go"));
    assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
    await follow(api, runId, ["cancelled"], { deadlineMs: 60_000 });
    const run = await view(api, runId);
    assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, 0.002, 1], JSON.stringify(run.cost));
    assert.deepEqual(await usageRow(api, runId), { usd: null, requests: 2, so_far_usd: 0.002, unpriced: 1 });
  });
}

test("a paid tool call a crash cut is a charge with no price: the run reads its model requests' known cost so far, and 1 not priced", { timeout: 120_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: MONID_KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api, data } = await serve(t, { faux: new URL("./fixtures/faux-priced.mjs", import.meta.url).pathname, fauxMonid: new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("monid-cut", { tools: ["monid.run"], tool_settings: { "monid.run": { permission: "allow" } } }))).status, 201);
  const { body } = await api("POST", "/agents/monid-cut/runs", { input: { content: "Run monid's /slow." } });
  await until("the monid call is sent", () => existsSync(log) && readFileSync(log, "utf8").includes('"path":"/v1/run"'));
  process.kill(JSON.parse(readFileSync(join(data, "runs", body.run_id, "run.json"), "utf8")).holder.pid, "SIGKILL");
  await follow(api, body.run_id, ["completed"], { deadlineMs: 90_000 });
  const run = await view(api, body.run_id);
  const { tokens } = metersIn(join(data, "runs", body.run_id, "store", "run.sqlite"));
  assert.ok(tokens > 0, `the model requests are priced: ${tokens}`);
  assert.deepEqual([run.cost.usd, run.cost.so_far_usd, run.cost.unpriced], [null, round(tokens), 1], JSON.stringify(run.cost));
});

test("a run whose every cost is known has neither field, on the run and its usage row", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  assert.equal((await api("POST", "/agents", agent("known"))).status, 201);
  const runId = (await api("POST", "/agents/known/runs", { input: { content: "hi" } })).body.run_id;
  await follow(api, runId, ["completed"]);
  const { cost } = await view(api, runId);
  assert.ok(typeof cost.usd === "number" && !("so_far_usd" in cost) && !("unpriced" in cost), JSON.stringify(cost));
  const usage = await usageRow(api, runId);
  assert.ok(!("so_far_usd" in usage) && !("unpriced" in usage), JSON.stringify(usage));
});
