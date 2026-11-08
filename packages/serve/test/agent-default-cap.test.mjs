// An agent's default spend cap, through the API: a definition's max_cost_usd is kept with its revision and caps every run
// started without one of its own, a trigger's included, read when the firing starts; a run's own cap wins; leaving the
// field out of an edit never removes the cap, only 0 does; a workflow agent keeps one as an agentic agent does; and a
// trigger with no cap of its own needs the agent's.
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
  // An edit that leaves it out never removes a spend limit: the agent keeps its default, and the next run is capped by it.
  const edit = async (extra) => {
    const { max_cost_usd: _, version: __, ...definition } = (await api("GET", "/agents/capped")).body.definition;
    return api("PUT", "/agents/capped/definition", { definition: { ...definition, instructions: `Answer. ${Math.random()}`, ...extra } });
  };
  const kept = await edit({});
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.equal((await api("GET", "/agents/capped")).body.definition.max_cost_usd, 0.5, "kept on an edit that leaves it out");
  const stillCapped = (await api("POST", "/agents/capped/runs", { input: { content: "Answer soon." } })).body;
  assert.equal(stillCapped.cost.cap_usd, 0.5);
  await follow(api, stillCapped.run_id, ["completed"]);
  // Only an explicit 0 clears it: no default, and the next run is uncapped.
  assert.equal((await edit({ max_cost_usd: 0 })).status, 200);
  assert.equal((await api("GET", "/agents/capped")).body.definition.max_cost_usd, undefined, "cleared by 0");
  const uncapped = (await api("POST", "/agents/capped/runs", { input: { content: "Answer soon." } })).body;
  assert.equal(uncapped.cost.cap_usd, null);
  await follow(api, uncapped.run_id, ["completed"]);
  // Refused: anything but a number of at least 0 (null included).
  for (const value of [-1, "1", null]) assert.deepEqual(fields(await api("POST", "/agents", agent(`bad-${String(value)}`, { max_cost_usd: value }))), [["definition.max_cost_usd", "wrong_type"]], String(value));
  // A workflow agent keeps a default cap, and its cap mode, as an agentic one does: each run started with none takes it.
  const flow = await api("POST", "/agents", flowAgent("flow", answerFlow(), { max_cost_usd: 1, cap_mode: "strict" }));
  assert.deepEqual(flow.body.error?.fields?.map((f) => [f.field, f.reason]) ?? [], []);
  assert.equal(flow.status, 201);
  assert.deepEqual([flow.body.definition.max_cost_usd, flow.body.definition.cap_mode], [1, "strict"]);
  const flowRun = (await api("POST", "/agents/flow/runs", { input: { question: "What is six times seven?" } })).body;
  assert.deepEqual([flowRun.cost.cap_usd, flowRun.cap_mode], [1, "strict"], JSON.stringify(flowRun));
  await follow(api, flowRun.run_id, ["completed", "failed"]);
  const flowZero = await api("POST", "/agents", flowAgent("flow-zero", answerFlow(), { max_cost_usd: 0 }));
  assert.equal(flowZero.status, 201, JSON.stringify(flowZero.body));
  assert.equal(flowZero.body.definition.max_cost_usd, undefined);
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
  // An edit that leaves it out keeps it; one that clears it (0) leaves the trigger with no cap: a new one with no cap of
  // its own is refused, and the next firing starts no uncapped run: it fails, saying why.
  const { max_cost_usd: ___, version: ____, ...plain } = (await api("GET", "/agents/nightly")).body.definition;
  assert.equal((await api("PUT", "/agents/nightly/definition", { definition: { ...plain, instructions: "Answer, kept." } })).status, 200);
  assert.equal((await api("GET", "/agents/nightly")).body.definition.max_cost_usd, 0.7, "kept");
  assert.equal((await edit({ max_cost_usd: 0 })).status, 200);
  const late = await api("POST", "/triggers", { ...schedule("nightly", { every_s: 600, start_at: "2026-06-01T01:00:00Z" }), target });
  assert.deepEqual([late.status, ...fields(late)], [422, ["target.max_cost_usd", "missing"]]);
  clock.to("2026-06-01T00:30:00Z");
  const [third] = await firings(api, id, 3);
  assert.deepEqual([third.status, third.run_id, third.error?.code], ["failed", null, "input_invalid"]);
  assert.match(third.error.message, /max_cost_usd/);
  assert.equal((await api("GET", "/agents/nightly/runs")).body.runs.length, 2, "no uncapped run");
});

