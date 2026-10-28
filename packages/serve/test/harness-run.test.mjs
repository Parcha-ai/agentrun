// A run on a harness other than pi, on the faux harness: it starts, answers, takes a follow-up after its end and while
// it works, and completes; each paid request is counted once, also when the run's process dies mid-turn and the next
// one resumes the session.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  assert.deepEqual(usageOf(rows), { usd: 0.006, requests: 2 }, "the request before the kill and the one after it, once each");
});

/** How many of the run's store entries are of `kind` (a session's runner record, or the root's request marker). */
function storeCount(data, runId, kind) {
  // The run's process writes the store meanwhile: a read that finds it locked tries again.
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries").all().filter((row) => JSON.parse(String(row.record)).kind === kind).length;
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}

const killRun = async (data, runId) => {
  const { holder } = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  process.kill(holder.pid, "SIGKILL");
};

test("a request whose price is unknown makes the run's cost unknown, never 0", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const runId = await started(api, "unpriced", "Price unknown.");
  const { rows } = await follow(api, runId, ["completed"]);
  assert.deepEqual(usageOf(rows), { usd: null, requests: 1 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, null);
});

test("a request admitted and cut by a crash is booked once, unknown: on resume the cost is unknown and every admitted request counts once", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const go = join(await scratch(t), "go");
  const runId = await started(api, "cut", `Cut until ${go}.`);
  // The first request's entry is written at its tool's end; the second is then admitted and cut.
  for (let i = 0; !(await api("GET", `/runs/${runId}/timeline`)).body.rows.some((r) => r.kind === "tool_result"); i++) {
    assert.ok(i < 300, "the first request's row");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await writeFile(go, "");
  await killRun(data, runId);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answer(api, runId), "After the cut.");
  assert.deepEqual(usageOf(rows), { usd: null, requests: 3 }, "the first, the cut one (unknown), and the one after: once each");
  assert.equal(storeCount(data, runId, "adapter.request"), 3);
});

test("a request booked in the session whose root entry was never written (the process died first) is written on resume, once", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const go = join(await scratch(t), "go");
  const runId = await started(api, "hold", `Hold until ${go}.`);
  await follow(api, runId, ["working"]);
  // The faux answers at once: well within this, the first request is answered and booked in the session, and the turn
  // holds with no next request to write its entry. The run's own store is locked while its process lives.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(usageOf((await api("GET", `/runs/${runId}/timeline`)).body.rows), undefined, "no request on the root yet");
  await writeFile(go, "");
  await killRun(data, runId);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answer(api, runId), "Done holding.");
  assert.deepEqual(usageOf(rows), { usd: 0.006, requests: 2 }, "the request booked before the kill counts, once, from the session's records");
  assert.equal(storeCount(data, runId, "adapter.request"), 2);
});

test("a run opened again whose new opening has a request of unknown price reads cost unknown, never the earlier opening's figure", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { fauxHarness: FAUX_HARNESS });
  const runId = await started(api, "later", "Second turn unpriced.");
  await follow(api, runId, ["completed"]);
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, 0.002);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "and then?" })).status, 202);
  const { rows } = await follow(api, runId, ["completed"]);
  assert.deepEqual(usageOf(rows), { usd: null, requests: 4 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost.usd, null, "unknown, not the first opening's 0.002");
});
