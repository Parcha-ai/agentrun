// A Docker box's network (box-egress.ts), with a fake `docker` first on PATH (fixtures/fake-docker.mjs; no daemon is
// reached) and the tests' fake network for the proxy (fixtures/fake-egress.mjs; no lookup or connection leaves this
// machine). A run's box stays `--network none` and gets the run's egress proxy, with AGENTRUN_BOX_ALLOW's list or, unset,
// the default one (never none: a proxy with no list would reach every public host): its directory bound read-only at
// /run/agentrun/egress, the proxy variables in its fixed environment, and its relay started in it. The proxy reaches a
// listed host and refuses any other in words. With `none`, a box is as it was: no proxy.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { release } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BOX_ENV } from "../dist/run-box.js";
import { follow, scratch, serve, withEnv } from "./support.mjs";
import { startServe } from "../dist/index.js";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const FAKE_EGRESS = new URL("./fixtures/fake-egress.mjs", import.meta.url).pathname;
/** An image the fake has, so nothing is built. */
const IMAGE = "debian:bookworm-slim";
const SANDBOX = { mode: "sandbox", box: "docker" };
const LIST = "pypi.org,files.pythonhosted.org";
/** The default list, written out: the package registries, and GitHub's clone and archive hosts. */
const DEFAULT = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "registry.yarnpkg.com", "github.com", "codeload.github.com"];
// The box's network as a box sees it, written out here: what a box gets is this contract, not whatever the module says.
const BOX_ALLOW_ENV = "AGENTRUN_BOX_ALLOW";
const EGRESS_MOUNT = "/run/agentrun/egress";
const PROXY = "http://127.0.0.1:3128";
const PROXY_ENV = { HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, http_proxy: PROXY, https_proxy: PROXY, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" };
const FORWARDER_START = ["sh", "-c", [
  "command -v socat >/dev/null 2>&1 || exit 127",
  "command -v setsid >/dev/null 2>&1 || exit 126",
  "listening() { grep -q ' 0100007F:0C38 00000000:0000 0A ' /proc/net/tcp 2>/dev/null; }",
  "listening && exit 0",
  'log=$(mktemp); setsid socat TCP-LISTEN:3128,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/agentrun/egress/egress.sock </dev/null >/dev/null 2>"$log" &',
  'i=0; while [ "$i" -lt 30 ]; do listening && { rm -f "$log"; exit 0; }; i=$((i + 1)); sleep 0.1; done',
  'head -c 300 "$log" >&2; rm -f "$log"; exit 124',
].join("; ")];
const ALLOW_HINT = "use web_fetch for web pages, or ask the operator to add it to AGENTRUN_BOX_ALLOW";
const NO_SOCAT = "This box's image has no socat, so it has no network. Add socat to the image, or set AGENTRUN_BOX_ALLOW=none to silence this.";
/** A run's proxy directory: short, under /tmp, by this user and the run's id. */
const egressDir = (runId) => join("/tmp", `agentrun-egress-${process.getuid()}`, createHash("sha256").update(runId).digest("hex").slice(0, 16));

/** A fake docker first on PATH, docker listed in AGENTRUN_BOXES with an image it has (and `vars` set), and the state
 *  files `marks` names made (`no-socat`: the image has none). */
async function fakeDocker(t, marks = {}, vars = {}) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  for (const [name, text] of Object.entries(marks)) await writeFile(join(state, name), text);
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, AGENTRUN_BOXES: "docker", AGENTRUN_DOCKER_IMAGE: IMAGE, ...vars }, [BOX_ALLOW_ENV]);
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
  const lines = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { state, runs: () => lines("argv.jsonl").filter((args) => args[0] === "run"), removed: () => lines("argv.jsonl").filter((args) => args[0] === "rm").map((args) => args.at(-1)), relays: () => lines("relays.jsonl") };
}

const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** A sandbox run of the probe agent, its plan's steps one per turn. */
async function boxedRun(api, plan) {
  const made = await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } });
  assert.ok([201, 409].includes(made.status), JSON.stringify(made.body));
  const run = await api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

