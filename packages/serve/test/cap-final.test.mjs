// A cap's refusal is final on every harness, whatever digits its words hold. pi-ai's retry reads only an error's text:
// a status it retries on ("429", "502") anywhere in it means another attempt after a backoff, unless the text also says
// the run is out of budget (pi-ai's isRetryableAssistantError). So each refusal's code says so ("spend_cap_reached (out
// of budget): "), and these runs put retry digits in the cap ($0.4295), in what was spent and in the model's id: one
// request, no second attempt, no backoff, and the run ends failed with spend_cap_reached. pi through a gateway (its model id names "502"); claude-agent and codex
// through the faux harness (whose model id is the faux one, so "502" is in what the first request cost).
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, responsesEndpoint, runDir, serve, withEnv } from "./support.mjs";

const GATEWAY_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_PRICE", "AGENT_MODEL_API_KEY"];
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const CAP = 0.4295;

function records(data, runId, kind) {
  for (let tries = 0; ; tries++) {
    const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
    try {
      return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === kind);
    } catch (error) {
      if (tries > 20 || !/locked|busy/i.test(String(error.message))) throw error;
    } finally {
      db.close();
    }
  }
}

/** The run's end, or its pause at its cap, its rows and how long it took from `from`. */
async function ended(api, runId, from) {
  const { rows } = await follow(api, runId, ["input_required", "completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  return { run: (await api("GET", `/runs/${runId}`)).body, rows, ms: Date.now() - from };
}

test("pi: a refusal whose cap and model id hold retry digits is final: the request is never sent, nothing is tried again, and the run pauses at its cap", async (t) => {
  // $40 a million output tokens; the endpoint reports 10,625 of them, $0.425 (few enough that pi-ai still reads the
  // context as nearly empty). The first request's least, 1,024 tokens for the answer and the medium thinking level's 8,192
  // ($0.36864), fits $0.4295; after it $0.0045 is left, under the next one's least.
  const endpoint = await responsesEndpoint(t, "42", 10_625);
  withEnv(t, { AGENT_MODEL_BASE_URL: endpoint.url, AGENT_MODEL: "cap-model-502", AGENT_MODEL_PRICE: "0,40" }, GATEWAY_VARS);
  const { api } = await serve(t, { faux: undefined });
  const posts = () => endpoint.asked.filter((line) => line.startsWith("POST ")).length;
  assert.equal((await api("POST", "/agents", agent("digits"))).status, 201);
  const started = await api("POST", "/agents/digits/runs", { input: { content: "What is six times seven?" }, max_cost_usd: CAP });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const first = await ended(api, started.body.run_id, Date.now());
  assert.equal(first.run.status, "completed", JSON.stringify(first.run.error));
  assert.equal(posts(), 1);
  const from = Date.now();
  assert.equal((await api("POST", `/runs/${started.body.run_id}/messages`, { content: "And six times eight?" })).body.mode, "follow_up");
  const { run, rows, ms } = await ended(api, started.body.run_id, from);
  assert.deepEqual([run.status, run.state, run.error, run.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(run));
  // To run it the cap would have to be $0.425 spent and the next request's least, $0.36864: $0.80 up to the cent.
  assert.equal(run.pending.said, "Not sent: this run has spent $0.43 of its $0.4295 cap, and the next step needs at least $0.37. Raise the cap to at least $0.80 to continue.");
  const refusal = rows.find((r) => r.kind === "error");
  assert.ok(refusal?.text?.startsWith("spend_cap_reached (out of budget): Not sent: "), "its code keeps it final to pi-ai's retry");
  assert.equal(posts(), 1, "the refused request never reached the model, and was not tried again");
  assert.equal(rows.filter((r) => r.kind === "error").length, 1, "one refusal");
  assert.ok(ms < 15_000, `no retry backoff: ${ms} ms`);
});

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a refusal whose words hold retry digits is final: one request sent, no second attempt, and the run pauses at its cap`, { timeout: 90_000 }, async (t) => {
    // The first request costs $0.3502: $0.0793 is left of $0.4295, under the least of one more ($0.1024).
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
    assert.equal((await api("POST", "/agents", agent(`digits-${harness}`, { harness, instructions: "Spend 0.3502 on the first request." }))).status, 201);
    const from = Date.now();
    const started = await api("POST", `/agents/digits-${harness}/runs`, { input: { content: "go" }, max_cost_usd: CAP });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { run, rows, ms } = await ended(api, started.body.run_id, from);
    assert.deepEqual([run.status, run.state, run.error, run.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(run));
    // To run it the cap would have to be $0.3502 spent and the next request's least, $0.1024: $0.46 up to the cent.
    assert.match(run.pending.said, /^Not sent: this run has spent \$0\.35 of its \$0\.4295 cap, and the next step needs at least \$0\.11\. Raise the cap to at least \$0\.46 to continue\.$/);
    assert.equal(records(data, started.body.run_id, "faux.request").length, 1, "the second request was never sent");
    assert.equal(rows.filter((r) => r.kind === "error").length, 1, "one refusal");
    assert.ok(ms < 30_000, `no retry backoff: ${ms} ms`);
  });
}
