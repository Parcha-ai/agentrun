// A run list read while a run's start copies its seed must not take that copy back as a copy "a server went down
// during" (learning-run.ts onLoad): the run being started is held by its start (runs.ts startingRuns), never read from
// disk. The places lane's repro of the console's runs list polling as a run started.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { learningTestHooks } from "../dist/learning.js";
import { agent, follow, runDir, serve } from "./support.mjs";

const SYSTEM = new URL("./fixtures/faux-system.mjs", import.meta.url).pathname;

test("a run list read while a start copies its seed leaves the copy, its pin and its learning alone", { timeout: 120_000 }, async (t) => {
  const loaded = [];
  const { api, data } = await serve(t, { faux: SYSTEM, onRunLoad: (id) => loaded.push(id) });
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) {
    said.push(String(chunk));
    return write.call(this, chunk, ...rest);
  };
  t.after(() => void (process.stderr.write = write));
  assert.equal((await api("POST", "/agents", agent("racing", { learning: true, instructions: "Answer the question." }))).status, 201);
  let listed;
  let pinGone = false;
  learningTestHooks.afterPin = async (dir) => {
    learningTestHooks.afterPin = undefined;
    // The console's run list, as it polls: never awaited here (a fixed server may hold it until the start is done).
    listed = api("GET", "/agents/racing/runs");
    for (let i = 0; i < 75 && !pinGone; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      pinGone = !existsSync(join(dir, "learning.json"));
    }
    t.diagnostic(`run ${basename(dir)}: pin gone while the start still copied: ${pinGone}`);
  };
  t.after(() => void (learningTestHooks.afterPin = undefined));
  const run = await api("POST", "/agents/racing/runs", { input: { content: "hi" } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  assert.equal((await listed)?.status, 200);
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  for (let i = 0; ["seeded", "reflecting", "proposed"].includes((await api("GET", `/runs/${runId}`)).body.learning?.state); i++) {
    assert.ok(i < 600, "the run's learning ends");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const learning = (await api("GET", `/runs/${runId}`)).body.learning;
  t.diagnostic(`learning: ${JSON.stringify(learning)}; loaded: ${JSON.stringify(loaded)}`);
  const stopped = said.filter((line) => line.includes(runId) && /stopped while it copied|no learning pin/.test(line));
  assert.deepEqual(stopped, [], "no copy taken back, and the end-of-run turn finds its pin");
  assert.equal(pinGone, false, "the pin stays while the start copies");
  assert.ok(existsSync(join(runDir(data, runId), "learning.json")), "the run keeps its pin");
  assert.ok(!["seed_failed", "reflect_failed"].includes(learning?.reason), JSON.stringify(learning));
});
