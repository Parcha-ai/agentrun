// A server in a container of the Docker it runs boxes on, given that Docker's socket (compose.yaml): the daemon has none
// of the server's paths, only what it mounted into the server's container. The server finds its own container
// (box-paths.ts), and a box mounts the run's work/ and its egress directory as subpaths of the data directory's volume, with
// a fake `docker` first on PATH (fixtures/fake-docker.mjs; no daemon is reached) and the tests' fake network for the
// proxy (fixtures/fake-egress.mjs; nothing leaves this machine). Where it cannot, docker is unavailable, saying why.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { release } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { runDirIn } from "@parcha/pi-durable-agent";
import { follow, jsonLines, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const FAKE_EGRESS = new URL("./fixtures/fake-egress.mjs", import.meta.url).pathname;
const IMAGE = "debian:bookworm-slim";
const SANDBOX = { mode: "sandbox", box: "docker" };
const ID = "c0ffee".padEnd(64, "0");
const ALLOW_HINT = "use web_fetch for web pages, or ask the operator to add it to AGENTRUN_BOX_ALLOW";

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
  return { state, mountinfo: info, runs: () => lines("argv.jsonl").filter((args) => args[0] === "run"), relays: () => lines("relays.jsonl") };
}

/** A data directory of its own, canonical, as the server's container has it at its mount. */
async function dataDir(t) {
  const data = join(realpathSync(await scratch(t)), "data");
  await mkdir(data, { mode: 0o700 });
  return data;
}

const flags = (args, name) => args.flatMap((arg, i) => (args[i - 1] === name ? [arg] : []));
const docker = async (api) => (await api("GET", "/capabilities")).body.places.boxes.find((box) => box.id === "docker");
const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

function viaSocket(socketPath, options) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, ...options }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode, reason: res.statusMessage, body }));
    });
    req.once("connect", (res, socket) => (socket.destroy(), resolve({ status: res.statusCode, reason: res.statusMessage, body: "" })));
    req.once("error", reject).end();
  });
}

async function boxedRun(api, plan) {
  const made = await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

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
test("demo through the API: the server in a container, its data a named volume: docker is available with the list; the run's box mounts its work/ and its egress directory as the volume's subpaths, keeps --network none, writes out.txt into the run's files, and reaches a listed host and nothing else", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own", timeout: 120_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, { mounts: [{ Type: "volume", Name: "agentrun_agentrun-data", Source: "/var/lib/docker/volumes/agentrun_agentrun-data/_data", Destination: data, RW: true }], volumes: { "agentrun_agentrun-data": data } });
  const hold = join(await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "box-paths-hold-")), "hold");
  t.after(() => writeFile(hold, ""));
  const { api } = await serve(t, { data, faux: PROBE, fauxEgress: FAKE_EGRESS, fauxMountinfo: fake.mountinfo });
  const offer = await docker(api);
  assert.equal(offer.available, true, JSON.stringify(offer));
  assert.equal(offer.network, "allowlist", JSON.stringify(offer));
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: `printf 'from the box' > out.txt; until [ -e ${hold} ]; do sleep 0.1; done` } }]);
  await until(() => fake.runs().length === 1 && fake.relays().length === 1, "the box and its relay");
  const [run] = fake.runs();
  const hash = createHash("sha256").update(runId).digest("hex").slice(0, 16);
  // The run's work/ on the agent's disk: `disk/agents/<key>/runs/<run>/work` below the data directory, and nothing above it.
  const work = join(runDirIn(data, "boxed", runId), "work");
  assert.deepEqual(flags(run, "--mount"), [
    `type=volume,source=agentrun_agentrun-data,target=/run/agentrun/run/work,volume-subpath=${relative(data, work)},volume-nocopy`,
    `type=volume,source=agentrun_agentrun-data,target=/run/agentrun/egress,volume-subpath=box-egress/${hash},volume-nocopy,readonly`,
  ]);
  assert.equal(flags(run, "--network")[0], "none");
  assert.deepEqual(flags(run, "--cap-drop"), ["ALL"]);
  assert.deepEqual(flags(run, "--security-opt"), ["no-new-privileges"]);
  // The proxy is the run's own, its socket in the data volume, where the box's mount has it.
  const socket = join(data, "box-egress", hash, "egress.sock");
  const listed = await viaSocket(socket, { method: "GET", path: "http://pypi.org/simple/", headers: { host: "pypi.org" } });
  assert.equal(listed.status, 200, JSON.stringify(listed));
  const refused = await viaSocket(socket, { method: "CONNECT", path: "example.com:443", headers: { host: "example.com:443" } });
  assert.equal(refused.status, 403);
  assert.equal(refused.reason, `example.com is not on this box's network list: ${ALLOW_HINT}`);
  await writeFile(hold, "");
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(readFileSync(join(work, "out.txt"), "utf8"), "from the box", "the box's write is in the run's files");
  await until(() => !existsSync(join(data, "box-egress", hash)), "the run's egress directory removed with its box");
});

