// The demo: an agent whose place is a Docker box runs its read, write, edit and bash there, through the API, on pi and on
// another harness; the box gets a fixed environment and no key, and only the run's work/. Here the box is a faux one
// (fixtures/faux-box.mjs: pi-transport's local box behind `startServe({ fauxBox })`), so it runs without Docker; it
// shares this machine, so /proc and the network are checked on real Docker only (boxed-tools.docker.test.mjs).
// run-box.test.mjs checks what Docker itself is asked, with a fake `docker` first on PATH.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { startServe } from "../dist/index.js";
import { writesHeld } from "../dist/workspace.js";
import fauxBoxes, { fauxRoot } from "./fixtures/faux-box.mjs";
import { client, flowAgent, follow, jsonLines, runDir, runRecordOf, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_BOX = new URL("./fixtures/faux-box.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SANDBOX = { mode: "sandbox", box: "docker" };
// Values planted in the server's environment, each one no box may hold: an unnamed key, OpenAI's, and the four keys a
// tester runs everything with: OpenRouter's (which a harness may be handed under another name), Monid's, Parallel's and
// Browserbase's. A box is searched for each value, so a key handed on under any name is found.
const planted = (name) => `planted-${name}-sentinel`;
const SENTINELS = { FOO_API_KEY: planted("foo"), OPENAI_API_KEY: planted("openai"), OPENROUTER_API_KEY: planted("openrouter"), MONID_API_KEY: planted("monid"), PARALLEL_API_KEY: planted("parallel"), BROWSERBASE_API_KEY: planted("browserbase") };
const ENV_PROBE = "env; cat /proc/self/environ 2>/dev/null | tr '\\0' '\\n'";
// What a shell adds to its own environment, and what pi-transport's local box adds (its marker and private TMPDIR).
const SHELL_OWN = ["OLDPWD", "PWD", "SHLVL", "_"];
const LOCAL_BOX_OWN = ["PI_TRANSPORT_BOX", "TMPDIR"];

/** Each tool call of run `runId` and its answer, in order, from its released store. */
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

const lines = (file) => jsonLines(file);
const specs = (data) => lines(join(fauxRoot(data), "specs.jsonl"));
const execs = (data) => lines(join(fauxRoot(data), "execs.jsonl"));
/** The faux boxes that live now: a local box keeps its record while it lives. */
const liveBoxes = (data) => (existsSync(fauxRoot(data)) ? readdirSync(fauxRoot(data)).filter((name) => name.startsWith("local-") && existsSync(join(fauxRoot(data), name, "box.json"))) : []);
const until = async (done, what, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

async function boxed(t, extra = {}) {
  withEnv(t, SENTINELS);
  const server = await serve(t, { faux: PROBE, fauxBox: FAUX_BOX, harnessTable: fauxTable(FAUX_HARNESS), ...extra });
  return server;
}

/** Start a run of `agent` whose probe plan is `plan` (fixtures/faux-probe.mjs). */
async function probe(api, agent, plan) {
  const run = await api("POST", `/agents/${agent}/runs`, { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body;
}

/** The box's environment as bash printed it, by name. */
function envOf(text) {
  const vars = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, at))) vars[line.slice(0, at)] = line.slice(at + 1);
  }
  return vars;
}

/** No sentinel, token or door token in `text`. */
async function noSecretIn(text, server) {
  const door = (await readFile(join(server.data, ".door-token"), "utf8")).trim();
  for (const [name, value] of Object.entries({ ...SENTINELS, token: server.token, door })) assert.ok(!text.includes(value), `${name} reached the box`);
}

test("demo (pi): in a Docker place bash runs in the run's box, and read, write and edit on this machine's work/ that the box binds; bash's out.txt shows in the run's files; the box's environment is the fixed one, with no key or token", { timeout: 120_000 }, async (t) => {
  const server = await boxed(t);
  const { api, data } = server;
  assert.deepEqual((await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "docker"), { id: "docker", available: true, state: "ready", reason: "a faux box (tests)", network: "none", network_reason: "a faux box (tests)" });
  const made = await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["read", "write", "edit", "bash"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.warnings, []);
  const scratchDir = await scratch(t);
  const outside = join(scratchDir, "outside.txt");
  const plan = [
    { tool: "bash", args: { command: "printf hi > out.txt" } },
    { tool: "write", args: { path: "note.txt", content: "written in the box" } },
    { tool: "read", args: { path: "note.txt" } },
    { tool: "edit", args: { path: "note.txt", edits: [{ oldText: "written", newText: "edited" }] } },
    { tool: "bash", args: { command: "cat note.txt" } },
    // A file tool's path stays in the box's work dir: a host path is refused in the confined tools' words, never mapped.
    { tool: "write", args: { path: outside, content: "box" } },
    { tool: "bash", args: { command: ENV_PROBE } },
    { tool: "bash", args: { command: "exit 3" } },
    { tool: "read", args: { path: "missing.md" } },
    { tool: "read", args: { path: join(data, "runs", "x", "work", "note.txt") } },
  ];
  const run = await probe(api, "boxed", plan);
  await follow(api, run.run_id, ["completed"], { deadlineMs: 60_000 });
  const said = answers(data, run.run_id);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), plan.map((step, i) => [step.tool, i >= 5 && i !== 6]));
  assert.equal(said[2].text, "written in the box");
  assert.equal(said[4].text, "edited in the box");
  // A refusal names the path as the call gave it, and no other: not the box's work dir, not the host's.
  assert.equal(said[5].text, `<harness>\n[error] ${outside}: outside the workspace\n</harness>`);
  assert.equal(existsSync(outside), false);
  assert.match(said[7].text, /Command exited with code 3/);
  // Errors name the box's paths, never the data root, which only the server knows; a host path given is refused.
  assert.match(said[8].text, /\/workspace\/missing\.md/);
  assert.ok(!said[8].text.includes(realpathSync(data)), said[8].text);
  assert.equal(said[9].text, `<harness>\n[error] ${plan[9].args.path}: outside the workspace\n</harness>`);
  // The files: bash's out.txt and the edited note, in GET /runs/{id}/files.
  const files = (await api("GET", `/runs/${run.run_id}/files`)).body.files.map((f) => f.path);
  assert.ok(files.includes("out.txt") && files.includes("note.txt"), JSON.stringify(files));
  assert.equal((await api("GET", `/runs/${run.run_id}/files/out.txt`)).body, "hi");
  // The environment: the fixed constant (and the box's own PATH), nothing of this server's.
  const env = envOf(said[6].text);
  assert.deepEqual(Object.keys(env).filter((name) => !SHELL_OWN.includes(name) && !LOCAL_BOX_OWN.includes(name)).sort(), ["HOME", "LANG", "PATH"], said[6].text);
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.HOME, "/tmp");
  await noSecretIn(said[6].text, server);
  // One box, made on the first call with the fixed spec, every call's command run in it, and destroyed at the end.
  const [spec, ...more] = specs(data);
  assert.equal(more.length, 0, "one box for the run");
  assert.deepEqual(spec, {
    env: { LANG: "C.UTF-8", HOME: "/tmp" }, workspace: "/workspace",
    mounts: [{ source: join(runDir(data, run.run_id), "work"), target: "/workspace" }],
    labels: { "agentrun.run": run.run_id, "agentrun.box": "run", "agentrun.epoch": "1" }, network: "none", maxLifetimeMs: 86_400_000,
  });
  // bash's calls ran in the box, one command each; read, write and edit ran none where they run here (bound-files.ts),
  // and at least one each where this host reaches directories by path.
  if (writesHeld()) assert.equal(execs(data).length, plan.filter((step) => step.tool === "bash").length, JSON.stringify(execs(data)));
  else assert.ok(execs(data).length >= plan.length, "every call ran a command in the box");
  const view = (await api("GET", `/runs/${run.run_id}`)).body;
  assert.deepEqual(view.place, SANDBOX);
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
});

