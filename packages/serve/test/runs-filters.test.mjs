// GET /runs' window and model filters, for any run, made here or imported: `from` and `to` keep the runs started in
// [from, to) (ISO instants with a zone, either one alone), and `model` the runs that used a model (`provider/model`, as a
// run's metrics name it). The server reads no time zone: the console turns its own dates into instants. A value that is
// no instant with a zone, a `from` after `to`, an empty model, or a second of any of them is 400; a window or a model no
// run has lists none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, follow, serve } from "./support.mjs";

const listed = async (api, query) => {
  const { status, body } = await api("GET", `/runs?${query}`);
  assert.equal(status, 200, `${query}: ${JSON.stringify(body)}`);
  return body.runs.map((run) => run.run_id).sort();
};

const T = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;
const metrics = (models) => {
  const model = Object.entries(models).sort(([, a], [, b]) => b - a)[0][0];
  const requests = Object.values(models).reduce((a, b) => a + b, 0);
  return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests, unmetered: 0, models, model, tools: {}, activeMs: 0 };
};

test("GET /runs' from and to keep the runs started in [from, to), and model the runs that used it; a window or a model no run has lists none", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const live = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  assert.equal(live.status, 202, JSON.stringify(live.body));
  await follow(api, live.body.run_id, ["completed"]);
  const { agentId, revisionId } = await store.runs.get(live.body.run_id);
  const run = async (id, startedAt, models) => {
    await store.importRun({ id, agentId, revisionId, importedFrom: { source: "claude-code", session: id }, launch: { body: { input: { content: "hi" }, title: id, place: { mode: "runner" } } }, startedAt, metrics: metrics(models), transcript: [] });
    return id;
  };
  // Before the window, at its start, just inside its end, at its end.
  const before = await run("imp-before", T - 1, { "anthropic/claude-sonnet-5": 2, "openai/gpt-5": 1 });
  const atFrom = await run("imp-at-from", T, { "openai/gpt-5": 3 });
  const inside = await run("imp-inside", T + HOUR - 1, { "anthropic/claude-haiku-5": 1 });
  const atTo = await run("imp-at-to", T + HOUR, { "anthropic/claude-sonnet-5": 1 });
  const [from, to] = [new Date(T).toISOString(), new Date(T + HOUR).toISOString()];

  assert.deepEqual(await listed(api, `from=${from}&to=${to}`), [atFrom, inside].sort(), "a run at from is in, one at to is out");
  assert.deepEqual(await listed(api, `from=${from}`), [atFrom, inside, atTo, live.body.run_id].sort(), "from alone: every run since");
  assert.deepEqual(await listed(api, `to=${from}`), [before], "to alone: every run before");
  assert.deepEqual(await listed(api, `from=${encodeURIComponent("2026-11-01T01:00:00+01:00")}&to=${encodeURIComponent("2026-10-31T19:00:00.001-05:00")}`), [atFrom], "an instant in any zone, to the ms");
  assert.deepEqual(await listed(api, `from=${from}&to=${from}`), [], "an empty window lists none");
  assert.deepEqual(await listed(api, "from=2027-01-01T00:00:00Z"), [], "a window no run started in lists none");

  assert.deepEqual(await listed(api, "model=openai/gpt-5"), [before, atFrom].sort(), "every run that used the model, its main model or not");
  assert.deepEqual(await listed(api, "model=anthropic/claude-sonnet-5"), [before, atTo].sort(), "a run that used two models is listed under each");
  assert.deepEqual(await listed(api, "model=openai/gpt"), [], "a prefix of a model's name is no model a run used");
  assert.deepEqual(await listed(api, "model=OpenAI/GPT-5"), [], "nor is the name in another case");
  assert.deepEqual(await listed(api, `model=${encodeURIComponent("anthropic/claude-sonnet-5")}&from=${from}`), [atTo], "with the window");
  assert.deepEqual(await listed(api, "model=anthropic/claude-opus-5"), [], "a model no run used lists none");
  assert.deepEqual(await listed(api, "model=gpt-5"), [], "a model's name without its provider is no model a run used");
  assert.equal((await listed(api, `model=anthropic/claude-sonnet-5&limit=1`)).length, 1, "with a page");
  assert.equal((await listed(api, "")).length, 5, "no filter: every run");

  for (const query of [
    `from=${to}&to=${from}`, "from=2026-11-01", "from=2026-11-01T00:00:00", "to=yesterday", "from=", "to=2026-02-30T00:00:00Z", "to=2026-11-01T24:00:00Z",
    `from=${from}&from=${from}`, `to=${to}&to=${to}`, "model=", "model=openai/gpt-5&model=openai/gpt-5",
  ]) {
    const refused = await api("GET", `/runs?${query}`);
    assert.deepEqual([refused.status, refused.body.error?.code], [400, "bad_request"], `${query}: ${JSON.stringify(refused.body)}`);
  }
});

test("a run made here is found by the model its metrics name, in the form a caller passes (provider/model)", { timeout: 120_000 }, async (t) => {
  const { api, store } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  const live = await api("POST", "/agents/calc/runs", { input: { content: "What is six times seven?" } });
  assert.equal(live.status, 202, JSON.stringify(live.body));
  await follow(api, live.body.run_id, ["completed"]);
  const { agentId, revisionId, metrics: kept } = await store.runs.get(live.body.run_id);
  const [model] = Object.keys(kept.models);
  assert.match(model, /^[^/]+\/.+$/, JSON.stringify(kept));
  await store.importRun({ id: "imp-other", agentId, revisionId, importedFrom: { source: "codex", session: "s1" }, launch: { body: { input: { content: "hi" }, title: "other", place: { mode: "runner" } } }, startedAt: T, metrics: metrics({ "openai/gpt-5": 1 }), transcript: [] });
  assert.deepEqual(await listed(api, `model=${encodeURIComponent(model)}`), [live.body.run_id]);
});
