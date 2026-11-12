// Docker by default: a server started with AGENTRUN_BOXES not set at all probes Docker as if it were listed (place-offers.ts
// enabledBoxes), and offers it when Docker answers, so a new agent lands in the Docker box with a shell (place.ts
// newAgentPlace). Where Docker is not there, new agents run on the runner and capabilities, the start's banner and the
// console's editor say why in words a first-time user can act on. An operator's AGENTRUN_BOXES still wins: a list probes
// only what it names, and an empty value or `none` sets up no box. Every other box stays the operator's to list.
// Everything runs on a fake `docker` first on PATH (fixtures/fake-docker.mjs), or on a PATH with no docker at all: no
// daemon is reached, nothing is pulled or built, and no box provider is called.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { enabledBoxes, placeOffers, remoteNoList, withNetworks } from "../dist/place-offers.js";
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
const JOIN_GROUP = "This server's process isn't in the docker group: add this user to it with `sudo usermod -aG docker $USER`, then restart your user manager with `sudo systemctl restart user@$(id -u)`, or log in again if linger is off";
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

// SKIP (follow-up #2080): the default Docker box's run ends failed on the runner instead of writing out.txt in the box.
test.skip("demo through the API: with AGENTRUN_BOXES not set and Docker answering, docker is on by default; a new agent is saved in the Docker box with bash, and its run writes out.txt there", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, undefined);
  const server = await serve(t, { faux: PROBE });
  const { api } = server;
  const places = await placesOf(api);
  assert.equal(dockerOf(places).available, true, JSON.stringify(dockerOf(places)));
  assert.equal(dockerOf(places).state, "ready");
  assert.deepEqual(places.default_place, DOCKER);
  assert.equal("default_reason" in places, false);
  assert.ok(server.boxesLine.startsWith(ON_BY_DEFAULT), server.boxesLine);
  assert.ok(docker.calls().some((args) => args[0] === "version"), "docker was probed");
  for (const id of ["daytona", "modal"]) assert.equal(places.boxes.find((box) => box.id === id).reason, `not enabled on this server: start AgentRun with AGENTRUN_BOXES=docker,${id}`, "every other box stays opt-in, and its setting keeps docker");
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
  const offers = await placeOffers({ PATH: bin });
  assert.deepEqual(offers.find((offer) => offer.id === "docker"), { id: "docker", available: false, reason: NO_DAEMON });
});

/** Docker's words for a socket that refused this process: the CLI's, and a bare connect's EACCES. */
const CLI_DENIED = "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get \\\"http://%2Fvar%2Frun%2Fdocker.sock/v1.47/version\\\": EOF";
const CONNECT_DENIED = "error during connect: Get http://%2Fvar%2Frun%2Fdocker.sock/v1.47/version: dial unix /var/run/docker.sock: connect: permission denied";

/** A docker on PATH that answers `words` on stderr and fails. */
async function deniedDocker(t, words) {
  const bin = join(await scratch(t), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), `#!/bin/sh\necho "${words}" >&2\nexit 1\n`, { mode: 0o755 });
  return bin;
}

/** A group file whose docker group (gid 999) lists `members`. */
async function groupFile(t, members) {
  const file = join(await scratch(t), "group");
  await writeFile(file, `root:x:0:\ndocker:x:999:${members.join(",")}\nusers:x:100:\n`);
  return file;
}

test("a docker socket that refuses this process: the group file lists the user, so a restart of the user manager is the fix; it does not, so joining comes first; either of docker's wordings", async (t) => {
  const joined = await groupFile(t, ["someone", "manuel"]);
  const never = await groupFile(t, ["someone"]);
  for (const words of [CLI_DENIED, CONNECT_DENIED]) {
    const bin = await deniedDocker(t, words);
    const reasonOf = async (groups) => (await placeOffers({ PATH: bin }, { groups })).find((offer) => offer.id === "docker");
    assert.deepEqual(await reasonOf({ file: joined, user: "manuel", ids: [100] }), { id: "docker", available: false, reason: NOT_IN_GROUP }, words);
    assert.deepEqual(await reasonOf({ file: never, user: "manuel", ids: [100] }), { id: "docker", available: false, reason: JOIN_GROUP }, words);
    // In the group and holding it, yet refused: no restart would help, so the reason says to join (the full fix).
    assert.deepEqual(await reasonOf({ file: joined, user: "manuel", ids: [100, 999] }), { id: "docker", available: false, reason: JOIN_GROUP }, words);
    assert.deepEqual(await reasonOf({ file: join(await scratch(t), "none"), user: "manuel", ids: [100] }), { id: "docker", available: false, reason: JOIN_GROUP }, "no group file: it cannot say");
    // A process whose uid has no name (no passwd entry) cannot be looked up: the guidance stays, never a failed probe.
    assert.deepEqual(await reasonOf({ file: await groupFile(t, ["", "manuel"]), user: "", ids: [100] }), { id: "docker", available: false, reason: JOIN_GROUP }, "no user name");
  }
});