test("demo (claude-agent, codex): the faux harness's bash, write and read run in the box through the host tools; out.txt shows in the run's files, and no key or token is in the box; an absolute path under the harness's cwd (the run's work/) is the same file in the box", { timeout: 150_000 }, async (t) => {
  const server = await boxed(t);
  const { api, data } = server;
  withEnv(t, { AGENTRUN_TEST_DATA: realpathSync(data) });
  for (const harness of ["claude-agent", "codex"]) {
    const calls = [
      { call: "bash", args: { command: "printf hi > out.txt" } },
      { call: "write", args: { path: "w.txt", content: "from the host tool" } },
      { call: "read", args: { path: "w.txt" } },
      { call: "bash", args: { command: ENV_PROBE } },
      // Another run's directory on this machine is no box path.
      { call: "read", args: { path: join(data, "runs", "any", "harness", "work", "out.txt") } },
      // The harness works in the run's work/ on this machine: an absolute path it builds there is the box's same file,
      // and one out of it is refused.
      { call: "write", args: { path: "{work}/abs.txt", content: "absolute" } },
      { call: "read", args: { path: "{work}/../serve.json" } },
    ];
    const id = `boxed-${harness}`;
    assert.equal((await api("POST", "/agents", { definition: { id, name: id, harness, instructions: `Box calls: ${JSON.stringify(calls)}`, place: SANDBOX, tools: ["read", "write", "bash"] } })).status, 201);
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: "go" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
    const said = answers(data, run.body.run_id);
    assert.deepEqual(said.map((a) => [a.tool, a.error]), [["bash", false], ["write", false], ["read", false], ["bash", false], ["read", true], ["write", false], ["read", true]], `${harness}: ${JSON.stringify(said)}`);
    assert.equal(said[4].text, `${calls[4].args.path}: outside the workspace`, harness);
    assert.equal(await readFile(join(runDir(data, run.body.run_id), "work", "abs.txt"), "utf8"), "absolute");
    // As the harness gave it, under its cwd, the run's work/: named relative to it.
    assert.equal(said[6].text, "../serve.json: outside the workspace", harness);
    assert.ok(!said[6].text.includes(realpathSync(data)), said[6].text);
    assert.equal(said[2].text, "from the host tool");
    assert.equal(await readFile(join(runDir(data, run.body.run_id), "work", "out.txt"), "utf8"), "hi");
    assert.ok((await api("GET", `/runs/${run.body.run_id}/files`)).body.files.some((f) => f.path === "out.txt"), harness);
    const env = envOf(said[3].text);
    assert.deepEqual([env.LANG, env.HOME], ["C.UTF-8", "/tmp"], harness);
    assert.deepEqual(Object.keys(env).filter((name) => !SHELL_OWN.includes(name) && !LOCAL_BOX_OWN.includes(name)).sort(), ["HOME", "LANG", "PATH"], `${harness}: ${said[3].text}`);
    await noSecretIn(said[3].text, server);
    assert.ok(specs(data).some((spec) => spec.labels["agentrun.run"] === run.body.run_id), `${harness}: its box was made`);
  }
  await until(() => liveBoxes(data).length === 0, "the boxes' destroy at the runs' ends");
});

