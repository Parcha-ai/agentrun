// A stop holds across a restart of a run whose conversation has been compacted: the next server reads the run from a
// snapshot that holds the summary in place of the older messages, and the run still reads stopped until the person
// sends another message.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, follow, scratch } from "./support.mjs";

const FIXTURE = new URL("./fixtures/faux-compact-slow.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateOf = async (api, runId) => {
  const { body } = await api("GET", `/runs/${runId}`);
  return [body.status, body.state];
};

test("a run stopped after its conversation compacted is still stopped after a restart, and a follow-up then completes it", { timeout: 180_000 }, async (t) => {
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: FIXTURE, drainTimeout: "5s" });
  let firstOpen = true;
  t.after(() => firstOpen && first.close());
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", agent("long"))).status, 201);
  const long = (n) => `Message ${n}. ${"word ".repeat(3_990)}`;
  const { body: run } = await api("POST", "/agents/long/runs", { input: { content: long(1) } });
  await follow(api, run.run_id, ["completed"]);
  for (let n = 2; n <= 6; n++) {
    assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: long(n) })).status, 202);
    await follow(api, run.run_id, ["completed"]);
  }
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "Take your time." })).status, 202);
  // Its message shown, so the stop is the turn's and not one refused while the message is still on its way.
  const shown = async () => (await api("GET", `/runs/${run.run_id}/timeline`)).body.rows.some((r) => r.kind === "user_message" && r.text === "Take your time.");
  for (let i = 0; !(await shown()) || (await stateOf(api, run.run_id)).join() !== "working,working"; i++) {
    assert.ok(i < 400, "the held turn works");
    await sleep(50);
  }
  assert.equal((await api("POST", `/runs/${run.run_id}/stop`)).body.stopped, true);
  await follow(api, run.run_id, ["input_required"]);
  await first.close();
  firstOpen = false;

  const second = await startServe({ data, port: 0, faux: FIXTURE, drainTimeout: "5s" });
  t.after(() => second.close());
  const next = client(second.baseUrl, second.token);
  for (let i = 0; (await stateOf(next, run.run_id))[0] === "queued"; i++) {
    assert.ok(i < 400, "the run's rows arrive");
    await sleep(50);
  }
  assert.deepEqual(await stateOf(next, run.run_id), ["input_required", "idle"], "still stopped after the restart");
  const { rows } = (await next("GET", `/runs/${run.run_id}/timeline`)).body;
  assert.ok(rows.some((r) => r.kind === "phase" && /Summarized/.test(r.summary ?? "")), "the run compacted");
  const reply = await next("POST", `/runs/${run.run_id}/messages`, { content: "Go on." });
  assert.equal(reply.body.mode, "follow_up");
  await follow(next, run.run_id, ["completed"]);
  assert.equal((await next("GET", `/runs/${run.run_id}`)).body.result.final_answer, "Noted.");
});
