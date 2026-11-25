// A server in a container of the Docker it runs computers on, given that Docker's socket (compose.yaml): the daemon has
// none of the server's paths, only what it mounted into the server's container. The server finds its own container
// (box-paths.ts), and a Docker computer mounts the run's folder as a subpath of the data directory's volume, with a fake
// `docker` first on PATH (fixtures/fake-docker.mjs; no daemon is reached). Where it cannot, docker is unavailable, saying
// why.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate as macrotask } from "node:timers/promises";
import { takeServerLock } from "../dist/server-lock.js";
import { jsonLines, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const IMAGE = "debian:bookworm-slim";
const ID = "c0ffee".padEnd(64, "0");

/** /proc/self/mountinfo of a process in a container whose files Docker keeps under `root` (`/var/lib/docker`, rootless's,
 *  userns-remap's), with id `id`. */
const mountinfo = (id, root = "/var/lib/docker") => [
  "1601 1520 0:243 / / rw,relatime master:612 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC",
  `1611 1601 259:1 ${root}/containers/${id}/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/root rw`,
  `1612 1601 259:1 ${root}/containers/${id}/hostname /etc/hostname rw,relatime - ext4 /dev/root rw`,
  `1613 1601 259:1 ${root}/containers/${id}/hosts /etc/hosts rw,relatime - ext4 /dev/root rw`,
  "",
].join("\n");

/** A fake docker first on PATH, as the Docker that runs this server in container ID with `mounts`, whose data root this
 *  server can't see; `volumes`: each named volume's directory here; `marks`: more state files. */
async function containerDocker(t, { mounts, volumes = {}, marks = {}, own = true }) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(join(state, "containers"), { recursive: true });
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  await writeFile(join(state, "docker-info"), `linux|${release()}|/var/lib/docker|Docker Engine - Community\n`);
  await writeFile(join(state, "volumes.json"), JSON.stringify(volumes));
  for (const [name, text] of Object.entries(marks)) await writeFile(join(state, name), text);
  if (own) await writeFile(join(state, "containers", `${ID}.json`), JSON.stringify({ Id: ID, State: { Running: true, ExitCode: 0 }, Config: { Labels: {} }, HostConfig: {}, Mounts: mounts }));
  const info = join(dir, "mountinfo");
  await writeFile(info, mountinfo(ID));
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, AGENTRUN_BOXES: "docker", AGENTRUN_DOCKER_IMAGE: IMAGE }, ["AGENTRUN_BOX_ALLOW"]);
  const lines = (name) => jsonLines(join(state, name));
  return { state, mountinfo: info, runs: () => lines("argv.jsonl").filter((args) => args[0] === "run") };
}

/** A data directory of its own, canonical, as the server's container has it at its mount. */
async function dataDir(t) {
  const data = join(realpathSync(await scratch(t)), "data");
  await mkdir(data, { mode: 0o700 });
  return data;
}

const docker = async (api) => (await api("GET", "/capabilities")).body.places.boxes.find((box) => box.id === "docker");

