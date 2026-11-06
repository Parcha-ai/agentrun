// A run its spend cap stops for room pauses instead of failing: the refused request was not sent, so the cap holds, and a
// higher cap would send it. The run is input_required and waiting, with no error and `pending.kind` budget; its timeline
// says so after the refusal; its process is let go while it waits; a server started again reads it paused; a message is
// 409 budget_reached until the cap is raised. A refusal no cap fixes (a model with no price) still fails the run:
// gateway-price.test.mjs holds that.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, follow, letGo, scratch, serve, storeRun } from "./support.mjs";

/** The tests' faux model priced on output only, $100 a million: a request's least (1,024 tokens) is $0.1024. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
/** Where a run stands once its first turn is over: paused, failed or completed. */
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const CANT_COVER = /^Not sent: the next step needs at least \$0\.11, and this run's cap is \$0\.05\. Raise the cap to at least \$0\.11 to continue\.$/;

async function paused(api, id) {
  assert.equal((await api("POST", "/agents", agent(id))).status, 201);
  const { run_id } = (await api("POST", `/agents/${id}/runs`, { input: { content: "Write one.md" }, max_cost_usd: 0.05 })).body;
  const { rows } = await follow(api, run_id, SETTLED);
  return { runId: run_id, rows };
}

test("pi: a run whose cap cannot buy its next request's least pauses, the request unsent: input_required and waiting, no error, pending budget in the refusal's words, and a waiting row after the refusal", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const { runId, rows } = await paused(api, "pausing");
  const run = await view(api, runId);
  assert.deepEqual([run.status, run.state, run.error, run.pending?.kind, run.pending?.cap_usd], ["input_required", "waiting", null, "budget", 0.05], JSON.stringify(run));
  assert.match(run.pending.said, CANT_COVER);
  // Its figures as the cap counted them: nothing spent or held, and the request's least, 1,024 tokens at $100 a million.
  assert.equal(run.pending.spent_usd, 0);
  assert.ok(Math.abs(run.pending.needs_usd - 1_024 * 100 / 1e6) < 1e-12, `the least: ${run.pending.needs_usd}`);
  assert.ok(!Number.isNaN(Date.parse(run.pending.at)), run.pending.at);
  // Its last rows but the usage line: the refusal, then the pause.
  const shown = rows.filter((row) => row.kind !== "usage" && row.kind !== "phase");
  const last = shown.at(-1);
  assert.deepEqual([last.kind, last.summary, last.text], ["waiting", "Waiting for you to raise the cap", "Waiting for you to raise the cap"], JSON.stringify(last));
  assert.equal(shown.at(-2).kind, "error", "after the refusal's own row");
  assert.equal(run.cost.usd, 0, "nothing was sent");
});

test("a run paused at its cap lets its process go, takes no message (409 budget_reached) until its cap is raised, and a server started again reads it paused", async (t) => {
  const dir = await scratch(t);
  const data = join(dir, "agents");
  let server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  t.after(() => server?.close());
  let api = client(server.baseUrl, server.token);
  const { runId } = await paused(api, "parked");
  // Let go: its process has exited, with its run still running in the agent store.
  await letGo(data, runId);
  assert.equal(storeRun(data, runId).state, "running", "not ended");
  const refused = await api("POST", `/runs/${runId}/messages`, { content: "go on" });
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "budget_reached"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /^The run is paused at its \$0\.05 cap: raise the cap first\. Not sent: /);
  await server.close();
  server = await startServe({ data, port: 0, faux: OUTPUT_PRICED, drainTimeout: "5s" });
  api = client(server.baseUrl, server.token);
  const again = await view(api, runId);
  assert.deepEqual([again.status, again.state, again.error, again.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(again));
  assert.match(again.pending.said, CANT_COVER);
  assert.equal(again.pending.spent_usd, 0, "its figures are read back from the refusal's mark");
  assert.ok(Math.abs(again.pending.needs_usd - 1_024 * 100 / 1e6) < 1e-12, `the least: ${again.pending.needs_usd}`);
});