test("a run request names no place: a sandbox agent's run with place \"runner\" is refused as a field the body does not keep, as network is, and makes no run; without one, the sandbox agent's run is in its box and a runner agent's on the runner", { timeout: 90_000 }, async (t) => {
  const { api, data } = await boxed(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["read", "write", "bash"] } })).status, 201);
  assert.equal((await api("POST", "/agents", { definition: { id: "plain", name: "plain", instructions: "Probe.", place: { mode: "runner" }, tools: ["read", "write"] } })).status, 201);
  const before = (await api("GET", "/runs")).body.runs;
  const network = await api("POST", "/agents/boxed/runs", { input: { content: "hi" }, network: "open" });
  assert.deepEqual([network.status, network.body.error?.code, network.body.error?.fields], [422, "input_invalid", [{ field: "network", reason: "not_allowed", message: "The body keeps no field network." }]]);
  for (const place of ["runner", { mode: "runner" }, SANDBOX]) {
    const refused = await api("POST", "/agents/boxed/runs", { input: { content: "hi" }, place });
    assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.fields], [422, "input_invalid", [{ field: "place", reason: "not_allowed", message: "The body keeps no field place." }]], JSON.stringify(place));
  }
  assert.deepEqual((await api("GET", "/runs")).body.runs, before, "no run was made");
  assert.deepEqual(specs(data), [], "and no box");
  const inBox = await probe(api, "boxed", [{ tool: "bash", args: { command: "printf hi > out.txt" } }]);
  assert.deepEqual(inBox.place, SANDBOX, "the revision's place");
  await follow(api, inBox.run_id, ["completed"]);
  assert.deepEqual(answers(data, inBox.run_id).map((a) => [a.tool, a.error]), [["bash", false]]);
  assert.equal(await readFile(join(runDir(data, inBox.run_id), "work", "out.txt"), "utf8"), "hi");
  assert.ok(specs(data).some((spec) => spec.labels["agentrun.run"] === inBox.run_id), "its box was made");
  assert.deepEqual((await api("GET", `/runs/${inBox.run_id}`)).body.place, SANDBOX);
  const onRunner = await probe(api, "plain", [{ tool: "write", args: { path: "a.txt", content: "a" } }]);
  assert.deepEqual(onRunner.place, { mode: "runner" }, "the revision's place");
  await follow(api, onRunner.run_id, ["completed"]);
  assert.deepEqual(answers(data, onRunner.run_id).map((a) => [a.tool, a.error, a.text]), [["write", false, "Successfully wrote to a.txt"]]);
  assert.ok(!specs(data).some((spec) => spec.labels["agentrun.run"] === onRunner.run_id), "no box for a runner run");
  assert.deepEqual((await api("GET", `/runs/${onRunner.run_id}`)).body.place, { mode: "runner" });
  await until(() => liveBoxes(data).length === 0, "the box's destroy at the run's end");
});