test("its own container, read from /proc/self/mountinfo (the source of the /etc/hostname Docker bound in); none on a host", async () => {
  const { ownContainerOf } = await import("../dist/box-paths.js");
  assert.equal(ownContainerOf(mountinfo(ID)), ID);
  assert.equal(ownContainerOf("22 1 259:1 / / rw,relatime shared:1 - ext4 /dev/root rw\n"), undefined, "a host");
  assert.equal(ownContainerOf(`1 1 259:1 /var/lib/docker/containers/${ID}/hostname /opt/hostname rw - ext4 /dev/root rw\n`), undefined, "only its own /etc/hostname counts");
});
test("where the daemon has the data directory: the read-write named volume of its container that holds it, on Docker Engine 26+; any other layout is compose's one way in, an older engine says so", async () => {
  const { pathsOf, IN_COMPOSE, OLD_ENGINE } = await import("../dist/box-paths.js");
  const volume = { Type: "volume", Name: "agentrun_agentrun-data", Destination: "/data", RW: true };
  assert.equal(IN_COMPOSE, "run AgentRun in a container with `docker compose up` from compose.yaml (its named data volume is how boxes reach a run's files)");
  assert.equal(OLD_ENGINE, "Docker Engine <26 can't mount a named volume's subpath: upgrade to Docker 26+");
  assert.deepEqual(pathsOf([volume], "/data", "1.47\n"), { paths: { at: "/data", volume: "agentrun_agentrun-data" } });
  assert.deepEqual(pathsOf([{ Type: "bind", Destination: "/", RW: true }, volume], "/data/agents", "1.45"), { paths: { at: "/data", volume: "agentrun_agentrun-data" } }, "the deepest mount that holds it");
  assert.deepEqual(pathsOf([volume], "/data", "1.44"), { reason: OLD_ENGINE });
  assert.deepEqual(pathsOf([volume], "/data", ""), { reason: OLD_ENGINE }, "an engine that names no version");
  for (const mounts of [[], [{ ...volume, Destination: "/other" }], [{ ...volume, Destination: "/dat" }], [{ ...volume, RW: false }], [{ Type: "bind", Destination: "/data", RW: true }], [{ Type: "tmpfs", Destination: "/data", RW: true }]]) {
    assert.deepEqual(pathsOf(mounts, "/data", "1.47"), { reason: IN_COMPOSE }, JSON.stringify(mounts));
  }
  // A mount below the data directory hides part of it from the volume a box mounts its run's folder from: the box would
  // get the volume's files there, not the server's. Refused; one beside it is not below it.
  for (const below of ["/data/disk", "/data/disk/agents/a/runs", "/data/box-egress"]) {
    assert.deepEqual(pathsOf([volume, { Type: "bind", Destination: below, RW: true }], "/data", "1.47"), { reason: IN_COMPOSE }, below);
  }
  assert.deepEqual(pathsOf([volume, { Type: "bind", Destination: "/data-other", RW: true }], "/data", "1.47"), { paths: { at: "/data", volume: "agentrun_agentrun-data" } });
});
test("on a host (no container of its own), nothing is asked of Docker and the paths are this machine's: the Linux path as it was; a container it can't place is compose's one way in", async () => {
  const { dockerPathsOf, IN_COMPOSE } = await import("../dist/box-paths.js");
  const asked = [];
  const call = async (args) => (asked.push(args), { code: 0, stdout: "", stderr: "" });
  const host = "22 1 259:1 / / rw - ext4 /dev/root rw\n";
  assert.deepEqual(await dockerPathsOf(process.env, "/data", { mountinfo: host, inContainer: false, docker: call }), { here: true });
  assert.deepEqual(asked, []);
  assert.deepEqual(await dockerPathsOf(process.env, "/data", { mountinfo: host, inContainer: true, docker: call }), { reason: IN_COMPOSE });
  const gone = async (args) => (args[0] === "inspect" ? { code: 1, stdout: "", stderr: `Error: No such object: ${ID}` } : { code: 0, stdout: "1.47\n", stderr: "" });
  assert.deepEqual(await dockerPathsOf(process.env, "/data", { mountinfo: mountinfo(ID), inContainer: true, docker: gone }), { reason: IN_COMPOSE }, "another Docker's socket");
});

const IN_COMPOSE = "run AgentRun in a container with `docker compose up` from compose.yaml (its named data volume is how boxes reach a run's files)";

test("the server in a container that this Docker does not have, its data not on a named volume, or on an engine that can't mount a volume's subpath: docker is unavailable at start, saying why, and no box is made", { timeout: 120_000 }, async (t) => {
  for (const [given, reason] of [
    [{ own: false }, IN_COMPOSE],
    [{ bind: true }, IN_COMPOSE],
    [{ marks: { "docker-api": "1.44\n" } }, "Docker Engine <26 can't mount a named volume's subpath: upgrade to Docker 26+"],
  ]) {
    const data = await dataDir(t);
    const mounts = given.bind ? [{ Type: "bind", Source: "/opt/agentrun-data", Destination: data, RW: true }] : [{ Type: "volume", Name: "v", Source: "/var/lib/docker/volumes/v/_data", Destination: data, RW: true }];
    const fake = await containerDocker(t, { mounts, volumes: { v: data }, ...given });
    // The bind case names its mountinfo as a server under test in a container does: in the process's environment.
    if (given.bind) withEnv(t, { AGENTRUN_SERVE_FAUX_MOUNTINFO: fake.mountinfo });
    const { api } = await serve(t, { data, faux: PROBE, ...(given.bind ? {} : { fauxMountinfo: fake.mountinfo }) });
    const offer = await docker(api);
    assert.equal(offer.available, false, JSON.stringify(offer));
    assert.equal(offer.state, "unavailable");
    assert.equal(offer.reason, reason);
    assert.deepEqual(fake.runs(), []);
  }
});

