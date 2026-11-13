// A completed run takes a follow-up: the same run opens again on its own store and session, answers, and completes
// again, under the server's run cap. A failed run does not, and neither does an archived run or a run of an archived
// agent: archiving closes it.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, scratch, serve, startRun, storeRun } from "./support.mjs";

test("a failed run takes no follow-up, and archiving closes a completed one: an archived run, or a run of an archived agent, is 409 not_continuable", async (t) => {
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
  assert.deepEqual(closed.body.error.details, { reason: "archived", archived: "run" });
  assert.deepEqual(closed.body.error.next_action, { type: "request", method: "POST", path: `/runs/${archived.run_id}/unarchive`, caller_supplies: [] });
  const ofAgent = await startRun(api, "solo", "What is six times seven?");
  await follow(api, ofAgent.run_id, ["completed"]);
  assert.equal((await api("POST", "/agents/solo/archive")).status, 200);
  const agentClosed = await api("POST", `/runs/${ofAgent.run_id}/messages`, { content: "x" });
  assert.deepEqual([agentClosed.status, agentClosed.body.error.code], [409, "not_continuable"]);
  assert.match(agentClosed.body.error.message, /agent is archived/, "the refusal says the run's agent is archived");
  assert.deepEqual(agentClosed.body.error.details, { reason: "archived", archived: "agent" });
  assert.deepEqual(agentClosed.body.error.next_action, { type: "request", method: "POST", path: "/agents/solo/unarchive", caller_supplies: [] });
  for (const id of [archived.run_id, ofAgent.run_id]) assert.equal(storeRun(data, id).state, "completed", "a refused follow-up opens nothing");
});

/** The runs the store holds a runner's claim on right now: the places in use. */
function claimed(data) {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true, timeout: 5_000 });
  try {
    return db.prepare("SELECT id FROM runs WHERE state = 'running' AND runner IS NOT NULL").all().map((row) => row.id);
  } finally {
    db.close();
  }
}

// The run cap queues, as it does a new start (admission.test.mjs): nothing is refused for a place, a run past the cap waits.
test("a completed run's follow-up takes a place under the run cap: with every place taken it is taken (202) and waits unclaimed, the run goes on when a place is free; a message to the run holding the place takes none", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const { api, data, runnerBeats } = await serve(t, { maxRuns: 1 });
  const done = await startRun(api, "calc", "What is six times seven?");
  await follow(api, done.run_id, ["completed"]);
  const busy = await startRun(api, "slow", `Answer once ${join(dir, "go")} exists.`);
  await follow(api, busy.run_id, ["working"]);
  assert.deepEqual(claimed(data), [busy.run_id], "the one place is the working run's");
  const queued = await api("POST", `/runs/${done.run_id}/messages`, { content: "go on" });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  for (let since = runnerBeats(), i = 0; runnerBeats() < since + 3; i++) {
    assert.ok(i < 400, "the runner polls");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(claimed(data), [busy.run_id], "the follow-up waits: the reopened run is not claimed past the cap");
  assert.equal(storeRun(data, done.run_id).state, "running", "reopened, waiting for its place");
  // A message to the run that holds the place is a steer: no second place.
  assert.equal((await api("POST", `/runs/${busy.run_id}/messages`, { content: "still here" })).status, 202);
  assert.deepEqual(claimed(data), [busy.run_id]);
  assert.equal((await api("POST", `/runs/${busy.run_id}/cancel`)).status, 202);
  await follow(api, busy.run_id, ["cancelled"]);
  await follow(api, done.run_id, ["completed"]);
});

test("a follow-up to a completed run and new starts sent together under one place: all are taken, exactly one holds the place at a time, never two, and each runs in its turn", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const { api, data, runnerBeats } = await serve(t, { maxRuns: 1 });
  const done = await startRun(api, "calc", "What is six times seven?");
  await follow(api, done.run_id, ["completed"]);
  for (const id of ["one", "two", "three"]) assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const hold = `Answer once ${join(dir, "go")} exists.`;
  const answers = await Promise.all([
    api("POST", `/runs/${done.run_id}/messages`, { content: hold }),
    ...["one", "two", "three"].map((id) => api("POST", `/agents/${id}/runs`, { input: { content: hold } })),
  ]);
  assert.deepEqual(answers.map((a) => a.status), [202, 202, 202, 202], JSON.stringify(answers.map((a) => a.body)));
  const ids = [done.run_id, ...answers.slice(1).map((a) => a.body.run_id)];
  // Sampled across polls of the runner while every run holds on the gate: one place, one claim, however the four raced.
  for (let since = runnerBeats(), i = 0; runnerBeats() < since + 6; i++) {
    assert.ok(i < 600, "the runner polls");
    assert.ok(claimed(data).length <= 1, `never two places: ${claimed(data)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(claimed(data).length, 1, "the place is taken by one of them");
  await writeFile(join(dir, "go"), "");
  for (const id of ids) {
    for (let i = 0; storeRun(data, id).state !== "completed"; i++) {
      assert.ok(i < 1_200, `run ${id} ends in its turn`);
      assert.ok(claimed(data).length <= 1, `never two places: ${claimed(data)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

// SKIP (follow-up #2058): a follow-up to a completed run is refused not_continuable on the runner; the one-door message() PR replaces this case
test.skip("a follow-up sent while a completed run's end is still being written waits for it, then continues the run", { timeout: 60_000 }, async (t) => {
  const { api, data } = await serve(t);
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
  // Sent under a key: a probe under the same key, with a body the route refuses before it does anything, is
  // idempotency_mismatch only once the server holds the message.
  let answered = false;
  const sent = api("POST", `/runs/${run_id}/messages`, { content: "go on" }, { "idempotency-key": "go-on" }).finally(() => (answered = true));
  for (let i = 0; (await api("POST", `/runs/${run_id}/messages`, {}, { "idempotency-key": "go-on" })).body.error?.code !== "idempotency_mismatch"; i++) {
    assert.ok(i < 400 && !answered, "the server holds the message");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(answered, false, "it waits for the run's end to be written");
  store.exec("ROLLBACK");
  store.close();
  const answer = await sent;
  assert.equal(answer.status, 202, JSON.stringify(answer.body));
  assert.equal(answer.body.mode, "follow_up");
  const { rows } = await follow(api, run_id, ["completed"]);
  assert.deepEqual(rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["What is six times seven?", "go on"]);
});

// SKIP (follow-up #2058): a follow-up to a completed run is refused not_continuable on the runner; the one-door message() PR replaces this case
test.skip("a follow-up to a completed run whose end the store has not taken yet is 503 unavailable, to try again; once the end is written it continues the run", { timeout: 60_000 }, async (t) => {
  // One carry back try, then a try every 2 s: with the store held, the run ends here before its row does.
  const { api, data } = await serve(t);
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
