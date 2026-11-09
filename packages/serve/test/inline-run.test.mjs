// POST /v2/runs: a run of an agent given inline, owned by another system and named by its reference there
// (`external: {source, kind, id, version}`). The agent (one per source, kind and id) and its revision (one per version) are
// written on the first run that names them, in the run's own start; a later run under the same version reuses them; a
// different definition under a version is refused, 409 external_body_conflict; the definition is checked as POST /agents
// checks one. The run's fields are POST /agents/{agent_id}/runs' own, and the run reads, on every read route, as a run of
// an agent made with POST /agents.
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, serve } from "./support.mjs";

const DEFINITION = { name: "Expert 42", description: "Answers questions.", instructions: "Answer.", skills: [], tools: [] };
const external = (version = 7, id = "42") => ({ source: "grep", kind: "expert", id, version });
const inline = (extra = {}) => ({ external: external(), definition: DEFINITION, input: { content: "What is six times seven?" }, ...extra });

/** The agents mapped to `ref`'s source, kind and id, read through GET /agents. */
async function mapped(api, id = "42") {
  const { body } = await api("GET", "/agents?limit=100");
  return body.agents.filter((agent) => agent.external?.id === id);
}

test("a first use makes the agent and its revision and starts the run; a reuse of the version makes neither; the agent is read-only here", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const first = await api("POST", "/runs", inline());
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.headers.get("location"), `/v2/runs/${first.body.run_id}`);
  const [agent, ...more] = await mapped(api);
  assert.equal(more.length, 0, "one agent per external reference");
  assert.deepEqual(agent.external, { source: "grep", kind: "expert", id: "42", version: "7" });
  assert.equal(agent.revisions, 1);
  assert.deepEqual([agent.definition.name, agent.definition.description, agent.definition.instructions], ["Expert 42", "Answers questions.", "Answer."]);
  assert.equal(first.body.agent_id, agent.agent_id);
  assert.equal(first.body.revision, agent.revision);
  await follow(api, first.body.run_id, ["completed"]);

  // The same version again: the same agent and revision, nothing added.
  const again = await api("POST", "/runs", inline({ input: { content: "And seven times six?" } }));
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.deepEqual([again.body.agent_id, again.body.revision], [agent.agent_id, agent.revision]);
  const [after, ...none] = await mapped(api);
  assert.equal(none.length, 0);
  assert.equal(after.revisions, 1, "a reuse adds no revision");
  await follow(api, again.body.run_id, ["completed"]);

  // A key sent twice with the same body replays its run, as POST /agents/{agent_id}/runs does.
  const keyed = await api("POST", "/runs", inline(), { "idempotency-key": "inline-once" });
  const replayed = await api("POST", "/runs", inline(), { "idempotency-key": "inline-once" });
  assert.deepEqual([keyed.status, replayed.status, replayed.body.run_id, replayed.headers.get("idempotent-replayed")], [202, 202, keyed.body.run_id, "true"]);
  await follow(api, keyed.body.run_id, ["completed"]);

  // A new version: its first use makes a new current revision, and the agent takes its name and description.
  const next = await api("POST", "/runs", inline({ external: external(8), definition: { ...DEFINITION, name: "Expert 42 (v8)", description: "Answers better.", instructions: "Answer well." } }));
  assert.equal(next.status, 202, JSON.stringify(next.body));
  const [moved] = await mapped(api);
  assert.deepEqual([moved.revisions, moved.external.version, moved.definition.name, moved.definition.description], [2, "8", "Expert 42 (v8)", "Answers better."]);
  assert.equal(next.body.revision, moved.revision);
  await follow(api, next.body.run_id, ["completed"]);

  // Its source is the truth: an edit, a change of its current revision and an archive here are refused, in words.
  const { version: _, ...definition } = moved.definition;
  for (const [method, path, body] of [
    ["PUT", `/agents/${moved.agent_id}/definition`, { definition: { ...definition, instructions: "Something else." } }],
    ["POST", `/agents/${moved.agent_id}/current`, { revision: agent.revision }],
    ["POST", `/agents/${moved.agent_id}/archive`, {}],
  ]) {
    const refused = await api(method, path, body);
    assert.deepEqual([refused.status, refused.body.error?.code], [403, "forbidden"], `${method} ${path}: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error.message, /managed by its source/);
  }
});

test("two first uses at once make one agent and one revision", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const [a, b] = await Promise.all([api("POST", "/runs", inline()), api("POST", "/runs", inline({ input: { content: "Again?" } }))]);
  assert.deepEqual([a.status, b.status], [202, 202], JSON.stringify([a.body, b.body]));
  const agents = await mapped(api);
  assert.equal(agents.length, 1, "one agent");
  assert.equal(agents[0].revisions, 1, "one revision");
  assert.deepEqual([a.body.agent_id, a.body.revision], [b.body.agent_id, b.body.revision]);
  await follow(api, a.body.run_id, ["completed"]);
  await follow(api, b.body.run_id, ["completed"]);
});

test("a different definition under a version already run is 409 external_body_conflict, naming the id and version, and writes nothing", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const first = await api("POST", "/runs", inline());
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(api, first.body.run_id, ["completed"]);
  const runs = (await api("GET", "/runs?limit=100")).body.runs.length;
  const changed = await api("POST", "/runs", inline({ definition: { ...DEFINITION, instructions: "Answer in French." } }));
  assert.deepEqual([changed.status, changed.body.error?.code], [409, "external_body_conflict"], JSON.stringify(changed.body));
  assert.match(changed.body.error.message, /\b42\b/);
  assert.match(changed.body.error.message, /version 7\b/);
  assert.match(changed.body.error.message, /publish a new version/);
  assert.deepEqual(changed.body.error.details, { external: { source: "grep", kind: "expert", id: "42", version: "7" } });
  const [agent] = await mapped(api);
  assert.deepEqual([agent.revisions, agent.definition.instructions], [1, "Answer."], "nothing written");
  assert.equal((await api("GET", "/runs?limit=100")).body.runs.length, runs, "no run started");
});

test("an inline definition is refused in POST /agents' own words, and the external reference and run fields are checked", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t, { runner: false });
  const fields = (answer) => answer.body.error?.fields?.map(({ field, reason, message }) => ({ field, reason, message }));
  for (const bad of [
    { name: "Bad", tools: "web_search" },
    { ...DEFINITION, instructions: undefined },
    { ...DEFINITION, workflow: { v: 2 } },
    { ...DEFINITION, harness: "nowhere" },
  ]) {
    const agents = await api("POST", "/agents", { definition: bad });
    const runs = await api("POST", "/runs", inline({ definition: bad }));
    assert.equal(agents.status, 422, JSON.stringify(agents.body));
    assert.deepEqual([runs.status, runs.body.error?.code], [422, "input_invalid"], JSON.stringify(runs.body));
    assert.deepEqual(fields(runs), fields(agents), JSON.stringify(bad));
  }
  // Skill files as POST /agents takes them, checked the same way.
  const skillsAgents = await api("POST", "/agents", { definition: { ...DEFINITION, skills: ["missing"] }, skills: {} });
  const skillsRuns = await api("POST", "/runs", inline({ definition: { ...DEFINITION, skills: ["missing"] }, skills: {} }));
  assert.deepEqual([skillsRuns.status, fields(skillsRuns)], [422, fields(skillsAgents)]);
  // The reference: each of its four fields, by name.
  const reference = await api("POST", "/runs", inline({ external: { source: "grep:x", kind: "", id: 42 } }));
  assert.equal(reference.status, 422, JSON.stringify(reference.body));
  assert.deepEqual(reference.body.error.fields.map((f) => [f.field, f.reason]), [["external.source", "bad_format"], ["external.kind", "bad_format"], ["external.id", "wrong_type"], ["external.version", "missing"]]);
  assert.deepEqual((await api("POST", "/runs", inline({ external: undefined }))).body.error.fields.map((f) => [f.field, f.reason]), [["external", "missing"]]);
  // The id and the version are the reference's: the definition names neither.
  const named = await api("POST", "/runs", inline({ definition: { ...DEFINITION, id: "mine", version: 3 } }));
  assert.deepEqual(named.body.error.fields.map((f) => [f.field, f.reason]), [["definition.id", "not_allowed"], ["definition.version", "not_allowed"]]);
  // The run's fields, as POST /agents/{agent_id}/runs checks them: an unknown one, a pin of a revision, a bad cap.
  const run = await api("POST", "/runs", inline({ revision: "r1", max_cost_usd: -1, extra: true }));
  assert.equal(run.status, 422, JSON.stringify(run.body));
  assert.deepEqual(run.body.error.fields.map((f) => [f.field, f.reason]).sort(), [["extra", "not_allowed"], ["max_cost_usd", "wrong_type"], ["revision", "not_allowed"]]);
  assert.deepEqual(await mapped(api), [], "nothing made");
});

/** `value` with what differs between any two runs of one agent (their ids, their times and timeline cursors, their console
 *  pages) put to one placeholder each, so two runs that read alike compare equal. */
function shapeOf(value, ids) {
  const text = JSON.stringify(value, (_key, v) => {
    if (typeof v !== "string") return v;
    let s = v;
    for (const [id, name] of ids) s = s.split(id).join(name);
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(s) ? "<time>" : s;
  });
  return JSON.parse(text, (key, v) => (typeof v === "number" && /(_ms|_at|^at|^ts|^next_after)$/.test(key) ? "<number>" : v));
}

test("a run started inline reads exactly as a run of an agent made with POST /agents: GET /runs/{id}, its timeline and the run lists", { timeout: 180_000 }, async (t) => {
  const { api } = await serve(t);
  const made = await api("POST", "/agents", { definition: { ...DEFINITION, id: "plain" } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const input = { content: "What is six times seven?" };
  const plain = await api("POST", "/agents/plain/runs", { input, max_cost_usd: 1 });
  const external_ = await api("POST", "/runs", inline({ input, max_cost_usd: 1 }));
  assert.deepEqual([plain.status, external_.status], [202, 202], JSON.stringify([plain.body, external_.body]));
  const ids = (run) => [[run.run_id, "<run>"], [run.agent_id, "<agent>"], [run.revision, "<revision>"]];
  // The start's own answer.
  assert.deepEqual(shapeOf(external_.body, ids(external_.body)), shapeOf(plain.body, ids(plain.body)), "the 202");
  await follow(api, plain.body.run_id, ["completed"]);
  await follow(api, external_.body.run_id, ["completed"]);
  const read = async (path, run) => shapeOf((await api("GET", path)).body, ids(run));
  for (const path of ["", "/timeline"]) {
    assert.deepEqual(await read(`/runs/${external_.body.run_id}${path}`, external_.body), await read(`/runs/${plain.body.run_id}${path}`, plain.body), `GET /runs/{id}${path}`);
  }
  // Each in its agent's list, and in the list of every run.
  assert.deepEqual(await read(`/agents/${external_.body.agent_id}/runs`, external_.body), await read("/agents/plain/runs", plain.body), "GET /agents/{agent_id}/runs");
  const all = (await api("GET", "/runs?limit=100")).body.runs;
  const of = (run) => shapeOf(all.find((summary) => summary.run_id === run.run_id), ids(run));
  assert.deepEqual(of(external_.body), of(plain.body), "GET /runs");
});
