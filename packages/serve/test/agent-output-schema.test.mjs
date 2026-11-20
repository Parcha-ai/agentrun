// An agentic agent's structured answer (#2145): its definition's output_schema is kept with its revision, and a completed
// run's result.output is its final answer's last fenced json block when that meets the schema, so the API, the SDK and
// the console read the answer there instead of parsing the message. No schema, no block, or a block the schema refuses:
// result.output is null, as before. The runner tells the model the schema in its instructions, and asks once more when
// the answer misses it; one that still misses says why (result.output_error). And a triggered run is handed its trigger's previous result (#2144): a scheduled run
// of the same trigger reads what its last completed run answered, so a weekly digest can leave out what it reported. A
// result over the limit is handed as the fields its run's output schema names in `x-carried` alone, when they fit.
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

/** A run of agent `id` on `content`, followed to its end: its view and its timeline's rows. */
async function ranOn(api, id, content) {
  const started = await api("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  return { run: (await api("GET", `/runs/${started.body.run_id}`)).body, rows: (await api("GET", `/runs/${started.body.run_id}/timeline`)).body.rows };
}
const RETRY = /^Your final JSON did not match the output schema: (.+)\. Reply again, ending with the corrected json block\.$/;
/** The server's retry rows a run's timeline shows (the output contract's one retry), by their text. */
const retriesOf = (rows) => rows.filter((row) => row.origin === "server" && RETRY.test(row.text ?? ""));

test("the runner gives the model the output schema itself, in its instructions: an agent with none is told nothing", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("digest", { output_schema: DIGEST }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const told = await ranOn(api, "digest", "Quote the output contract.");
  assert.ok(told.run.result.final_answer.startsWith(`End your final answer with exactly one \`\`\`json block that matches this JSON Schema:\n\n\`\`\`json\n${JSON.stringify(DIGEST, null, 2)}\n\`\`\``), told.run.result.final_answer);
  const plain = await ranOn(api, "plain", "Quote the output contract.");
  assert.equal(plain.run.result.final_answer, "NO CONTRACT");
  assert.equal(plain.run.result.output_error, undefined, "no schema, no output_error");
  assert.deepEqual(retriesOf(plain.rows), [], "and no retry");
});

test("an answer that misses the output schema gets one more turn in the same session, and the corrected answer is the run's output", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("digest", { output_schema: DIGEST }))).status, 201);

  const prose = await ranOn(api, "digest", `Answer in prose, then on a retry with this json: ${JSON.stringify(MET)}`);
  assert.deepEqual(prose.run.result.output, MET, "the retry's answer is the run's output");
  assert.equal(prose.run.result.output_error, undefined, "a run that met the schema in the end says no why");
  const [told] = retriesOf(prose.rows);
  assert.equal(retriesOf(prose.rows).length, 1, "one retry");
  assert.equal(RETRY.exec(told.text)[1], "the answer has no fenced json block", "the retry says why");
  assert.match(prose.run.result.final_answer, /Told: Your final JSON did not match the output schema: the answer has no fenced json block\./, "the model read the retry as its next message, in the same session");

  const wrong = await ranOn(api, "digest", `Answer with this json: ${JSON.stringify({ quiet: "no", items: [] })}, then on a retry with this json: ${JSON.stringify(MET)}`);
  assert.deepEqual(wrong.run.result.output, MET);
  assert.match(RETRY.exec(retriesOf(wrong.rows)[0].text)[1], /^\/quiet /, "a block the schema refuses says which path, the schema named once");

  const met = await ranOn(api, "digest", `Answer with this json: ${JSON.stringify(MET)}`);
  assert.deepEqual([met.run.result.output, retriesOf(met.rows).length], [MET, 0], "an answer that meets the schema at once is never asked again");
});

