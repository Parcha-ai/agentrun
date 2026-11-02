// A stopped run takes a follow-up: a fresh turn on its history. Its timeline shows the person's message as theirs, never as
// a steer into the turn the stop cut. (A cancelled run takes none: continue.test.mjs and runs.test.mjs.)
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { follow, scratch, serve, startRun } from "./support.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a follow-up after a stop that cut the turn's next request reads as the person's message, not a steer, and its turn finishes", async (t) => {
  const { api } = await serve(t);
  const signal = join(await scratch(t), "asked");
  const content = `Write a file, then signal ${signal} and wait.`;
  const { run_id } = await startRun(api, "writer", content, { tools: ["write"] });
  // The write's result is in and the next request has left (the faux model made the signal file as it started).
  for (let i = 0; !existsSync(signal); i++) {
    assert.ok(i < 400, "the request after the write leaves");
    await sleep(50);
  }
  const stop = await api("POST", `/runs/${run_id}/stop`);
  assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
  await follow(api, run_id, ["input_required"]);
  const sent = await api("POST", `/runs/${run_id}/messages`, { content: "Go on." });
  assert.equal(sent.body.mode, "follow_up", JSON.stringify(sent.body));
  const { rows } = await follow(api, run_id, ["completed"]);
  assert.deepEqual(rows.filter((row) => row.kind === "user_message").map((row) => row.summary), [`You: ${content}`, "You: Go on."]);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.result.final_answer, "Went on.");
});
