// A place waited for is taken only for what may still run: a follow-up to a run archived while it waited, or a start of
// an agent archived while it waited, is refused, and nothing opens.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST `body` to `path` under Idempotency-Key `key`, and return once the server holds it, still unanswered: a probe under
 *  the same key, with a body the route refuses before it does anything, is idempotency_mismatch only once the server has
 *  the request. `answer` is its answer; `pending()` says whether it has come. */
async function held(api, path, body, key) {
  let answered = false;
  const answer = api("POST", path, body, { "idempotency-key": key }).finally(() => (answered = true));
  for (let i = 0; (await api("POST", path, {}, { "idempotency-key": key })).body.error?.code !== "idempotency_mismatch"; i++) {
    assert.ok(i < 400 && !answered, "the server holds the request");
    await sleep(25);
  }
  assert.equal(answered, false, "it waits for a place");
  return { answer, pending: () => !answered };
}

test("a follow-up that waits for a place does not open a run archived while it waited", { timeout: 120_000 }, async (t) => {
  const gate = join(await scratch(t), "exit");
  withEnv(t, { GATE: gate });
  const { api } = await serve(t, { maxRuns: 1, faux: new URL("./fixtures/faux-hold.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("a"))).status, 201);
  const done = await api("POST", "/agents/a/runs", { input: { content: "hi" } });
  assert.equal(done.status, 202, JSON.stringify(done.body));
  await follow(api, done.body.run_id, ["completed"]);
  const failing = await api("POST", "/agents/a/runs", { input: { content: "fail" } });
  assert.equal(failing.status, 202, JSON.stringify(failing.body));
  for (let i = 0; (await api("GET", `/runs/${failing.body.run_id}`)).body.status !== "failed"; i++) {
    assert.ok(i < 400, "the failing run reads failed");
    await sleep(50);
  }
  const message = await held(api, `/runs/${done.body.run_id}/messages`, { content: "one more" }, "one-more");
  const archived = await api("POST", `/runs/${done.body.run_id}/archive`, {});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.ok(message.pending(), "the follow-up still waits once the run is archived");
  await writeFile(gate, "");
  const answer = await message.answer;
  const after = await api("GET", `/runs/${done.body.run_id}`);
  assert.deepEqual([answer.status, answer.body.error?.code], [409, "not_continuable"], `an archived run took a follow-up: ${JSON.stringify(answer.body)}; now ${JSON.stringify(after.body)}`);
  assert.equal(after.body.status, "completed", JSON.stringify(after.body));
});

test("a start that waits for a place does not start a run of an agent archived while it waited", { timeout: 120_000 }, async (t) => {
  const gate = join(await scratch(t), "exit");
  withEnv(t, { GATE: gate });
  const { api } = await serve(t, { maxRuns: 1, faux: new URL("./fixtures/faux-hold.mjs", import.meta.url).pathname });
  assert.equal((await api("POST", "/agents", agent("a"))).status, 201);
  const failing = await api("POST", "/agents/a/runs", { input: { content: "fail" } });
  assert.equal(failing.status, 202, JSON.stringify(failing.body));
  for (let i = 0; (await api("GET", `/runs/${failing.body.run_id}`)).body.status !== "failed"; i++) {
    assert.ok(i < 400, "the failing run reads failed");
    await sleep(50);
  }
  const start = await held(api, "/agents/a/runs", { input: { content: "hi" } }, "start");
  assert.equal((await api("POST", "/agents/a/archive", {})).status, 200);
  assert.ok(start.pending(), "the start still waits once the agent is archived");
  await writeFile(gate, "");
  const answer = await start.answer;
  assert.equal(answer.status, 409, `a run of an archived agent started: ${JSON.stringify(answer.body)}`);
  assert.equal(answer.body.error?.code, "agent_not_runnable");
  const runs = (await api("GET", "/runs?agent=a&archived=true")).body.runs ?? [];
  assert.equal(runs.length, 1, `only the failed run: ${JSON.stringify(runs.map((r) => r.run_id))}`);
});
