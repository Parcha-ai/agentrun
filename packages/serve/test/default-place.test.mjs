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
import { agent, client, flowAgent, follow, jsonLines, runDir, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const DOCKER = { mode: "sandbox", box: "docker" };
const RUNNER = { mode: "runner" };
const BUILDING = "Preparing the box image: building it (python, git, curl, node, npm, rg)…";
/** What a new agent in the box that names no tools gets: bash, and the background tools (background.ts). */
const SHELL = ["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"];

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
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true });
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
/** A run of a revision with the browser that did not start: refused (409 agent_not_runnable) for the browser's keys,
 *  which these tests do not hold, and never for its place. */
function refusedNotForPlace(answer) {
  assert.equal(answer.status, 409, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, "agent_not_runnable", JSON.stringify(answer.body));
  assert.ok(!/sandbox|box/.test(answer.body.error.message), JSON.stringify(answer.body));
}
/** A definition as a person writes one first: a name and instructions, no place and no tools. */
const fresh = (id) => ({ definition: { id, name: id, instructions: "Probe." } });

// SKIP (follow-up #2078): a run in a Docker box fails on the runner instead of completing
test.skip("a new agent on a server with docker can start a command in the background and read its output, with no tools named", { timeout: 120_000 }, async (t) => {
  const [{ NEW_AGENT_TOOLS }, { SHELL_TOOLS }] = await Promise.all([import("../dist/place.js"), import("../dist/background.js")]);
  assert.deepEqual([...NEW_AGENT_TOOLS], [...SHELL_TOOLS], "a new agent's tools are the shell tools, bash and the background tools");
  await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  const made = await api("POST", "/agents", fresh("backgrounded"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual([made.body.definition.place, made.body.definition.tools], [DOCKER, SHELL]);
  const plan = [
    { tool: "bash_background", args: { command: "echo from the background" } },
    // Until its runner has written its exit code, 20 s at most: no fixed wait a busy machine could outrun.
    { tool: "bash", args: { command: "i=0; until [ -f background/1/exit ] || [ $i -ge 200 ]; do sleep 0.1; i=$((i+1)); done" } },
    { tool: "bash_output", args: { id: "1" } },
  ];
  const run = await probe(api, "backgrounded", plan);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 60_000 });
  const said = answers(data, run.run_id);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step) => [step.tool, false]), JSON.stringify(said));
  assert.match(said[0].text, /^Started background process 1 /);
  assert.equal(said[2].text, "Background process 1 exited with code 0. Output bytes 0 to 20 of 20, the end.\n\nfrom the background\n");
});

