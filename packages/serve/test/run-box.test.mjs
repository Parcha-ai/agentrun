// What Docker is asked for a run's box, with a fake `docker` first on PATH (fixtures/fake-docker.mjs; no daemon is
// reached): the create's arguments (no network, serve's user, work/ alone at its fixed target, the run's labels, the
// fixed environment as NAME=value only), one box per run, found again by its label, destroyed at the run's end and by
// the start's sweep. And the Docker quirks a box must survive: `--env NAME` with no value copies the host's variable (so
// it is never sent), a killed `docker exec` client leaves its command running (so a timeout kills the command's group),
// and a create that fails can leave a container (so it carries the run's label, and is destroyed by it).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { boxMounts, mountSource, runBox, runBoxProvider } from "../dist/run-box.js";
import { writesHeld } from "../dist/workspace.js";
import { DEFAULT_DOCKER_IMAGE, RECIPE_HASH, RECIPE_LABEL } from "../dist/box-image.js";
import { startServe } from "../dist/index.js";
import { client, follow, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const SANDBOX = { mode: "sandbox", box: "docker" };
const WORK = "/run/agentrun/run/work";
/** Values planted in the server's environment, which the box must not hold: an unnamed key, OpenAI's, and the four keys
 *  a tester runs everything with (OpenRouter's, Monid's, Parallel's and Browserbase's), each searched for by value. */
const PLANTED = Object.fromEntries(["FOO", "OPENAI", "OPENROUTER", "MONID", "PARALLEL", "BROWSERBASE"].map((name) => [`${name}_API_KEY`, ["planted", name.toLowerCase(), "sentinel"].join("-")]));

/** A fake docker first on PATH, with docker listed in AGENTRUN_BOXES, for test `t`. */
async function fakeDocker(t, vars = {}) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(state);
  // Docker has this server's own image, built from its recipe (box-image.test.mjs builds it).
  await mkdir(join(state, "images"));
  await writeFile(join(state, "images", `${encodeURIComponent(DEFAULT_DOCKER_IMAGE)}.json`), JSON.stringify({ labels: { [RECIPE_LABEL]: RECIPE_HASH } }));
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, AGENTRUN_BOXES: "docker", ...vars });
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
  const calls = () => (existsSync(join(state, "argv.jsonl")) ? readFileSync(join(state, "argv.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  const containers = async () => (await readdir(join(state, "containers")).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(state, "containers", name), "utf8")));
  // The fake writes a call's argv before it acts on it, so an `rm` is in `removed()` before its container's file is gone:
  // a wait on a box's destroy waits on both.
  const gone = (id) => !existsSync(join(state, "containers", `${id}.json`));
  return { state, calls, runs: () => calls().filter((args) => args[0] === "run"), removed: () => calls().filter((args) => args[0] === "rm").map((args) => args.at(-1)), containers, gone };
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

const until = async (done, what, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const running = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
};
/** The values that follow each `name` in `args`. */
const flag = (args, name) => args.flatMap((arg, i) => (arg === name ? [args[i + 1]] : []));
/** What Docker keeps of a box this version made: no network, every capability dropped, no new privilege. */
const HARDENED = { NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] };

async function boxedAgent(api) {
  const made = await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["read", "write", "bash"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
}
async function probe(api, plan, extra = {}) {
  const run = await api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: plan }) }, ...extra });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("a mount source is refused when it is, or runs through, a link below the data root, or lies outside it; work/ alone is bound, at the box's work dir", async (t) => {
  const root = realpathSync(await scratch(t));
  const work = join(root, "runs", "r1", "work");
  await mkdir(work, { recursive: true });
  assert.equal(await mountSource(root, work), work);
  assert.deepEqual(await boxMounts(root, join(root, "runs", "r1"), SANDBOX), [{ source: work, target: WORK }]);
  const elsewhere = join(root, "elsewhere");
  await mkdir(join(elsewhere, "r2", "work"), { recursive: true });
  // A link at each step: work/ itself, the run's directory, and runs/.
  await symlink(join(elsewhere, "r2", "work"), join(root, "runs", "r1", "linked-work"));
  await assert.rejects(mountSource(root, join(root, "runs", "r1", "linked-work")), /linked-work is a link/);
  await symlink(join(elsewhere, "r2"), join(root, "runs", "r2"));
  await assert.rejects(mountSource(root, join(root, "runs", "r2", "work")), new RegExp(`${join(root, "runs", "r2")} is a link`));
  const other = join(await scratch(t), "data");
  await mkdir(join(other, "real-runs", "r3", "work"), { recursive: true });
  await symlink(join(other, "real-runs"), join(other, "runs"));
  await assert.rejects(boxMounts(other, join(other, "runs", "r3"), SANDBOX), /runs is a link/);
  await assert.rejects(mountSource(root, elsewhere.replace(root, "/tmp")), /is not below the data root/);
  await assert.rejects(mountSource(root, root), /is not below the data root/);
  // A data root that is not its own canonical path: everything below it is refused, fail-closed.
  const linkedRoot = join(await scratch(t), "linked-root");
  await symlink(root, linkedRoot);
  await assert.rejects(mountSource(linkedRoot, join(linkedRoot, "runs", "r1", "work")), /not its own canonical path/);
});

