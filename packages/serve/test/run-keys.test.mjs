// A run's own tool keys (`keys` on its start or a message, run-keys.ts): a run carries the key a tool of its revision reads,
// and that tool sends it; the value is sealed with the run's launch, never in the store's files, the run's timeline,
// events or answer, nor a log line, even when the model quotes it. A name no tool of the revision reads, or a value that
// is not text, is refused by name, never echoed. AGENTRUN_RUN_KEYS=1 (an install whose runs bring their keys): a
// template's apply makes its agent though a tool key it declares is not set here, and says so; a run that does not carry
// it is refused, one that does runs. Off by default. Under --faux, with a fake Parallel that files the key each request
// carried (fixtures/faux-parallel-keys.mjs); keys are made at run time, never real.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const KEYED_PARALLEL = new URL("./fixtures/faux-parallel-keys.mjs", import.meta.url).pathname;
/** Every variable a case here sets or must find unset: no key of the machine's reaches a run. */
const CLEARED = ["PARALLEL_API_KEY", "MONID_API_KEY", "TYPESAFE_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "AGENTRUN_RUN_KEYS", "AGENTRUN_TEST_FAUX_PARALLEL_KEYS", "AGENTRUN_SEAL_KEY"];
const ENDED = ["completed", "failed", "cancelled", "input_required"];
/** A run key made here: distinct per case, and no credential-shaped literal for the source scan. */
const newKey = () => ["not-a-secret", "run-key", randomBytes(8).toString("hex")].join("-");
/** An agent whose web search is Parallel's: its runs read PARALLEL_API_KEY. */
const SEARCHER = (id, tools = ["web_search"]) => agent(id, { tools, tool_settings: { web_search: { provider: "parallel" } } });

/** A server whose fake Parallel files the key each request carried, and every log line it and its runner wrote. */
async function setup(t, { env = {}, ...options } = {}) {
  const dir = await scratch(t);
  const keyLog = join(dir, "parallel-keys.ndjson");
  writeFileSync(keyLog, "");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TEST_FAUX_PARALLEL_KEYS: keyLog, ...env }, CLEARED);
  const logs = [];
  const server = await serve(t, { fauxParallel: KEYED_PARALLEL, log: (line) => logs.push(String(line)), ...options });
  const sent = () => readFileSync(keyLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { ...server, dir, logs, sent };
}

/** Every file under `root` whose bytes hold `value`, by path. */
function filesHolding(root, value) {
  const out = [];
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && readFileSync(path).includes(value)) out.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Whether `text` holds any 8 characters of `secret` in a row. */
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};

/** Everything the API answers about run `runId`: its view, timeline, events and trace, those served. */
async function answersOf(api, runId) {
  const out = [];
  for (const path of [`/runs/${runId}`, `/runs/${runId}/timeline`, `/runs/${runId}/events`, `/runs/${runId}/trace`, `/runs/${runId}/usage`]) {
    const answer = await api("GET", path);
    if (answer.status === 200) out.push(JSON.stringify(answer.body));
  }
  return out.join("\n");
}