async function rowsOf(api, runId) {
  return (await api("GET", `/runs/${runId}/timeline?after=0`)).body.rows;
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

/** The values of `--env` and `--mount` in a `docker run`'s arguments. */
const flags = (args, name) => args.flatMap((arg, i) => (args[i - 1] === name ? [arg] : []));

/** One request to the proxy on its socket, as a box's client sends it: the status line and the body. */
function viaSocket(socketPath, options) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, ...options }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => (body += chunk)).on("end", () => resolve({ status: res.statusCode, reason: res.statusMessage, body, headers: res.headers }));
    });
    req.once("connect", (res, socket) => (socket.destroy(), resolve({ status: res.statusCode, reason: res.statusMessage, body: "", headers: res.headers })));
    req.once("error", reject).end();
  });
}

test("AGENTRUN_BOX_ALLOW, read in one place: unset or empty is the default list, never no list; `none` is none; a comma list of names replaces the default; `*`, an address, a CIDR or a URL refuses, naming the setting", async () => {
  const { boxAllowOf } = await import("../dist/run-box.js");
  assert.deepEqual(boxAllowOf({}), DEFAULT);
  assert.deepEqual(boxAllowOf({ [BOX_ALLOW_ENV]: "" }), DEFAULT);
  assert.deepEqual(boxAllowOf({ [BOX_ALLOW_ENV]: "  " }), DEFAULT);
  assert.equal(boxAllowOf({ [BOX_ALLOW_ENV]: "none" }), "none");
  assert.equal(boxAllowOf({ [BOX_ALLOW_ENV]: "NONE" }), "none");
  assert.deepEqual(boxAllowOf({ [BOX_ALLOW_ENV]: "pypi.org, *.pythonhosted.org,PyPI.org" }), ["pypi.org", "*.pythonhosted.org"]);
  for (const value of ["*", "93.184.215.14", "8.8.8.0/24", "https://pypi.org", "pypi.org:443", "localhost", " , "]) {
    assert.throws(() => boxAllowOf({ [BOX_ALLOW_ENV]: value }), (error) => error.message.startsWith(`${BOX_ALLOW_ENV} is a comma list of host names`) && (value.trim() === "," || error.message.includes(JSON.stringify(value))), value);
  }
});

test("a server whose AGENTRUN_BOX_ALLOW is not a list of names refuses to start, naming the setting", async (t) => {
  await fakeDocker(t, {}, { [BOX_ALLOW_ENV]: "*" });
  const data = join(await scratch(t), "agents");
  await assert.rejects(startServe({ data, port: 0, faux: PROBE }), new RegExp(`^Error: ${BOX_ALLOW_ENV} is a comma list of host names`));
  assert.equal(existsSync(join(data, "server.lock")), false, "the start took nothing");
});

