// A cancel means cancel: one that lands while the run's process is still coming up, before its first request, stops the
// run with no request sent and nothing paid.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cancelledIn } from "../dist/request-start.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const GATED = new URL("./fixtures/faux-gated.mjs", import.meta.url).pathname;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a cancel that lands before the run's process sends anything: no request leaves, the run is cancelled, at $0", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const gate = join(dir, "gate");
  const sent = join(dir, "sent");
  withEnv(t, { FAUX_GATE: gate, FAUX_SENT: sent });
  const { api } = await serve(t, { faux: GATED });
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  // The process is up and waiting on its model, its door not open yet: the cancel lands first, and while the server
  // waits to reach the door, the model loads and the run would send its first request.
  await sleep(1_500);
  const cancelled = api("POST", `/runs/${run.run_id}/cancel`);
  await sleep(300);
  await writeFile(gate, "");
  assert.equal((await cancelled).status, 202);
  const ended = await follow(api, run.run_id, ["cancelled"], { deadlineMs: 60_000 });
  assert.equal(existsSync(sent) ? readFileSync(sent, "utf8").split("\n").filter(Boolean).length : 0, 0, "no request was sent");
  const view = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.equal(view.status, "cancelled");
  assert.ok(view.cost.usd === 0, JSON.stringify(view.cost));
  assert.ok(!ended.rows.some((r) => r.kind === "final_answer"), "nothing answered");
});

test("serve's cancel and the run's guard meet: once a run is cancelled through serve, the guard its process reads says so", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const gate = join(dir, "gate");
  withEnv(t, { FAUX_GATE: gate, FAUX_SENT: join(dir, "sent") });
  const { api, data } = await serve(t, { faux: GATED });
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const { body: run } = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  const guard = cancelledIn(join(data, "runs", run.run_id));
  assert.equal(guard(), false, "a run not cancelled sends its requests");
  assert.equal((await api("POST", `/runs/${run.run_id}/cancel`)).status, 202);
  assert.equal(guard(), true, "the mark serve wrote is the one the run's process reads");
  await writeFile(gate, "");
  await follow(api, run.run_id, ["cancelled"], { deadlineMs: 60_000 });
});