test("bash is a 422 on an agent whose place is the runner; a new agent that names no place is given the box, so its bash saves; a workflow whose place is a box, and the browser in one, are 422", async (t) => {
  const { api } = await boxed(t);
  const made = await api("POST", "/agents", { definition: { id: "shell", name: "shell", instructions: "Probe.", tools: ["read", "bash"], place: { mode: "runner" } } });
  assert.deepEqual([made.status, made.body.error.fields.map((f) => [f.field, f.reason])], [422, [["definition.tools[1]", "not_an_option"]]]);
  assert.match(made.body.error.fields[0].message, /bash runs only in a box/);
  const given = await api("POST", "/agents", { definition: { id: "shell", name: "shell", instructions: "Probe.", tools: ["read", "bash"] } });
  assert.deepEqual([given.status, given.body.definition.place, given.body.definition.tools], [201, SANDBOX, ["read", "bash"]], JSON.stringify(given.body));
  const flow = await api("POST", "/agents", flowAgent("flow", undefined, { place: SANDBOX }));
  assert.deepEqual([flow.status, flow.body.error.fields.map((f) => f.field)], [422, ["definition.place"]]);
  // The browser writes work/ from this machine by path, which a box's command could turn through a link: runner only.
  const browser = await api("POST", "/agents", { definition: { id: "browsing", name: "browsing", instructions: "Probe.", tools: ["bash", "browser"], place: SANDBOX } });
  assert.deepEqual([browser.status, browser.body.error.fields.map((f) => [f.field, f.reason])], [422, [["definition.tools[1]", "not_an_option"]]]);
  assert.match(browser.body.error.fields[0].message, /^browser does not run in a sandbox place yet/);
  // And a place that tries to open the box's network is no place.
  const open = await api("POST", "/agents", { definition: { id: "open", name: "open", instructions: "Probe.", tools: ["bash"], place: { ...SANDBOX, network: "open" } } });
  assert.deepEqual([open.status, open.body.error.fields.map((f) => [f.field, f.reason])], [422, [["definition.place", "not_allowed"]]]);
});

test("a link swapped in at the run's work/ is refused as a mount source: bash's answer names the link, no box is made, and the link's target is untouched", { timeout: 90_000 }, async (t) => {
  const { api, data } = await boxed(t);
  const elsewhere = await scratch(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } })).status, 201);
  const go = join(elsewhere, "go");
  const target = join(elsewhere, "target");
  await mkdir(target);
  const run = await probe(api, "boxed", [{ wait: go }, { tool: "bash", args: { command: "printf pwned > pwned.txt" } }]);
  const work = join(runDir(data, run.run_id), "work");
  await until(() => existsSync(work), "the run's work/");
  await rename(work, `${work}.moved`);
  await symlink(target, work);
  await writeFile(go, "");
  await follow(api, run.run_id, ["completed"], { deadlineMs: 60_000 });
  const [bash] = answers(data, run.run_id);
  assert.equal(bash.error, true);
  assert.match(bash.text, new RegExp(`the mount source ${work.replaceAll("/", "\\/")} is refused: ${work.replaceAll("/", "\\/")} is a link`));
  assert.deepEqual(specs(data), [], "no box was made: nothing was bound");
  assert.deepEqual(readdirSync(target), [], "the link's target is untouched");
});

