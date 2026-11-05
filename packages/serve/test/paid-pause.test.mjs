// A paid tool call the cap refuses for room pauses the run, as a refused model request does: the call is not sent, its
// result says so, and the model's next request is refused in the paid call's words, so the turn ends there and the run
// waits on a raise (input_required, waiting, pending kind budget) with the call's figures: what was taken, and the
// call's hold as what it needs. A raise sends the run on (#1642), and the model calls again: each call the model makes is
// one call, none of ours on top. Faux model and harness, faux monid: no key, no network.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { KEY } from "./fixtures/faux-monid.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_MONID = new URL("./fixtures/faux-monid.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const ENDED = ["completed", "failed", "cancelled"];
const ASK = "Run monid's /person/enrich, called again after a raise.";
/** monid's run allowed: a catalog tool asks by default (tool-gate.ts), and these runs are about the cap, not the gate. */
const ALLOWED = { "monid.run": { permission: "allow" } };
/** The paid call's refusal, held at monid's run allowance ($1, no inspect quoted it), of a $0.5 cap: what the run has
 *  spent (the faux harness's requests cost $0.001 each, pi's faux model nothing) and any model request still held. */
const WORDS = /^Not sent: the run has spent \$[\d.]+( and holds \$[\d.]+ for calls still answering)? of its \$0\.50 cap, and monid_run could cost up to \$1 \(no monid_inspect in this run quoted its price, so it is held at the \$1 allowance; monid_inspect gives its quote\)\. Raise the cap to at least \$1\.\d\d to run it\.$/;
const view = async (api, runId) => (await api("GET", `/runs/${runId}`)).body;
const monidRuns = async (log) => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((call) => call.path === "/v1/run").length;

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`${harness}: a paid call the cap refuses for room pauses the run, its result saying it was not sent; a raise sends it on and the model's next call is made, once`, { timeout: 120_000 }, async (t) => {
    const log = join(await scratch(t), "monid-calls.jsonl");
    withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
    const { api } = await serve(t, { fauxMonid: FAUX_MONID, ...(harness === "pi" ? {} : { fauxHarness: FAUX_HARNESS }) });
    const id = `paid-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { ...(harness === "pi" ? {} : { harness, instructions: ASK }), tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: ASK }, max_cost_usd: 0.5 });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    const { rows } = await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
    const paused = await view(api, runId);
    assert.deepEqual([paused.status, paused.state, paused.error, paused.pending?.kind], ["input_required", "waiting", null, "budget"], JSON.stringify(paused));
    const spent = paused.pending.spent_usd;
    assert.ok(spent >= 0 && spent < 0.01, `what was taken: ${spent}`);
    // Its figures: the cap, what was taken, the call's hold as its need, and the raise offered (spent + 10 x needs, up).
    assert.deepEqual([paused.pending.cap_usd, paused.pending.needs_usd, paused.pending.suggested_cap_usd], [0.5, 1, Math.ceil(spent + 10 - 1e-9)], JSON.stringify(paused.pending));
    assert.match(paused.pending.said, WORDS);
    assert.equal(await monidRuns(log), 0, "the refused call was not sent");
    const result = rows.find((row) => row.kind === "tool_result");
    assert.match(result?.text ?? result?.summary ?? "", /Not sent: .*monid_run could cost up to \$1/, JSON.stringify(result));
    // The suggested raise sends the run on, and the model calls again: that call is made, once.
    const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: paused.pending.suggested_cap_usd });
    assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
    await follow(api, runId, ENDED, { deadlineMs: 60_000 });
    const done = await view(api, runId);
    assert.deepEqual([done.status, done.error, done.cost.cap_usd], ["completed", null, paused.pending.suggested_cap_usd], JSON.stringify(done));
    assert.equal(await monidRuns(log), 1, "the call made after the raise, once");
  });
}

test("pi: after a raise, a model that calls twice makes two calls: none is added, and none retried", { timeout: 120_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const { api } = await serve(t, { fauxMonid: FAUX_MONID });
  assert.equal((await api("POST", "/agents", agent("paid-twice", { tools: ["monid.run"], tool_settings: ALLOWED }))).status, 201);
  const started = await api("POST", "/agents/paid-twice/runs", { input: { content: "Run monid's /person/enrich, called again after a raise, twice." }, max_cost_usd: 0.5 });
  const runId = started.body.run_id;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).pending?.kind, "budget", "paused at its refused call");
  assert.equal((await api("PATCH", `/runs/${runId}`, { max_cost_usd: 10 })).status, 200);
  await follow(api, runId, ENDED, { deadlineMs: 60_000 });
  assert.equal((await view(api, runId)).status, "completed");
  assert.equal(await monidRuns(log), 2, "the model's two calls after the raise, and the refused one never sent");
});