// A server in a container with no named data volume can't run a Docker computer (its run's folder and the computer's
// daemon would be mounted by paths the host's Docker doesn't have): the words above refuse a run that names one at its
// start, never at its create, and an agent with no computer falls back as on a machine with no Docker, to the runner,
// with the file tools and no shell.
test("the server in a container with no named data volume: a run naming a Docker computer is refused at its start in those words, and a new agent gets the runner", { timeout: 120_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, { mounts: [{ Type: "bind", Source: "/opt/agentrun-data", Destination: data, RW: true }] });
  withEnv(t, { AGENTRUN_SERVE_FAUX_MOUNTINFO: fake.mountinfo });
  const { api } = await serve(t, { data, faux: PROBE });
  const offer = await docker(api);
  assert.deepEqual([offer.available, offer.state, offer.reason], [false, "unavailable", IN_COMPOSE], JSON.stringify(offer));

  const made = await api("POST", "/agents", { definition: { id: "boxed-computer", name: "boxed", instructions: "Probe.", computer: { kind: "sandbox", provider: "docker" } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", "/agents/boxed-computer/runs", { input: { content: "Probe." } });
  assert.equal(started.status, 409, JSON.stringify(started.body));
  assert.equal(started.body.error.code, "agent_not_runnable");
  const field = started.body.error.fields.find((one) => one.field === "definition.computer");
  assert.equal(field?.message, `This agent's computer is a Docker sandbox, and this server cannot run it: ${IN_COMPOSE}.`, JSON.stringify(started.body));

  // An agent that names no place or computer: the runner, as where there is no Docker, with no default tools (no shell).
  const plain = await api("POST", "/agents", { definition: { id: "plain", name: "plain", instructions: "Answer." } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  const read = await api("GET", "/agents/plain");
  assert.equal(read.body.place?.mode ?? "runner", "runner", JSON.stringify(read.body));
  assert.deepEqual(read.body.tools ?? [], [], "no shell, no other default tool");
  assert.deepEqual(fake.runs(), [], "no box or computer is made");
});

// compose.yaml's own layout (its data a named volume, Docker Engine 26+) under an allow-list: a Docker computer keeps
// the list only knowing the Docker host's own addresses, the union of the read through the socket (one container on the
// host's network, docker-host-addresses.ts) and AGENTRUN_DOCKER_HOST_ADDRESSES, read once at the start. With none,
// Docker isn't offered, in words that name both ways out; under none no read is made.
const COMPOSE_MOUNTS = (data) => ({ mounts: [{ Type: "volume", Name: "agentrun_agentrun-data", Source: "/var/lib/docker/volumes/agentrun_agentrun-data/_data", Destination: data, RW: true }], volumes: { "agentrun_agentrun-data": data } });
const hostReads = (fake) => jsonLines(join(fake.state, "host-reads.jsonl"));

test("compose's layout under an allow-list: the Docker host's addresses read once through the socket, unioned with AGENTRUN_DOCKER_HOST_ADDRESSES and shown in capabilities (a Desktop's gateway among them); a failed read with no setting is refused in words, with it offered", { timeout: 240_000 }, async (t) => {
  const NO_ADDRESSES = "the server runs in a container and doesn't know the Docker host's own addresses (the read through Docker's socket failed (exit 125: docker: Error response from daemon: the fake's read failed.)), so a Docker computer can't keep this server's allow-list: set AGENTRUN_DOCKER_HOST_ADDRESSES to the host's IP addresses, or AGENTRUN_BOX_ALLOW=none for no network";
  // Each case's addresses as capabilities show them, where an operator looks (undefined when Docker isn't offered). The
  // setting is saved once, here, and restored at the end: a save per case would restore one case's value after the others
  // (after-hooks run in the order they were added), and the tests after this one would read it.
  withEnv(t, {}, ["AGENTRUN_DOCKER_HOST_ADDRESSES"]);
  for (const [given, available, shown] of [
    [{ read: { interfaces: ["127.0.0.1", "172.17.0.1", "203.0.113.7"], gateway: [] } }, true, ["172.17.0.1", "203.0.113.7"]],
    [{ fail: true }, false, undefined],
    [{ fail: true, named: "198.51.100.9" }, true, ["198.51.100.9"]],
    [{ read: { interfaces: ["192.168.65.3"], gateway: ["192.168.65.254"] }, named: "203.0.113.9" }, true, ["192.168.65.3", "192.168.65.254", "203.0.113.9"]],
  ]) {
    const data = await dataDir(t);
    const fake = await containerDocker(t, COMPOSE_MOUNTS(data));
    if (given.read) await writeFile(join(fake.state, "host-addresses.json"), `${JSON.stringify(given.read)}\n`);
    if (given.fail) await writeFile(join(fake.state, "host-addresses-fail"), "");
    if (given.named) process.env.AGENTRUN_DOCKER_HOST_ADDRESSES = given.named;
    else delete process.env.AGENTRUN_DOCKER_HOST_ADDRESSES;
    const { api } = await serve(t, { data, faux: PROBE, fauxMountinfo: fake.mountinfo });
    const offer = await docker(api);
    assert.equal(offer.available, available, JSON.stringify({ given, offer }));
    if (!available) assert.equal(offer.reason, NO_ADDRESSES);
    assert.deepEqual(offer.host_addresses, shown, JSON.stringify({ given, offer }));
    const reads = hostReads(fake);
    assert.equal(reads.length, 1, "one read at the start");
    assert.deepEqual([reads[0][reads[0].indexOf("--network") + 1], reads[0][reads[0].indexOf("--user") + 1]], ["host", "65534:65534"]);
  }
});

// A read that fails at the start (a busy host's Docker, beta.53's autoqa) is tried again in the background
// (docker-host-addresses.ts retryHostAddresses): once one answers, Docker is offered with no restart. The test's wait
// stands in for the backoff's, each one ended when the test says.
test("compose's layout, the read failing at the start: the server reads again in the background, and once a read answers Docker is offered, its boxes logged again, with no restart; none waits or reads after that", { timeout: 120_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, COMPOSE_MOUNTS(data));
  withEnv(t, {}, ["AGENTRUN_DOCKER_HOST_ADDRESSES"]);
  await writeFile(join(fake.state, "host-addresses.json"), `${JSON.stringify({ interfaces: ["172.17.0.1"], gateway: [] })}\n`);
  await writeFile(join(fake.state, "host-addresses-fail"), "");
  const lines = [];
  const waits = [];
  // Settled at each retry wait begun and each line logged: what `until` looks again on. No clock; the test's timeout
  // bounds a hang.
  let changed;
  let next = new Promise((resolve) => (changed = resolve));
  const change = () => {
    changed();
    next = new Promise((resolve) => (changed = resolve));
  };
  const hostReadWait = (ms, signal) => new Promise((go) => {
    waits.push({ ms, go });
    change();
    signal.addEventListener("abort", () => go(), { once: true });
  });
  /** Until `ready()` holds, looking again at each retry wait begun or line logged. */
  const until = async (ready) => {
    while (!ready()) await next;
  };
  const logged = (event) => lines.filter((line) => line.includes(` event=${event} `) || line.endsWith(` event=${event}`));
  const { api } = await serve(t, { data, faux: PROBE, fauxMountinfo: fake.mountinfo, log: (line) => (lines.push(line), change()), hostReadWait });
  const before = await docker(api);
  assert.deepEqual([before.available, before.state], [false, "unavailable"], JSON.stringify(before));
  await until(() => waits.length === 1);
  assert.equal(waits[0].ms, 15_000);
  // The second read fails as the first did: the retry waits again, longer.
  waits[0].go();
  await until(() => waits.length === 2);
  assert.equal(waits[1].ms, 30_000);
  assert.equal(hostReads(fake).length, 2);
  assert.equal((await docker(api)).available, false);
  // The host's Docker answers now: the third read takes its addresses, and Docker is offered.
  await rm(join(fake.state, "host-addresses-fail"));
  const boxesBefore = logged("boxes").length;
  assert.equal(boxesBefore, 1, "the start's");
  waits[1].go();
  await until(() => logged("boxes").length > boxesBefore);
  const after = await docker(api);
  assert.deepEqual([after.available, after.host_addresses], [true, ["172.17.0.1"]], JSON.stringify(after));
  assert.match(logged("docker_host_addresses").at(-1), /addresses=172\.17\.0\.1/);
  assert.equal(hostReads(fake).length, 3);
  assert.equal(waits.length, 2, "no wait after a read answered");
});

test("compose's layout, the read failing at the start, and a later check failing that start: the retry stops with it", { timeout: 120_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, COMPOSE_MOUNTS(data));
  withEnv(t, {}, ["AGENTRUN_DOCKER_HOST_ADDRESSES"]);
  await writeFile(join(fake.state, "host-addresses-fail"), "");
  const signals = [];
  const hostReadWait = (ms, signal) => (signals.push(signal), new Promise((go) => signal.addEventListener("abort", () => go(), { once: true })));
  await assert.rejects(serve(t, { data, faux: PROBE, fauxMountinfo: fake.mountinfo, hostReadWait, trustedProxies: ["not a proxy"] }), /trustedProxies/);
  assert.equal(signals.length, 1, "the retry began");
  assert.equal(signals[0].aborted, true, "and stopped with the start");
  assert.equal(hostReads(fake).length, 1, "the start's read alone");
});

/** Whether the fake docker has a container named `name`. */
const hasContainer = (fake, name) => readdirSync(join(fake.state, "containers")).some((one) => one.endsWith(".json") && JSON.parse(readFileSync(join(fake.state, "containers", one), "utf8")).Name === name);
/** The read's container name in `args`, a `docker run`'s. */
const nameIn = (args) => args[args.indexOf("--name") + 1];
/** The fake docker's calls from the `from`th on, each its verb and its last argument. */
const callsFrom = (fake, from) => jsonLines(join(fake.state, "argv.jsonl")).slice(from).map((args) => [args[0], args.at(-1)]);
/** A retry wait (hostReadWait) the test ends when it says; each one begun is in `waits`. */
const testWaits = () => {
  const waits = [];
  const hostReadWait = (ms, signal) => new Promise((go) => {
    waits.push({ ms, go, signal });
    signal.addEventListener("abort", () => go(), { once: true });
  });
  return { waits, hostReadWait };
};

// The retry's read in flight at the close: its docker client stalled, its container made and running, then the client
// killed by a signal from outside (the OOM killer's), so it answers no exit code. The read still removes its container
// by name, and the close answers only after that removal: stop() awaits the retry. Two fifos in the fake's state order
// it, with no clock: `host-addresses-held` gives the stalled client's pid, and `rm-gate` holds the removal until the test
// has begun the close.
test("compose's layout, the read failing at the start: a close while the retry's read is in flight answers only after that read's removal ran, its client killed by an outside signal", { timeout: 120_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, COMPOSE_MOUNTS(data));
  withEnv(t, {}, ["AGENTRUN_DOCKER_HOST_ADDRESSES"]);
  await writeFile(join(fake.state, "host-addresses-fail"), "");
  const { waits, hostReadWait } = testWaits();
  const { close } = await serve(t, { data, faux: PROBE, fauxMountinfo: fake.mountinfo, hostReadWait, runner: false });
  assert.equal(waits.length, 1, "the retry began");
  await rm(join(fake.state, "host-addresses-fail"));
  await writeFile(join(fake.state, "host-addresses-hold"), "");
  const held = join(fake.state, "host-addresses-held");
  const gate = join(fake.state, "rm-gate");
  execFileSync("mkfifo", [held, gate]);
  waits[0].go();
  const pid = Number(await readFile(held, "utf8"));
  const name = nameIn(hostReads(fake).at(-1));
  assert.equal(hasContainer(fake, name), true, "the stalled read's container is made");
  process.kill(pid, "SIGKILL");
  const from = jsonLines(join(fake.state, "argv.jsonl")).length;
  let atClose;
  const closed = close().then(() => (atClose = { there: hasContainer(fake, name), calls: callsFrom(fake, from) }));
  assert.equal(waits[0].signal.aborted, true, "the close began");
  // Opened once the read's removal reads it: the removal waited for the close to begin. A close that answers first
  // didn't wait for it; the gate is then opened here, so its writer (and this file) doesn't hang, and the case fails.
  const opened = writeFile(gate, "go");
  const first = await Promise.race([opened.then(() => "removal"), closed.then(() => "close")]);
  if (first === "close") {
    closeSync(openSync(gate, constants.O_RDONLY | constants.O_NONBLOCK));
    await opened.catch(() => undefined);
  }
  await closed;
  assert.deepEqual([first, atClose], ["removal", { there: false, calls: [["rm", name], ["inspect", name]] }]);
  assert.equal(hostReads(fake).length, 2, "the start's read and the retry's");
  assert.equal(waits.length, 1, "no wait after the close");
});

// The close cuts the retry's read where it stalls (its client killed, not left to READ_MS's 60 s, which outlives a
// stop's deadline: stop-signals.ts, compose's 15 s grace) and answers once its container is removed. The store closes
// first: with the removal held at `rm-gate`, the data root's lock (released right after the store closes) is free, so a
// stop cut at its deadline cuts only the cleanup. No clock: the case's timeout, under READ_MS, bounds a close that waited
// out the read or held the store until the removal.
test("compose's layout, the read failing at the start: a close while the retry's read stalls kills that read at once, closes the store, then answers once its container is removed by name", { timeout: 30_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, COMPOSE_MOUNTS(data));
  withEnv(t, {}, ["AGENTRUN_DOCKER_HOST_ADDRESSES"]);
  await writeFile(join(fake.state, "host-addresses-fail"), "");
  const { waits, hostReadWait } = testWaits();
  const { close } = await serve(t, { data, faux: PROBE, fauxMountinfo: fake.mountinfo, hostReadWait, runner: false });
  assert.equal(waits.length, 1, "the retry began");
  await rm(join(fake.state, "host-addresses-fail"));
  await writeFile(join(fake.state, "host-addresses-hold"), "");
  const held = join(fake.state, "host-addresses-held");
  const gate = join(fake.state, "rm-gate");
  execFileSync("mkfifo", [held, gate]);
  waits[0].go();
  const pid = Number(await readFile(held, "utf8"));
  const name = nameIn(hostReads(fake).at(-1));
  assert.equal(hasContainer(fake, name), true, "the stalled read's container is made");
  const from = jsonLines(join(fake.state, "argv.jsonl")).length;
  let answered = false;
  const closed = close().then(() => (answered = true));
  // The removal waits at the gate; the store's close, ahead of it, frees the data root's lock.
  let lock;
  while (lock === undefined) {
    try {
      lock = takeServerLock(data);
    } catch (error) {
      if (error?.code !== "SERVER_LOCK_HELD") throw error;
      await macrotask();
    }
  }
  lock.release();
  assert.equal(answered, false, "the store closed while the removal was still held, and the close waits for the removal");
  // A writer's open of the gate answers once the removal holds it, and the removal begins only once the killed read's
  // client has exited (execFile answers after the child is reaped): only then is its pid sure to be gone.
  const gateWriter = await open(gate, "w");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the stalled read's client is killed");
  await gateWriter.writeFile("go");
  await gateWriter.close();
  await closed;
  assert.deepEqual([hasContainer(fake, name), callsFrom(fake, from)], [false, [["rm", name], ["inspect", name]]]);
});

