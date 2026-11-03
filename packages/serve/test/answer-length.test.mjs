// A pi follow-up whose answer stops at its length (max output tokens: text, no tool call, stopReason "length") ends the
// turn, and the timeline shows its text as the run's newest answer row (a text_block). The run's final_answer must be that
// text, never the earlier turn's answer: on the server that ran it, and on a server started anew, which reads it back from
// the store. The faux model, no network.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, FAUX, follow, scratch } from "./support.mjs";

const CUT = "The follow-up's answer, cut at its length";

test("a follow-up whose answer stops at its length is the run's final_answer, also on a server started anew", { timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  const options = { data: join(dir, "agents"), port: 0, faux: FAUX, drainTimeout: "5s" };
  const one = await startServe(options);
  let closed = false;
  t.after(() => (closed ? undefined : one.close()));
  let api = client(one.baseUrl, one.token);
  assert.equal((await api("POST", "/agents", agent("cut", { instructions: "Answer in one line." }))).status, 201);
  const { body } = await api("POST", "/agents/cut/runs", { input: { content: "Stop the follow-up at its length." } });
  const runId = body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "On Stop the follow-up at its length.: done.", "the first turn's answer");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Go on." })).status, 202);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  t.diagnostic(`rows ${JSON.stringify(rows.map((r) => [r.kind, r.summary]))}`);
  assert.equal(rows.filter((r) => r.kind === "text_block" || r.kind === "final_answer").at(-1)?.text, CUT, "the newest answer row is the follow-up's");
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, CUT, "the run's answer is the follow-up's, cut at its length");
  closed = true;
  await one.close();
  const two = await startServe(options);
  t.after(() => two.close());
  api = client(two.baseUrl, two.token);
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.status, "completed");
  assert.equal(view.result?.final_answer, CUT, "on a server started anew too");
});
