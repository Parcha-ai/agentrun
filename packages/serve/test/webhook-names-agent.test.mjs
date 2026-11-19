// A run's webhook messages name its agent: a run.ended carries its agent's name beside its id, so a receiver need not read
// the agent back. The name differs from the id, so a message that sent the id in the name's place fails. A trigger.failed's
// agent is trigger-engine.test.mjs's (a failed firing end to end waits on a fired run's runner: trigger-support RUN_EXEC).
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, serve, startRun } from "./support.mjs";
import { ofType, PRIVATE_OK, receiver } from "./webhook-support.mjs";

test("a run.ended names its agent: agent_name, the agent's name, beside agent_id", { timeout: 60_000 }, async (t) => {
  const hook = await receiver(t);
  const { api, data, url } = await serve(t, PRIVATE_OK);
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const done = await startRun(api, "answers", "hi", { name: "Answer desk" });
  await follow(api, done.run_id, ["completed"]);
  const [ended] = ofType(await hook.when((got) => ofType(got, "run.ended").length, `the run.ended of run ${done.run_id}`, data), "run.ended");
  assert.deepEqual(JSON.parse(ended.body).data, { run_id: done.run_id, agent_id: "answers", agent_name: "Answer desk", status: "completed", title: "hi", url: `${url}/#/runs/${done.run_id}` });
});
