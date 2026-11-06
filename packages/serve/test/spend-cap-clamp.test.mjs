// A cap below one request's worst case at its model's ceiling no longer stops a run before it starts: each request is
// sent with the output tokens what is left of the cap can buy, and a request is refused only when that cannot buy its
// least (1,024 tokens for the answer, and its thinking's least), before it is sent, saying in plain words what the run
// spent and what the request needs. A request a run's cap refused is no model request: the usage never says "$0 over 1
// model request". pi through a gateway (a Responses endpoint on loopback, so the output on the wire is the one checked);
// claude-agent and codex through the faux harness, which files the output limit each request was admitted with.
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { agent, follow, responsesEndpoint, runDir, serve, withEnv } from "./support.mjs";

const GATEWAY_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_PRICE", "AGENT_MODEL_API_KEY"];
/** The gateway models' max output tokens (model.ts), which a request is sent with as max_output_tokens uncapped. */
const GATEWAY_MAX_OUTPUT = 32_000;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
/** The faux model priced on output only, $100 a million tokens: $0.0001 a token, 16,384 of them at its ceiling. */
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
const FAUX_PER_TOKEN = 100 / 1e6;

/** The run's end, or its pause at its cap. */
const ended = async (api, runId) => {
  const { rows } = await follow(api, runId, ["input_required", "completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  return { run: (await api("GET", `/runs/${runId}`)).body, rows };
};

async function start(api, id, content, extra = {}, definition = {}) {
  assert.equal((await api("POST", "/agents", agent(id, definition))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content }, ...extra });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body;
}

/** No row says the run made a model request it never sent: its usage line says it sent none. */
function noPhantomRequest(rows) {
  for (const row of rows) {
    assert.doesNotMatch(String(row.summary ?? ""), /over 1 model request/, JSON.stringify(row));
    if (row.kind === "usage") assert.equal(row.usage?.requests ?? 0, 0, JSON.stringify(row));
  }
  assert.deepEqual(rows.filter((row) => row.kind === "usage").map((row) => row.summary), ["no model request sent"]);
}

/** The run's store records of `kind`, read once its process has let it go. */
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

async function gateway(t, price) {
  const endpoint = await responsesEndpoint(t, "42", 10);
  withEnv(t, { AGENT_MODEL_BASE_URL: endpoint.url, AGENT_MODEL: "cap-model", AGENT_MODEL_PRICE: price }, GATEWAY_VARS);
  const server = await serve(t, { faux: undefined });
  return { ...server, endpoint, posts: () => endpoint.asked.filter((line) => line.startsWith("POST ")).length };
}

test("pi: a cap under one request's worst case at the ceiling runs, the request sent with the output tokens the cap buys", async (t) => {
  // Output only, $1 a million: at its ceiling a request could cost $0.032; $0.016 buys 16,000 tokens.
  const { api, endpoint, posts } = await gateway(t, "0,1");
  const { run } = await ended(api, (await start(api, "half", "What is six times seven?", { max_cost_usd: 0.016 })).run_id);
  assert.deepEqual([run.status, posts()], ["completed", 1], JSON.stringify(run.error));
  const sent = endpoint.bodies[0].max_output_tokens;
  assert.ok(sent >= 15_999 && sent <= 16_000 && sent < GATEWAY_MAX_OUTPUT, `max_output_tokens ${sent}`);
});

test("pi: a cap that cannot buy its first request's least is refused before anything is sent, in plain words, the run made no request, and it pauses at its cap", async (t) => {
  // A gateway model reasons, and its reasoning shares max_output_tokens: its least is 1,024 tokens for the answer and the
  // medium thinking level's 8,192 (pi-ai's table), 9,216 at $1 a million, $0.009216 (rounded up in the words to $0.01).
  const { api, posts } = await gateway(t, "0,1");
  const { run, rows } = await ended(api, (await start(api, "tiny", "What is six times seven?", { max_cost_usd: 0.0005 })).run_id);
  assert.deepEqual([run.status, run.state, run.error, run.pending?.kind, posts()], ["input_required", "waiting", null, "budget", 0], JSON.stringify(run));
  assert.match(run.pending.said, /^Not sent: this run's cap of \$0\.0005 can't cover one \S+ request \(at least \$0\.01\)\. Raise the cap to at least \$0\.01 to run it\.$/);
  assert.equal(run.cost.usd, 0);
  noPhantomRequest(rows);
});

for (const harness of ["claude-agent", "codex"]) {
  test(`${harness}: a cap under one request's worst case at the ceiling runs, each request admitted with the output what is left buys`, { timeout: 90_000 }, async (t) => {
    // At its ceiling a faux request could cost $1.6384; $0.50 buys about 5,000 tokens, less what each answer cost.
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
    const { run_id } = await start(api, `clamp-${harness}`, "go", { max_cost_usd: 0.5 }, { harness, instructions: "Make three requests." });
    const { run } = await ended(api, run_id);
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    const limits = records(data, run_id, "faux.request").map((r) => r.data.outputTokensMax);
    assert.equal(limits.length, 3, JSON.stringify(limits));
    assert.ok(limits.every((n) => Number.isInteger(n) && n >= 1_024 && n <= 5_000), `each request's output limit: ${JSON.stringify(limits)}`);
    const held = records(data, run_id, "runner.request").map((r) => r.data.heldUsd);
    assert.ok(held.length === 3 && held.every((usd, i) => Math.abs(usd - limits[i] * FAUX_PER_TOKEN) < 1e-9 && usd <= 0.5), `held at each clamped limit: ${JSON.stringify(held)}`);
  });

  test(`${harness}: a cap that cannot buy its first request's least is refused before anything is sent, in plain words, the run made no request, and it pauses at its cap`, { timeout: 90_000 }, async (t) => {
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
    const { run_id } = await start(api, `tiny-${harness}`, "go", { max_cost_usd: 0.05 }, { harness, instructions: "Make three requests." });
    const { run, rows } = await ended(api, run_id);
    assert.deepEqual([run.status, run.state, run.error, run.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(run));
    // 1,024 tokens at $0.0001 are $0.1024: the least cap is $0.11 in the words.
    assert.match(run.pending.said, /^Not sent: this run's cap of \$0\.05 can't cover one \S+ request \(at least \$0\.11\)\. Raise the cap to at least \$0\.11 to run it\.$/);
    assert.equal(records(data, run_id, "faux.request").length, 0, "nothing was sent");
    noPhantomRequest(rows);
  });

  test(`${harness}: a run that spends its cap down is refused once what is left cannot buy 1,024 tokens, saying so, the refused request counts as none, and the run pauses at its cap`, { timeout: 90_000 }, async (t) => {
    // $0.105 passes the least ($0.1024). The first request is admitted with 1,050 tokens and costs $0.001, the second with
    // 1,040 and costs $0.002; then $0.102 is left, 1,020 tokens: the third is refused.
    const { api, data } = await serve(t, { fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
    const { run_id } = await start(api, `down-${harness}`, "go", { max_cost_usd: 0.105 }, { harness, instructions: "Make three requests." });
    const { run, rows } = await ended(api, run_id);
    assert.deepEqual([run.status, run.state, run.error, run.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(run));
    // To run it the cap would have to be what was spent and the next request's least: $0.003 + $0.1024, $0.11 up to the cent.
    assert.match(run.pending.said, /^Not sent: the run has spent \$0\.003 of its \$0\.105 cap, and its next \S+ request needs at least \$0\.11\. Raise the cap to at least \$0\.11 to run it\.$/);
    assert.equal(records(data, run_id, "faux.request").length, 2, "two were sent");
    const usage = rows.findLast((r) => r.kind === "usage")?.usage;
    assert.equal(usage?.requests, 2, JSON.stringify(usage));
    for (const row of rows) assert.doesNotMatch(String(row.summary ?? ""), /over 3 model requests/, JSON.stringify(row));
  });
}
