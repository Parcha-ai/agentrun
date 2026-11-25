// A new agent's place: the box is the default machine for a shell. An agentic definition that names no place and no tools
// is saved with the Docker box as its place wherever this server has docker, and gets a shell (bash); one that names its
// tools gets the box only when one needs a shell, and else runs on the runner. Where docker is not there, a new agent that
// would get the box is refused in words that say to name a box or the runner (places.default_reason); one whose tools
// need no shell is saved with no place and runs on the runner. The default is stamped on
// the revision at its create, so an agent saved before keeps running where it ran: a stored revision with no place is the
// runner, whatever this server has now. A workflow is never given a box, and an explicit runner is kept. Everything runs
// on a fake `docker` first on PATH (fixtures/fake-docker.mjs): no daemon is reached, nothing is pulled or built.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dockerHost } from "./docker-host-fake.mjs";
import { agent, client, flowAgent, follow, jsonLines, journalOf, scratch, serve, startServe, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const DOCKER = { mode: "sandbox", box: "docker" };
const RUNNER = { mode: "runner" };
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
  // Its state is set in its own program: the Docker provider hands docker only the names docker reads.
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexport FAKE_DOCKER_STATE='${state}'\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  for (const [name, text] of Object.entries(marks)) await writeFile(join(state, name), text);
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, AGENTRUN_BOXES: "docker" }, ["AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW"]);
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
  const calls = () => jsonLines(join(state, "argv.jsonl"));
  return { runs: () => calls().filter((args) => args[0] === "run"), execs: () => calls().filter((args) => args[0] === "exec"), release: () => rm(join(state, "build-hold"), { force: true }) };
}

// The Docker computer's daemon file, which the computer package's build:daemon makes with Go (CI's build job does; a machine
// with no Go has none). The fake docker never runs it: the provider asks Docker's architecture, then copies and binds the file.
const DAEMON = fileURLToPath(new URL("../../computer/dist/computerd-linux-amd64", import.meta.url));
const NO_DAEMON = !existsSync(DAEMON) && "no computerd-linux-amd64: run npm run build:daemon -w @parcha/agentrun-computer (CI's build job does)";

/** A Docker host first on PATH and docker listed in AGENTRUN_BOXES, where a run in the box gets a computer whose fake
 *  computerd (computer/test/fake-computerd.mjs) runs its exec, file and process calls in the computer's folders, /workspace
 *  the run's folder: the real Docker provider over the computer package's fake docker. */
