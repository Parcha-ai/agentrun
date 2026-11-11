// Idempotency across a restart (ported from recovery.test.mjs, deleted at the cutover; its run processes and serve.json are
// gone, the rule is the store's now): a create retried under its key after the server went down before it saved the key's
// answer finds the run its first request made (store.runOfOrigin, written in the run's own insert), answers it marked as
// replayed, and refuses another body under the key; one run, never two. A key whose answer was saved replays it after a
// restart too.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, client, scratch, serve } from "./support.mjs";

test("a run create retried after a restart that came before its key's answer was saved answers the run it made: one run, marked replayed; another body under the key is idempotency_mismatch", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data, runner: false });
  assert.equal((await first.api("POST", "/agents", agent("calc"))).status, 201);
  // A directory where the kept keys' file is written first: no save lands, so the restart finds what a kill between the
  // run's insert and the save leaves, a run in the store and no key on disk.
  const partial = join(data, ".idempotency.json.partial");
  await mkdir(partial);
  const body = { input: { content: "Answer soon." } };
  const key = { "idempotency-key": "create-1" };
  const created = await first.api("POST", "/agents/calc/runs", body, key);
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const runId = created.body.run_id;
  await first.close();
  assert.equal(existsSync(join(data, ".idempotency.json")), false, "no key was saved");
  await rm(partial, { recursive: true });
  const next = await serve(t, { data, runner: false });
  const api = client(next.baseUrl, next.token);
  const retried = await api("POST", "/agents/calc/runs", body, key);
  assert.deepEqual([retried.status, retried.headers.get("idempotent-replayed"), retried.body.run_id], [202, "true", runId], JSON.stringify(retried.body));
  const other = await api("POST", "/agents/calc/runs", { input: { content: "Another." } }, key);
  assert.equal(other.body.error?.code, "idempotency_mismatch", JSON.stringify(other.body));
  assert.deepEqual((await api("GET", "/agents/calc/runs")).body.runs.map((run) => run.run_id), [runId], "one run");
});

test("an Idempotency-Key whose answer was saved replays it after a restart, marked, and another body under it is idempotency_mismatch", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await serve(t, { data, runner: false });
  const key = { "idempotency-key": "agent-1" };
  const made = await first.api("POST", "/agents", agent("kept"), key);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  await first.close();
  const next = await serve(t, { data, runner: false });
  const api = client(next.baseUrl, next.token);
  const again = await api("POST", "/agents", agent("kept"), key);
  assert.deepEqual([again.status, again.headers.get("idempotent-replayed"), again.body.agent_id], [201, "true", made.body.agent_id]);
  assert.equal((await api("POST", "/agents", agent("other"), key)).body.error?.code, "idempotency_mismatch");
});
