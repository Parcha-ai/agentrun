// A completed run takes a follow-up: the same run opens again on its own store and session, answers, and completes
// again, also after a restart, and under the server's run cap. A failed or cancelled run does not, and neither does an
// archived run or a run of an archived agent: archiving closes it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch, serve, startRun, storeRun } from "./support.mjs";

test("after a restart, a completed run takes a follow-up on the next server and completes again, the same run", { timeout: 60_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  const { run_id } = await startRun(client(one.baseUrl, one.token), "calc", "What is six times seven?");
  await follow(client(one.baseUrl, one.token), run_id, ["completed"]);
  await one.close();
  const two = await startServe({ data, port: 0, faux: FAUX, drainTimeout: "5s" });
  t.after(() => two.close());
  const api = client(two.baseUrl, two.token);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.status, "completed");
  const next = await api("POST", `/runs/${run_id}/messages`, { content: "go on" });
  assert.equal(next.status, 202, JSON.stringify(next.body));
  assert.equal(next.body.mode, "follow_up");
  const { rows } = await follow(api, run_id, ["completed"]);
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["What is six times seven?", "go on"]);
  assert.ok(kinds.lastIndexOf("final_answer") > kinds.lastIndexOf("user_message"), `a new answer after the follow-up: ${kinds.join(", ")}`);
  assert.equal(storeRun(data, run_id).state, "completed");
});

test("a failed or cancelled run takes no follow-up, and archiving closes a completed one: an archived run, or a run of an archived agent, is 409 not_continuable", async (t) => {
  const { api, data } = await serve(t);
  const failed = await startRun(api, "broken", "Fail now.");
  await follow(api, failed.run_id, ["failed"]);
  assert.equal((await api("POST", `/runs/${failed.run_id}/messages`, { content: "x" })).body.error.code, "not_continuable");
  const archived = await startRun(api, "calc", "What is six times seven?");
  await follow(api, archived.run_id, ["completed"]);
  assert.equal((await api("POST", `/runs/${archived.run_id}/archive`)).status, 200);
  const closed = await api("POST", `/runs/${archived.run_id}/messages`, { content: "x" });
  assert.deepEqual([closed.status, closed.body.error.code], [409, "not_continuable"]);
  assert.match(closed.body.error.message, /archived/);
  const ofAgent = await startRun(api, "solo", "What is six times seven?");
  await follow(api, ofAgent.run_id, ["completed"]);
  assert.equal((await api("POST", "/agents/solo/archive")).status, 200);
  assert.equal((await api("POST", `/runs/${ofAgent.run_id}/messages`, { content: "x" })).body.error.code, "not_continuable");
  for (const id of [archived.run_id, ofAgent.run_id]) assert.equal(storeRun(data, id).state, "completed", "a refused follow-up opens nothing");
});

test("a completed run's follow-up takes a place under the run cap: with every place taken it is 429 rate_limited, and the run stays completed", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { maxRuns: 1 });
  const done = await startRun(api, "calc", "What is six times seven?");
  await follow(api, done.run_id, ["completed"]);
  const busy = await startRun(api, "slow", "Take your time.");
  await follow(api, busy.run_id, ["working"]);
  const refused = await api("POST", `/runs/${done.run_id}/messages`, { content: "go on" });
  assert.deepEqual([refused.status, refused.body.error.code], [429, "rate_limited"], JSON.stringify(refused.body));
  assert.equal((await api("GET", `/runs/${done.run_id}`)).body.status, "completed");
  assert.equal(storeRun(data, done.run_id).state, "completed");
  assert.equal((await api("POST", `/runs/${busy.run_id}/cancel`)).status, 202);
  await follow(api, busy.run_id, ["cancelled"]);
  assert.equal((await api("POST", `/runs/${done.run_id}/messages`, { content: "go on" })).status, 202, "a place is free again");
  await follow(api, done.run_id, ["completed"]);
});

test("a follow-up to a completed run and new starts sent together under one place: exactly one gets it, never two", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { maxRuns: 1 });
  const done = await startRun(api, "calc", "What is six times seven?");
  await follow(api, done.run_id, ["completed"]);
  for (const id of ["one", "two", "three"]) assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const answers = await Promise.all([
    api("POST", `/runs/${done.run_id}/messages`, { content: "Take your time." }),
    ...["one", "two", "three"].map((id) => api("POST", `/agents/${id}/runs`, { input: { content: "Take your time." } })),
  ]);
  const statuses = answers.map((a) => a.status);
  assert.equal(statuses.filter((s) => s === 202).length, 1, `one place, one start: ${statuses.join(", ")}`);
  assert.equal(statuses.filter((s) => s === 429).length, 3, statuses.join(", "));
});

test("a follow-up sent while a completed run's end is still being written waits for it, then continues the run", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t, { carryBackRetry: { delaysMs: Array(20).fill(200) } });
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  // Another writer holds the agent store, so the run's carry back waits: it reads completed before its end is written.
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  t.after(() => store.isOpen && store.close());
  store.exec("BEGIN IMMEDIATE");
  for (let i = 0; (await api("GET", `/runs/${run_id}`)).body.status !== "completed"; i++) {
    assert.ok(i < 300, "the run answers");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(storeRun(data, run_id).state, "running", "its end is not written yet");
  const sent = api("POST", `/runs/${run_id}/messages`, { content: "go on" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  store.exec("ROLLBACK");
  store.close();
  const answer = await sent;
  assert.equal(answer.status, 202, JSON.stringify(answer.body));
  assert.equal(answer.body.mode, "follow_up");
  const { rows } = await follow(api, run_id, ["completed"]);
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["What is six times seven?", "go on"]);
});

test("a follow-up to a completed run whose end the store has not taken yet is 503 unavailable, to try again; once the end is written it continues the run", { timeout: 60_000 }, async (t) => {
  // One carry back try, then a try every 2 s: with the store held, the run ends here before its row does.
  const { api, data } = await serve(t, { carryBackRetry: { delaysMs: [50] }, settleRetryMs: 2_000 });
  const { run_id } = await startRun(api, "calc", "What is six times seven?");
  const store = new DatabaseSync(join(data, "store.sqlite"), { timeout: 0 });
  t.after(() => store.isOpen && store.close());
  store.exec("BEGIN IMMEDIATE");
  await follow(api, run_id, ["completed"]);
  store.exec("ROLLBACK");
  store.close();
  assert.equal(storeRun(data, run_id).state, "running", "its end is not in the store yet");
  const early = await api("POST", `/runs/${run_id}/messages`, { content: "go on" });
  assert.deepEqual([early.status, early.body.error?.code, early.body.error?.retryable], [503, "unavailable", true], JSON.stringify(early.body));
  assert.equal(typeof early.body.error.retry_after_ms, "number");
  for (let i = 0; storeRun(data, run_id).state !== "completed"; i++) {
    assert.ok(i < 100, "the end is written on a later try");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const next = await api("POST", `/runs/${run_id}/messages`, { content: "go on" });
  assert.equal(next.status, 202, JSON.stringify(next.body));
  await follow(api, run_id, ["completed"]);
});
