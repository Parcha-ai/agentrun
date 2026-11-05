// A cancel means cancel: one that lands while the run's process is still coming up, before its first request, stops the
// run with no request sent and nothing paid.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { RUN_CANCELLED } from "../dist/files.js";
import { cancelledIn } from "../dist/request-start.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const GATED = new URL("./fixtures/faux-gated.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a cancel that lands before the run's process sends anything: no request leaves, the run is cancelled, at $0", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const gate = join(dir, "gate");
  const sent = join(dir, "sent");
  withEnv(t, { FAUX_GATE: gate, FAUX_SENT: sent });
  const { api, data } = await serve(t, { faux: GATED });
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  // The guard the run's process reads before each request.
  const guard = cancelledIn(join(data, "runs", run.run_id));
  assert.equal(guard(), false, "a run not cancelled sends its requests");
  // The process is started and waiting on its model, its door not open yet: the cancel lands first, and while the
  // server waits to reach the door, the model loads and the run would send its first request.
  const cancelled = api("POST", `/runs/${run.run_id}/cancel`);
  for (let i = 0; !guard(); i++) {
    assert.ok(i < 400, "the mark serve writes is the one the run's process reads");
    await sleep(25);
  }
  await writeFile(gate, "");
  assert.equal((await cancelled).status, 202);
  assert.equal(guard(), true);
  const ended = await follow(api, run.run_id, ["cancelled"], { deadlineMs: 60_000 });
  assert.equal(existsSync(sent) ? readFileSync(sent, "utf8").split("\n").filter(Boolean).length : 0, 0, "no request was sent");
  const view = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(view.status, "cancelled");
  assert.ok(view.cost.usd === 0, JSON.stringify(view.cost));
  assert.ok(!ended.rows.some((r) => r.kind === "final_answer"), "nothing answered");
});

test("the run's app reads that guard: built on a cancelled run's directory, its models send nothing, and the faux model is never called", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const gate = join(dir, "gate");
  const sent = join(dir, "sent");
  await writeFile(gate, "");
  withEnv(t, { FAUX_GATE: gate, FAUX_SENT: sent });
  const { api, data } = await serve(t, { faux: GATED });
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  await follow(api, run.run_id, ["completed"]);
  // The run's directory now holds its store and revision; cancelling it writes the mark there.
  const root = join(data, "runs", run.run_id);
  await writeFile(join(root, RUN_CANCELLED), "");
  withEnv(t, { AGENTRUN_SERVE_FAUX: GATED, FAUX_GATE: gate, FAUX_SENT: join(dir, "sent-in-test") });
  const { default: app } = await import("../dist/app.js");
  const options = await app({ ref: { id: run.run_id }, root, work: join(root, "work"), store: join(root, "store") });
  // No conversation yet: the tool gate reads none of its requests (tool-gate.ts).
  await options.onOpen({ harness: { commit: async (change) => change({ appendEntry: async () => ({ id: 1 }) }), conversation: async () => undefined } });
  const ref = options.root.agent.model;
  const result = await options.models.streamSimple(options.models.getModel(ref.provider, ref.modelId), { messages: [] }, {}).result();
  assert.match(result.errorMessage ?? "", /cancelled/);
  assert.equal(existsSync(join(dir, "sent-in-test")), false, "the faux model was never called");
});
