// A stopped run takes a follow-up: a fresh turn on its history. Its timeline shows the person's message as theirs, never as
// a steer into the turn the stop cut. A stop sent while the run still reads queued stops it as a working run. (A cancelled
// run takes none: continue.test.mjs and runs.test.mjs.)
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { follow, scratch, serve, startRun, withEnv } from "./support.mjs";

const GATED_START = new URL("./fixtures/faux-gated-start.mjs", import.meta.url).pathname;

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

test("a stop sent while the run still reads queued stops its turn once the run comes up: stopped, input_required, and a follow-up continues it", { timeout: 240_000 }, async (t) => {
  // The run's process cannot come up while the gate's file is missing, so the run reads queued (state working) for as
  // long as the test holds it, whatever the machine's load: its first message is not sent until the process serves.
  const gate = join(await scratch(t), "start");
  withEnv(t, { START_GATE: gate });
  const { api } = await serve(t, { faux: GATED_START });
  // Its first request answers only after a minute: the turn still runs when the stop reaches it.
  const { run_id, status } = await startRun(api, "slow", "Take your time.");
  assert.equal(status, "queued");
  const before = (await api("GET", `/runs/${run_id}`)).body;
  assert.deepEqual([before.status, before.state], ["queued", "working"], "the stop is sent while the run reads queued");
  let answered;
  const stopping = api("POST", `/runs/${run_id}/stop`).then((res) => (answered = res));
  // Held by the gate, the run cannot leave queued, so the stop cannot be done yet: it waits for the run's first message.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const held = (await api("GET", `/runs/${run_id}`)).body;
  assert.deepEqual([held.status, held.state, answered?.body], ["queued", "working", undefined], `the stop waits while the run reads queued: ${JSON.stringify(answered?.body)}`);
  await writeFile(gate, "");
  const stop = await stopping;
  assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
  assert.deepEqual([stop.body.status, stop.body.state], ["input_required", "idle"], JSON.stringify(stop.body));
  await follow(api, run_id, ["input_required"], { deadlineMs: 60_000 });
  // The stop held, its mark at the first message: a follow-up starts a fresh turn and the run completes.
  const sent = await api("POST", `/runs/${run_id}/messages`, { content: "Go on." });
  assert.equal(sent.body.mode, "follow_up", JSON.stringify(sent.body));
  const { rows, last } = await follow(api, run_id, ["completed"], { deadlineMs: 120_000 });
  assert.equal(last.final, true);
  assert.deepEqual(rows.filter((row) => row.kind === "user_message").map((row) => row.summary), ["You: Take your time.", "You: Go on."]);
});
