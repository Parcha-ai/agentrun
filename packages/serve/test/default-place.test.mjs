// A new agent's place: the box is the default machine. An agentic definition that names no place is saved with the
// Docker box as its place wherever this server has docker (ready, or preparing: its first run waits for the image with
// one timeline row), and one that names no tools gets a shell (bash). Where docker is not there, a new agent is saved as
// before, with no place, and runs on the runner; capabilities say why (places.default_reason). The default is stamped on
// the revision at its create, so an agent saved before keeps running where it ran: a stored revision with no place is the
// runner, whatever this server has now. A workflow is never given a box, and an explicit runner is kept. Everything runs
// on a fake `docker` first on PATH (fixtures/fake-docker.mjs): no daemon is reached, nothing is pulled or built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServe } from "../dist/index.js";
import { agent, client, flowAgent, follow, jsonLines, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const DOCKER = { mode: "sandbox", box: "docker" };
const RUNNER = { mode: "runner" };
const BUILDING = "Preparing the box image: building it (python, git, curl, node, npm, rg)…";

/** A fake docker first on PATH and docker listed in AGENTRUN_BOXES, with the state files `marks` names (build-hold,
 *  build-fail). `release()` lets a held build go on. */
async function fakeDocker(t, marks = {}) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  for (const [name, text] of Object.entries(marks)) await writeFile(join(state, name), text);
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, AGENTRUN_BOXES: "docker" }, ["AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW"]);
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
  const calls = () => jsonLines(join(state, "argv.jsonl"));
  return { runs: () => calls().filter((args) => args[0] === "run"), execs: () => calls().filter((args) => args[0] === "exec"), release: () => rm(join(state, "build-hold"), { force: true }) };
}

const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const placesOf = async (api) => (await api("GET", "/capabilities")).body.places;
async function rowsOf(api, runId) {
  const rows = new Map();
  for (let after = 0; ; ) {
    const page = (await api("GET", `/runs/${runId}/timeline?after=${after}`)).body;
    for (const row of page.rows) rows.set(row.id, row);
    after = page.next_after;
    if (!page.has_more) return [...rows.values()].sort((a, b) => a.seq - b.seq);
  }
}
function answers(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY id").all()
      .flatMap((row) => JSON.parse(row.record).model ?? [])
      .filter((message) => message.role === "toolResult")
      .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    db.close();
  }
}
const storedBodies = (data) => {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT body_json FROM revisions").all().map((row) => JSON.parse(row.body_json));
  } finally {
    db.close();
  }
};
async function probe(api, agentId, plan) {
  const run = await api("POST", `/agents/${agentId}/runs`, { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body;
}
/** A definition as a person writes one first: a name and instructions, no place and no tools. */
const fresh = (id) => ({ definition: { id, name: id, instructions: "Probe." } });

test("demo through the API: a new agent on a server with docker, still preparing, is saved in the Docker box with a shell; its first run waits for the image with one row, then bash writes out.txt in the box and it shows in the run's files", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, { "build-hold": "" });
  const { api, data } = await serve(t, { faux: PROBE });
  const places = await placesOf(api);
  assert.equal(places.boxes.find((box) => box.id === "docker").state, "preparing");
  assert.deepEqual(places.default_place, DOCKER, "a new agent's place, said in capabilities");
  assert.equal("default_reason" in places, false);
  const made = await api("POST", "/agents", fresh("shelly"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  assert.deepEqual(made.body.definition.place, DOCKER, "the default is stamped on the revision");
  assert.deepEqual(made.body.definition.tools, ["bash"], "a new agent in the box gets a shell");
  assert.deepEqual(storedBodies(data).map((body) => [body.place, body.tools]), [[DOCKER, ["bash"]]]);
  const run = await probe(api, "shelly", [{ tool: "bash", args: { command: "printf 'hello from the box\\n' > out.txt" } }]);
  assert.deepEqual(run.place, DOCKER);
  await until(async () => (await rowsOf(api, run.run_id)).some((row) => row.summary === BUILDING), "the preparing row");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(docker.runs(), [], "no box is made while the image is built");
  assert.ok(!["failed", "completed", "cancelled"].includes((await api("GET", `/runs/${run.run_id}`)).body.status), "the run waits, it does not fail");
  await docker.release();
  await follow(api, run.run_id, ["completed"], { deadlineMs: 60_000 });
  const said = answers(data, run.run_id);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), [["bash", false]], JSON.stringify(said));
  assert.equal(docker.runs().length, 1, "one box");
  assert.ok(docker.execs().some((args) => args.join(" ").includes("out.txt")), "bash ran in the box, through docker exec");
  assert.equal((await rowsOf(api, run.run_id)).filter((row) => row.summary?.startsWith("Preparing the box image")).length, 1);
  assert.equal((await api("GET", `/runs/${run.run_id}/files/out.txt`)).body, "hello from the box\n");
});