// The start's read fails and keeps its container's name (Docker didn't answer the check), but the operator's
// AGENTRUN_DOCKER_HOST_ADDRESSES is set, so Docker is offered on those: the retry still starts, to remove that container,
// reading nothing and changing no box.
test("compose's layout, the read failing at the start with AGENTRUN_DOCKER_HOST_ADDRESSES set: Docker is offered on the operator's addresses, and the retry removes the container the failed read kept, reading nothing and changing no box", { timeout: 120_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, COMPOSE_MOUNTS(data));
  withEnv(t, { AGENTRUN_DOCKER_HOST_ADDRESSES: "198.51.100.9" });
  await writeFile(join(fake.state, "host-addresses-fail"), "");
  await writeFile(join(fake.state, "inspect-fail-reads"), "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
  const { waits, hostReadWait } = testWaits();
  const lines = [];
  const { api, close } = await serve(t, { data, faux: PROBE, fauxMountinfo: fake.mountinfo, hostReadWait, runner: false, log: (line) => lines.push(line) });
  const offer = await docker(api);
  assert.deepEqual([offer.available, offer.host_addresses], [true, ["198.51.100.9"]], JSON.stringify(offer));
  assert.equal(waits.length, 1, "the retry began, the operator's addresses set");
  assert.equal(waits[0].ms, 15_000);
  const name = nameIn(hostReads(fake)[0]);
  // The daemon answers checks again; the retry's removal is held at the gate until the test has seen it begin.
  await rm(join(fake.state, "inspect-fail-reads"));
  const gate = join(fake.state, "rm-gate");
  execFileSync("mkfifo", [gate]);
  const from = jsonLines(join(fake.state, "argv.jsonl")).length;
  waits[0].go();
  await writeFile(gate, "go");
  await close();
  assert.deepEqual(callsFrom(fake, from), [["rm", name], ["inspect", name]], "the kept name removed, nothing read");
  assert.equal(hostReads(fake).length, 1, "the start's read alone");
  assert.equal(lines.filter((line) => / event=boxes( |$)/.test(line)).length, 1, "the start's boxes, not made again");
});