test("demo through the API, with a list: the run's box stays --network none and gets the run's egress proxy, its directory bound read-only, the proxy variables and no key in its environment, and its relay; the proxy reaches a listed host and refuses another in words; the directory goes when the run ends", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own", timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, {}, { [BOX_ALLOW_ENV]: LIST, OPENAI_API_KEY: "not-a-secret" });
  const { hold, release } = await holdFile(t);
  const { api, data } = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  // The run's bash holds its box open until the test is done with it (the fake runs it on this machine).
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: `until [ -e ${hold} ]; do sleep 0.1; done` } }]);
  await until(() => docker.runs().length === 1, "the box");
  const [run] = docker.runs();
  assert.equal(flags(run, "--network")[0], "none", "Docker's network stays none");
  assert.deepEqual(flags(run, "--env").sort(), Object.entries({ ...BOX_ENV, ...PROXY_ENV }).map(([name, value]) => `${name}=${value}`).sort(), "the box's environment: the fixed one and the proxy's, no key");
  const dir = egressDir(runId);
  assert.ok(flags(run, "--mount").includes(`type=bind,source=${dir},target=${EGRESS_MOUNT},readonly`), JSON.stringify(flags(run, "--mount")));
  await until(() => docker.relays().length === 1, "the box's relay");
  assert.deepEqual(docker.relays()[0].command, FORWARDER_START);
  // The proxy's directory and socket: this user's alone.
  const socket = join(dir, "egress.sock");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "..")).mode & 0o777, 0o700);
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  // A listed host is reached (the tests' fake origin), with no header the proxy added.
  const listed = await viaSocket(socket, { method: "GET", path: "http://pypi.org/simple/six/", headers: { host: "pypi.org", "proxy-authorization": "Basic planted" } });
  assert.equal(listed.status, 200, JSON.stringify(listed));
  assert.match(listed.body, /^fake origin: GET pypi\.org\/simple\/six\/\nheaders: (.*)\n$/);
  assert.doesNotMatch(listed.body, /proxy-authorization|authorization,/, "the proxy holds no key and adds none");
  // Another host is refused before any lookup, in words that say what to do.
  for (const [method, path, host] of [["CONNECT", "example.com:443", "example.com:443"], ["GET", "http://example.com/", "example.com"]]) {
    const refused = await viaSocket(socket, { method, path, headers: { host } });
    assert.equal(refused.status, 403, `${method}: ${JSON.stringify(refused)}`);
    assert.equal(refused.reason, `example.com is not on this box's network list: ${ALLOW_HINT}`);
    assert.equal(refused.headers["x-egress-refused"], "not-listed");
  }
  const address = await viaSocket(socket, { method: "CONNECT", path: "93.184.215.14:443", headers: { host: "93.184.215.14:443" } });
  assert.equal(address.status, 403);
  await release();
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(answers(data, runId).map((a) => [a.tool, a.error]), [["bash", false]]);
  assert.equal((await rowsOf(api, runId)).some((row) => row.summary === NO_SOCAT), false, "an image with socat: no row");
  await until(() => !existsSync(dir), "the run's proxy directory removed with its box");
});

test("an image with no socat: the box has no network, its run's timeline says so once, and its tools still run", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own", timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, { "no-socat": "" }, { [BOX_ALLOW_ENV]: LIST });
  const { api, data } = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: "printf one" } }, { tool: "bash", args: { command: "printf two" } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(answers(data, runId).map((a) => [a.error, a.text]), [[false, "one"], [false, "two"]]);
  assert.equal((await rowsOf(api, runId)).filter((row) => row.summary === NO_SOCAT).length, 1);
  assert.equal(docker.relays().length, 1);
});

/** The run's proxy decisions and its start, as its process logged them. */
function egressLines(data, runId) {
  const log = join(data, "runs", runId, "process.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value.event === "box_egress" ? [value.line] : [];
    } catch {
      return [];
    }
  });
}

/** A file a run's bash waits on (the fake runs it on this machine), made by `release()` and at the test's end at the
 *  latest, so no run is left waiting. */
async function holdFile(t) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "box-network-hold-"));
  const hold = join(dir, "hold");
  t.after(async () => {
    await writeFile(hold, "");
    // The run sees it and ends before its server closes.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await rm(dir, { recursive: true, force: true });
  });
  return { hold, release: () => writeFile(hold, "") };
}

/** A run that holds its box open (its bash waits on a file the test makes), and the box's proxy socket. */
async function heldBox(t, api, docker) {
  const { hold, release } = await holdFile(t);
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: `until [ -e ${hold} ]; do sleep 0.1; done` } }]);
  const socket = join(egressDir(runId), "egress.sock");
  await until(() => existsSync(socket) && docker.relays().length === 1, "the run's proxy and its box's relay");
  return { runId, socket, release };
}

