// A run's labels over the v2 API: given at the start (POST /agents/{agent_id}/runs, POST /runs), kept as given, served on
// every read of the run (its 202, GET /runs/{run_id}, each list's summary; {} when none), and matched by GET /runs' and GET
// /agents/{agent_id}/runs' `label=<key>:<value>`, once per request. A labels map out of bounds is 422 under `labels` or
// `labels.<key>`, nothing started; a filter that does not read, or a second one, is 400. A value's length counts Unicode
// characters, not UTF-16 units. A key replayed with other labels is a mismatch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const start = (api, labels, extra = {}) => api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" }, ...(labels !== undefined ? { labels } : {}), ...extra });
const listed = async (api, query) => {
  const { status, body } = await api("GET", `/runs?${query}`);
  assert.equal(status, 200, JSON.stringify(body));
  return body.runs.map((run) => run.run_id).sort();
};

test("a run keeps its labels, served on its start, its read and every list; GET /runs' label keeps the runs holding it", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const a = await start(api, { tenant: "t-1", job: "a" });
  assert.equal(a.status, 202, JSON.stringify(a.body));
  assert.deepEqual(a.body.labels, { job: "a", tenant: "t-1" });
  const b = await start(api, { tenant: "t-1", job: "b" });
  const c = await start(api, { tenant: "t-2", "turn/id": "x:y" });
  const bare = await start(api);
  assert.deepEqual(bare.body.labels, {}, "a run given none reads {}");
  for (const run of [a, b, c, bare]) await follow(api, run.body.run_id, ["completed"]);

  assert.deepEqual((await api("GET", `/runs/${a.body.run_id}`)).body.labels, { job: "a", tenant: "t-1" });
  const all = (await api("GET", "/runs")).body.runs;
  assert.deepEqual(all.find((run) => run.run_id === c.body.run_id).labels, { tenant: "t-2", "turn/id": "x:y" }, "a list's summary carries them");
  assert.deepEqual(all.find((run) => run.run_id === bare.body.run_id).labels, {});

  assert.deepEqual(await listed(api, "label=tenant:t-1"), [a.body.run_id, b.body.run_id].sort());
  assert.deepEqual(await listed(api, `label=${encodeURIComponent("turn/id:x:y")}`), [c.body.run_id], "split at the first colon");
  assert.deepEqual(await listed(api, "label=tenant:t-3"), []);
  assert.deepEqual(await listed(api, "label=tenant:t-1&status=completed&limit=1").then((ids) => ids.length), 1, "with the other filters and a page");
  const { body: mine } = await api("GET", "/agents/calc/runs?label=job:a");
  assert.deepEqual(mine.runs.map((run) => run.run_id), [a.body.run_id], "an agent's runs take the filter too");

  // One label per request: the document declares one string, which every generated client sends once, so a second is
  // refused, never read here and dropped by a client.
  for (const query of ["label=tenant", "label=:t-1", "label=bad%20key:x", "label=tenant:", "label=tenant:t-1&label=job:b", "label=tenant:t-1&label=tenant:t-1"]) {
    const refused = await api("GET", `/runs?${query}`);
    assert.deepEqual([refused.status, refused.body.error?.code], [400, "bad_request"], `${query}: ${JSON.stringify(refused.body)}`);
  }
});

test("labels out of bounds are 422 under labels or labels.<key>, and no run starts", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
  for (const [labels, field, reason] of [
    ["t-1", "labels", "wrong_type"],
    [["a"], "labels", "wrong_type"],
    [many, "labels", "too_many"],
    [{ "bad key": "v" }, "labels.bad key", "bad_format"],
    [{ "-lead": "v" }, "labels.-lead", "bad_format"],
    [{ "a:b": "v" }, "labels.a:b", "bad_format"],
    [{ [`k${"x".repeat(63)}`]: "v" }, `labels.k${"x".repeat(63)}`, "bad_format"],
    [{ tenant: 1 }, "labels.tenant", "wrong_type"],
    [{ tenant: "" }, "labels.tenant", "bad_format"],
    [{ tenant: "x".repeat(257) }, "labels.tenant", "bad_format"],
    [{ tenant: "😀".repeat(257) }, "labels.tenant", "bad_format"],
    [{ tenant: "a\nb" }, "labels.tenant", "bad_format"],
  ]) {
    const refused = await start(api, labels);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.ok(refused.body.error.fields.some((one) => one.field === field && one.reason === reason), `${JSON.stringify(labels).slice(0, 80)}: ${JSON.stringify(refused.body.error.fields)}`);
  }
  // At the bounds: 16 keys of 63 characters, values of 256.
  const most = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${String(i).padStart(2, "0")}${"x".repeat(60)}`, "v".repeat(256)]));
  const ok = await start(api, most);
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.labels, most);
  await follow(api, ok.body.run_id, ["completed"]);
  // A value is counted in Unicode characters: 256 emoji (512 UTF-16 units) are 256 characters, and filter as they are kept.
  const emoji = await start(api, { mood: "😀".repeat(256) });
  assert.equal(emoji.status, 202, JSON.stringify(emoji.body));
  await follow(api, emoji.body.run_id, ["completed"]);
  assert.deepEqual(await listed(api, `label=${encodeURIComponent(`mood:${"😀".repeat(256)}`)}`), [emoji.body.run_id]);
  assert.equal((await api("GET", `/runs?label=${encodeURIComponent(`mood:${"😀".repeat(257)}`)}`)).status, 400);
  assert.deepEqual((await api("GET", "/runs")).body.runs.map((run) => run.run_id).sort(), [ok.body.run_id, emoji.body.run_id].sort(), "no refused create started a run");
});

test("an inline agent's run takes labels; an idempotency key replayed with other labels is a mismatch", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const body = (labels) => ({
    external: { source: "src", kind: "expert", id: "42", version: 1 },
    definition: { name: "Expert 42", instructions: "Answer.", skills: [], tools: [] },
    input: { content: "What is six times seven?" },
    labels,
  });
  const first = await api("POST", "/runs", body({ turn: "t1" }), { "idempotency-key": "turn-1" });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.deepEqual(first.body.labels, { turn: "t1" });
  const again = await api("POST", "/runs", body({ turn: "t1" }), { "idempotency-key": "turn-1" });
  assert.deepEqual([again.status, again.body.run_id], [202, first.body.run_id]);
  const other = await api("POST", "/runs", body({ turn: "t2" }), { "idempotency-key": "turn-1" });
  assert.equal(other.body.error?.code, "idempotency_mismatch", JSON.stringify(other.body));
  await follow(api, first.body.run_id, ["completed"]);
  assert.deepEqual(await listed(api, "label=turn:t1"), [first.body.run_id]);
  const refused = await api("POST", "/runs", body({ "no good": "x" }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.ok(refused.body.error.fields.some((one) => one.field === "labels.no good"), JSON.stringify(refused.body));
});
