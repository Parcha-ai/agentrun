// A run on a harness other than pi, on the faux harness: it starts, answers, takes a follow-up after its end and while
// it works, and completes; each paid request is counted once, also when the run's process dies mid-turn and the next
// one resumes the session.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const usageOf = (rows) => rows.findLast((r) => r.kind === "usage")?.usage;
const answer = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer;

async function started(api, id, instructions, harness = "claude-agent") {
  assert.equal((await api("POST", "/agents", agent(id, { harness, instructions }))).status, 201);
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("with a faux harness every harness runs; a claude-agent run answers, takes follow-ups after its end and completes again, each request counted once", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  assert.deepEqual((await api("GET", "/capabilities")).body.harnesses.map((h) => [h.id, h.available]), [["pi", true], ["claude-agent", true], ["codex", true]]);
  const runId = await started(api, "chat", "Answer the question.");
  const first = await follow(api, runId, ["completed"]);
  assert.equal(await answer(api, runId), "Answer 1.");
  assert.deepEqual(usageOf(first.rows), { usd: 0.002, requests: 2 });
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and then?" })).status, 202);
  const second = await follow(api, runId, ["completed"]);
  assert.equal(await answer(api, runId), "Answer 2.");
  assert.deepEqual(usageOf(second.rows), { usd: 0.004, requests: 4 });
  assert.deepEqual(second.rows.filter((r) => r.kind === "user_message").map((r) => r.text), ["hi", "and then?"]);
});

test("one turn of three paid requests costs their sum, once: never twice", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const runId = await started(api, "three", "Make three requests.", "codex");
  const { rows } = await follow(api, runId, ["completed"]);
  assert.deepEqual(usageOf(rows), { usd: 0.007, requests: 3 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, 0.007);
});

test("a run whose process dies mid-turn after a paid request resumes on the next process and finishes; each paid request counted once", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const go = join(await scratch(t), "go");
  const runId = await started(api, "resume", `Wait for ${go} before the answer.`);
  // The first request is paid and its tool has ended: its row is in, then the turn hangs.
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the first request's tool row");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  await writeFile(go, "");
  process.kill(holder.pid, "SIGKILL");
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answer(api, runId), "Done after the wait.");
  assert.deepEqual(usageOf(rows), { usd: 0.007, requests: 3 }, "the request before the kill, and the two after it, once each");
});