test("with AGENTRUN_BOX_ALLOW unset, the run's proxy gets exactly the default list, never none: each listed host is reached, and an unlisted public host is refused", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own", timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  const { runId, socket, release } = await heldBox(t, api, docker);
  await until(() => egressLines(data, runId).some((line) => line.startsWith("egress start ")), "the proxy's start");
  assert.deepEqual(egressLines(data, runId).filter((line) => line.startsWith("egress start ")), [`egress start allow=${DEFAULT.join(",")}`]);
  for (const host of DEFAULT) {
    const reached = await viaSocket(socket, { method: "GET", path: `http://${host}/`, headers: { host } });
    assert.equal(reached.status, 200, `${host}: ${JSON.stringify(reached)}`);
    assert.match(reached.body, new RegExp(`^fake origin: GET ${host.replace(/\./g, "\\.")}/\n`));
  }
  for (const host of ["example.com", "evil.pypi.org.example.com", "raw.githubusercontent.com"]) {
    const refused = await viaSocket(socket, { method: "CONNECT", path: `${host}:443`, headers: { host: `${host}:443` } });
    assert.equal(refused.status, 403, host);
    assert.equal(refused.headers["x-egress-refused"], "not-listed", host);
  }
  assert.ok(flags(docker.runs()[0], "--env").includes(`HTTPS_PROXY=${PROXY}`));
  await release();
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
});

test("a listed name that resolves to OrbStack's VM host or gateway (0.250.250.254, 0.250.250.1, in 0.0.0.0/8) is refused by the address rule", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own", timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, {}, { [BOX_ALLOW_ENV]: "pypi.org,vm-host.example.org,vm-gateway.example.org" });
  const { api } = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  const { runId, socket, release } = await heldBox(t, api, docker);
  for (const host of ["vm-host.example.org", "vm-gateway.example.org"]) {
    for (const [method, path, header] of [["CONNECT", `${host}:443`, `${host}:443`], ["GET", `http://${host}/`, host]]) {
      const refused = await viaSocket(socket, { method, path, headers: { host: header } });
      assert.equal(refused.status, 403, `${method} ${host}: ${JSON.stringify(refused)}`);
      assert.notEqual(refused.headers["x-egress-refused"], "not-listed", "listed: refused for its address, not its name");
      assert.doesNotMatch(refused.body, /^fake origin/);
    }
  }
  assert.equal((await viaSocket(socket, { method: "GET", path: "http://pypi.org/", headers: { host: "pypi.org" } })).status, 200, "a public answer is reached");
  await release();
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
});

test("with none, a box is as it was: no proxy, no mount, no proxy variables, no relay", { timeout: 120_000 }, async (t) => {
  for (const value of ["none"]) {
    const docker = await fakeDocker(t, {}, { [BOX_ALLOW_ENV]: value });
    const { api, data } = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
    const runId = await boxedRun(api, [{ tool: "bash", args: { command: "true" } }]);
    await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
    assert.equal(answers(data, runId)[0].error, false);
    const [run] = docker.runs();
    assert.equal(flags(run, "--network")[0], "none");
    assert.deepEqual(flags(run, "--env").sort(), Object.entries(BOX_ENV).map(([name, v]) => `${name}=${v}`).sort());
    assert.ok(!flags(run, "--mount").some((mount) => mount.includes(EGRESS_MOUNT)), JSON.stringify(flags(run, "--mount")));
    assert.deepEqual(docker.relays(), []);
    assert.deepEqual(egressLines(data, runId), [], "no proxy started");
    assert.equal(existsSync(egressDir(runId)), false);
  }
});

const KERNEL = release();
/** A capabilities' docker entry, and the start's banner. */
async function dockerOf(api) {
  const places = (await api("GET", "/capabilities")).body.places;
  return { places, docker: places.boxes.find((box) => box.id === "docker") };
}