test("compose's layout under AGENTRUN_BOX_ALLOW=none: no address is needed, none is read, and Docker is offered with no network", { timeout: 120_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, COMPOSE_MOUNTS(data));
  await writeFile(join(fake.state, "host-addresses-fail"), "");
  withEnv(t, { AGENTRUN_BOX_ALLOW: "none" });
  const { api } = await serve(t, { data, faux: PROBE, fauxMountinfo: fake.mountinfo });
  const offer = await docker(api);
  assert.deepEqual([offer.available, offer.network], [true, "none"], JSON.stringify(offer));
  assert.deepEqual(hostReads(fake), []);
});

test("a server whose AGENTRUN_DOCKER_HOST_ADDRESSES holds an entry that is no IP address doesn't start, naming the entry", async (t) => {
  withEnv(t, { AGENTRUN_DOCKER_HOST_ADDRESSES: "172.17.0.1,host.docker.internal" });
  await assert.rejects(serve(t, { data: await dataDir(t), faux: PROBE }), { message: `AGENTRUN_DOCKER_HOST_ADDRESSES is a comma list of the Docker host's own IP addresses (such as 172.17.0.1): "host.docker.internal" is not an IP address` });
});

test("a daemon is another machine's only over ssh://, or tcp:// to a host that isn't loopback; unix://, npipe:// and tcp:// to loopback are this machine's", async () => {
  const { remoteEndpoint } = await import("../dist/box-paths.js");
  for (const endpoint of ["ssh://builder@docker.example.com", "ssh://docker.example.com:2222", "tcp://docker.example.com:2376", "tcp://203.0.113.7:2376", "tcp://[2001:db8::7]:2376"]) assert.equal(remoteEndpoint(endpoint), true, endpoint);
  for (const endpoint of ["unix:///var/run/docker.sock", "npipe:////./pipe/docker_engine", "tcp://localhost:2375", "tcp://127.0.0.1:2375", "tcp://127.1.2.3:2375", "tcp://[::1]:2375", "fd://", ""]) assert.equal(remoteEndpoint(endpoint), false, endpoint);
});