test("a new agent that names its tools gets exactly those in the box; one that names the runner, or a tool the box refuses, keeps the runner; a workflow is never given a box", { timeout: 60_000 }, async (t) => {
  await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  const named = await api("POST", "/agents", agent("named", { tools: ["read"] }));
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.deepEqual([named.body.definition.place, named.body.definition.tools], [DOCKER, ["read"]]);
  const none = await api("POST", "/agents", agent("toolless"));
  assert.deepEqual([none.body.definition.place, none.body.definition.tools], [DOCKER, []], "an empty list is a list named");
  const runner = await api("POST", "/agents", { definition: { id: "runner", name: "runner", instructions: "Probe.", place: RUNNER } });
  assert.equal(runner.status, 201, JSON.stringify(runner.body));
  assert.deepEqual([runner.body.definition.place, runner.body.definition.tools], [RUNNER, []], "an explicit runner is kept, and gets no shell");
  const onRunner = await probe(api, "runner", [{ tool: "write", args: { path: "a.txt", content: "a" } }]);
  assert.deepEqual(onRunner.place, RUNNER);
  await follow(api, onRunner.run_id, ["completed"]);
  // A tool the box refuses (browser, runner-only) keeps a new agent on the runner, as before: it saves, with no place.
  const browsing = await api("POST", "/agents", agent("browsing", { tools: ["read", "browser"] }));
  assert.equal(browsing.status, 201, JSON.stringify(browsing.body));
  assert.deepEqual(["place" in browsing.body.definition, browsing.body.definition.tools], [false, ["read", "browser"]]);
  const flow = await api("POST", "/agents", flowAgent("flow"));
  assert.equal(flow.status, 201, JSON.stringify(flow.body));
  assert.equal("place" in flow.body.definition, false, "a workflow names no place, and none is stamped");
  assert.equal("place" in storedBodies(data).find((body) => body.workflow), false);
  // An edit that names no place keeps the agent's, as before: the box.
  const edited = await api("PUT", "/agents/named/definition", { definition: { instructions: "Probe again.", tools: ["read", "bash"] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.definition.place, edited.body.definition.tools], [DOCKER, ["read", "bash"]]);
});

test("with no docker, a new agent is saved as before, with no place, and runs on the runner; capabilities say why: docker not enabled, or its image failed", { timeout: 60_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_BOXES"]);
  const { api, data } = await serve(t, { faux: PROBE });
  const places = await placesOf(api);
  assert.equal(places.default, "runner");
  assert.deepEqual(places.default_place, RUNNER);
  assert.equal(places.default_reason, "new agents run on the runner, because the docker box is unavailable here: not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker");
  const made = await api("POST", "/agents", fresh("plain"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal("place" in made.body.definition, false);
  assert.deepEqual(made.body.definition.tools, []);
  assert.ok(storedBodies(data).every((body) => !("place" in body)), "nothing stamped: the revision is the one it was before");
  const run = await probe(api, "plain", [{ tool: "write", args: { path: "a.txt", content: "a" } }]);
  assert.deepEqual(run.place, RUNNER);
  await follow(api, run.run_id, ["completed"]);
});

test("a docker whose image failed is no default: a new agent goes to the runner, with docker's reason", { timeout: 60_000 }, async (t) => {
  await fakeDocker(t, { "build-fail": "ERROR: the build failed RAW-DOCKER-STDERR" });
  const { api } = await serve(t, { faux: PROBE });
  await until(async () => (await placesOf(api)).boxes.find((box) => box.id === "docker").state === "unavailable", "docker unavailable", 60_000);
  const places = await placesOf(api);
  const reason = places.boxes.find((box) => box.id === "docker").reason;
  assert.deepEqual(places.default_place, RUNNER);
  assert.equal(places.default_reason, `new agents run on the runner, because the docker box is unavailable here: ${reason}`);
  const made = await api("POST", "/agents", fresh("plain"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal("place" in made.body.definition, false);
});

test("an agent saved before, with no place, runs where it ran before on a server that now has docker: the runner, no box made; an edit that names no place keeps none", { timeout: 90_000 }, async (t) => {
  withEnv(t, {}, ["AGENTRUN_BOXES"]);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  const before = await client(first.baseUrl, first.token)("POST", "/agents", fresh("old"));
  assert.equal(before.status, 201, JSON.stringify(before.body));
  assert.equal("place" in before.body.definition, false);
  await first.close();
  const docker = await fakeDocker(t);
  const { api } = await serve(t, { data, faux: PROBE });
  assert.deepEqual((await placesOf(api)).default_place, DOCKER, "this server gives new agents the box");
  const now = await api("GET", "/agents/old");
  assert.equal(now.body.revision, before.body.revision, "the same revision");
  assert.equal("place" in now.body.definition, false);
  const run = await probe(api, "old", [{ tool: "write", args: { path: "a.txt", content: "a" } }]);
  assert.deepEqual(run.place, RUNNER, "where it ran before");
  await follow(api, run.run_id, ["completed"]);
  assert.deepEqual(docker.runs(), [], "no box");
  const edited = await api("PUT", "/agents/old/definition", { definition: { instructions: "Probe again." } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal("place" in edited.body.definition, false, "an edit is no create: absent keeps the agent's, which is none");
  const again = await probe(api, "old", [{ tool: "write", args: { path: "b.txt", content: "b" } }]);
  assert.deepEqual(again.place, RUNNER);
  await follow(api, again.run_id, ["completed"]);
  assert.deepEqual(docker.runs(), [], "still no box");
});