test("where a Docker runs, by docker info (fails closed): the network goes on only for a daemon of this Linux machine, by its own kernel; any other answer, or none, is no network, naming what was seen", async (t) => {
  const { egressBlockedBy } = await import("../dist/box-egress.js");
  const said = (answer) => ({ info: async () => answer, kernel: "6.1.0-28-amd64", platform: "linux", sees: (dir) => dir === "/var/lib/docker" });
  withEnv(t, {}, ["DOCKER_HOST", "DOCKER_CONTEXT"]);
  const env = { DOCKER_CONFIG: join(await scratch(t), "no-config") };
  assert.equal(await egressBlockedBy(env, said("linux|6.1.0-28-amd64|/var/lib/docker|Debian GNU/Linux 13 (trixie)\n")), undefined, "this machine's own kernel: no VM in between");
  // Each runtime a Mac (or a desktop) runs Docker in: another kernel than this machine's.
  for (const [name, kernel] of [["Docker Desktop", "6.10.14-linuxkit"], ["OrbStack", "6.15.11-orbstack-00539-g9885ebd8e3f4"], ["Rancher Desktop WSL Distribution", "5.15.167.4-microsoft-standard-WSL2"], ["Colima", "6.8.0-50-generic"], ["Podman Machine", "6.12.7-200.fc41.aarch64"], ["Boot2Docker 19.03.12 (TCL 10.1)", "4.19.130-boot2docker"]]) {
    assert.equal(await egressBlockedBy(env, said(`linux|${kernel}|/var/lib/docker|${name}`)), `this Docker (${name}) runs in a VM (its kernel is ${JSON.stringify(kernel)}, this machine's "6.1.0-28-amd64") that can't reach this server's egress proxy yet`, name);
  }
  // A named runtime on this kernel still passes: the kernel is the evidence, not the name.
  assert.equal(await egressBlockedBy(env, said("linux|6.1.0-28-amd64|/var/lib/docker|Docker Engine - Community")), undefined);
  assert.equal(await egressBlockedBy(env, said("windows|10.0 20348 (20348.1.amd64fre.fe_release.210507-1500)|C:\\ProgramData\\docker|Windows Server 2022 Datacenter")), `this Docker (Windows Server 2022 Datacenter) runs "windows" containers, not Linux ones on this machine, so it can't reach this server's egress proxy`);
  for (const garbage of ["", "nonsense", "linux|||", "linux|6.1.0-28-amd64|Debian", "a|b|c|d|e", "<html>"]) {
    assert.match(await egressBlockedBy(env, said(garbage)), /^docker info's answer could not be read \(.*\), so this server can't tell this Docker is on this machine$/, JSON.stringify(garbage));
  }
  assert.equal(await egressBlockedBy(env, { ...said(""), info: async () => { throw new Error("it failed (exit 1)"); } }), "docker info did not say where this Docker runs (it failed (exit 1)), so this server can't tell it is on this machine");
  assert.equal(await egressBlockedBy(env, { ...said(""), platform: "darwin" }), "this server runs on macOS, where Docker runs in a VM that can't reach this server's egress proxy yet");
  assert.equal(await egressBlockedBy({ ...env, DOCKER_HOST: "tcp://docker.example.com:2376" }, said("linux|6.1.0-28-amd64|/var/lib/docker|Debian GNU/Linux 13 (trixie)")), "this Docker (DOCKER_HOST=tcp://docker.example.com:2376) is not on this machine, so it can't reach this server's egress proxy");
  assert.equal(await egressBlockedBy({ ...env, DOCKER_HOST: "unix:///var/run/docker.sock" }, said("linux|6.1.0-28-amd64|/var/lib/docker|Debian GNU/Linux 13 (trixie)")), undefined, "a unix socket is this machine's");
  // A server in a container given the host's docker socket: the host's kernel, but not its files.
  assert.equal(await egressBlockedBy(env, said("linux|6.1.0-28-amd64|/host/var/lib/docker|Docker Engine - Community")), `this Docker (Docker Engine - Community) keeps its data in "/host/var/lib/docker", which this server can't see: it runs on another machine's files (this server in a container, given the host's docker socket), so it can't reach this server's egress proxy`);
});