test("the daemon docker reaches: DOCKER_HOST when set, else the current context's endpoint as the CLI resolves it; this machine's is none, and a context that can't be read is taken as this machine's", async () => {
  const { remoteDockerOf } = await import("../dist/box-paths.js");
  const asked = [];
  const context = (answer) => async (args) => (asked.push(args), answer);
  const never = async () => assert.fail("DOCKER_HOST decides: no context is read");
  for (const host of ["tcp://docker.example.com:2376", "ssh://builder@docker.example.com"]) assert.equal(await remoteDockerOf({ DOCKER_HOST: host }, never), host);
  for (const host of ["unix:///var/run/docker.sock", "npipe:////./pipe/docker_engine", "tcp://localhost:2375"]) assert.equal(await remoteDockerOf({ DOCKER_HOST: host }, never), undefined, host);
  for (const host of [undefined, "", "  "]) {
    const env = host === undefined ? {} : { DOCKER_HOST: host };
    assert.equal(await remoteDockerOf(env, context({ code: 0, stdout: '"tcp://docker.example.com:2376"\n', stderr: "" })), "tcp://docker.example.com:2376", String(host));
    assert.equal(await remoteDockerOf(env, context({ code: 0, stdout: '"unix:///var/run/docker.sock"\n', stderr: "" })), undefined);
  }
  assert.deepEqual(asked.at(-1), ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]);
  assert.equal(await remoteDockerOf({}, context({ code: 1, stdout: "", stderr: "context not found" })), undefined);
  assert.equal(await remoteDockerOf({}, context({ code: 0, stdout: "<html>", stderr: "" })), undefined);
});

