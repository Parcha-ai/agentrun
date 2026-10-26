// Archiving, a route of this server outside the /v2 contract: an archived agent or run is hidden from the lists and kept
// with its history. Every read by id still answers, with archived_at; /usage still counts it; DELETE stays 405.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { agent, follow, scratch, serve, startRun } from "./support.mjs";

const ids = (list, key) => list.map((item) => item[key]);

/** A server with two agents, each with one completed run. */
async function two(t) {
  const server = await serve(t);
  const kept = await startRun(server.api, "kept", "What is six times seven?");
  const old = await startRun(server.api, "old", "What is six times seven?");
  for (const run of [kept, old]) await follow(server.api, run.run_id, ["completed"]);
  return { ...server, kept: kept.run_id, old: old.run_id };
}

test("archiving an agent hides it and its runs from every list, keeps every read by id, and unarchiving brings them back", async (t) => {
  const { api, kept, old } = await two(t);
  const archived = await api("POST", "/agents/old/archive");
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.agent_id, "old");
  assert.match(archived.body.archived_at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(ids((await api("GET", "/agents")).body.agents, "agent_id"), ["kept"]);
  assert.deepEqual(ids((await api("GET", "/runs")).body.runs, "run_id"), [kept]);
  assert.deepEqual((await api("GET", "/agents/old/runs")).body.runs, []);
  const read = await api("GET", "/agents/old");
  assert.deepEqual([read.status, read.body.archived_at], [200, archived.body.archived_at]);
  const run = await api("GET", `/runs/${old}`);
  assert.deepEqual([run.status, run.body.archived_at, run.body.status], [200, archived.body.archived_at, "completed"]);
  assert.equal((await api("GET", `/runs/${old}/timeline`)).status, 200);
  assert.equal((await api("GET", "/agents/kept")).body.archived_at, null);
  const back = await api("POST", "/agents/old/unarchive");
  assert.deepEqual([back.status, back.body.archived_at], [200, null]);
  assert.deepEqual(ids((await api("GET", "/agents")).body.agents, "agent_id").sort(), ["kept", "old"]);
  assert.equal((await api("GET", "/runs")).body.runs.length, 2);
});

test("?archived=true lists only what is archived; another value is 400", async (t) => {
  const { api, old } = await two(t);
  await api("POST", "/agents/old/archive");
  assert.deepEqual(ids((await api("GET", "/agents?archived=true")).body.agents, "agent_id"), ["old"]);
  assert.deepEqual(ids((await api("GET", "/runs?archived=true")).body.runs, "run_id"), [old]);
  assert.deepEqual(ids((await api("GET", "/agents/old/runs?archived=true")).body.runs, "run_id"), [old]);
  assert.deepEqual(ids((await api("GET", "/agents?archived=false")).body.agents, "agent_id"), ["kept"]);
  const bad = await api("GET", "/runs?archived=yes");
  assert.deepEqual([bad.status, bad.body.error.code], [400, "bad_request"]);
});

test("archiving one run hides only it; archive and unarchive are idempotent, and an unknown id is 404", async (t) => {
  const { api, kept, old } = await two(t);
  const first = await api("POST", `/runs/${kept}/archive`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.run_id, kept);
  const again = await api("POST", `/runs/${kept}/archive`);
  assert.deepEqual([again.status, again.body.archived_at], [200, first.body.archived_at], "archiving it again keeps the first time");
  assert.deepEqual(ids((await api("GET", "/runs")).body.runs, "run_id"), [old]);
  assert.deepEqual(ids((await api("GET", "/agents")).body.agents, "agent_id").sort(), ["kept", "old"], "its agent stays listed");
  assert.deepEqual([(await api("POST", `/runs/${kept}/unarchive`)).body.archived_at, (await api("POST", `/runs/${kept}/unarchive`)).body.archived_at], [null, null]);
  assert.equal((await api("POST", "/agents/nope/archive")).status, 404);
  assert.equal((await api("POST", "/runs/nope/archive")).status, 404);
});

test("/usage still counts an archived run: the spend happened", async (t) => {
  const { api, old } = await two(t);
  const before = (await api("GET", "/usage")).body.total_usd;
  await api("POST", "/agents/old/archive");
  await api("POST", `/runs/${old}/archive`);
  assert.equal((await api("GET", "/usage")).body.total_usd, before);
  assert.deepEqual(ids((await api("GET", "/usage?group_by=agent")).body.lines, "group").sort(), ["kept", "old"]);
});

test("a run of an archived agent is refused, 409 agent_not_runnable saying it is archived; a run already going keeps going", async (t) => {
  const { api } = await serve(t);
  const go = join(await scratch(t), "go");
  const { run_id } = await startRun(api, "slow", `Answer once ${go} exists.`);
  await follow(api, run_id, ["working"]);
  assert.equal((await api("POST", "/agents/slow/archive")).status, 200);
  const refused = await api("POST", "/agents/slow/runs", { input: { content: "again" } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "agent_not_runnable"], JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /archived/);
  assert.equal(typeof refused.body.error.details.archived_at, "string");
  await writeFile(go, "");
  await follow(api, run_id, ["completed"]);
  assert.equal((await api("GET", `/runs/${run_id}`)).body.result.final_answer, "Now.");
});

test("archiving deletes nothing: DELETE stays 405, and capabilities name the archive routes", async (t) => {
  const { api } = await serve(t);
  assert.equal((await api("POST", "/agents", agent("calc"))).status, 201);
  for (const path of ["/agents/calc", "/runs/x"]) assert.equal((await api("DELETE", path)).status, 405, path);
  const caps = (await api("GET", "/capabilities")).body;
  assert.deepEqual(caps.features.archive, {
    agents: true, runs: true, list_param: "archived",
    routes: ["POST /agents/{id}/archive", "POST /agents/{id}/unarchive", "POST /runs/{id}/archive", "POST /runs/{id}/unarchive"],
  });
});