test("docker info that errors or does not answer in time is no network, saying so", async (t) => {
  const { egressBlockedBy, dockerInfo } = await import("../dist/box-egress.js");
  const docker = await fakeDocker(t, { "docker-info-fail": "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" });
  assert.equal(await egressBlockedBy(process.env, { platform: "linux" }), "docker info did not say where this Docker runs (it failed (exit 1)), so this server can't tell it is on this machine");
  await rm(join(docker.state, "docker-info-fail"));
  await writeFile(join(docker.state, "docker-info-hold"), "");
  const started = Date.now();
  assert.equal(await egressBlockedBy(process.env, { platform: "linux", timeoutMs: 1_000, info: dockerInfo }), "docker info did not say where this Docker runs (it did not answer within 1 s), so this server can't tell it is on this machine");
  assert.ok(Date.now() - started < 10_000, "the bound ends the wait");
});

test("capabilities and the banner: on a Docker of this Linux machine's own, places.allow is the default list and docker's network is allowlist; the banner names the hosts", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own" }, async (t) => {
  await fakeDocker(t);
  const server = await serve(t, { faux: PROBE });
  const { places, docker } = await dockerOf(server.api);
  assert.deepEqual(places.allow, DEFAULT);
  assert.deepEqual(docker, { id: "docker", available: true, state: "ready", network: "allowlist" });
  assert.equal(server.boxesLine, "Boxes: docker is ready, so sandbox agents run their tools there. docker boxes reach only pypi.org, files.pythonhosted.org, registry.npmjs.org, registry.yarnpkg.com, github.com, and codeload.github.com.");
});

test("a Docker in a VM (docker info names the runtime, on another kernel): docker's network is none with the reason naming it, in capabilities and the banner, and a run's box gets no proxy", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, { "docker-info": "linux|6.15.11-orbstack-00539-g9885ebd8e3f4|/var/lib/docker|OrbStack\n" });
  const server = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  const { places, docker: offer } = await dockerOf(server.api);
  const why = process.platform === "linux"
    ? `this Docker (OrbStack) runs in a VM (its kernel is "6.15.11-orbstack-00539-g9885ebd8e3f4", this machine's ${JSON.stringify(KERNEL)}) that can't reach this server's egress proxy yet`
    : undefined;
  assert.deepEqual(places.allow, DEFAULT, "the server's one list stands: this box's network says it cannot have it");
  assert.equal(offer.network, "none");
  if (why) assert.equal(offer.network_reason, why);
  assert.ok(server.boxesLine.includes(`docker boxes have no network: ${offer.network_reason}.`), server.boxesLine);
  const runId = await boxedRun(server.api, [{ tool: "bash", args: { command: "true" } }]);
  await follow(server.api, runId, ["completed"], { deadlineMs: 60_000 });
  const [run] = docker.runs();
  assert.deepEqual(flags(run, "--env").sort(), Object.entries(BOX_ENV).map(([name, v]) => `${name}=${v}`).sort());
  assert.ok(!flags(run, "--mount").some((mount) => mount.includes(EGRESS_MOUNT)));
  assert.deepEqual(docker.relays(), []);
  assert.deepEqual(egressLines(server.data, runId), [], "no proxy started");
});

test("AGENTRUN_BOX_ALLOW=none: capabilities say none, with the setting as the reason", async (t) => {
  await fakeDocker(t, {}, { [BOX_ALLOW_ENV]: "none" });
  const server = await serve(t, { faux: PROBE });
  const { places, docker } = await dockerOf(server.api);
  assert.deepEqual([places.allow, docker.network, docker.network_reason], [[], "none", "AGENTRUN_BOX_ALLOW is none"]);
  assert.ok(server.boxesLine.endsWith("docker boxes have no network: AGENTRUN_BOX_ALLOW is none."), server.boxesLine);
});

/** A `docker run`'s arguments with what changes from run to run named: the data root, the run's id, the box's start
 *  time, and serve's uid:gid. */
