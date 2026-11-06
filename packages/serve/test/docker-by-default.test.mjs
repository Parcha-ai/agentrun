// Docker by default: a server started with AGENTRUN_BOXES not set at all probes Docker as if it were listed (boxes.ts
// enabledBoxes), and offers it when Docker answers, so a new agent lands in the Docker box with a shell (place.ts
// newAgentPlace). Where Docker is not there, new agents run on the runner and capabilities, the start's banner and the
// console's editor say why in words a first-time user can act on. An operator's AGENTRUN_BOXES still wins: a list probes
// only what it names, and an empty value or `none` sets up no box. Every other box stays the operator's to list.
// Everything runs on a fake `docker` first on PATH (fixtures/fake-docker.mjs), or on a PATH with no docker at all: no
// daemon is reached, nothing is pulled or built, and no box provider is called.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { boxRegistry, enabledBoxes, VM_PROVIDER } from "../dist/boxes.js";
import { client, follow, jsonLines, printed, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const DOCKER = { mode: "sandbox", box: "docker" };
const RUNNER = { mode: "runner" };
const ON_BY_DEFAULT = "Boxes: docker (on by default; set AGENTRUN_BOXES to change).";
const NO_DOCKER = "Docker isn't running on this machine (no docker command on PATH): install or start Docker, then restart AgentRun";
const NO_DAEMON = "Docker isn't running on this machine, or this user may not use it (docker version failed: exit 1): start Docker, or add this user to the docker group, then restart AgentRun";
const NOT_IN_GROUP = "This server's process isn't in the docker group: restart your user manager with `sudo systemctl restart user@$(id -u)`, or log in again if linger is off";
const PREPARING = "Preparing the Docker box image (first start only, a few minutes); agents can be made now, and their first run waits for it.";
const NOT_ENABLED = "not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker";

/** A fake docker first on PATH, its state directory set, and AGENTRUN_BOXES as `boxes` says (undefined: not set at all). */
async function fakeDocker(t, boxes) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, ...(boxes === undefined ? {} : { AGENTRUN_BOXES: boxes }) }, ["AGENTRUN_BOXES", "AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW", "DAYTONA_API_KEY"]);
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
  return { calls: () => jsonLines(join(state, "argv.jsonl")), state };
}

/** A PATH with no docker on it (an empty directory), AGENTRUN_BOXES not set. */
async function noDocker(t) {
  // A directory of its own, empty: wherever node and docker are installed, no docker is on this PATH.
  const empty = join(await scratch(t), "empty");
  await mkdir(empty);
  withEnv(t, { PATH: empty }, ["AGENTRUN_BOXES", "AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW"]);
  assert.notEqual(spawnSync("/bin/sh", ["-c", "command -v docker"], { encoding: "utf8" }).status, 0, "no docker on PATH");
}