test("a run carries the Parallel key its web search reads: the search goes out on that key, and the value is in no store file, answer or log line", { timeout: 120_000 }, async (t) => {
  const { api, data, logs, sent } = await setup(t);
  assert.equal((await api("POST", "/agents", SEARCHER("searcher"))).status, 201);
  const refused = await api("POST", "/agents/searcher/runs", { input: { content: "Search the web for widgets." } });
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "agent_not_runnable"], "no key here and none carried");

  const key = newKey();
  const started = await api("POST", "/agents/searcher/runs", { input: { content: "Search the web for widgets." }, keys: { PARALLEL_API_KEY: key } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { last } = await follow(api, runId, ENDED, { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(last.status, "completed", JSON.stringify(view.error ?? view));
  assert.match(view.result.final_answer, /^Found: /, "the run answered with what it found");
  assert.deepEqual(sent().map((one) => [one.path, one.key]), [["/v1/search", key]], "one search, on the run's own key");

  assert.deepEqual(filesHolding(data, key), [], "no file of the store holds the key");
  assert.ok(!(await answersOf(api, runId)).includes(key), "no answer about the run holds the key");
  assert.ok(!JSON.stringify(started.body).includes(key), "the start's answer holds no key");
  assert.ok(!logs.join("\n").includes(key), "no log line holds the key");
});

test("a model that quotes the run's key in its thinking, its text, a tool call and its answer: no 8 characters of it in any answer, file or log line", { timeout: 120_000 }, (t) => quotedKey(t, newKey()));

test("a key of 8 characters, the shortest taken, is cut the same when the model quotes it", { timeout: 120_000 }, (t) => quotedKey(t, `k-${randomBytes(3).toString("hex")}`));

/** A run carries `key` and its model quotes it everywhere it writes: no 8 characters of it in an answer, file or log line. */
async function quotedKey(t, key) {
  const { api, data, dir, logs } = await setup(t);
  const file = join(dir, "key.txt");
  writeFileSync(file, key);
  assert.equal((await api("POST", "/agents", SEARCHER("quotes", ["read", "web_search"]))).status, 201);
  const started = await api("POST", "/agents/quotes/runs", { input: { content: `Quote the key in ${file}` }, keys: { PARALLEL_API_KEY: key } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows, last } = await follow(api, started.body.run_id, ENDED, { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  for (const kind of ["thinking", "tool_use", "final_answer"]) assert.ok(rows.some((row) => row.kind === kind), `a ${kind} row: ${JSON.stringify(rows.map((row) => row.kind))}`);
  const said = await answersOf(api, started.body.run_id);
  for (const form of [key, Buffer.from(key).toString("base64")]) assert.ok(!holdsRun(said, form), `an answer holds part of ${form.slice(0, 12)}…`);
  assert.deepEqual(filesHolding(data, key), [], "no file of the store holds the key");
  assert.ok(!holdsRun(logs.join("\n"), key), "no log line holds the key");
}

test("keys names only the tool keys the run's revision reads, each a value of 8 or more characters with no space or control character: another tool's key, a name that is no tool key, a value that is not text, too short or holds a space or a newline, or keys that is not an object is 422 by name, never echoed, and nothing starts", { timeout: 60_000 }, async (t) => {
  const { api } = await setup(t);
  assert.equal((await api("POST", "/agents", SEARCHER("searcher"))).status, 201);
  const key = newKey();
  const short = randomBytes(4).toString("hex").slice(0, 7);
  const cases = [
    [{ MONID_API_KEY: key }, "keys.MONID_API_KEY", "not_an_option", key],
    [{ NOT_A_TOOL_KEY: key }, "keys.NOT_A_TOOL_KEY", "not_an_option", key],
    [{ AGENTRUN_TOKEN: key }, "keys.AGENTRUN_TOKEN", "not_an_option", key],
    [{ PARALLEL_API_KEY: 42 }, "keys.PARALLEL_API_KEY", "wrong_type", key],
    [{ PARALLEL_API_KEY: "" }, "keys.PARALLEL_API_KEY", "invalid", key],
    [{ PARALLEL_API_KEY: short }, "keys.PARALLEL_API_KEY", "invalid", short],
    [{ PARALLEL_API_KEY: `${key} x` }, "keys.PARALLEL_API_KEY", "invalid", key],
    [{ PARALLEL_API_KEY: `${key}\n` }, "keys.PARALLEL_API_KEY", "invalid", key],
    [key, "keys", "wrong_type", key],
  ];
  for (const [keys, field, reason, value] of cases) {
    const answer = await api("POST", "/agents/searcher/runs", { input: { content: "Search the web for widgets." }, keys });
    assert.deepEqual([answer.status, answer.body.error?.code], [422, "input_invalid"], `${field}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual(answer.body.error.fields.map((one) => [one.field, one.reason]), [[field, reason]], JSON.stringify(answer.body.error.fields));
    assert.ok(!JSON.stringify(answer.body).includes(value), `${field}: the refusal never echoes the value`);
  }
  const tooShort = await api("POST", "/agents/searcher/runs", { input: { content: "x" }, keys: { PARALLEL_API_KEY: short } });
  assert.match(tooShort.body.error.fields[0].message, /\b8\b/, "the refusal names the minimum");
  assert.match((await api("POST", "/agents/searcher/runs", { input: { content: "x" }, keys: { MONID_API_KEY: key } })).body.error.message, /MONID_API_KEY is a key no tool of this run's revision reads: it reads PARALLEL_API_KEY\./);
  assert.equal((await api("GET", "/runs?agent=searcher")).body.runs.length, 0, "no run was made");
  // An inline run's keys are checked against the revision its definition makes, as a stored agent's are.
  const inline = await api("POST", "/runs", { external: { source: "host", kind: "agent", id: "a1", version: 1 }, definition: { name: "inline", instructions: "Answer.", tools: ["read"] }, input: { content: "Say hello." }, keys: { PARALLEL_API_KEY: key } });
  assert.deepEqual([inline.status, inline.body.error?.fields?.map((one) => one.field)], [422, ["keys.PARALLEL_API_KEY"]], JSON.stringify(inline.body));
});

/** A template package that searches the web and declares the Parallel key, in a folder of its own; `extra`, more lines of
 *  its manifest. */
function searcherTemplate(root, extra = []) {
  const dir = join(root, "templates", "searcher");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), [
    "---",
    "name: searcher",
    "version: 1.0.0",
    "description: Searches the web for what it is asked.",
    "model: { tier: strong }",
    "tools: [web_search, read]",
    "secrets: [PARALLEL_API_KEY]",
    ...extra,
    "---",
    "Search the web for what you are asked, then answer.",
    "",
  ].join("\n"));
  return join(root, "templates");
}

/** The searcher's manifest lines for a schedule trigger, `morning`, and the per-run cap its runs take. */
const MORNING = ["budget: { per_run_usd: 0.5 }", "triggers:", "  - name: morning", "    source: { kind: schedule, cron: \"0 9 * * *\", timezone: UTC }", "    target: { kind: start_run, input: { content: \"Search the web for widgets.\" } }"];

/** The apply's warnings for the triggers it skipped: field and reason, and the words. */
const skippedOf = (body) => body.warnings.filter((one) => /^triggers\.\d+$/.test(one.field)).map((one) => [one.field, one.reason, one.message]);

test("AGENTRUN_RUN_KEYS=1 with no launch hook: a template's schedule trigger, whose firings would start runs without the key its agent owes, is not made: skipped at triggers.0, not_set_up_here, saying so and the fix, in the plan as in the apply, which stays 201", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const { api, store } = await setup(t, { templates: searcherTemplate(dir, MORNING), runKeys: true, runner: false });
  const planned = await api("POST", "/templates/searcher/apply", { dry_run: true });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.deepEqual(planned.body.plan.triggers.map((one) => [one.name, one.kind, one.action]), [["morning", "schedule", "skip"]], JSON.stringify(planned.body.plan.triggers));

  const applied = await api("POST", "/templates/searcher/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.triggers, [], "no trigger is made");
  assert.deepEqual(await store.triggers.list(applied.body.agent_id), [], "the store holds none");
  const skipped = skippedOf(applied.body);
  assert.deepEqual(skipped.map(([field, reason]) => [field, reason]), [["triggers.0", "not_set_up_here"]], JSON.stringify(applied.body.warnings));
  const [[, , words]] = skipped;
  assert.equal(planned.body.plan.triggers[0].reason, words, "the plan skips it in the apply's words");
  for (const said of [/PARALLEL_API_KEY/, /AGENTRUN_RUN_KEYS=1/, /keys/, /AGENTRUN_LAUNCH_HOOK_URL/]) assert.match(words, said);
});

test("AGENTRUN_RUN_KEYS=1 on a server that holds the key, or the setting off: the template's schedule trigger is made, planned as made", { timeout: 60_000 }, async (t) => {
  for (const runKeys of [true, false]) {
    await t.test(`runKeys ${runKeys}`, async (t) => {
      const dir = await scratch(t);
      const { api, store } = await setup(t, { templates: searcherTemplate(dir, MORNING), runKeys, runner: false, env: { PARALLEL_API_KEY: newKey() } });
      const planned = await api("POST", "/templates/searcher/apply", { dry_run: true });
      assert.deepEqual(planned.body.plan?.triggers?.map((one) => [one.name, one.action]), [["morning", "create"]], JSON.stringify(planned.body));
      const applied = await api("POST", "/templates/searcher/apply", {});
      assert.equal(applied.status, 201, JSON.stringify(applied.body));
      assert.deepEqual(skippedOf(applied.body), [], "nothing skipped");
      assert.deepEqual((await store.triggers.list(applied.body.agent_id)).map((one) => one.name), ["morning"]);
    });
  }
});

test("AGENTRUN_RUN_KEYS=1 with no launch hook: a trigger made or moved through the API to start runs of an agent that owes a key it can't carry, or to message one of its runs, is 409 agent_not_runnable naming the key, nothing made or changed", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const { api, store } = await setup(t, { templates: searcherTemplate(dir), runKeys: true, runner: false });
  const applied = await api("POST", "/templates/searcher/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const owing = applied.body.agent_id;
  const refusedAt = (answer, what) => assert.deepEqual([answer.status, answer.body.error?.code, answer.body.error?.fields?.map((one) => [one.field, one.reason])], [409, "agent_not_runnable", [["keys.PARALLEL_API_KEY", "not_set_up_here"]]], `${what}: ${JSON.stringify(answer.body)}`);

  const start = { kind: "start_run", agent_id: owing, input: { content: "Search the web for widgets." }, max_cost_usd: 0.5 };
  refusedAt(await api("POST", "/triggers", { name: "nightly", source: { kind: "schedule", every_s: 3600 }, target: start }), "a start_run trigger");
  const run = await api("POST", `/agents/${owing}/runs`, { input: { content: "Search the web for widgets." }, max_cost_usd: 0.5, keys: { PARALLEL_API_KEY: newKey() } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const poke = { kind: "message_run", run_id: run.body.run_id, input: { content: "Once more." } };
  refusedAt(await api("POST", "/triggers", { name: "poke", source: { kind: "schedule", every_s: 3600 }, target: poke }), "a message_run trigger");
  assert.deepEqual(await store.triggers.list(owing), [], "none made");

  // A trigger on an agent that owes nothing, moved to one that does: refused, left as it was.
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const plain = await api("POST", "/triggers", { name: "nightly", source: { kind: "schedule", every_s: 3600 }, target: { ...start, agent_id: "plain" } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  refusedAt(await api("PATCH", `/triggers/${plain.body.id}`, { target: start }), "a start_run trigger moved");
  refusedAt(await api("PATCH", `/triggers/${plain.body.id}`, { target: poke }), "a trigger moved to message the run");
  assert.equal((await api("GET", `/triggers/${plain.body.id}`)).body.target.agent_id, "plain", "left as it was");
  assert.equal((await api("PATCH", `/triggers/${plain.body.id}`, { name: "renamed" })).status, 200, "a change that keeps its target is taken");
});

test("off by default: a template's apply that needs a tool key this server does not hold is refused, nothing made", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const { api } = await setup(t, { templates: searcherTemplate(dir) });
  const refused = await api("POST", "/templates/searcher/apply", {});
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "agent_not_runnable"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((one) => [one.field, one.reason]), [["secrets.PARALLEL_API_KEY", "not_set_up_here"]]);
});

test("AGENTRUN_RUN_KEYS=1: the apply makes the agent with a warning naming the key; a run without it is 409 naming keys.PARALLEL_API_KEY, one that carries it runs, and a message that opens the ended run again carries it again", { timeout: 150_000 }, async (t) => {
  const dir = await scratch(t);
  const { api, data, logs } = await setup(t, { templates: searcherTemplate(dir), runKeys: true });
  const applied = await api("POST", "/templates/searcher/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const warned = applied.body.warnings.filter((one) => one.field === "secrets.PARALLEL_API_KEY");
  assert.deepEqual(warned.map((one) => one.reason), ["not_set_up_here"], JSON.stringify(applied.body.warnings));
  assert.match(warned[0].message, /PARALLEL_API_KEY is not set on this server: it takes it from each run \(AGENTRUN_RUN_KEYS=1\), so a run that does not carry it in keys is refused\./);
  const agentId = applied.body.agent_id;

  const refused = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Search the web for widgets." } });
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "agent_not_runnable"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((one) => [one.field, one.reason]), [["keys.PARALLEL_API_KEY", "not_set_up_here"]], JSON.stringify(refused.body.error.fields));

  const key = newKey();
  const started = await api("POST", `/agents/${agentId}/runs`, { input: { content: "Search the web for widgets." }, keys: { PARALLEL_API_KEY: key } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  assert.equal((await follow(api, runId, ENDED, { deadlineMs: 90_000 })).last.status, "completed");

  // Its keys ended with its turn: a message that opens it again carries them again, else it is refused.
  const bare = await api("POST", `/runs/${runId}/messages`, { content: "Once more." });
  assert.deepEqual([bare.status, bare.body.error?.code, bare.body.error?.fields?.map((one) => one.field)], [409, "agent_not_runnable", ["keys.PARALLEL_API_KEY"]], JSON.stringify(bare.body));
  const wrong = await api("POST", `/runs/${runId}/messages`, { content: "Once more.", keys: { MONID_API_KEY: key } });
  assert.deepEqual([wrong.status, wrong.body.error?.fields?.map((one) => one.field)], [422, ["keys.MONID_API_KEY"]], JSON.stringify(wrong.body));
  const again = newKey();
  const carried = await api("POST", `/runs/${runId}/messages`, { content: "Once more.", keys: { PARALLEL_API_KEY: again } });
  assert.equal(carried.status, 202, JSON.stringify(carried.body));
  assert.equal((await follow(api, runId, ENDED, { deadlineMs: 90_000 })).last.status, "completed");

  for (const one of [key, again]) {
    assert.deepEqual(filesHolding(data, one), [], "no file of the store holds a run key");
    assert.ok(!(await answersOf(api, runId)).includes(one), "no answer holds a run key");
    assert.ok(!logs.join("\n").includes(one), "no log line holds a run key");
  }
});

test("a message's keys replace the run's whole set, an empty one too: `keys: {}` on a queued run that still holds its key leaves it none, so under AGENTRUN_RUN_KEYS=1 it is 409 naming keys.PARALLEL_API_KEY", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  // No runner: the run stays queued, its launch still holding the key it carried.
  const { api } = await setup(t, { templates: searcherTemplate(dir), runKeys: true, runner: false });
  const applied = await api("POST", "/templates/searcher/apply", {});
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const started = await api("POST", `/agents/${applied.body.agent_id}/runs`, { input: { content: "Search the web for widgets." }, keys: { PARALLEL_API_KEY: newKey() } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;

  const emptied = await api("POST", `/runs/${runId}/messages`, { content: "Once more.", keys: {} });
  assert.deepEqual([emptied.status, emptied.body.error?.code, emptied.body.error?.fields?.map((one) => one.field)], [409, "agent_not_runnable", ["keys.PARALLEL_API_KEY"]], JSON.stringify(emptied.body));
  const carried = await api("POST", `/runs/${runId}/messages`, { content: "Once more.", keys: { PARALLEL_API_KEY: newKey() } });
  assert.equal(carried.status, 202, JSON.stringify(carried.body));
  const kept = await api("POST", `/runs/${runId}/messages`, { content: "And again." });
  assert.equal(kept.status, 202, "a message without keys keeps the keys the queued run holds");
});

test("AGENTRUN_RUN_KEYS=1 leaves the monid key the server's: a template granting monid tools with none here is refused at its apply, at secrets.MONID_API_KEY, saying why, nothing made", { timeout: 60_000 }, async (t) => {
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "enricher"), { recursive: true });
  writeFileSync(join(root, "enricher", "agent.md"), "---\nname: enricher\nversion: 1.0.0\ndescription: Enriches a person.\ntools: [\"monid:faux/person/enrich\"]\nsecrets: [MONID_API_KEY]\n---\nRun.\n");
  const { api, store } = await setup(t, { templates: root, runKeys: true });
  const refused = await api("POST", "/templates/enricher/apply", {});
  assert.deepEqual([refused.status, refused.body.error?.code], [409, "agent_not_runnable"], JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((one) => [one.field, one.reason]), [["secrets.MONID_API_KEY", "not_set_up_here"]]);
  assert.equal(refused.body.error.fields[0].message, "MONID_API_KEY is not set on this server, and a run can't bring it (AGENTRUN_RUN_KEYS=1): the agent's monid tools are checked with this server's key when it is saved.");
  assert.deepEqual(await store.agents.list(), [], "nothing made");
});

test("AGENTRUN_RUN_KEYS is 1 or 0: any other value is refused in words", async () => {
  const { runKeysFrom } = await import("../dist/run-keys.js");
  assert.equal(runKeysFrom({}), false);
  assert.equal(runKeysFrom({ AGENTRUN_RUN_KEYS: "0" }), false);
  assert.equal(runKeysFrom({ AGENTRUN_RUN_KEYS: "false" }), false);
  assert.equal(runKeysFrom({ AGENTRUN_RUN_KEYS: "1" }), true);
  assert.equal(runKeysFrom({ AGENTRUN_RUN_KEYS: "true" }), true);
  assert.throws(() => runKeysFrom({ AGENTRUN_RUN_KEYS: "yes" }), /AGENTRUN_RUN_KEYS is 1 \(each run brings the tool keys this server does not hold\) or 0, not "yes"/);
});