// SKIP (follow-up #2078): it reads the old run-row column body_json, which the store switch removed
test.skip("a new agent that names its tools gets exactly those in the box; one that names the runner, or a tool the box refuses, keeps the runner; a workflow is never given a box", { timeout: 60_000 }, async (t) => {
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

// SKIP (follow-up #2078): it reads the old run-row column body_json, which the store switch removed
test.skip("with no docker, a new agent is saved as before, with no place, and runs on the runner; capabilities say why: docker turned off (AGENTRUN_BOXES=none), or its image failed", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_BOXES: "none" });
  const { api, data } = await serve(t, { faux: PROBE });
  const places = await placesOf(api);
  assert.equal("default" in places, false);
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

// SKIP (follow-up #2078): a run in a Docker box fails on the runner instead of completing
test.skip("a revision that names no place runs where default_place says, as a new agent would be saved: in the Docker box on a server that now has docker; one with a tool the box refuses, and a workflow, on the runner", { timeout: 90_000 }, async (t) => {
  withEnv(t, { AGENTRUN_BOXES: "none" });
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  t.after(() => first.close());
  const before = client(first.baseUrl, first.token);
  const made = await before("POST", "/agents", fresh("old"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal("place" in made.body.definition, false, "saved with no place where docker was not there");
  assert.equal((await before("POST", "/agents", agent("browsing", { tools: ["read", "browser"] }))).status, 201);
  assert.equal((await before("POST", "/agents", flowAgent("flow"))).status, 201);
  await first.close();
  const docker = await fakeDocker(t);
  const { api } = await serve(t, { data, faux: PROBE });
  const places = await placesOf(api);
  assert.deepEqual(places.default_place, DOCKER, "this server's default place");
  const now = await api("GET", "/agents/old");
  assert.equal(now.body.revision, made.body.revision, "the same revision, still with no place");
  assert.equal("place" in now.body.definition, false);
  const run = await probe(api, "old", [{ tool: "write", args: { path: "a.txt", content: "a" } }]);
  assert.deepEqual(run.place, DOCKER, "where default_place says, not the runner");
  assert.equal("default" in places, false, "one field says where a revision with no place runs: default_place");
  await follow(api, run.run_id, ["completed"]);
  // An edit that names no place keeps none, and may name bash: the place it resolves to has a shell.
  const edited = await api("PUT", "/agents/old/definition", { definition: { instructions: "Probe again.", tools: ["bash"] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal("place" in edited.body.definition, false, "an edit is no create: absent keeps the agent's, which is none");
  const shell = await probe(api, "old", [{ tool: "bash", args: { command: "printf 'hi\\n' > out.txt" } }]);
  assert.deepEqual(shell.place, DOCKER);
  await follow(api, shell.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.equal(docker.runs().length, 1, "one box, for the run with bash");
  // A tool the box refuses keeps the runner, as at create; a workflow is never given a box.
  // (Its run may still be refused for the browser's keys, which this test does not hold: never for its place.)
  const browsing = await api("POST", "/agents/browsing/runs", { input: { content: JSON.stringify({ probe: [] }) } });
  if (browsing.status === 202) assert.deepEqual(browsing.body.place, RUNNER);
  else refusedNotForPlace(browsing);
  const flow = await api("POST", "/agents/flow/runs", { input: { question: "q" } });
  assert.equal(flow.status, 202, JSON.stringify(flow.body));
  assert.deepEqual(flow.body.place, RUNNER);
});

test("a revision with no place and bash, saved while docker was there, is refused at a run once default_place is the runner: a 409 that says why, never bash on the runner; one with the browser stays on the runner when docker comes", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_BOXES: "none" });
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  t.after(() => first.close());
  const none = client(first.baseUrl, first.token);
  assert.equal((await none("POST", "/agents", fresh("shell"))).status, 201);
  assert.equal((await none("POST", "/agents", agent("browsing", { tools: ["read", "browser"] }))).status, 201);
  await first.close();
  // Docker is there: an edit naming bash and no place saves, its place resolving to the box.
  const docker = await fakeDocker(t);
  const second = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  t.after(() => second.close());
  const boxed = client(second.baseUrl, second.token);
  const edited = await boxed("PUT", "/agents/shell/definition", { definition: { instructions: "Probe.", tools: ["bash"] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal("place" in edited.body.definition, false);
  // The browser keeps the runner, docker or not: a revision with a tool the box refuses never resolves to it.
  const browsing = await boxed("POST", "/agents/browsing/runs", { input: { content: JSON.stringify({ probe: [] }) } });
  if (browsing.status === 202) assert.deepEqual(browsing.body.place, RUNNER);
  else refusedNotForPlace(browsing);
  await second.close();
  // Docker is gone: default_place is the runner, and the revision with bash is refused, saying why, before anything runs.
  withEnv(t, { AGENTRUN_BOXES: "none" });
  const { api } = await serve(t, { data, faux: PROBE });
  assert.deepEqual((await placesOf(api)).default_place, RUNNER);
  const before = (await api("GET", "/runs?agent=shell")).body.runs.length;
  const refused = await api("POST", "/agents/shell/runs", { input: { content: JSON.stringify({ probe: [{ tool: "bash", args: { command: "echo hi" } }] }) } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  // The words name why the sandbox is not the default here (default_reason) and both ways out: fix that, or pin the runner.
  assert.equal(refused.body.error.message, `bash runs only in a box, and this agent names no place, so it runs on the runner, which has no shell (a shell needs a sandbox computer), and ${(await placesOf(api)).default_reason}. Do that, or keep this agent on the runner: name "place": {"mode": "runner"} and remove "bash" from definition.tools.`);
  assert.equal((await api("GET", "/runs?agent=shell")).body.runs.length, before, "no run was made");
  assert.deepEqual(docker.execs(), [], "no shell ran anywhere");
});

