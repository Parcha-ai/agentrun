// A model request is booked when it leaves, not when its answer starts: one cut before its first content (a stop, a
// crash) still counts, and since what it cost is unknown, so is the run's cost. Never the earlier requests' sum alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;

test("a request stopped before its first content is booked: the run counts it, and its cost reads unknown, never the earlier requests' sum", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  const answered = await follow(api, run.run_id, ["completed"]);
  const before = usageOf(answered.rows);
  assert.equal(before?.requests, 1);
  assert.equal(typeof before?.usd, "number", "the first request is priced");
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "Slowly, please." })).status, 202);
  for (let i = 0; (await api("GET", `/runs/${run.run_id}`)).body.state !== "working"; i++) {
    assert.ok(i < 200, "the follow-up's turn works");
    await sleep(50);
  }
  await sleep(500);
  assert.equal((await api("POST", `/runs/${run.run_id}/stop`)).body.stopped, true);
  const { rows } = await follow(api, run.run_id, ["input_required"]);
  assert.deepEqual(usageOf(rows), { usd: null, requests: 2 }, "the cut request counts, at an unknown cost");
});