const normalized = (args, data, runId) => args.map((arg) => arg.split(data).join("<DATA>").split(runId).join("<RUN>").replace(/"startedAt":"[^"]+"/, '"startedAt":"<TIME>"').replace(new RegExp(`^${process.getuid()}:${process.getgid()}$`), "<UID:GID>"));
/** main's `docker run` of a box with no network, before boxes had any (captured on main at 46eb3968a with slice 1 merged,
 *  where the box code was main's): a box with `none` is made byte for byte as it was. */
const NONE_GOLDEN = ["run", "--detach", "--init", "--rm", "--workdir", "/run/agentrun/run/work", "--label", "pi-transport.box=1", "--label", 'pi-transport.facts={"provider":"docker","isolation":"container","cpus":2,"memoryMb":4096,"gpu":null,"workspace":"/run/agentrun/run/work","maxLifetimeMs":86400000,"snapshot":null,"bulk":"stream","secretsVia":"fd","network":"none","ports":[],"startedAt":"<TIME>"}', "--label", "agentrun.run=<RUN>", "--label", "agentrun.box=run", "--env", "LANG=C.UTF-8", "--env", "HOME=/tmp", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "<UID:GID>", "--cpu-period", "100000", "--cpu-quota", "200000", "--memory", "4g", "--memory-swap", "4g", "--pids-limit", "1024", "--mount", "type=bind,source=<DATA>/runs/<RUN>/work,target=/run/agentrun/run/work", "--entrypoint", "sleep", "debian:bookworm-slim", "86400"];

test("golden: with AGENTRUN_BOX_ALLOW=none, a run's `docker run` is byte for byte main's", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, {}, { [BOX_ALLOW_ENV]: "none" });
  const { api, data } = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: "true" } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const [run] = docker.runs();
  assert.deepEqual(normalized(run, data, runId), NONE_GOLDEN);
});

test("a relay that cannot start (an image with socat but no setsid, or a relay that never listens) leaves the box with no network, and the run's timeline says why once; its tools still run", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own", timeout: 120_000 }, async (t) => {
  for (const [mark, text, row] of [
    ["no-setsid", "", "This box's image has no setsid, so it has no network. Add util-linux's setsid to the image, or set AGENTRUN_BOX_ALLOW=none to silence this."],
    ["relay-dead", "2026/11/04 socat[7] E bind(5, {AF=2 127.0.0.1:3128}, 16): Address in use", "This box's network relay did not start within 3 s (2026/11/04 socat[7] E bind(5, {AF=2 127.0.0.1:3128}, 16): Address in use), so it has no network."],
  ]) {
    const docker = await fakeDocker(t, { [mark]: text });
    const { api, data } = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
    const runId = await boxedRun(api, [{ tool: "bash", args: { command: "printf one" } }]);
    await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
    assert.deepEqual(answers(data, runId).map((a) => [a.error, a.text]), [[false, "one"]], mark);
    assert.deepEqual((await rowsOf(api, runId)).filter((r) => r.summary?.startsWith("This box")).map((r) => r.summary), [row], mark);
    assert.equal(docker.relays().length, 1);
    await rm(docker.state, { recursive: true, force: true });
  }
});

