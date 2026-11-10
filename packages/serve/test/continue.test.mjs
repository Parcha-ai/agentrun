// A completed run takes a follow-up: the same run opens again and answers. A failed run does not, and neither does an
// archived run or a run of an archived agent: archiving closes it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, serve, startRun, storeRun } from "./support.mjs";

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
  const ofAgent = await startRun(api, "solo", "What is six times seven?");
  await follow(api, ofAgent.run_id, ["completed"]);
  assert.equal((await api("POST", "/agents/solo/archive")).status, 200);
  assert.equal((await api("POST", `/runs/${ofAgent.run_id}/messages`, { content: "x" })).body.error.code, "not_continuable");
  for (const id of [archived.run_id, ofAgent.run_id]) assert.equal(storeRun(data, id).state, "completed", "a refused follow-up opens nothing");
});