async function computerDocker(t) {
  const host = dockerHost({ computerd: true });
  withEnv(t, { PATH: `${host.dir}:${process.env.PATH}`, AGENTRUN_BOXES: "docker" }, ["AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW"]);
  return { runs: () => host.calls().filter((args) => args[0] === "run") };
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
  return journalOf(data, runId)
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult")
    .map((message) => ({ tool: message.toolName, error: message.isError, text: (message.content ?? []).map((c) => c.text ?? "").join("") }));
}
const storedBodies = (data) => {
  const db = new DatabaseSync(join(data, "store.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT body FROM revisions ORDER BY created_at, rowid").all().map((row) => JSON.parse(row.body));
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
/** Why an agent with no place and a shell is refused where no Docker box is set up (no box is, here). */
const NAME_A_BOX = "name a box: this server has no Docker box for a new agent. Set place to {mode: sandbox, box: <none is set up>}, or to {mode: runner} to run without a shell.";

// A run in the Docker box starts a computer: computerDocker gives it a fake computerd, so its bash and background tools run.
test("a new agent on a server with docker can start a command in the background and read its output, with no tools named", { timeout: 120_000, skip: NO_DAEMON }, async (t) => {
  const [{ NEW_AGENT_TOOLS }, { SHELL_TOOLS }] = await Promise.all([import("../dist/place.js"), import("../dist/background.js")]);
  assert.deepEqual([...NEW_AGENT_TOOLS], [...SHELL_TOOLS], "a new agent's tools are the shell tools, bash and the background tools");
  await computerDocker(t);
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

test("a first agent with no place whose tools need no shell (none named, or only read and write) runs on the runner and starts no container; one that names bash keeps the box", { timeout: 60_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api } = await serve(t, { faux: PROBE });
  for (const [id, tools, plan] of [["notes", [], []], ["writer", ["read", "write"], [{ tool: "write", args: { path: "a.txt", content: "a" } }]]]) {
    const made = await api("POST", "/agents", agent(id, { tools }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([made.body.definition.place, made.body.definition.tools], [undefined, tools], `${id}: saved with no place`);
    const run = await probe(api, id, plan);
    assert.deepEqual(run.place, RUNNER, `${id}: its run is on the runner`);
    await follow(api, run.run_id, ["completed"]);
  }
  assert.deepEqual(docker.runs(), [], "no container was started");
  const shell = await api("POST", "/agents", agent("shell", { tools: ["bash"] }));
  assert.equal(shell.status, 201, JSON.stringify(shell.body));
  assert.deepEqual([shell.body.definition.place, shell.body.definition.tools], [DOCKER, ["bash"]], "a shell keeps the box");
});

test("a new agent that names a shell among its tools gets exactly those in the box; one that names the runner, or a tool the box refuses, keeps the runner; a workflow is never given a box", { timeout: 60_000 }, async (t) => {
  await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  const named = await api("POST", "/agents", agent("named", { tools: ["read", "bash"] }));
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.deepEqual([named.body.definition.place, named.body.definition.tools], [DOCKER, ["read", "bash"]]);
  const none = await api("POST", "/agents", agent("toolless"));
  assert.deepEqual([none.body.definition.place, none.body.definition.tools], [undefined, []], "an empty list is a list named, and needs no shell");
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
  // An edit that names no place keeps the agent's, as before: the box, a shell named or not.
  const edited = await api("PUT", "/agents/named/definition", { definition: { instructions: "Probe again.", tools: ["read"] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual([edited.body.definition.place, edited.body.definition.tools], [DOCKER, ["read"]]);
});

test("with no docker, a new agent that names no place and no tools is refused, in words that name a box; one whose tools need no shell is saved with no place and runs on the runner", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_BOXES: "none" });
  const { api, data } = await serve(t, { faux: PROBE });
  const places = await placesOf(api);
  assert.equal("default" in places, false);
  assert.equal(places.default_place, null, "no default: a new agent names its place");
  const refused = await api("POST", "/agents", fresh("plain"));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.deepEqual(refused.body.error.fields.map((one) => [one.field, one.message]), [["definition.place", NAME_A_BOX]]);
  assert.equal((await api("GET", "/agents/plain")).status, 404, "nothing saved");
  const made = await api("POST", "/agents", { definition: { ...fresh("plain").definition, tools: ["write"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal("place" in made.body.definition, false);
  assert.ok(storedBodies(data).every((body) => !("place" in body)), "nothing stamped: the revision is the one it was before");
  const run = await probe(api, "plain", [{ tool: "write", args: { path: "a.txt", content: "a" } }]);
  assert.deepEqual(run.place, RUNNER);
  await follow(api, run.run_id, ["completed"]);
});

test("a revision that names no place runs where default_place says, as a new agent would be saved: in the Docker box on a server that now has docker; one with a tool the box refuses, and a workflow, on the runner", { timeout: 90_000, skip: NO_DAEMON }, async (t) => {
  withEnv(t, { AGENTRUN_BOXES: "none" });
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  t.after(() => first.close());
  const before = client(first.baseUrl, first.token);
  const made = await before("POST", "/agents", { definition: { ...fresh("old").definition, tools: [] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal("place" in made.body.definition, false, "saved with no place where docker was not there");
  assert.equal((await before("POST", "/agents", agent("browsing", { tools: ["read", "browser"] }))).status, 201);
  assert.equal((await before("POST", "/agents", flowAgent("flow"))).status, 201);
  await first.close();
  const docker = await computerDocker(t);
  const { api } = await serve(t, { data, faux: PROBE });
  const places = await placesOf(api);
  assert.deepEqual(places.default_place, DOCKER, "this server's default place");
  const now = await api("GET", "/agents/old");
  assert.equal(now.body.revision, made.body.revision, "the same revision, still with no place");
  assert.equal("place" in now.body.definition, false);
  const run = await probe(api, "old", [{ tool: "write", args: { path: "a.txt", content: "a" } }]);
  assert.deepEqual(run.place, RUNNER, "its tools need no shell: the runner, with no container to wait for");
  assert.equal("default" in places, false, "one field says where a revision with no place runs: default_place");
  await follow(api, run.run_id, ["completed"]);
  // An edit that names no place keeps none, and may name bash: the place it resolves to has a shell.
  const edited = await api("PUT", "/agents/old/definition", { definition: { instructions: "Probe again.", tools: ["bash"] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal("place" in edited.body.definition, false, "an edit is no create: absent keeps the agent's, which is none");
  const shell = await probe(api, "old", [{ tool: "bash", args: { command: "printf 'hi\\n' > out.txt" } }]);
  assert.deepEqual(shell.place, DOCKER, "where default_place says, not the runner");
  await follow(api, shell.run_id, ["completed"], { deadlineMs: 60_000 });
  // A box-placed run gets its computer when the runner claims it: one for the run with bash, and none for the run before
  // it or what stays on the runner, below.
  const computers = docker.runs().filter((args) => args.includes("agentrun.computer=1")).map((args) => args.find((arg) => arg.startsWith("agentrun.run=")));
  assert.deepEqual(computers, [`agentrun.run=${shell.run_id}`], "one computer, for the run placed in the box");
  // A tool the box refuses keeps the runner, as at create; a workflow is never given a box.
  // (Its run may still be refused for the browser's keys, which this test does not hold: never for its place.)
  const browsing = await api("POST", "/agents/browsing/runs", { input: { content: JSON.stringify({ probe: [] }) } });
  if (browsing.status === 202) assert.deepEqual(browsing.body.place, RUNNER);
  else refusedNotForPlace(browsing);
  const flow = await api("POST", "/agents/flow/runs", { input: { question: "q" } });
  assert.equal(flow.status, 202, JSON.stringify(flow.body));
  assert.deepEqual(flow.body.place, RUNNER);
});

test("a revision with no place and bash, saved while docker was there, is refused at a run once default_place is null: a 409 that says why, never bash on the runner; one with the browser stays on the runner when docker comes", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_BOXES: "none" });
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  t.after(() => first.close());
  const none = client(first.baseUrl, first.token);
  assert.equal((await none("POST", "/agents", { definition: { ...fresh("shell").definition, tools: [] } })).status, 201);
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
  // Docker is gone: default_place is null (name a box), and the revision with bash is refused, saying why, before anything runs.
  withEnv(t, { AGENTRUN_BOXES: "none" });
  const { api } = await serve(t, { data, faux: PROBE });
  assert.equal((await placesOf(api)).default_place, null);
  const before = (await api("GET", "/runs?agent=shell")).body.runs.length;
  const refused = await api("POST", "/agents/shell/runs", { input: { content: JSON.stringify({ probe: [{ tool: "bash", args: { command: "echo hi" } }] }) } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, "agent_not_runnable");
  // The words a new agent with no place is refused in here: name a box (listing the boxes, never picking one), or the runner.
  assert.equal(refused.body.error.message, NAME_A_BOX);
  assert.equal((await api("GET", "/runs?agent=shell")).body.runs.length, before, "no run was made");
  assert.deepEqual(docker.execs(), [], "no shell ran anywhere");
});