test("lifecycle: no tool call makes no box; a wait for the person keeps it; cancel and archive destroy it", { timeout: 150_000 }, async (t) => {
  const { api, data } = await boxed(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["bash", "ask_person"] } })).status, 201);
  const idle = await probe(api, "boxed", []);
  await follow(api, idle.run_id, ["completed"]);
  assert.deepEqual(specs(data), [], "a run with no tool call costs no box");
  // A wait for the person keeps the run's box; the run's end destroys it.
  const asked = await probe(api, "boxed", [{ tool: "bash", args: { command: "printf 1 > one.txt" } }, { tool: "ask_person", args: { question: "Go on?" } }]);
  await follow(api, asked.run_id, ["input_required"]);
  assert.equal(liveBoxes(data).length, 1, "the box lives while the run waits");
  assert.equal((await api("POST", `/runs/${asked.run_id}/messages`, { content: "yes" })).status, 202);
  await follow(api, asked.run_id, ["completed"]);
  await until(() => liveBoxes(data).length === 0, "the destroy at completion");
  // A cancel destroys it, the command it runs included.
  const long = await probe(api, "boxed", [{ tool: "bash", args: { command: "echo $$ > long.pid; sleep 600" } }]);
  const pidFile = join(runDir(data, long.run_id), "work", "long.pid");
  await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the long command's start");
  assert.equal((await api("POST", `/runs/${long.run_id}/cancel`)).status, 202);
  await follow(api, long.run_id, ["cancelled"]);
  await until(() => liveBoxes(data).length === 0, "the destroy at cancel");
  await until(() => !running(Number(readFileSync(pidFile, "utf8").trim())), "the cancelled command's end");
  // An archive of a run waiting for the person destroys its box once its process is gone.
  const waiting = await probe(api, "boxed", [{ tool: "bash", args: { command: "true" } }, { tool: "ask_person", args: { question: "Wait?" } }]);
  await follow(api, waiting.run_id, ["input_required"]);
  assert.equal(liveBoxes(data).length, 1);
  assert.equal((await api("POST", `/runs/${waiting.run_id}/archive`)).status, 200);
  await until(() => liveBoxes(data).length === 0, "the destroy at archive", 60_000);
});

/** Whether `pid` runs: a zombie is not running. */
function running(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

test("a crash: the run's next process, under a later epoch, destroys the box the dead one left (its left command with it), makes its own, and tells the model once", { timeout: 120_000 }, async (t) => {
  const { api, data } = await boxed(t);
  assert.equal((await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "boxed", [{ tool: "bash", args: { command: "echo $$ > left.pid; sleep 600; touch late.txt" } }, { tool: "bash", args: { command: "printf after > after.txt" } }]);
  const work = join(runDir(data, run.run_id), "work");
  await until(() => existsSync(join(work, "left.pid")) && readFileSync(join(work, "left.pid"), "utf8").trim() !== "", "the left command's start");
  const left = Number(readFileSync(join(work, "left.pid"), "utf8").trim());
  t.after(() => running(left) && process.kill(left, "SIGKILL"));
  const { holder } = runRecordOf(data, run.run_id);
  process.kill(holder.pid, "SIGKILL");
  await follow(api, run.run_id, ["completed"], { deadlineMs: 90_000 });
  const said = answers(data, run.run_id);
  assert.equal(said.at(-1).tool, "bash");
  assert.equal(said.at(-1).error, false, JSON.stringify(said));
  assert.ok(said.at(-1).text.startsWith("this run's box was replaced after a restart: /workspace is kept; packages installed outside it and /tmp are gone; reinstall what you need"), said.at(-1).text);
  assert.equal(await readFile(join(work, "after.txt"), "utf8"), "after");
  await until(() => !running(left), "the left command's kill");
  assert.equal(existsSync(join(work, "late.txt")), false);
  assert.equal(specs(data).length, 2, "made again under the later epoch, never taken over");
});

test("the start's sweep destroys the box of a run that ended while serve was down, and leaves a box of a run it does not know", { timeout: 90_000 }, async (t) => {
  withEnv(t, SENTINELS);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: PROBE, fauxBox: FAUX_BOX, drainTimeout: "5s" });
  const api = client(first.baseUrl, first.token);
  assert.equal((await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } })).status, 201);
  const run = await probe(api, "boxed", []);
  await follow(api, run.run_id, ["completed"]);
  await first.close();
  // Boxes left as a crash would leave them: one of the ended run, one of a run this store does not know.
  const canonical = (await import("node:fs")).realpathSync(data);
  const boxes = fauxBoxes(canonical);
  const left = [];
  for (const id of [run.run_id, "run_unknown"]) {
    const made = await boxes.create({ maxLifetimeMs: 600_000, labels: { "agentrun.run": id, "agentrun.box": "run" } }, BACKGROUND_CONTEXT);
    assert.ok(made.ok);
    left.push(made.value.id);
  }
  const second = await startServe({ data, port: 0, faux: PROBE, fauxBox: FAUX_BOX, drainTimeout: "5s" });
  t.after(() => second.close());
  await until(() => !liveBoxes(canonical).includes(left[0]), "the sweep");
  assert.ok(liveBoxes(canonical).includes(left[1]), "a box of a run this store does not know waits out its lifetime");
  const other = await boxes.attach(left[1], BACKGROUND_CONTEXT);
  await other.value.destroy(BACKGROUND_CONTEXT);
});
