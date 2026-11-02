// A stopped run takes a follow-up: a fresh turn on its history. Its timeline shows the person's message as theirs, never as
// a steer into the turn the stop cut. (A cancelled run takes none: continue.test.mjs and runs.test.mjs.)
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { follow, scratch, serve, startRun } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a follow-up after a stop that cut the turn's next request reads as the person's message, not a steer, and its turn finishes", { timeout: 240_000 }, async (t) => {
  const { api } = await serve(t);
  const signal = join(await scratch(t), "asked");
  const content = `Write a file, then signal ${signal} and wait.`;
  const { run_id } = await startRun(api, "writer", content, { tools: ["write"] });
  // The write's result is in and the next request has left (the faux model made the signal file as it started), and this
  // server reads the run working: its door's events can trail the run's process on a loaded machine, and a stop the
  // server takes before it reads the run working is refused (stopped false).
  for (const end = Date.now() + 60_000; ; await sleep(50)) {
    const { status, state } = (await api("GET", `/runs/${run_id}`)).body;
    if (existsSync(signal) && status === "working" && state === "working") break;
    assert.ok(Date.now() < end, `the request after the write leaves and the run reads working: last ${status}/${state}, signal ${existsSync(signal)}`);
  }
  const stop = await api("POST", `/runs/${run_id}/stop`);
  assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
  await follow(api, run_id, ["input_required"], { deadlineMs: 60_000 });
  const sent = await api("POST", `/runs/${run_id}/messages`, { content: "Go on." });
  assert.equal(sent.body.mode, "follow_up", JSON.stringify(sent.body));
  // Followed to final, as support.mjs's follow does: the run's end is in the agent store, through whatever busy retries the
  // store's other writers cause (the end is written again until it lands).
  const { rows, last } = await follow(api, run_id, ["completed"], { deadlineMs: 120_000 });
  assert.equal(last.final, true);
  assert.deepEqual(rows.filter((row) => row.kind === "user_message").map((row) => row.summary), [`You: ${content}`, "You: Go on."]);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.result.final_answer, "Went on.");
});
