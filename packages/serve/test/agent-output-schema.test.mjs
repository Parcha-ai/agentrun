// An agentic agent's structured answer (#2145): its definition's output_schema is kept with its revision, and a completed
// run's result.output is its final answer's last fenced json block when that meets the schema, so the API, the SDK and
// the console read the answer there instead of parsing the message. No schema, no block, or a block the schema refuses:
// result.output is null, as before. And a triggered run is handed its trigger's previous result (#2144): a scheduled run
// of the same trigger reads what its last completed run answered, so a weekly digest can leave out what it reported.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { agent, flowAgent, follow, serve, withEnv } from "./support.mjs";
import { fakeClock, schedule } from "./trigger-support.mjs";

/** A digest's schema: what a market monitor's answer holds, cut down. */
const DIGEST = {
  type: "object",
  additionalProperties: false,
  required: ["quiet", "items"],
  properties: {
    quiet: { type: "boolean" },
    items: { type: "array", items: { type: "object", required: ["claim"], properties: { claim: { type: "string" } } } },
  },
};
const MET = { quiet: false, items: [{ claim: "Acme launched Pulse" }] };

/** A run of agent `id` asked to answer with `json` as its last fenced json block (the faux model's structured reply). */
async function answered(api, id, json) {
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: `Answer with this json: ${JSON.stringify(json)}` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  return (await api("GET", `/runs/${started.body.run_id}`)).body;
}

test("an agentic definition keeps its output_schema: it reads back, an edit that leaves it out keeps it, and one that isn't an object or sits on a workflow is refused by field", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", agent("digest", { output_schema: DIGEST }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual((await api("GET", "/agents/digest")).body.definition.output_schema, DIGEST);
  const edited = await api("PUT", "/agents/digest/definition", { definition: { name: "digest", instructions: "Answer again.", skills: [], tools: [] } }, { "if-match": made.headers.get("etag") });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual((await api("GET", "/agents/digest")).body.definition.output_schema, DIGEST, "an edit that leaves it out keeps it");
  const notObject = await api("POST", "/agents", agent("bad-type", { output_schema: "an object" }));
  assert.deepEqual([notObject.status, notObject.body.error.fields.map((f) => [f.field, f.reason])], [422, [["definition.output_schema", "wrong_type"]]]);
  const onFlow = await api("POST", "/agents", flowAgent("flow", undefined, { output_schema: DIGEST }));
  assert.deepEqual([onFlow.status, onFlow.body.error.fields.map((f) => [f.field, f.reason])], [422, [["definition.output_schema", "not_allowed"]]]);
});

test("a completed run's result.output is its answer's last json block when it meets the agent's output schema; null when it does not, or the agent has none", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("digest", { output_schema: DIGEST }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);

  const met = await answered(api, "digest", MET);
  assert.deepEqual(met.result.output, MET, "the structured answer is the run's result");
  assert.match(met.result.final_answer, /```json/, "the final answer is still the message as written");

  const refused = await answered(api, "digest", { quiet: "no", items: [] });
  assert.equal(refused.result.output, null, "a block the schema refuses is no output");
  assert.match(refused.result.final_answer, /"quiet":"no"/);

  const none = await answered(api, "plain", MET);
  assert.equal(none.result.output, null, "an agent with no output schema has none, as before");
});

test("the structured answer is read off the answer as written, then cut: a held value in it, a number's too, is cut inside the output, never the output dropped", { timeout: 120_000 }, async (t) => {
  // Held values, made at runtime: one all digits (a gateway's key can be), which an answer can quote as a JSON number.
  // Cut in the answer's text first, that number would leave `"amount": [redacted]`, no JSON at all.
  const digits = String(10_000_000 + randomBytes(3).readUIntBE(0, 3));
  const held = ["not-a-secret", "output-key", randomBytes(6).toString("hex")].join("-");
  withEnv(t, { PARALLEL_API_KEY: held, AGENT_MODEL_API_KEY: digits });
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("digest", { output_schema: DIGEST }))).status, 201);
  const quoting = { quiet: false, items: [{ claim: `Acme's key ${held} leaked`, amount: Number(digits) }] };
  const run = await answered(api, "digest", quoting);
  assert.deepEqual(run.result.output, { quiet: false, items: [{ claim: "Acme's key [redacted] leaked", amount: "[redacted]" }] }, "each held value is cut inside the output, its shape kept");
  assert.ok(!JSON.stringify(run.result).includes(held) && !JSON.stringify(run.result).includes(digits), "no held value anywhere in the result");
});

test("a triggered run is handed its trigger's last completed result after its message; the first run, and another trigger's, get none", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  assert.equal((await api("POST", "/agents", agent("digest", { output_schema: DIGEST }))).status, 201);
  const input = { content: `Answer with this json: ${JSON.stringify(MET)}` };
  const make = async (name) => (await api("POST", "/triggers", { ...schedule("digest", { cron: "0 9 * * 1", timezone: "UTC" }, { enabled: false }), name, target: { kind: "start_run", agent_id: "digest", input, max_cost_usd: 0.5 } })).body;
  const weekly = await make("weekly");
  const other = await make("other");
  /** Fires `trigger` now, waits for its run to complete, and reads what the run was handed after the trigger's message:
   *  the faux model quotes it back as "Handed: ..." (none when the message is the trigger's alone). */
  const fire = async (trigger, press) => {
    const fired = await api("POST", `/triggers/${trigger.id}/fire`, undefined, { "idempotency-key": press });
    assert.equal(fired.status, 202, JSON.stringify(fired.body));
    await follow(api, fired.body.run_id, ["completed"]);
    const run = (await api("GET", `/runs/${fired.body.run_id}`)).body;
    assert.deepEqual(run.result.output, MET, "its own structured answer is its result, whatever it was handed");
    return { runId: fired.body.run_id, handed: /\n\nHanded: ([\s\S]*)\n\n```json\n[^\n]*\n```$/.exec(run.result.final_answer)?.[1] };
  };

  // A trigger's message also says how the run was started ("(Started by hand from the schedule ...)"): what matters is
  // whether the previous result is in it.
  const PREVIOUS = "The result of this trigger's last completed run";
  const first = await fire(weekly, "week-1");
  assert.ok(!first.handed?.includes(PREVIOUS), `the first run has no previous result: ${first.handed}`);
  const second = await fire(weekly, "week-2");
  assert.match(second.handed ?? "", new RegExp(`${PREVIOUS} \\(${first.runId}, ended `), "the second run is handed the first's result");
  assert.ok(second.handed.includes(JSON.stringify(MET, null, 2)), `the previous result is handed whole: ${second.handed}`);
  const elsewhere = await fire(other, "other-1");
  assert.ok(!elsewhere.handed?.includes(PREVIOUS), `another trigger's runs are never handed this trigger's result: ${elsewhere.handed}`);
});