test("fake docker: one create per run, with no network, serve's user, work/ alone at its target, the run's labels and the fixed environment as NAME=value; a setting or a request field cannot open the network; destroyed at the run's end", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, { AGENTRUN_DOCKER_IMAGE: "registry.example/agentrun-box:1", AGENTRUN_DOCKER_NETWORK: "host", AGENTRUN_BOX_NETWORK: "open", ...PLANTED });
  const { api, data } = await serve(t, { faux: PROBE });
  assert.deepEqual((await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "docker"), { id: "docker", available: true, state: "ready" });
  await boxedAgent(api);
  for (const body of [{ network: "host" }, { place: "sandbox" }, { place: { mode: "sandbox", box: "docker", network: "open" } }]) {
    assert.equal((await api("POST", "/agents/boxed/runs", { input: { content: "hi" }, ...body })).status, 422, JSON.stringify(body));
  }
  const runId = await probe(api, [
    { tool: "bash", args: { command: "printf hi > out.txt" } },
    { tool: "read", args: { path: "out.txt" } },
    { tool: "bash", args: { command: "env" } },
    { tool: "read", args: { path: "missing.md" } },
  ]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const said = answers(data, runId);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), [["bash", false], ["read", false], ["bash", false], ["read", true]], JSON.stringify(said));
  assert.match(said[3].text, /\/run\/agentrun\/run\/work\/missing\.md/, "an error names the box's path");
  assert.ok(!said[3].text.includes(realpathSync(data)), "never the data root");
  assert.equal(said[1].text, "hi");
  for (const [name, value] of Object.entries(PLANTED)) assert.ok(!said[2].text.includes(value), `${name}: the run's environment is not the box's`);
  assert.equal(readFileSync(join(data, "runs", runId, "work", "out.txt"), "utf8"), "hi");
  const runs = docker.runs();
  assert.equal(runs.length, 1, "one box for the run's calls");
  const [args] = runs;
  assert.deepEqual(flag(args, "--network"), ["none"]);
  assert.deepEqual(flag(args, "--user"), [`${process.getuid()}:${process.getgid()}`]);
  // No capability and no new privilege: as root (serve run as uid 0) the box still cannot make a device node in work/.
  assert.deepEqual([flag(args, "--cap-drop"), flag(args, "--security-opt")], [["ALL"], ["no-new-privileges"]]);
  assert.deepEqual(flag(args, "--mount"), [`type=bind,source=${join(realpathSync(data), "runs", runId, "work")},target=${WORK}`]);
  assert.deepEqual(flag(args, "--workdir"), [WORK]);
  assert.deepEqual(flag(args, "--env"), ["LANG=C.UTF-8", "HOME=/tmp"], "the fixed environment, each NAME=value: a bare --env NAME would copy the host's");
  for (const label of [`agentrun.run=${runId}`, "agentrun.box=run"]) assert.ok(flag(args, "--label").includes(label), label);
  assert.equal(args[args.indexOf("--entrypoint") + 2], "registry.example/agentrun-box:1", "AGENTRUN_DOCKER_IMAGE");
  for (const never of ["-e", "-v", "--volume", "--privileged", "--env-file", "--cap-add", "-p", "--publish"]) assert.ok(!args.includes(never), never);
  // Its destroy at the run's end: removed by the id its label lists.
  await until(() => docker.removed().length === 1 && docker.gone(docker.removed()[0]), "the destroy at the run's end");
  assert.deepEqual(await docker.containers(), [], "no container is left");
});

