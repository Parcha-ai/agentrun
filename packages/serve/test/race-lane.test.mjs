// The console's race lane, as apps/console/src/lib/race.ts laneStart sends it (its own tests pin laneStart and laneKit;
// this one pins the server's side): an agent of the console's own (POST /agents, with an id of the lane's), then a run of
// it (POST /agents/{id}/runs) with the race's task, cap and labels.
import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, serve } from "./support.mjs";

// Its harness and model are a harness this server offers, on its default model. Its tools are a new agent's: this
// server's offers for that harness as laneKit picks them on a server with no box (every available tool its harness runs,
// none sandbox-only). It names no place, so the server puts it where it puts that agent: the runner. Its task takes
// tools: a file written, then read back.
test("a race lane, as the console's race form sends it, is taken; it does its task with its tools; its agent is the console's to archive", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const caps = (await api("GET", "/capabilities")).body;
  const offered = caps.harnesses.find((h) => h.available && h.default_model);
  assert.ok(offered, "a harness this server runs");
  const lane = { harness: offered.id, model: offered.default_model };
  assert.notEqual(caps.places?.default_place?.mode, "sandbox", "a test server with no box by default");
  const tools = caps.tools
    .filter((tool) => !tool.meta && !tool.call_only && tool.available && tool.harnesses.includes(lane.harness) && !tool.sandbox_only)
    .map((tool) => tool.name);
  assert.ok(tools.includes("write") && tools.includes("read"), JSON.stringify(tools));
  const agent = { id: "race-20261123-1004-1f2e-1-1", version: 1, name: "Race 20261123-1004-1f2e, lane 1", instructions: "Do the task you are given.", harness: lane.harness, model: lane.model, tools, skills: [] };
  const made = await api("POST", "/agents", { definition: agent });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.agent_id, agent.id);
  assert.equal(made.body.external ?? null, null, "the console's own agent, not another system's");
  // The same lane sent again after a lost answer: the id says it was made, and nothing more is.
  const again = await api("POST", "/agents", { definition: agent });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error.code, "agent_exists");

  const labels = { race: "20261123-1004-1f2e", lane: "1", harness: lane.harness, model: lane.model };
  const started = await api("POST", `/agents/${agent.id}/runs`, { input: { content: "Keep LANE-READY everywhere." }, max_cost_usd: 1, labels }, { "idempotency-key": "race-lane-1" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.deepEqual(started.body.labels, labels);
  assert.equal(started.body.cost?.cap_usd, 1, "the race's cap is the run's");
  assert.deepEqual(started.body.place, { mode: "runner" }, "placed as a new agent with these tools is");
  const { rows } = await follow(api, started.body.run_id, ["completed"]);
  // The model's write and read each ran: neither is a tool the lane lacks.
  const results = rows.filter((row) => row.kind === "tool_result").map((row) => [row.tool_name, row.tool_status]);
  assert.deepEqual(results, [["write", "success"], ["read", "success"]], JSON.stringify(rows.filter((row) => row.kind === "tool_result")));
  assert.equal(rows.findLast((row) => row.kind === "final_answer")?.text, "Kept LANE-READY.");
  // The race view finds it by its label.
  const listed = (await api("GET", `/runs?label=${encodeURIComponent("race:20261123-1004-1f2e")}`)).body.runs.map((run) => run.run_id);
  assert.deepEqual(listed, [started.body.run_id]);
  // Once the race is over, the console archives the lane's agent as any of its own.
  const archived = await api("POST", `/agents/${agent.id}/archive`, {});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
});