const placesOf = async (api) => (await api("GET", "/capabilities")).body.places;
const dockerOf = (places) => places.boxes.find((box) => box.id === "docker");
/** A definition as a person writes one first: a name and instructions, no place and no tools. */
const fresh = (id) => ({ definition: { id, name: id, instructions: "Probe." } });
const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("demo through the API: with AGENTRUN_BOXES not set and Docker answering, docker is on by default; a new agent is saved in the Docker box with bash, and its run writes out.txt there", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, undefined);
  const server = await serve(t, { faux: PROBE });
  const { api } = server;
  const places = await placesOf(api);
  assert.equal(dockerOf(places).available, true, JSON.stringify(dockerOf(places)));
  assert.ok(["ready", "preparing"].includes(dockerOf(places).state));
  assert.deepEqual(places.default_place, DOCKER);
  assert.equal("default_reason" in places, false);
  assert.ok(server.boxesLine.startsWith(ON_BY_DEFAULT), server.boxesLine);
  assert.ok(docker.calls().some((args) => args[0] === "version"), "docker was probed");
  for (const id of ["daytona", VM_PROVIDER.id]) assert.equal(places.boxes.find((box) => box.id === id).reason, `not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker,${id}`, "every other box stays opt-in, and its setting keeps docker");
  const made = await api("POST", "/agents", fresh("shelly"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.definition.place, DOCKER);
  assert.ok(made.body.definition.tools.includes("bash"), JSON.stringify(made.body.definition.tools));
  const run = await api("POST", "/agents/shelly/runs", { input: { content: JSON.stringify({ probe: [{ tool: "bash", args: { command: "printf 'hello from the box\\n' > out.txt" } }] }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.deepEqual(run.body.place, DOCKER);
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.ok(docker.calls().some((args) => args[0] === "exec" && args.join(" ").includes("out.txt")), "bash ran in the box, through docker exec");
  assert.equal((await api("GET", `/runs/${run.body.run_id}/files/out.txt`)).body, "hello from the box\n");
});

test("with AGENTRUN_BOXES not set and no docker command on PATH, new agents run on the runner, and capabilities and the banner say why plainly", { timeout: 60_000 }, async (t) => {
  await noDocker(t);
  const server = await serve(t, { faux: PROBE });
  const places = await placesOf(server.api);
  assert.deepEqual(dockerOf(places), { id: "docker", available: false, state: "unavailable", reason: NO_DOCKER });
  assert.deepEqual(places.default_place, RUNNER);
  assert.equal(places.default_reason, `new agents run on the runner, because the docker box is unavailable here: ${NO_DOCKER}`);
  assert.equal(server.boxesLine, `Boxes: none, so new agents run on the runner. ${NO_DOCKER}.`);
  const made = await server.api("POST", "/agents", fresh("plain"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal("place" in made.body.definition, false);
  assert.deepEqual(made.body.definition.tools, []);
});

test("with AGENTRUN_BOXES not set and a Docker daemon that does not answer, the reason says so and what to do", async (t) => {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n", { mode: 0o755 });
  const registry = await boxRegistry({ PATH: bin });
  assert.deepEqual(registry.offers().find((offer) => offer.id === "docker"), { id: "docker", available: false, reason: NO_DAEMON });
});

/** A docker on PATH whose daemon refuses this process its socket, in the Docker CLI's own words. */
async function deniedDocker(t) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), "#!/bin/sh\necho 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/version\": dial unix /var/run/docker.sock: connect: permission denied' >&2\nexit 1\n", { mode: 0o755 });
  return bin;
}

test("a docker whose socket refuses this server's process says it is not in the docker group, and how to fix that without a reboot: in capabilities, the default reason and the banner, default or listed", { timeout: 60_000 }, async (t) => {
  const bin = await deniedDocker(t);
  const registry = await boxRegistry({ PATH: bin });
  assert.deepEqual(registry.offers().find((offer) => offer.id === "docker"), { id: "docker", available: false, reason: NOT_IN_GROUP });
  withEnv(t, { PATH: `${bin}:${dirname(process.execPath)}` }, ["AGENTRUN_BOXES", "AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW"]);
  const server = await serve(t, { faux: PROBE });
  const places = await placesOf(server.api);
  assert.equal(dockerOf(places).reason, NOT_IN_GROUP);
  assert.equal(places.default_reason, `new agents run on the runner, because the docker box is unavailable here: ${NOT_IN_GROUP}`);
  assert.equal(server.boxesLine, `Boxes: none, so new agents run on the runner. ${NOT_IN_GROUP}.`);
  withEnv(t, { AGENTRUN_BOXES: "docker" });
  const listed = await serve(t, { faux: PROBE });
  assert.ok(listed.boxesLine.includes(`docker: ${NOT_IN_GROUP}.`), listed.boxesLine);
});

test("an explicit AGENTRUN_BOXES wins: a list probes only what it names, so daytona alone asks Docker nothing", { timeout: 60_000 }, async (t) => {
  const docker = await fakeDocker(t, "daytona");
  const server = await serve(t, { faux: PROBE });
  const places = await placesOf(server.api);
  assert.deepEqual(dockerOf(places), { id: "docker", available: false, state: "unavailable", reason: "not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker,daytona" });
  assert.equal(places.boxes.find((box) => box.id === "daytona").reason, "needs DAYTONA_API_KEY");
  assert.deepEqual(places.default_place, RUNNER);
  assert.deepEqual(docker.calls(), [], "no docker command ran");
  assert.ok(server.boxesLine.startsWith("Boxes: none is ready, so sandbox agents do not run here."), server.boxesLine);
  assert.ok(!server.boxesLine.includes("on by default"), server.boxesLine);
});

for (const value of ["", "none", " none "]) {
  test(`AGENTRUN_BOXES=${JSON.stringify(value)} sets up no box: nothing is probed, and new agents run on the runner`, { timeout: 60_000 }, async (t) => {
    const docker = await fakeDocker(t, value);
    assert.deepEqual([...enabledBoxes(process.env)], []);
    const server = await serve(t, { faux: PROBE });
    const places = await placesOf(server.api);
    assert.ok(places.boxes.every((box) => !box.available), JSON.stringify(places.boxes));
    assert.equal(dockerOf(places).reason, NOT_ENABLED);
    assert.deepEqual(places.default_place, RUNNER);
    assert.equal(places.default_reason, `new agents run on the runner, because the docker box is unavailable here: ${NOT_ENABLED}`);
    assert.deepEqual(docker.calls(), [], "no docker command ran");
    assert.ok(server.boxesLine.startsWith("Boxes: none is ready, so sandbox agents do not run here."), server.boxesLine);
  });
}

test("the published server installs the Docker box's provider: @parcha/pi-transport is a dependency at the server's version, not an optional peer", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const transport = JSON.parse(readFileSync(new URL("../../pi-transport/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.dependencies["@parcha/pi-transport"], manifest.version);
  assert.equal(transport.version, manifest.version);
  assert.equal(manifest.peerDependencies?.["@parcha/pi-transport"], undefined);
  assert.equal(manifest.peerDependenciesMeta?.["@parcha/pi-transport"], undefined);
});

test("none stands alone: AGENTRUN_BOXES that names none and a box refuses the start, naming why", () => {
  assert.throws(() => enabledBoxes({ AGENTRUN_BOXES: "none,docker" }), /AGENTRUN_BOXES=none sets up no box, so it names no other: list the boxes to set up, or none alone/);
  assert.deepEqual([...enabledBoxes({})], ["docker"], "not set: docker");
  assert.deepEqual([...enabledBoxes({ AGENTRUN_BOXES: "daytona" })], ["daytona"]);
});

test("fresh-HOME start of the built CLI with AGENTRUN_BOXES not set, a fake docker first on PATH: the banner says docker is on by default, capabilities show it, a new agent lands in the box with bash, and the image's first build is said as it starts and ends", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, undefined);
  const home = await scratch(t);
  const token = "a-fresh-home-token-of-32-characters-or-more";
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), AGENTRUN_TOKEN: token };
  delete env.AGENTRUN_BOXES;
  const child = spawn(process.execPath, [CLI, "--port", "0", "--faux", PROBE], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  t.after(() => {
    if (child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  });
  let all = "";
  child.stdout.on("data", (chunk) => (all += chunk));
  const out = await printed(child, /^Boxes: /m);
  const line = out.split("\n").find((text) => text.startsWith("Boxes: "));
  assert.ok(line.startsWith(ON_BY_DEFAULT), line);
  const baseUrl = /^AGENTRUN_BASE_URL=(\S+)$/m.exec(out)?.[1];
  assert.ok(baseUrl, out);
  const api = client(baseUrl, token);
  await until(async () => (await api("GET", "/health")).status === 200, "the server answers");
  const places = (await api("GET", "/capabilities")).body.places;
  assert.equal(dockerOf(places).available, true, JSON.stringify(places.boxes));
  assert.deepEqual(places.default_place, DOCKER);
  const made = await api("POST", "/agents", fresh("first"));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.definition.place, DOCKER);
  assert.ok(made.body.definition.tools.includes("bash"), JSON.stringify(made.body.definition.tools));
  assert.ok(docker.calls().some((args) => args[0] === "version"), "the CLI's start probed docker");
  // The box image's first build, said as it starts and as it ends, after the banner.
  await until(async () => /^The Docker box image is ready\.$/m.test(all), "the image's end line");
  const said = all.split("\n");
  const at = (text) => said.indexOf(text);
  assert.ok(at(PREPARING) > said.findIndex((text) => text.startsWith("Boxes: ")), all);
  assert.ok(at("The Docker box image is ready.") > at(PREPARING), all);
});