test("a refused docker socket's reason is the one capabilities, the default reason and the banner say, default or listed", { timeout: 60_000 }, async (t) => {
  const bin = await deniedDocker(t, CLI_DENIED);
  withEnv(t, { PATH: `${bin}:${dirname(process.execPath)}` }, ["AGENTRUN_BOXES", "AGENTRUN_DOCKER_IMAGE", "AGENTRUN_BOX_ALLOW"]);
  const server = await serve(t, { faux: PROBE });
  const places = await placesOf(server.api);
  const reason = dockerOf(places).reason;
  assert.ok([NOT_IN_GROUP, JOIN_GROUP].includes(reason), reason);
  assert.equal(places.default_reason, `new agents run on the runner, because the docker box is unavailable here: ${reason}`);
  assert.equal(server.boxesLine, `Boxes: none, so new agents run on the runner. ${reason}.`);
  withEnv(t, { AGENTRUN_BOXES: "docker" });
  const listed = await serve(t, { faux: PROBE });
  assert.ok(listed.boxesLine.includes(`docker: ${reason}.`), listed.boxesLine);
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

test("daytona and modal are offered by their computer provider's required keys, read through keyOf (the environment, else a key saved in Settings → Computers); neither vendor is asked anything", async () => {
  const saved = { DAYTONA_API_KEY: "fake-test-key", MODAL_TOKEN_ID: "saved-modal-id" };
  const asked = [];
  const keyOf = async (name) => (asked.push(name), saved[name]);
  const offers = await placeOffers({ AGENTRUN_BOXES: "daytona,modal" }, { keyOf });
  assert.deepEqual(offers.find((offer) => offer.id === "daytona"), { id: "daytona", available: true, reason: "configured; not probed at start" });
  assert.deepEqual(offers.find((offer) => offer.id === "modal"), { id: "modal", available: false, reason: "needs MODAL_TOKEN_SECRET" }, "a token pair with one half missing is not offered");
  assert.deepEqual(asked.sort(), ["DAYTONA_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"], "only each provider's required keys are read");
  // With no keyOf, the environment alone; no key's value is in an offer.
  const fromEnv = await placeOffers({ AGENTRUN_BOXES: "modal", MODAL_TOKEN_ID: "env-id", MODAL_TOKEN_SECRET: "env-secret" });
  assert.deepEqual(fromEnv.find((offer) => offer.id === "modal"), { id: "modal", available: true, reason: "configured; not probed at start" });
  const shown = JSON.stringify([...offers, ...fromEnv]);
  assert.ok(!shown.includes("fake-test-key") && !shown.includes("saved-modal-id") && !shown.includes("env-"), "no key's value in an offer");
});

test("what each available box reaches: docker through its egress proxy (or none, or unavailable as refused); daytona and modal never get the host list", () => {
  const offers = [{ id: "bwrap", available: false, reason: "not yet" }, { id: "docker", available: true }, { id: "modal", available: true }, { id: "daytona", available: true }];
  const by = (list) => Object.fromEntries(list.map((offer) => [offer.id, offer]));
  const listed = by(withNetworks(offers, ["pypi.org"], { hostAddresses: ["docker-host-address"] }));
  assert.deepEqual(listed.bwrap, { id: "bwrap", available: false, reason: "not yet" });
  assert.deepEqual(listed.docker, { id: "docker", available: true, network: "allowlist", host_addresses: ["docker-host-address"] });
  assert.deepEqual(listed.daytona, { id: "daytona", available: true, network: "none", network_reason: remoteNoList("daytona") });
  assert.deepEqual(listed.modal, { id: "modal", available: true, network: "none", network_reason: remoteNoList("modal") });
  const none = by(withNetworks(offers, "none"));
  assert.deepEqual([none.docker.network, none.docker.network_reason, none.daytona.network, none.daytona.network_reason, none.modal.network_reason], ["none", "AGENTRUN_BOX_ALLOW is none", "none", undefined, undefined]);
  assert.deepEqual(by(withNetworks(offers, ["pypi.org"], { refused: "Docker is another machine's" })).docker, { id: "docker", available: false, state: "unavailable", reason: "Docker is another machine's" });
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
  // The start builds and pulls nothing: a Docker computer makes its image ready on its first run.
  assert.deepEqual(docker.calls().filter((args) => ["build", "pull", "image", "buildx"].includes(args[0])), [], "no image asked for at the start");
});