test("an answer that still misses after the one retry ends completed with output null and output_error: never a second retry", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("digest", { output_schema: DIGEST }))).status, 201);
  const missed = await ranOn(api, "digest", `Answer with this json: ${JSON.stringify({ quiet: "no", items: [] })}`);
  assert.equal(missed.run.status, "completed");
  assert.equal(missed.run.result.output, null);
  assert.match(missed.run.result.output_error, /^the answer's json does not meet the output schema: \/quiet /);
  assert.equal(retriesOf(missed.rows).length, 1, "exactly one retry, never a second");
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

/** A schema that carries `carried` (its x-carried) over `seen` (what a watch reads back), `noise` (what fills a result
 *  past the limit) and `tag` (a small field a newer revision carries instead). */
const carrying = (carried) => ({
  type: "object",
  ...(carried ? { "x-carried": carried } : {}),
  required: ["seen"],
  properties: { seen: { type: "array", items: { type: "string" } }, noise: { type: "string" }, tag: { type: "string" } },
});
const SEEN = ["https://jobs.example.com/1", "https://jobs.example.com/2"];
/** An answer whose whole result is over PREVIOUS_RESULT_MAX_BYTES (32 KiB as 2-space JSON); its `seen` is small. Its
 *  noise is words, not one 33 KiB run of letters, which a run's cut takes for a key and redacts. */
const BIG = { seen: SEEN, noise: "word ".repeat(7 * 1024).trim(), tag: "newer" };
const SMALL = { seen: SEEN, noise: "short", tag: "small" };

const PREVIOUS = "The result of this trigger's last completed run";
const CARRIED = "The carried fields";
const TOO_LARGE = /This trigger's last completed run \(([^)]+)\) has a result over 32768 bytes, so it is not handed to you here\./;
/** A scheduled trigger on a new agent `id` with output schema `schema`, whose runs answer `json`, fired twice: the first
 *  run's id and what the second was handed (the faux model quotes it back as "Handed: ..."). `between` runs after the
 *  first firing (an edit of the agent). */
async function firedTwice(api, id, schema, json, between) {
  assert.equal((await api("POST", "/agents", agent(id, { output_schema: schema }))).status, 201);
  const input = { content: `Answer with this json: ${JSON.stringify(json)}` };
  const trigger = (await api("POST", "/triggers", { ...schedule(id, { cron: "0 9 * * 1", timezone: "UTC" }, { enabled: false }), name: id, target: { kind: "start_run", agent_id: id, input, max_cost_usd: 0.5 } })).body;
  const fire = async (press) => {
    const fired = await api("POST", `/triggers/${trigger.id}/fire`, undefined, { "idempotency-key": press });
    assert.equal(fired.status, 202, JSON.stringify(fired.body));
    await follow(api, fired.body.run_id, ["completed"]);
    const run = (await api("GET", `/runs/${fired.body.run_id}`)).body;
    assert.deepEqual(run.result.output, json, `${id}: its own answer is its result`);
    return { runId: fired.body.run_id, handed: /\n\nHanded: ([\s\S]*)\n\n```json\n[^\n]*\n```$/.exec(run.result.final_answer)?.[1] ?? "" };
  };
  const first = await fire(`${id}-1`);
  if (between) await between();
  return { first, handed: (await fire(`${id}-2`)).handed };
}
/** The JSON block of a handed text (its last fenced json block), parsed; null for none. */
const blockOf = (handed) => JSON.parse(/```json\n([\s\S]*?)\n```\s*$/.exec(handed)?.[1] ?? "null");

test("a previous result over the limit whose run's output schema names x-carried is handed as those fields alone, said so with its whole size", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  const carried = await firedTwice(api, "carried", carrying(["seen"]), BIG);
  assert.ok(!TOO_LARGE.test(carried.handed), `a result over the limit whose schema carries fields is not refused whole: ${carried.handed.slice(0, 300)}`);
  assert.deepEqual(blockOf(carried.handed), { seen: SEEN }, "only the carried fields are handed, as an object with their names");
  assert.match(carried.handed, new RegExp(`${CARRIED} \\(seen\\) of this trigger's last completed run \\(${carried.first.runId}, ended [^)]+\\): its whole result is ${Buffer.byteLength(JSON.stringify(BIG, null, 2))} bytes, over 32768`));
  assert.ok(!carried.handed.includes("word word") && !carried.handed.includes('"tag"'), "nothing of the fields it does not carry");
});