// A daemon of another machine has none of this machine's paths: whether DOCKER_HOST names it, DOCKER_CONTEXT picks a
// context whose endpoint it is, or the CLI's saved current context is one (each read through the fake docker), Docker
// computers aren't offered, in words naming the endpoint.
test("a server whose Docker daemon is another machine's, by DOCKER_HOST, DOCKER_CONTEXT or the saved current context: Docker computers aren't offered, saying why", { timeout: 240_000 }, async (t) => {
  const words = (endpoint) => `this server's Docker daemon (${endpoint}) is another machine's: it can't mount the run's folder from this machine, so Docker computers aren't available on this setup (give the agent another computer, or run the server on the Docker host)`;
  for (const [given, endpoint] of [
    [{ env: { DOCKER_HOST: "tcp://docker.example.com:2376" } }, "tcp://docker.example.com:2376"],
    [{ env: { DOCKER_CONTEXT: "builder" }, contexts: { builder: "tcp://builder.example.com:2376" } }, "tcp://builder.example.com:2376"],
    [{ saved: "ssh://ops@docker.example.com" }, "ssh://ops@docker.example.com"],
  ]) {
    const fake = await containerDocker(t, { mounts: [] });
    if (given.contexts) await writeFile(join(fake.state, "contexts.json"), JSON.stringify(given.contexts));
    if (given.saved) await writeFile(join(fake.state, "docker-context"), given.saved);
    withEnv(t, given.env ?? {}, ["DOCKER_HOST", "DOCKER_CONTEXT"]);
    const { api } = await serve(t, { data: await dataDir(t), faux: PROBE });
    const offer = await docker(api);
    assert.deepEqual([offer.available, offer.reason], [false, words(endpoint)], JSON.stringify({ given, offer }));
    assert.deepEqual(fake.runs(), []);
  }
});

