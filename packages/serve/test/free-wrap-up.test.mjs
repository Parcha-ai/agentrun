// The wrap-up before the free-model request limit: a run on a free model (fixtures/faux-loop.mjs, the faux model at its
// $0 listing, looping on a failing tool) is told once, FREE_WRAP_UP_MARGIN requests before its limit, in the model
// request it is about to send, to finish with its answer (the dollar cap's wrap-up note, placed by the same mechanism).
// It never reaches a paid model's request, and the limit (AGENTRUN_FREE_MODEL_REQUESTS) moves it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const FREE_LOOP = new URL("./fixtures/faux-loop.mjs", import.meta.url).pathname;
const PAID_LOOP = new URL("./fixtures/faux-loop-priced.mjs", import.meta.url).pathname;
const ENV = "AGENTRUN_FREE_MODEL_REQUESTS";
/** The words with `left` requests left (kernel cap free.ts). */
const WORDS = (left) => `${left} free-model requests left in this run, this one included: finish now with your answer.`;
/** The text between the tags the proxy places the note in. */
const reminderIn = (text) => /<system-reminder>([\s\S]*?)(?:<\/system-reminder>|$)/.exec(text)?.[1] ?? text;

/** A run of `input` on the faux model `faux`, followed to its end: its view and what each model request was sent. */
async function runOn(t, faux, input, env, body = {}) {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls, ...env }, [ENV]);
  const { api } = await serve(t, { faux });
  assert.equal((await api("POST", "/agents", agent("loop", { instructions: "Look it up." }))).status, 201);
  const started = await api("POST", "/agents/loop/runs", { input: { content: input }, ...body });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 120_000 });
  const view = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const sent = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const rows = (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows.filter((row) => row.kind === "phase" && /free-model requests left/.test(row.summary ?? ""));
  return { view, sent, rows };
}

test("a free model's run is told once, 3 requests before its limit: the request before the limit carries the note, the earlier ones none", { timeout: 240_000 }, async (t) => {
  const { view, sent, rows } = await runOn(t, FREE_LOOP, "Loop 9", { [ENV]: "10" });
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(sent.length, 10, "the run's 10 requests all went");
  // Its 8th request is the first with 3 left (8, 9 and 10): it carries the note; the 7 before it carry none, the 2 after none.
  assert.deepEqual(sent.map((call, i) => (call.note === null ? null : i + 1)).filter((n) => n !== null), [8], "one request carried it, the 8th");
  // The model is told it as the server's note (SERVER_NOTE_LABEL, as every note the server tells it); the server's row,
  // labelled already, says the words after the label.
  assert.equal(reminderIn(sent[7].note).trim(), `AgentRun server note: ${WORDS(3)}`);
  assert.deepEqual(rows.map((row) => row.text), [WORDS(3)], "one row of the server's says so");
});

test("a run that stays well under its limit is told nothing", { timeout: 240_000 }, async (t) => {
  const { view, sent } = await runOn(t, FREE_LOOP, "Loop 3", { [ENV]: "10" });
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(sent.length, 4);
  assert.ok(sent.every((call) => call.note === null), "no request carried a note");
});

test("a paid model in the same loop never gets the free-limit note", { timeout: 240_000 }, async (t) => {
  const { view, sent } = await runOn(t, PAID_LOOP, "Loop 9", { [ENV]: "10" }, { max_cost_usd: 50 });
  assert.equal(view.status, "completed", JSON.stringify(view.error));
  assert.equal(sent.length, 10);
  assert.ok(sent.every((call) => call.note === null), "none carried it");
});