test("beside it, over the limit with no x-carried, or a carried string over the limit itself (a scalar is never cut, only a carried array's oldest entries): the too-large line; under the limit: the whole result", { timeout: 180_000 }, async (t) => {
  const { api } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  // The positive control in the same run: a schema that carries `seen` is handed {seen}.
  const control = await firedTwice(api, "control", carrying(["seen"]), BIG);
  assert.deepEqual(blockOf(control.handed), { seen: SEEN }, `the control is handed its carried fields: ${control.handed.slice(0, 300)}`);
  const plain = await firedTwice(api, "uncarried", carrying(undefined), BIG);
  assert.equal(TOO_LARGE.exec(plain.handed)?.[1], plain.first.runId, `no x-carried, the too-large line: ${plain.handed.slice(0, 300)}`);
  assert.ok(!plain.handed.includes(CARRIED) && !plain.handed.includes("```json"), "and nothing of the result");
  const heavy = await firedTwice(api, "heavy", carrying(["noise"]), BIG);
  assert.equal(TOO_LARGE.exec(heavy.handed)?.[1], heavy.first.runId, `a carried string over the limit is never cut, the too-large line: ${heavy.handed.slice(0, 300)}`);
  assert.ok(!heavy.handed.includes(CARRIED) && !heavy.handed.includes("```json"), "and nothing of the result");
  const under = await firedTwice(api, "under", carrying(["seen"]), SMALL);
  assert.match(under.handed, new RegExp(`${PREVIOUS} \\(${under.first.runId}, ended `));
  assert.ok(under.handed.includes(JSON.stringify(SMALL, null, 2)), `under the limit the whole result is handed, x-carried or not: ${under.handed}`);
  assert.ok(!under.handed.includes(CARRIED));
});

test("the carried fields are read from the schema the completed run was checked against (its revision), never the agent's newer one", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  // An edit after the first run carries `tag` instead: the second run is still handed the first run's `seen`.
  const pinned = await firedTwice(api, "pinned", carrying(["seen"]), BIG, async () => {
    const current = await api("GET", "/agents/pinned");
    const edited = await api("PUT", "/agents/pinned/definition", { definition: { name: "pinned", instructions: "Answer again.", skills: [], tools: [], output_schema: carrying(["tag"]) } }, { "if-match": current.headers.get("etag") });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
  });
  assert.deepEqual((await api("GET", "/agents/pinned")).body.definition.output_schema["x-carried"], ["tag"], "the agent's current schema carries tag");
  assert.deepEqual(blockOf(pinned.handed), { seen: SEEN }, `the first run's revision's x-carried, never the newer one's: ${pinned.handed.slice(0, 300)}`);
});

test("a carried field absent from the output is left out, never a null in its place; a pick with none of them present is the too-large line", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { triggerClock: fakeClock("2026-06-01T00:00:00Z") });
  const { tag: _absent, ...noTag } = BIG;
  // x-carried ["seen", "tag"], an answer with no tag: {seen} alone, and the words name seen alone.
  const partial = await firedTwice(api, "partial", carrying(["seen", "tag"]), noTag);
  assert.deepEqual(blockOf(partial.handed), { seen: SEEN }, `an absent carried field is left out, never null: ${partial.handed.slice(0, 300)}`);
  assert.match(partial.handed, new RegExp(`${CARRIED} \\(seen\\) of this trigger's last completed run \\(${partial.first.runId}, `));
  // x-carried ["tag"], an answer with no tag: nothing to pick, so the too-large line, as with no x-carried.
  const none = await firedTwice(api, "none-present", carrying(["tag"]), noTag);
  assert.equal(TOO_LARGE.exec(none.handed)?.[1], none.first.runId, `a pick with no carried field present is the too-large line: ${none.handed.slice(0, 300)}`);
  assert.ok(!none.handed.includes(CARRIED) && !none.handed.includes("```json"), "and nothing of the result, not {}");
});

test("an output_schema's x-carried is a list of unique names of its root's properties: anything else is refused by field", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", agent("watch", { output_schema: carrying(["seen", "tag"]) }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual((await api("GET", "/agents/watch")).body.definition.output_schema["x-carried"], ["seen", "tag"], "it reads back as saved");
  const refusals = [];
  for (const [name, carried] of [["not-a-list", "seen"], ["not-strings", ["seen", 3]], ["repeated", ["seen", "seen"]], ["no-such-property", ["seen", "unknown"]], ["empty-name", [""]]]) {
    const refused = await api("POST", "/agents", agent(name, { output_schema: { ...carrying(undefined), "x-carried": carried } }));
    refusals.push([name, refused.status, refused.body.error?.fields?.map((f) => [f.field, f.reason])]);
  }
  const field = [["definition.output_schema.x-carried", "bad_format"]];
  assert.deepEqual(refusals, [["not-a-list", 422, field], ["not-strings", 422, field], ["repeated", 422, field], ["no-such-property", 422, field], ["empty-name", 422, field]]);
  const noProperties = await api("POST", "/agents", agent("bare", { output_schema: { type: "object", "x-carried": ["seen"] } }));
  assert.deepEqual([noProperties.status, noProperties.body.error?.fields?.map((f) => [f.field, f.reason])], [422, field], "a schema with no properties carries none");
});