test("fake docker: read, write and edit run no docker command, on the work/ the box binds; bash runs one docker exec; a run with no bash makes no box", { skip: !writesHeld() && "needs held directory handles (/proc/self/fd)", timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  assert.equal((await api("POST", "/agents", { definition: { id: "files", name: "files", instructions: "Probe.", place: SANDBOX, tools: ["read", "write", "edit", "bash"] } })).status, 201);
  const ran = async (plan) => {
    const run = await api("POST", "/agents/files/runs", { input: { content: JSON.stringify({ probe: plan }) } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
    return answers(data, run.body.run_id);
  };
  const files = [
    { tool: "write", args: { path: "a.txt", content: "written" } },
    { tool: "read", args: { path: "a.txt" } },
    { tool: "edit", args: { path: "a.txt", edits: [{ oldText: "written", newText: "edited" }] } },
    { tool: "read", args: { path: "a.txt" } },
  ];
  const plain = await ran(files);
  assert.deepEqual(plain.map((a) => [a.tool, a.error, a.text]).filter(([tool]) => tool === "read"), [["read", false, "written"], ["read", false, "edited"]]);
  assert.deepEqual(docker.calls().filter((args) => args[0] === "run" || args[0] === "exec"), [], "no box made, no command run in one");
  const said = await ran([...files, { tool: "bash", args: { command: "cat a.txt" } }]);
  assert.equal(said.at(-1).text, "edited", "bash, in the box, reads what the file tools wrote here");
  const execs = docker.calls().filter((args) => args[0] === "exec");
  assert.equal(execs.length, 1, JSON.stringify(execs));
  assert.ok(execs[0].join(" ").includes("cat a.txt"), "the one exec is bash's");
  assert.equal(docker.runs().length, 1, "one box, made for bash");
});

test("fake docker: a run whose earlier process left a box gets that box's left commands killed before its first read, write or edit here, with no create; a fresh run makes no box for them", { skip: !writesHeld() && "needs held directory handles (/proc/self/fd)", timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  assert.equal((await api("POST", "/agents", { definition: { id: "files", name: "files", instructions: "Probe.", place: SANDBOX, tools: ["read", "write", "edit", "bash"] } })).status, 201);
  const go = join(await scratch(t), "go");
  const run = await api("POST", "/agents/files/runs", { input: { content: JSON.stringify({ probe: [{ wait: go }, { tool: "write", args: { path: "a.txt", content: "resumed" } }, { tool: "read", args: { path: "a.txt" } }] }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  const work = join(realpathSync(data), "runs", runId, "work");
  await until(() => existsSync(work), "the run's work/");
  // The box an earlier process of the run made, as Docker would list it: its commands may still change work/.
  const id = "e".repeat(64);
  const labels = { "pi-transport.box": "1", "pi-transport.facts": JSON.stringify({ provider: "docker", workspace: WORK, isolation: "container" }), "agentrun.run": runId, "agentrun.box": "run" };
  await mkdir(join(docker.state, "containers"), { recursive: true });
  await writeFile(join(docker.state, "containers", `${id}.json`), JSON.stringify({ Id: id, State: { Running: true, ExitCode: 0 }, Config: { Labels: labels }, HostConfig: HARDENED, env: ["LANG=C.UTF-8", "HOME=/tmp"], mounts: [{ source: work, target: WORK }], workdir: WORK }));
  await writeFile(go, "");
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(answers(data, runId).map((a) => [a.tool, a.error, a.text]), [["write", false, "Successfully wrote to a.txt"], ["read", false, "resumed"]]);
  const execs = docker.calls().filter((args) => args[0] === "exec");
  assert.equal(execs.length, 1, JSON.stringify(execs));
  assert.ok(execs[0].join(" ").includes(".pi-transport") && execs[0].join(" ").includes("kill -KILL"), "the one command kills what the earlier process left, before the file tools ran");
  assert.deepEqual(docker.runs(), [], "taken over: no create");
});

test("a Docker daemon on another machine (DOCKER_HOST tcp:// or ssh://) binds none of this machine's work/: the run's box is not bound, so read, write and edit go through the box", async (t) => {
  const { codingSource } = await import("../dist/coding-tools.js");
  const root = realpathSync(await scratch(t));
  const dir = join(root, "runs", "r1");
  await mkdir(join(dir, "work"), { recursive: true });
  await writeFile(join(dir, "work", "a.txt"), "here");
  // Put back as they were once the test ends; each case sets DOCKER_HOST itself.
  withEnv(t, {}, ["DOCKER_HOST", "DOCKER_CONTEXT", "AGENTRUN_SERVE_FAUX"]);
  const boundWith = async (host) => {
    process.env.DOCKER_HOST = host;
    return runBox(() => runBoxProvider(SANDBOX, process.env, root), { id: "r1", root, dir, place: SANDBOX }).bound();
  };
  assert.equal(await boundWith("unix:///var/run/docker.sock"), true);
  for (const host of ["tcp://docker.example:2376", "ssh://builder@docker.example"]) {
    assert.equal(await boundWith(host), false, host);
    // The file tools then ask the box, never this machine's work/.
    const box = { hostWork: join(dir, "work"), bound: () => boundWith(host), env: async () => { throw new Error("in the box"); } };
    const read = codingSource(SANDBOX, box).tools.find((tool) => tool.name === "read");
    await assert.rejects(read.execute({ path: "a.txt" }, {}, BACKGROUND_CONTEXT), /in the box/, host);
  }
});

test("fake docker: a run's box made before every capability was dropped (an older version's) is ended, not taken over, and the run gets a hardened one", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  await boxedAgent(api);
  const go = join(await scratch(t), "go");
  const runId = await probe(api, [{ wait: go }, { tool: "bash", args: { command: "printf fresh > out.txt" } }]);
  const work = join(realpathSync(data), "runs", runId, "work");
  await until(() => existsSync(work), "the run's work/");
  const id = "a".repeat(64);
  const labels = { "pi-transport.box": "1", "pi-transport.facts": JSON.stringify({ provider: "docker", workspace: WORK, isolation: "container" }), "agentrun.run": runId, "agentrun.box": "run" };
  await mkdir(join(docker.state, "containers"), { recursive: true });
  // As an older serve made it: no capability dropped, so as root it could still make a device node in work/.
  await writeFile(join(docker.state, "containers", `${id}.json`), JSON.stringify({ Id: id, State: { Running: true, ExitCode: 0 }, Config: { Labels: labels }, HostConfig: { NetworkMode: "none" }, env: [], mounts: [{ source: work, target: WORK }], workdir: WORK }));
  await writeFile(go, "");
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(answers(data, runId).map((a) => [a.tool, a.error]), [["bash", false]]);
  assert.ok(docker.removed().includes(id), "the old box is ended");
  const [made] = docker.runs();
  assert.ok(made, "a new box is made");
  assert.deepEqual([flag(made, "--cap-drop"), flag(made, "--security-opt")], [["ALL"], ["no-new-privileges"]]);
  assert.equal(readFileSync(join(work, "out.txt"), "utf8"), "fresh");
  assert.ok(!docker.calls().some((args) => args[0] === "exec" && args.includes(id)), "nothing ran in the old box");
});

test("fake docker: a run's box is found by its label and taken over, its left commands killed first, with no create", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE });
  await boxedAgent(api);
  const go = join(await scratch(t), "go");
  const runId = await probe(api, [{ wait: go }, { tool: "bash", args: { command: "printf adopted > out.txt" } }]);
  const work = join(realpathSync(data), "runs", runId, "work");
  await until(() => existsSync(work), "the run's work/");
  // The box an earlier process of the run made, as Docker would list it.
  const id = "c".repeat(64);
  const labels = { "pi-transport.box": "1", "pi-transport.facts": JSON.stringify({ provider: "docker", workspace: WORK, isolation: "container" }), "agentrun.run": runId, "agentrun.box": "run" };
  await mkdir(join(docker.state, "containers"), { recursive: true });
  await writeFile(join(docker.state, "containers", `${id}.json`), JSON.stringify({ Id: id, State: { Running: true, ExitCode: 0 }, Config: { Labels: labels }, HostConfig: HARDENED, env: ["LANG=C.UTF-8", "HOME=/tmp"], mounts: [{ source: work, target: WORK }], workdir: WORK }));
  await writeFile(go, "");
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(answers(data, runId).map((a) => [a.tool, a.error]), [["bash", false]]);
  assert.equal(readFileSync(join(work, "out.txt"), "utf8"), "adopted");
  assert.deepEqual(docker.runs(), [], "taken over: no create");
  const execs = docker.calls().filter((args) => args[0] === "exec");
  assert.ok(execs[0].join(" ").includes(".pi-transport") && execs[0].join(" ").includes("kill -KILL"), "the first command kills what the earlier process left");
  await until(() => docker.removed().includes(id) && docker.gone(id), "the destroy at the run's end");
});

test("fake docker: a bash timeout kills the command's group in the box, though the killed docker exec client left it running", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t);
  // The quirk itself: a `docker exec` client killed leaves its command running in the box.
  const quirk = await scratch(t);
  const id = "d".repeat(64);
  await mkdir(join(docker.state, "containers"), { recursive: true });
  await writeFile(join(docker.state, "containers", `${id}.json`), JSON.stringify({ Id: id, State: { Running: true, ExitCode: 0 }, Config: { Labels: {} }, env: [], mounts: [{ source: quirk, target: WORK }], workdir: WORK }));
  const client = spawn("docker", ["exec", "-i", "-w", WORK, id, "sh", "-c", "echo $$ > q.pid; exec sleep 600"], { stdio: "ignore" });
  await until(() => existsSync(join(quirk, "q.pid")) && readFileSync(join(quirk, "q.pid"), "utf8").trim() !== "", "the command's start");
  const left = Number(readFileSync(join(quirk, "q.pid"), "utf8").trim());
  t.after(() => running(left) && process.kill(left, "SIGKILL"));
  client.kill("SIGKILL");
  await new Promise((resolve) => client.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(running(left), "the command outlived its killed client");
  process.kill(left, "SIGKILL");
  const { api, data } = await serve(t, { faux: PROBE });
  await boxedAgent(api);
  const runId = await probe(api, [{ tool: "bash", args: { command: "echo $$ > k.pid; sleep 600; touch late.txt", timeout: 1 } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const [bash] = answers(data, runId);
  assert.equal(bash.error, true);
  assert.match(bash.text, /timed out after 1 seconds/);
  const pid = Number(readFileSync(join(data, "runs", runId, "work", "k.pid"), "utf8").trim());
  t.after(() => running(pid) && process.kill(pid, "SIGKILL"));
  await until(() => !running(pid), "the timed-out command's kill", 15_000);
  assert.equal(existsSync(join(data, "runs", runId, "work", "late.txt")), false);
});

test("fake docker: a create that fails is the call's error, never a run on this machine, and the container it left is destroyed by its label", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t);
  await writeFile(join(docker.state, "fail-run"), "");
  const { api, data } = await serve(t, { faux: PROBE });
  await boxedAgent(api);
  const runId = await probe(api, [{ tool: "bash", args: { command: "printf x > out.txt" } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const [bash] = answers(data, runId);
  assert.equal(bash.error, true);
  assert.match(bash.text, /the run's box could not be made: docker could not start a box: docker: Error response from daemon: the fake's start failed/);
  assert.equal(existsSync(join(data, "runs", runId, "work", "out.txt")), false, "nothing ran on this machine");
  assert.equal(docker.runs().length, 1);
  // Waited on by its rm and its file, not by polling containers(), which could read a file an rm in flight is removing.
  await until(() => docker.removed().length >= 1 && docker.removed().every(docker.gone), "the left container's destroy");
  assert.deepEqual(await docker.containers(), [], "no container is left");
});

test("fake docker: the start's sweep destroys the box of a run that has ended, and leaves one of a run this store does not know", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const data = join(await scratch(t), "agents");
  const first = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  const api = client(first.baseUrl, first.token);
  await boxedAgent(api);
  const runId = await probe(api, []);
  await follow(api, runId, ["completed"]);
  await first.close();
  const left = (id, run) => writeFile(join(docker.state, "containers", `${id}.json`), JSON.stringify({ Id: id, State: { Running: true, ExitCode: 0 }, Config: { Labels: { "pi-transport.box": "1", "pi-transport.facts": JSON.stringify({ provider: "docker", workspace: WORK }), "agentrun.run": run, "agentrun.box": "run" } }, env: [], mounts: [], workdir: WORK }));
  await mkdir(join(docker.state, "containers"), { recursive: true });
  await left("a".repeat(64), runId);
  await left("b".repeat(64), "run_unknown");
  const second = await startServe({ data, port: 0, faux: PROBE, drainTimeout: "5s" });
  t.after(() => second.close());
  await until(() => docker.removed().includes("a".repeat(64)) && docker.gone("a".repeat(64)), "the sweep");
  assert.deepEqual(docker.removed(), ["a".repeat(64)]);
  assert.deepEqual((await docker.containers()).map((c) => c.Id), ["b".repeat(64)]);
});

test("a link a box's command plants in work/ never turns the server's own writes there: monid's and the browser's evidence are refused through it, and written beside it", async (t) => {
  const { monidText, CLIP } = await import("../dist/monid.js");
  const { evidenceIn } = await import("../dist/tools.js");
  const work = realpathSync(await scratch(t));
  const outside = realpathSync(await scratch(t));
  const huge = { runId: "run_1", output: "x".repeat(CLIP + 10) };
  // evidence/ itself a link out: the whole answer is not filed, and nothing lands outside.
  await symlink(outside, join(work, "evidence"));
  assert.match(await monidText(huge, work, "run"), /the whole answer could not be saved \((ELOOP|ENOTDIR)\)\]$/);
  await assert.rejects(evidenceIn(work).file("page", { tool: "browser_read", facts: {}, body: "text" }), (error) => ["ELOOP", "ENOTDIR"].includes(error.code));
  assert.deepEqual(await readdir(outside), []);
  // evidence/ real, evidence/monid a link out: refused the same.
  await rm(join(work, "evidence"));
  await mkdir(join(work, "evidence"));
  await symlink(outside, join(work, "evidence", "monid"));
  assert.match(await monidText(huge, work, "run"), /could not be saved \((ELOOP|ENOTDIR)\)\]$/);
  assert.deepEqual(await readdir(outside), []);
  // A file's own name a link out: never written through; evidence takes the next name.
  await writeFile(join(outside, "target.md"), "kept");
  await symlink(join(outside, "target.md"), join(work, "evidence", "0001-browser_read.md"));
  assert.deepEqual(await evidenceIn(work).file("page", { tool: "browser_read", facts: {}, body: "text" }), { path: "evidence/0002-browser_read.md", bodyLine: 3 });
  assert.equal(readFileSync(join(outside, "target.md"), "utf8"), "kept");
  assert.deepEqual(await readdir(outside), ["target.md"]);
  // With no link in the way, both file as before.
  await rm(join(work, "evidence", "monid"));
  assert.match(await monidText(huge, work, "run"), /the whole answer is in the run's files at evidence\/monid\/run_1\.json\]$/);
  assert.equal(readFileSync(join(work, "evidence", "monid", "run_1.json"), "utf8"), JSON.stringify(huge));
  // The same answer again: filed already, its file kept.
  assert.match(await monidText(huge, work, "run"), /the whole answer is in the run's files at evidence\/monid\/run_1\.json\]$/);
  // A link planted at the answer's own name is no filing: the answer says it could not be saved, and names no path.
  const other = { runId: "run_2", output: "y".repeat(CLIP + 10) };
  await symlink(join(outside, "target.md"), join(work, "evidence", "monid", "run_2.json"));
  const linked = await monidText(other, work, "run");
  assert.match(linked, /the whole answer could not be saved \(EEXIST\)\]$/);
  assert.doesNotMatch(linked, /evidence\/monid\/run_2\.json/);
  assert.equal(readFileSync(join(outside, "target.md"), "utf8"), "kept");
});

test("where this host reaches a run's directories by path (no /proc/self/fd, as on macOS), the server files nothing in a sandbox run's work/, and still files in a runner run's", async (t) => {
  const { monidText, CLIP } = await import("../dist/monid.js");
  const { evidenceIn } = await import("../dist/tools.js");
  const { workspaceTestHooks } = await import("../dist/workspace.js");
  workspaceTestHooks.byPath = true;
  t.after(() => void (workspaceTestHooks.byPath = undefined));
  const huge = { runId: "run_1", output: "x".repeat(CLIP + 10) };
  const runDir = async (place) => {
    const dir = realpathSync(await scratch(t));
    await mkdir(join(dir, "work"));
    await writeFile(join(dir, "serve.json"), JSON.stringify({ title: "t", created_at: new Date().toISOString(), place }));
    return join(dir, "work");
  };
  const boxed = await runDir({ mode: "sandbox", box: "docker" });
  assert.match(await monidText(huge, boxed, "run"), /the whole answer could not be saved \(ENOTSUP\)\]$/);
  await assert.rejects(evidenceIn(boxed).file("page", { tool: "browser_read", facts: {}, body: "text" }), (error) => error.code === "ENOTSUP");
  assert.deepEqual(await readdir(boxed), [], "nothing was written in the box's work/");
  const runner = await runDir({ mode: "runner" });
  assert.match(await monidText(huge, runner, "run"), /the whole answer is in the run's files at evidence\/monid\/run_1\.json\]$/);
  assert.equal(readFileSync(join(runner, "evidence", "monid", "run_1.json"), "utf8"), JSON.stringify(huge));
});
