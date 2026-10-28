// Decision workflows on Jev: a workflow's judge, pick, sift, route and ask nodes run on TypeSafe's System One when this
// server's environment names its key. The key reaches the judge's runner only, never a run's tools or model. Here Jev
// is the tests' fake fetch (fixtures/faux-jev.mjs): no network, no real key.
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { durableDecisions } from "@parcha/agentrun-pi/durable";
import { flowAgent, follow, scratch, serve, storeRun, withEnv } from "./support.mjs";
import { CANARY } from "./fixtures/faux-jev.mjs";

const FAUX_JEV = new URL("./fixtures/faux-jev.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_JEV_CALLS"];

/** A judge over the input, then a model node that reports whether the decision key is anywhere it can reach. */
const decisionFlow = () => ({
  v: 2, name: "coi-check",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Coi: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
    Probe: { type: "object", required: ["leaked", "key_set"], properties: { leaked: { type: "boolean" }, key_set: { type: "boolean" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Probe", path: "probe" },
  root: { node: "chain", steps: [
    { node: "judge", label: "coi", state: { doc: "{question}" }, out: "Coi", as: "coi" },
    { node: "extract", label: "probe", instructions: "Report the canary.", out: "Probe", as: "probe" },
  ] },
});

/** With the canary set as the decision key: one decision workflow run to its end, and where its fake Jev filed its calls. */
async function decided(t) {
  const calls = join(await scratch(t), "jev-calls.jsonl");
  withEnv(t, { TYPESAFE_API_KEY: CANARY, AGENTRUN_TEST_FAUX_JEV_CALLS: calls }, KEYS);
  const { api, data } = await serve(t, { fauxJev: FAUX_JEV });
  const made = await api("POST", "/agents", flowAgent("coi", decisionFlow()));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", "/agents/coi/runs", { input: { question: "State of Delaware. Certificate of Incorporation of Example Widgets, Inc." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { last } = await follow(api, started.body.run_id, ["completed", "failed"]);
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  const seen = (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { api, data, runId: started.body.run_id, last, run, seen };
}

/** Every file under `dir` (small ones only) whose bytes hold `needle`. */
async function filesHolding(dir, needle) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    if ((await stat(path)).size > 32 * 2 ** 20) continue;
    if ((await readFile(path)).includes(needle)) found.push(path);
  }
  return found;
}

test("with TYPESAFE_API_KEY set, a judge workflow runs on Jev and its decision is recorded in the run", async (t) => {
  const { data, runId, last, run, seen } = await decided(t);
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  assert.equal(seen.length, 1, "one System One request");
  assert.deepEqual([seen[0].path, seen[0].authorized, seen[0].questions], ["/v1/systemone", true, ["is_coi"]], "sent with the key the server's environment names");
  const rows = durableDecisions(join(data, "runs", runId, "store", "run.sqlite"));
  assert.equal(rows.length, 1, "the decision's receipt is a row of the run's store");
  assert.equal(rows[0].kind, "judge");
  assert.equal(rows[0].answers.is_coi.noul, 0.92);
});

test("a decision whose cost is unknown leaves the run's cost unknown, never $0", async (t) => {
  const { data, runId, last, run } = await decided(t);
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  const rows = durableDecisions(join(data, "runs", runId, "store", "run.sqlite"));
  assert.equal(rows[0].cost_usd, null, "Jev reports no cost, and no price is set: the receipt says unknown");
  assert.equal(run.cost.usd, null, "the run's cost reads unknown");
  assert.equal(storeRun(data, runId).costUsd ?? null, null, "and the store keeps no cost for it");
});

test("the decision key never reaches a run's tools or model: not in the run's environment, its kernel view or its files", async (t) => {
  const { data, last, run } = await decided(t);
  assert.equal(last.status, "completed", JSON.stringify(run.error));
  assert.deepEqual(run.result.output, { leaked: false, key_set: false }, "the model node's process holds no TYPESAFE_API_KEY and no copy of its value");
  assert.deepEqual(await filesHolding(data, CANARY), [], "no file of the data directory holds the key");
  assert.equal(process.env.TYPESAFE_API_KEY, CANARY, "the server's own environment is as it was");
});

test("with no decision key, a judge workflow saves with a warning, and its run is 409 not_set_up_here naming TYPESAFE_API_KEY", async (t) => {
  withEnv(t, {}, KEYS);
  const { api } = await serve(t, { fauxJev: FAUX_JEV });
  const made = await api("POST", "/agents", flowAgent("coi", decisionFlow()));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const warning = made.body.warnings.find((w) => w.field === "definition.workflow");
  assert.equal(warning?.reason, "not_set_up_here", JSON.stringify(made.body.warnings));
  assert.match(warning.message, /TYPESAFE_API_KEY/);
  const refused = await api("POST", "/agents/coi/runs", { input: { question: "x" } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  assert.match(refused.body.error.message, /TYPESAFE_API_KEY/);
  assert.deepEqual(refused.body.error.details.adapters, ["runJudge"]);
  assert.deepEqual(refused.body.error.details.decisions, { jev: { reason: "not_set_up_here", needs: ["TYPESAFE_API_KEY"] } });
});

test("capabilities lists the decision providers: jev is available where its key is set, and says why not where it is not", async (t) => {
  withEnv(t, {}, KEYS);
  const off = await serve(t);
  const caps = (await off.api("GET", "/capabilities")).body;
  assert.ok(caps.workflows.decisions, "capabilities has workflows.decisions");
  const none = caps.workflows.decisions.providers;
  assert.equal(none.length, 1);
  assert.deepEqual([none[0].id, none[0].available], ["jev", false]);
  assert.match(none[0].reason, /TYPESAFE_API_KEY/);
  process.env.TYPESAFE_API_KEY = CANARY;
  const on = await serve(t);
  assert.deepEqual((await on.api("GET", "/capabilities")).body.workflows.decisions?.providers, [{ id: "jev", available: true }]);
  assert.ok((await on.api("GET", "/capabilities")).body.workflows.adapters.includes("runJudge"));
});