test("a box an earlier process of the run made with another network (none) is made again with the list, not reused offline", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own", timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t);
  const { api, data } = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  const go = await holdFile(t);
  const runId = await boxedRun(api, [{ wait: go.hold }, { tool: "bash", args: { command: "printf again > out.txt" } }]);
  const work = join(realpathSync(data), "runs", runId, "work");
  await until(() => existsSync(work), "the run's work/");
  // The box an earlier process of the run made under AGENTRUN_BOX_ALLOW=none, as Docker would list it: no network label.
  const id = "e".repeat(64);
  const labels = { "pi-transport.box": "1", "pi-transport.facts": JSON.stringify({ provider: "docker", workspace: "/run/agentrun/run/work", isolation: "container" }), "agentrun.run": runId, "agentrun.box": "run" };
  await mkdir(join(docker.state, "containers"), { recursive: true });
  await writeFile(join(docker.state, "containers", `${id}.json`), JSON.stringify({ Id: id, State: { Running: true, ExitCode: 0 }, Config: { Labels: labels }, HostConfig: { NetworkMode: "none", CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"] }, env: ["LANG=C.UTF-8", "HOME=/tmp"], mounts: [{ source: work, target: "/run/agentrun/run/work" }], workdir: "/run/agentrun/run/work" }));
  await go.release();
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(answers(data, runId).map((a) => [a.tool, a.error]), [["bash", false]]);
  assert.equal(readFileSync(join(work, "out.txt"), "utf8"), "again", "work/ is this machine's: nothing lost");
  assert.ok(docker.removed().includes(id), "the box made offline is ended");
  const [made] = docker.runs();
  assert.ok(made, "a box is made again");
  assert.ok(flags(made, "--env").includes(`HTTPS_PROXY=${PROXY}`), "with the proxy");
  assert.ok(flags(made, "--mount").some((mount) => mount.includes(`target=${EGRESS_MOUNT},readonly`)), "and its socket's directory");
  const net = flags(made, "--label").find((label) => label.startsWith("agentrun.net="));
  assert.equal(net, `agentrun.net=${createHash("sha256").update(DEFAULT.join(",")).digest("hex").slice(0, 16)}`, "labelled with its list");
});

test("a Docker whose data root this server can't see (the server in a container, given the host's docker socket): docker's network is none at start, with the reason, and a run's box gets no proxy; one it sees keeps the list", { skip: process.platform !== "linux" && "a box's network list needs a Docker daemon of this Linux machine's own", timeout: 120_000 }, async (t) => {
  const missing = join(await scratch(t), "host-var-lib-docker");
  const docker = await fakeDocker(t, { "docker-info": `linux|${KERNEL}|${missing}|Docker Engine - Community\n` });
  const server = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  const { docker: offer } = await dockerOf(server.api);
  assert.equal(offer.network, "none");
  assert.equal(offer.network_reason, `this Docker (Docker Engine - Community) keeps its data in ${JSON.stringify(missing)}, which this server can't see: it runs on another machine's files (this server in a container, given the host's docker socket), so it can't reach this server's egress proxy`);
  const runId = await boxedRun(server.api, [{ tool: "bash", args: { command: "true" } }]);
  await follow(server.api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(answers(server.data, runId)[0].error, false, "the call runs, with no network");
  assert.ok(!flags(docker.runs()[0], "--mount").some((mount) => mount.includes(EGRESS_MOUNT)));
  // The same, its data root one this server sees: the list.
  await mkdir(missing);
  const seen = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  assert.equal((await dockerOf(seen.api)).docker.network, "allowlist");
});

test("the start's sweep removes only dead proxy directories of this user's: one whose socket refuses (or has none) and is older than a minute goes, a live one and a new one stay", async (t) => {
  const { sweepEgressDirs, STALE_EGRESS_MS } = await import("../dist/box-egress.js");
  const { createServer } = await import("node:net");
  const { utimes } = await import("node:fs/promises");
  const parent = join("/tmp", `agentrun-egress-${process.getuid()}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = (n) => join(parent, createHash("sha256").update(`sweep-test-${process.pid}-${n}`).digest("hex").slice(0, 16));
  const [dead, live, fresh, empty] = [dir(1), dir(2), dir(3), dir(4)];
  t.after(() => Promise.all([dead, live, fresh, empty].map((d) => rm(d, { recursive: true, force: true }))));
  for (const d of [dead, live, fresh, empty]) await mkdir(d, { mode: 0o700 });
  // dead: a socket file nothing listens on (a regular file refuses a connect the same way); live: a listener.
  await writeFile(join(dead, "egress.sock"), "");
  const listener = createServer((socket) => socket.end());
  await new Promise((resolve) => listener.listen(join(live, "egress.sock"), resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const old = new Date(Date.now() - 2 * STALE_EGRESS_MS);
  for (const d of [dead, live, empty]) await utimes(d, old, old);
  const removed = await sweepEgressDirs(process.getuid());
  assert.ok(removed >= 2, `removed ${removed}`);
  assert.deepEqual([dead, live, fresh, empty].map((d) => existsSync(d)), [false, true, true, false], "dead and empty go; live and fresh stay");
});