test("a definition whose default cap would keep every default run from running is refused at save, with the reason a run would get: claude-agent's or codex's own search, picked, under a cap", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  for (const harness of ["claude-agent", "codex"]) {
    const native = { harness, tools: ["web_search"], tool_settings: { web_search: { provider: "native" } } };
    // Uncapped, its own search runs: saved.
    const plain = await api("POST", "/agents", agent(`native-${harness}`, native));
    assert.equal(plain.status, 201, `${harness}: ${JSON.stringify(plain.body)}`);
    // With a default cap, every run started without its own would be agent_not_runnable: refused, saying why.
    const capped = await api("POST", "/agents", agent(`capped-${harness}`, { ...native, max_cost_usd: 0.5 }));
    assert.deepEqual([capped.status, ...fields(capped)], [422, ["definition.tools[0]", "not_an_option"]], `${harness}: ${JSON.stringify(capped.body)}`);
    assert.match(capped.body.error.fields[0].message, /under a spend cap/);
    assert.match(capped.body.error.fields[0].fix, /max_cost_usd/);
    // So is the edit that sets one, and an edit that picks it on an agent that keeps one (left out, it is kept).
    const { version: _, ...definition } = (await api("GET", `/agents/native-${harness}`)).body.definition;
    const setting = await api("PUT", `/agents/native-${harness}/definition`, { definition: { ...definition, max_cost_usd: 0.5 } });
    assert.deepEqual([setting.status, ...fields(setting)], [422, ["definition.tools[0]", "not_an_option"]], `${harness}: ${JSON.stringify(setting.body)}`);
    assert.equal((await api("POST", "/agents", agent(`auto-${harness}`, { harness, tools: ["web_search"], max_cost_usd: 0.5 }))).status, 201, `${harness}: auto works under a cap`);
    const { version: __, ...auto } = (await api("GET", `/agents/auto-${harness}`)).body.definition;
    const picking = await api("PUT", `/agents/auto-${harness}/definition`, { definition: { ...auto, max_cost_usd: undefined, tool_settings: { web_search: { provider: "native" } } } });
    assert.deepEqual([picking.status, ...fields(picking)], [422, ["definition.tools[0]", "not_an_option"]], `${harness}: ${JSON.stringify(picking.body)}`);
  }
});

test("a cap that parses to Infinity (1e999) is no cap: refused on a run, a trigger's target and a definition, never taken as uncapped", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl, token } = await serve(t);
  // JSON.stringify writes Infinity as null: the body goes as text, as a caller's would.
  const raw = async (method, path, text) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: text });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const run = await raw("POST", "/agents/plain/runs", '{"input":{"content":"Answer soon."},"max_cost_usd":1e999}');
  assert.deepEqual([run.status, ...fields(run)], [422, ["max_cost_usd", "wrong_type"]], JSON.stringify(run.body));
  assert.equal((await api("GET", "/agents/plain/runs")).body.runs.length, 0, "no run started");
  const target = '{"kind":"start_run","agent_id":"plain","input":{"content":"Answer soon."},"max_cost_usd":1e999}';
  const trigger = await raw("POST", "/triggers", `{"name":"inf","source":{"kind":"schedule","every_s":600},"target":${target}}`);
  assert.deepEqual([trigger.status, ...fields(trigger)], [422, ["target.max_cost_usd", "wrong_type"]], JSON.stringify(trigger.body));
  const made = await api("POST", "/triggers", { name: "fine", source: { kind: "schedule", every_s: 600 }, target: { kind: "start_run", agent_id: "plain", input: { content: "Answer soon." }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const patched = await raw("PATCH", `/triggers/${made.body.id}`, `{"target":${target}}`);
  assert.deepEqual([patched.status, ...fields(patched)], [422, ["target.max_cost_usd", "wrong_type"]], JSON.stringify(patched.body));
  const definition = await raw("POST", "/agents", '{"definition":{"id":"inf","name":"inf","instructions":"Answer.","max_cost_usd":1e999}}');
  assert.deepEqual([definition.status, ...fields(definition)], [422, ["definition.max_cost_usd", "wrong_type"]], JSON.stringify(definition.body));
  const edit = await raw("PUT", "/agents/plain/definition", '{"definition":{"id":"plain","name":"plain","instructions":"Answer.","max_cost_usd":1e999}}');
  assert.deepEqual([edit.status, ...fields(edit)], [422, ["definition.max_cost_usd", "wrong_type"]], JSON.stringify(edit.body));
});