test("a Mac server is never in a container of its Docker's: even given a container's mountinfo, it asks Docker nothing of its own container, and docker is not compose's one way in (its box's network is the Mac's proxy container's, box-egress-vm.ts)", { timeout: 120_000 }, async (t) => {
  const data = await dataDir(t);
  const fake = await containerDocker(t, { mounts: [{ Type: "volume", Name: "v", Source: "/var/lib/docker/volumes/v/_data", Destination: data, RW: true }], volumes: { v: data } });
  const { api } = await serve(t, { data, faux: PROBE, fauxEgress: FAKE_EGRESS, fauxMountinfo: fake.mountinfo, fauxPlatform: "darwin" });
  const offer = await docker(api);
  assert.equal(offer.available, true, JSON.stringify(offer));
  const asked = jsonLines(join(fake.state, "argv.jsonl")).filter((args) => args[0] === "inspect" && args.includes("container"));
  assert.deepEqual(asked, [], "no inspect of its own container");
});

test("the server in a container that this Docker does not have, its data not on a named volume, or on an engine that can't mount a volume's subpath: docker is unavailable at start, saying why, and no box is made", { timeout: 120_000 }, async (t) => {
  const IN_COMPOSE = "run AgentRun in a container with `docker compose up` from compose.yaml (its named data volume is how boxes reach a run's files)";
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
    const { api } = await serve(t, { data, faux: PROBE, fauxEgress: FAKE_EGRESS, ...(given.bind ? {} : { fauxMountinfo: fake.mountinfo }) });
    const offer = await docker(api);
    assert.equal(offer.available, false, JSON.stringify(offer));
    assert.equal(offer.state, "unavailable");
    assert.equal(offer.reason, reason);
    assert.deepEqual(fake.runs(), []);
  }
});
test("the start check: a Docker whose data root this server can't see blocks the network, unless the server found its own container's mount of its data directory", async () => {
  const { egressBlockedBy } = await import("../dist/box-egress.js");
  const said = { info: async () => "linux|6.1.0-28-amd64|/var/lib/docker|Docker Engine - Community\n", kernel: "6.1.0-28-amd64", platform: "linux", sees: () => false };
  const env = { DOCKER_CONFIG: "/nonexistent/agentrun-docker-config" };
  assert.match(await egressBlockedBy(env, said), /^this Docker \(Docker Engine - Community\) keeps its data in "\/var\/lib\/docker", which this server can't see/);
  assert.equal(await egressBlockedBy(env, { ...said, mapped: true }), undefined);
  assert.match(await egressBlockedBy(env, { ...said, mapped: true, kernel: "6.15.11-orbstack" }), /runs in a VM/, "a VM is still none");
});

test("the egress parent's limit holds the proxy's longest socket path, the temporary one it listens on first, in bytes: a parent of exactly the limit listens; one byte more is refused at the start, a two-byte character counted as two", { skip: process.platform !== "linux" && "a Unix socket's path limit is Linux's here (macOS's is 103 bytes)" }, async (t) => {
  const { MAX_EGRESS_PARENT, egressParentTooLong } = await import("../dist/box-egress.js");
  const base = join(realpathSync(await scratch(t)), "p");
  // A parent of exactly MAX_EGRESS_PARENT bytes, padded under the scratch directory.
  const parent = base + "x".repeat(MAX_EGRESS_PARENT - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(parent), MAX_EGRESS_PARENT);
  const dir = join(parent, "0123456789abcdef");
  await mkdir(dir, { recursive: true });
  // The run's proxy itself there: it listens on a temporary socket (`.egress-<12 hex>.sock`, its longest name) and links
  // it to egress.sock, by the whole path. Node cuts a socket path past 107 bytes without a word, so only the link and the
  // file's name show it whole.
  const { startEgressProxy } = await import("@parcha/agentrun-kernel/host");
  const socketPath = join(dir, "egress.sock");
  const proxy = await startEgressProxy({ socketPath, maxTunnels: 1, maxConnections: 1, log: () => {}, allow: ["pypi.org"] });
  t.after(() => proxy.close());
  assert.ok(existsSync(socketPath), "egress.sock, under its whole name");
  assert.equal(egressParentTooLong(parent), false);
  assert.equal(egressParentTooLong(`${parent}x`), true, "one byte more");
  assert.equal(egressParentTooLong(`${parent.slice(0, -1)}é`), true, "a two-byte character is two bytes");
});
