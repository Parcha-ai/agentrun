// An agent's default spend cap, through the API: a definition's max_cost_usd is kept with its revision and caps every run
// started without one of its own, a trigger's included, read when the firing starts; a run's own cap wins; a workflow
// agent keeps none, since a workflow run is not capped here; and a trigger with no cap of its own needs the agent's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, answerFlow, flowAgent, follow, serve } from "./support.mjs";
import { fakeClock, firings, made, schedule } from "./trigger-support.mjs";

const fields = (answer) => answer.body.error.fields.map((f) => [f.field, f.reason]);

test("a definition's max_cost_usd is the agent's default cap: kept with its revision, read back, and used by a run started without one; a run's own wins", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const created = await api("POST", "/agents", agent("capped", { max_cost_usd: 0.5 }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await api("GET", "/agents/capped")).body.definition.max_cost_usd, 0.5, "read back");
  const byDefault = (await api("POST", "/agents/capped/runs", { input: { content: "Answer soon." } })).body;
  assert.equal(byDefault.cost.cap_usd, 0.5, "the agent's default");
  const own = (await api("POST", "/agents/capped/runs", { input: { content: "Answer soon." }, max_cost_usd: 2 })).body;
  assert.equal(own.cost.cap_usd, 2, "the run's own wins");
  await follow(api, byDefault.run_id, ["completed"]);
  await follow(api, own.run_id, ["completed"]);
  // A definition saved without it keeps none, as it keeps no tool_settings it leaves out: the next run is uncapped.
  const { definition } = (await api("GET", "/agents/capped")).body;
  const { max_cost_usd: _, version: __, ...without } = definition;
  const saved = await api("PUT", "/agents/capped/definition", { definition: without });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await api("GET", "/agents/capped")).body.definition.max_cost_usd, undefined);
  const uncapped = (await api("POST", "/agents/capped/runs", { input: { content: "Answer soon." } })).body;
  assert.equal(uncapped.cost.cap_usd, null);
  await follow(api, uncapped.run_id, ["completed"]);
  // Refused: not a number above 0, and any on a workflow agent, whose runs are not capped here.
  for (const value of [0, -1, "1"]) assert.deepEqual(fields(await api("POST", "/agents", agent(`bad-${String(value)}`, { max_cost_usd: value }))), [["definition.max_cost_usd", "wrong_type"]], String(value));
  const flow = await api("POST", "/agents", flowAgent("flow", answerFlow(), { max_cost_usd: 1 }));
  assert.deepEqual(fields(flow), [["definition.max_cost_usd", "not_allowed"]]);
  assert.match(flow.body.error.fields[0].message, /workflow/);
});

test("a trigger with no max_cost_usd of its own caps each run with the agent's default as it stands when the firing starts; with neither it is refused, and a firing that finds none fails", { timeout: 180_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const { api } = await serve(t, { triggerClock: clock });
  await made(api, "nightly", { max_cost_usd: 0.5 });
  await made(api, "bare");
  const { max_cost_usd: _, ...target } = schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }).target;
  const bare = await api("POST", "/triggers", { ...schedule("bare", { every_s: 600 }), target: { ...target, agent_id: "bare" } });
  assert.deepEqual([bare.status, ...fields(bare)], [422, ["target.max_cost_usd", "missing"]]);
  assert.match(bare.body.error.fields[0].message, /the agent's/);
  const created = await api("POST", "/triggers", { ...schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }), target });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  clock.to("2026-06-01T00:10:00Z");
  const [first] = await firings(api, id, 1);
  assert.equal((await api("GET", `/runs/${first.run_id}`)).body.cost.cap_usd, 0.5, "the agent's default");
  await follow(api, first.run_id, ["completed"]);
  // The agent's default moves: the next firing reads it then.
  const edit = async (extra) => {
    const { max_cost_usd: __, version: ___, ...definition } = (await api("GET", "/agents/nightly")).body.definition;
    return api("PUT", "/agents/nightly/definition", { definition: { ...definition, ...extra } });
  };
  assert.equal((await edit({ max_cost_usd: 0.7 })).status, 200);
  clock.to("2026-06-01T00:20:00Z");
  const [second] = await firings(api, id, 2);
  assert.equal((await api("GET", `/runs/${second.run_id}`)).body.cost.cap_usd, 0.7, "the default as it stands");
  await follow(api, second.run_id, ["completed"]);
  // Gone, the next firing starts no uncapped run: it fails, saying why.
  assert.equal((await edit({})).status, 200);
  clock.to("2026-06-01T00:30:00Z");
  const [third] = await firings(api, id, 3);
  assert.deepEqual([third.status, third.run_id, third.error?.code], ["failed", null, "input_invalid"]);
  assert.match(third.error.message, /max_cost_usd/);
  assert.equal((await api("GET", "/agents/nightly/runs")).body.runs.length, 2, "no uncapped run");
});
