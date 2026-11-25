// The store's side of GET /runs' window and model filters (Runs.listed's startedFrom, startedBefore and model), on each
// store the tests run on (SQLite, and Postgres under npm run test:pg): the runs started in [startedFrom, startedBefore),
// and the runs that sent at least one request to the model: their metrics' `models` hold it as a key, exactly (no prefix,
// no case folding). A run with no metrics yet used none.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWithRevision, storeOn } from "./store-helpers.mjs";

const T = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;

test("the store lists the runs started in [startedFrom, startedBefore), and those that used a model, on its own database", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  const run = (id, startedAt, models) =>
    store.importRun({
      id, agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "pi", session: id }, launch: { body: { input: { content: "hi" }, title: id, place: { mode: "runner" } } }, startedAt, transcript: [],
      ...(models ? { metrics: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, requests: 1, unmetered: 0, models, model: Object.keys(models)[0], tools: {} } } : {}),
    });
  await run("before", T - 1, { "openai/gpt-5": 1, "anthropic/claude-sonnet-5": 1 });
  await run("at-from", T, { "anthropic/claude-sonnet-5": 2 });
  await run("inside", T + HOUR - 1, { "openai/gpt-5.1": 1 });
  await run("at-to", T + HOUR);
  const ids = async (filter) => (await store.runs.listed({ archived: false, limit: 10, ...filter })).rows.map(({ row }) => row.id).sort();

  assert.deepEqual(await ids({ startedFrom: T, startedBefore: T + HOUR }), ["at-from", "inside"], "a run at from is in, one at to is out");
  assert.deepEqual(await ids({ startedFrom: T }), ["at-from", "at-to", "inside"]);
  assert.deepEqual(await ids({ startedBefore: T }), ["before"]);
  assert.deepEqual(await ids({ startedFrom: T + 2 * HOUR }), [], "a window no run started in");
  assert.deepEqual(await ids({ model: "anthropic/claude-sonnet-5" }), ["at-from", "before"], "every run that used it");
  assert.deepEqual(await ids({ model: "openai/gpt-5" }), ["before"], "a run that used two models is listed under each, and a name is matched whole");
  assert.deepEqual(await ids({ model: "openai/gpt" }), [], "never as a prefix");
  assert.deepEqual(await ids({ model: "OpenAI/GPT-5" }), [], "never with its case folded");
  assert.deepEqual(await ids({ model: "anthropic/claude-sonnet-5", startedFrom: T }), ["at-from"]);
  assert.deepEqual(await ids({ model: "anthropic/claude-opus-5" }), [], "a model no run used");
  assert.deepEqual(await ids({ model: "'; DROP TABLE runs; --" }), [], "bound, never spliced");
  assert.equal((await ids({})).length, 4);
});