// A server whose computerd build for its Docker's architecture is not there (`npm run build` without `npm run
// build:daemon`) can't run a Docker computer: each would fail at its create. The start says so, with the command that
// builds it, where the other reasons are: the boxes line, capabilities, a new agent's place and a run's start, which
// refuses a run naming one. The architecture is the one Docker's start probe read; the test names the directory the build
// would be in (fauxDaemonDir). With the build there, nothing changes.
const NO_DAEMON = (dir, arch = "amd64") => `no daemon for Docker's ${arch} at ${join(dir, `computerd-linux-${arch}`)}: run npm run build:daemon -w @parcha/agentrun-computer, then restart AgentRun`;
test("a server with no computerd build for its Docker's architecture: Docker isn't offered, its boxes line, capabilities and a run's start say how to build it, and Docker is asked once; with the build there nothing changes", { timeout: 240_000 }, async (t) => {
  const builds = await scratch(t);
  const fake = await containerDocker(t, { mounts: [] });
  const versions = () => jsonLines(join(fake.state, "argv.jsonl")).filter((args) => args[0] === "version");
  const start = async () => {
    const lines = [];
    const server = await serve(t, { data: await dataDir(t), faux: PROBE, fauxDaemonDir: builds, log: (line) => lines.push(line) });
    return { ...server, boxes: lines.filter((line) => line.includes(" event=boxes ")) };
  };

  const { api, boxes } = await start();
  const offer = await docker(api);
  assert.deepEqual([offer.available, offer.state, offer.reason], [false, "unavailable", NO_DAEMON(builds)], JSON.stringify(offer));
  assert.equal(boxes.length, 1, JSON.stringify(boxes));
  assert.ok(boxes[0].includes("unavailable=docker,") && boxes[0].includes("npm run build:daemon -w @parcha/agentrun-computer"), boxes[0]);
  // Docker is asked once at the start: the probe names its version and its architecture.
  assert.equal(versions().length, 1, JSON.stringify(versions()));
  assert.ok(versions()[0].some((arg) => arg.includes("{{.Server.Arch}}")), JSON.stringify(versions()));

  // A run naming a Docker computer is refused at its start, in those words, never at its create; a new agent gets the runner.
  const made = await api("POST", "/agents", { definition: { id: "boxed-computer", name: "boxed", instructions: "Probe.", computer: { kind: "sandbox", provider: "docker" } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", "/agents/boxed-computer/runs", { input: { content: "Probe." } });
  assert.equal(started.status, 409, JSON.stringify(started.body));
  assert.equal(started.body.error.code, "agent_not_runnable");
  const field = started.body.error.fields.find((one) => one.field === "definition.computer");
  assert.equal(field?.message, `This agent's computer is a Docker sandbox, and this server cannot run it: ${NO_DAEMON(builds)}.`, JSON.stringify(started.body));
  const plain = await api("POST", "/agents", { definition: { id: "plain", name: "plain", instructions: "Answer." } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal((await api("GET", "/agents/plain")).body.place?.mode ?? "runner", "runner");
  assert.deepEqual(fake.runs(), [], "no box or computer is made");

  // The build there: Docker is offered as before, and its line says nothing of a build.
  await writeFile(join(builds, "computerd-linux-amd64"), "a stand-in for computerd\n", { mode: 0o755 });
  const built = await start();
  const ready = await docker(built.api);
  assert.deepEqual([ready.available, ready.state, ready.reason], [true, "ready", undefined], JSON.stringify(ready));
  assert.ok(built.boxes[0].includes("available=docker ") && !built.boxes[0].includes("build:daemon"), built.boxes[0]);
  const fresh = await built.api("POST", "/agents", { definition: { id: "fresh", name: "fresh", instructions: "Answer." } });
  assert.deepEqual(fresh.body.definition.place, { mode: "sandbox", box: "docker" }, JSON.stringify(fresh.body));

  // The architecture is Docker's: an arm64 Docker needs the arm64 build, whatever else is built.
  await writeFile(join(fake.state, "docker-arch"), "arm64\n");
  const arm = await docker((await start()).api);
  assert.deepEqual([arm.available, arm.reason], [false, NO_DAEMON(builds, "arm64")], JSON.stringify(arm));
  assert.deepEqual(fake.runs(), []);
});

// A CLI server in a container under --faux (the --vps walk's) names its mountinfo in its own environment, which the
// runner beside it does not inherit (runner/main.ts besideRunEnv): the server hands it over with the other switches.
test("a --faux server hands its runner the mountinfo it reads, from its options or its own environment", async (t) => {
  const { fauxEnvOf } = await import("../dist/server.js");
  withEnv(t, { AGENTRUN_SERVE_FAUX_MOUNTINFO: "/proc/self/mountinfo" });
  assert.equal(fauxEnvOf({ faux: PROBE }).AGENTRUN_SERVE_FAUX_MOUNTINFO, "/proc/self/mountinfo");
  assert.equal(fauxEnvOf({ faux: PROBE, fauxMountinfo: "/tmp/given-mountinfo" }).AGENTRUN_SERVE_FAUX_MOUNTINFO, "/tmp/given-mountinfo");
  assert.equal(fauxEnvOf({}).AGENTRUN_SERVE_FAUX_MOUNTINFO, undefined);
});
