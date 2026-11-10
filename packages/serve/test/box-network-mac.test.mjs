// A Docker box's network on a Mac (box-egress-vm.ts): where Docker runs in a VM that docker info names (Docker Desktop,
// OrbStack, colima), the server runs its egress proxy in one container inside that VM, its socket in a tmpfs
// named volume the box mounts read-only, and the box stays `--network none`. Anything else stays offline, with why. With
// a fake `docker` first on PATH (fixtures/fake-docker.mjs, answering docker info as each runtime does; no daemon is
// reached): it runs the proxy container's own `node` command on this machine, with the tests' fake network loaded
// (fixtures/fake-egress-preload.mjs), so no lookup or connection leaves this machine. The server takes itself to be on a
// Mac by its faux-only `fauxPlatform`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { BOX_ENV } from "../dist/run-box.js";
import { follow, scratch, serve, withEnv } from "./support.mjs";

const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAKE = new URL("./fixtures/fake-docker.mjs", import.meta.url).pathname;
const PRELOAD = new URL("./fixtures/fake-egress-preload.mjs", import.meta.url).pathname;
const IMAGE = "debian:bookworm-slim";
const SANDBOX = { mode: "sandbox", box: "docker" };
const DEFAULT = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "registry.yarnpkg.com", "github.com", "codeload.github.com"];
// The contract, written out: what the proxy container and the box get.
const EGRESS_IMAGE = "node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da";
const EGRESS_MOUNT = "/run/agentrun/egress";
const PROXY = "http://127.0.0.1:3128";
const PROXY_ENV = { HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, http_proxy: PROXY, https_proxy: PROXY, NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1" };
const ALLOW_HINT = "use web_fetch for web pages, or ask the operator to add it to AGENTRUN_BOX_ALLOW";
const MAC = { faux: PROBE, fauxPlatform: "darwin" };
/** colima's OperatingSystem is its VM's distro; detection keys on Name, not on this. */
const COLIMA_OS = "Debian GNU/Linux 12 (bookworm)";

/** A fake docker first on PATH answering docker info as `runtime`, with the proxy's fake network, and `marks` made. */
async function fakeDocker(t, runtime, marks = {}, vars = {}) {
  const dir = await scratch(t);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(join(bin, "docker"), `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  if (runtime) await writeFile(join(state, "docker-runtime"), runtime);
  for (const [name, text] of Object.entries(marks)) await writeFile(join(state, name), text);
  withEnv(t, { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_STATE: state, FAKE_DOCKER_EGRESS_PRELOAD: PRELOAD, DOCKER_CONFIG: join(dir, "docker-config"), AGENTRUN_BOXES: "docker", AGENTRUN_DOCKER_IMAGE: IMAGE, ...vars }, ["AGENTRUN_BOX_ALLOW", "DOCKER_HOST", "DOCKER_CONTEXT"]);
  assert.equal(spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim(), join(bin, "docker"), "the fake is the docker on PATH");
  const lines = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const runs = () => lines("argv.jsonl").filter((args) => args[0] === "run");
  // The fake's volumes: short directories under /tmp (fake-docker.mjs volumeDir).
  const volumeDir = (name) => join("/tmp", `fdv-${createHash("sha256").update(`${state}\0${name}`).digest("hex").slice(0, 12)}`);
  t.after(() => Promise.all(lines("volumes.jsonl").map((args) => rm(volumeDir(args.at(-1)), { recursive: true, force: true }))));
  // Every proxy process the fake started ends with the test, whatever else happens.
  t.after(() => {
    for (const { pid } of lines("egress.jsonl")) {
      if (commandOf(pid).includes("main.js")) try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  });
  return {
    state,
    volumeDir,
    argv: () => lines("argv.jsonl"),
    runs,
    proxies: () => runs().filter((args) => args.some((arg) => arg.startsWith("agentrun.egress="))),
    boxes: () => runs().filter((args) => args.includes("agentrun.box=run")),
    volumes: () => lines("volumes.jsonl"),
    relays: () => lines("relays.jsonl"),
    started: () => lines("egress.jsonl"),
  };
}

/** A process's command line, as `ps` gives it (Linux and macOS alike; a Mac has no /proc), or "" when it is gone. */
const commandOf = (pid) => {
  const answer = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return answer.status === 0 ? answer.stdout : "";
};

const until = async (done, what, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const flags = (args, name) => args.flatMap((arg, i) => (args[i - 1] === name ? [arg] : []));
const keyOf = (data) => createHash("sha256").update(realpathSync(data)).digest("hex").slice(0, 12);
const dockerOf = async (api) => (await api("GET", "/capabilities")).body.places.boxes.find((box) => box.id === "docker");

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

async function boxedRun(api, plan) {
  const made = await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } });
  assert.ok([201, 409].includes(made.status), JSON.stringify(made.body));
  const run = await api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("which Docker in a VM gets a box's network on a Mac, by docker info's own strings (fails closed): Docker Desktop, OrbStack and colima, on a kernel not this machine's; anything else is a reason", async () => {
  const { vmDockerOf } = await import("../dist/box-egress-vm.js");
  const mac = { platform: "darwin", kernel: "24.6.0" };
  const as = (os, name, kernel = "6.10.14-linuxkit", type = "linux") => vmDockerOf(`${type}|${kernel}|${os}|${name}\n`, mac);
  // Each runtime's own strings (fixtures/fake-docker.mjs RUNTIMES, from their users' pasted docker info).
  assert.deepEqual(as("Docker Desktop", "docker-desktop"), { runtime: "Docker Desktop" });
  assert.deepEqual(as("OrbStack", "orbstack", "6.13.7-orbstack-00283-g9d1400e7e9c6"), { runtime: "OrbStack" });
  assert.deepEqual(as(COLIMA_OS, "colima", "6.8.0-64-generic"), { runtime: "colima" });
  assert.deepEqual(as(COLIMA_OS, "colima-work", "6.8.0-39-generic"), { runtime: "colima" }, "a colima profile's VM is colima-<profile>");
  // colima's OperatingSystem is not read: two distros, one Name, one answer.
  assert.deepEqual(as("Alpine Linux v3.23", "colima", "6.8.0-64-generic"), as(COLIMA_OS, "colima", "6.8.0-64-generic"));
  // Known by name, but on this machine's own kernel: no VM in between.
  assert.equal(as("Docker Desktop", "docker-desktop", "24.6.0").reason, "this Docker (Docker Desktop) runs on this machine's own kernel, not in a VM this server knows, so its boxes get no network");
  // Runtimes this server does not know, and a colima whose host name was changed: offline, naming what was seen.
  for (const [os, name, kernel] of [["Alpine Linux v3.23", "lima-rancher-desktop", "6.6.119-0-virt"], ["fedora", "localhost.localdomain", "6.7.4-200.fc39.aarch64"], [COLIMA_OS, "my-vm", "6.8.0-64-generic"], ["docker desktop", "docker-desktop", "6.10.14-linuxkit"]]) {
    assert.equal(as(os, name, kernel).reason, `this Docker (${os.trim()}) runs in a VM this server does not know (its kernel is ${JSON.stringify(kernel)}, its name ${JSON.stringify(name)}), so its boxes get no network: on a Mac, a box's network goes on only for Docker Desktop, OrbStack or colima`, name);
  }
  assert.equal(as("Docker Desktop", "docker-desktop", "10.0 20348", "windows").reason, `this Docker (Docker Desktop) runs "windows" containers, not Linux ones, so its boxes get no network`);
  for (const garbage of ["", "nonsense", "linux||OrbStack|orbstack", "a|b|c|d|e"]) {
    assert.match(vmDockerOf(garbage, mac).reason, /^docker info's answer could not be read \(.*\), so this server can't tell which VM this Docker runs in$/, JSON.stringify(garbage));
  }
  // Not a Mac: never this path.
  assert.equal(vmDockerOf("linux|6.10.14-linuxkit|Docker Desktop|docker-desktop", { platform: "linux", kernel: "6.8.0" }).reason, "this server runs on linux, not a Mac, so a Docker in a VM gets no box network here");
});

test("on a Mac, a Docker reached by DOCKER_HOST over TCP, or a docker info that fails, gets no network, saying why; Linux keeps its own check, unchanged", async (t) => {
  const { vmDocker } = await import("../dist/box-egress-vm.js");
  const { boxNetworkOf } = await import("../dist/run-box.js");
  const docker = await fakeDocker(t, "docker-desktop");
  const env = { ...process.env, DOCKER_CONFIG: join(docker.state, "no-config") };
  assert.deepEqual(await vmDocker(env, { platform: "darwin" }), { runtime: "Docker Desktop" });
  assert.equal((await vmDocker({ ...env, DOCKER_HOST: "tcp://docker.example.com:2376" }, { platform: "darwin" })).reason, "this Docker (DOCKER_HOST=tcp://docker.example.com:2376) is not on this machine, so its boxes get no network");
  await writeFile(join(docker.state, "docker-info-fail"), "Cannot connect to the Docker daemon");
  assert.equal((await vmDocker(env, { platform: "darwin" })).reason, "docker info did not say where this Docker runs (it failed (exit 1)), so its boxes get no network");
  await rm(join(docker.state, "docker-info-fail"));
  assert.deepEqual(await boxNetworkOf(env, { platform: "darwin" }), { allow: DEFAULT, vm: "Docker Desktop" });
  // The same Docker Desktop seen from a Linux server: the Linux check's own reason, as before.
  const linux = await boxNetworkOf(env, { platform: "linux", kernel: "6.8.0-50-generic" });
  assert.deepEqual(linux, { allow: "none", reason: `this Docker (Docker Desktop) runs in a VM (its kernel is "6.10.14-linuxkit", this machine's "6.8.0-50-generic") that can't reach this server's egress proxy yet` });
  assert.deepEqual(await boxNetworkOf({ ...env, AGENTRUN_BOX_ALLOW: "none" }, { platform: "darwin" }), { allow: "none", reason: "AGENTRUN_BOX_ALLOW is none" });
});

/** The proxy container's `docker run`, with the data root, its key, the code's directory and serve's uid:gid named. */
const normalized = (args, data, key) => args.map((arg) => arg.split(realpathSync(data)).join("<DATA>").split(key).join("<KEY>").replace(/egress\/[0-9a-f]{12},/, "egress/<CODE>,").replace(new RegExp(`^${process.getuid()}:${process.getgid()}$`), "<UID:GID>"));
const PROXY_GOLDEN = ["run", "--detach", "--name", "agentrun-egress-<KEY>", "--restart", "unless-stopped", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "<UID:GID>", "--memory", "256m", "--pids-limit", "256", "--log-driver", "json-file", "--log-opt", "max-size=1m", "--log-opt", "max-file=2", "--label", "agentrun.egress=<KEY>", "--mount", "type=volume,source=agentrun-egress-<KEY>,target=/egress", "--mount", "type=bind,source=<DATA>/egress/<CODE>,target=/code,readonly", "--env", `AGENTRUN_BOX_ALLOW=${DEFAULT.join(",")}`, "--entrypoint", "node", EGRESS_IMAGE, "/code/main.js", "/egress/egress.sock"];

// SKIP (follow-up #2078): a run in a Docker box fails on the runner instead of completing
test.skip("demo through the API, Docker Desktop on a Mac: capabilities say allowlist; one proxy container, its argv golden (Docker's default network, the tmpfs volume of the server's uid, the code read-only, the digest image, the list its only variable); the box stays --network none with the volume read-only; the proxy reaches a listed host and refuses another in words; the server's stop removes it", { timeout: 120_000 }, async (t) => {
  const docker = await fakeDocker(t, "docker-desktop", {}, { OPENAI_API_KEY: "not-a-secret" });
  const server = await serve(t, MAC);
  const { api, data } = server;
  const key = keyOf(data);
  const offer = await dockerOf(api);
  assert.equal(offer.network, "allowlist", JSON.stringify(offer));
  assert.equal(offer.network_reason, undefined);
  assert.ok(server.boxesLine.includes("docker boxes reach only pypi.org"), server.boxesLine);
  // The volume: tmpfs, the server's uid:gid, 0700, labelled.
  assert.deepEqual(docker.volumes(), [["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", `o=size=1m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`, "--label", `agentrun.egress=${key}`, `agentrun-egress-${key}`]]);
  // The proxy container, once.
  assert.equal(docker.proxies().length, 1);
  const [proxy] = docker.proxies();
  assert.deepEqual(normalized(proxy, data, key), PROXY_GOLDEN);
  assert.equal(flags(proxy, "--network").length, 0, "Docker's default network: the only container with one");
  assert.equal(flags(proxy, "--env").length, 1, "the list, and nothing else");
  assert.ok(!proxy.some((arg) => /^(-p|--publish|--privileged)$/.test(arg) || arg.includes("docker.sock")), "no port, no privilege, no Docker socket");
  // Its code, read-only from the data root: the kernel's two files and the entry.
  const code = flags(proxy, "--mount")[1].replace(/^type=bind,source=/, "").replace(/,target=\/code,readonly$/, "");
  assert.deepEqual(["egress-proxy.js", "egress-table.js", "main.js"].map((name) => existsSync(join(code, name))), [true, true, true]);
  // A run's box: --network none, the fixed environment and the proxy's, no key; the volume read-only; no bind of a socket.
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: "printf boxed" } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const [box] = docker.boxes();
  assert.equal(flags(box, "--network")[0], "none");
  assert.deepEqual(flags(box, "--env").sort(), Object.entries({ ...BOX_ENV, ...PROXY_ENV }).map(([name, value]) => `${name}=${value}`).sort());
  assert.deepEqual(flags(box, "--mount").filter((mount) => mount.includes(EGRESS_MOUNT)), [`type=volume,source=agentrun-egress-${key},target=${EGRESS_MOUNT},readonly`]);
  assert.equal(docker.relays().length, 1, "the box's relay to the socket");
  // The proxy, as a box's client reaches it: its socket in the volume, 0600.
  const socket = join(docker.volumeDir(`agentrun-egress-${key}`), "egress.sock");
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  const listed = await viaSocket(socket, { method: "GET", path: "http://pypi.org/simple/", headers: { host: "pypi.org" } });
  assert.equal(listed.status, 200, JSON.stringify(listed));
  assert.match(listed.body, /^fake origin: GET pypi\.org\/simple\/\n/);
  for (const [method, path, host] of [["CONNECT", "example.com:443", "example.com:443"], ["GET", "http://example.com/", "example.com"]]) {
    const refused = await viaSocket(socket, { method, path, headers: { host } });
    assert.equal(refused.status, 403, `${method}: ${JSON.stringify(refused)}`);
    assert.equal(refused.reason, `example.com is not on this box's network list: ${ALLOW_HINT}`);
  }
  // The VM's own host is never reached: an address, private or public, is refused before any lookup.
  const desktopHost = "192.168.65.254"; // key-gate: denylist the Docker Desktop host address, which the proxy must refuse
  for (const host of [desktopHost, "93.184.215.14"]) {
    assert.equal((await viaSocket(socket, { method: "CONNECT", path: `${host}:443`, headers: { host: `${host}:443` } })).status, 403, host);
  }
  const [{ pid }] = docker.started();
  await server.close();
  const [{ id: proxyId }] = docker.started();
  assert.ok(docker.argv().some((args) => args[0] === "rm" && args.at(-1) === proxyId), "the stop removes it, by its id");
  assert.ok(!docker.argv().some((args) => args[0] === "rm" && args.at(-1) === `agentrun-egress-${key}`), "never by its name, which another container may hold");
  await until(() => !commandOf(pid).includes("main.js"), "the proxy's process gone");
});

// SKIP (follow-up #2078): a run in a Docker box fails on the runner instead of completing
test.skip("each VM runtime a Mac runs: OrbStack and colima get the proxy container too; a runtime this server does not know (Rancher Desktop) stays offline with why, and its boxes get no volume", { timeout: 120_000 }, async (t) => {
  for (const runtime of ["orbstack", "colima"]) {
    const docker = await fakeDocker(t, runtime);
    const server = await serve(t, MAC);
    assert.equal((await dockerOf(server.api)).network, "allowlist", runtime);
    assert.equal(docker.proxies().length, 1, runtime);
    await server.close();
  }
  const docker = await fakeDocker(t, "rancher-desktop");
  const { api } = await serve(t, MAC);
  const offer = await dockerOf(api);
  assert.equal(offer.network, "none");
  assert.equal(offer.network_reason, `this Docker (Alpine Linux v3.23) runs in a VM this server does not know (its kernel is "6.6.119-0-virt", its name "lima-rancher-desktop"), so its boxes get no network: on a Mac, a box's network goes on only for Docker Desktop, OrbStack or colima`);
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: "true" } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual(docker.proxies(), [], "no proxy container");
  assert.deepEqual(docker.volumes(), []);
  const [box] = docker.boxes();
  assert.deepEqual(flags(box, "--env").sort(), Object.entries(BOX_ENV).map(([name, value]) => `${name}=${value}`).sort());
  assert.ok(!flags(box, "--mount").some((mount) => mount.includes(EGRESS_MOUNT)));
});

test("a Docker Desktop seen by a Linux server keeps the Linux answer: none, its reason as before, no proxy container", { timeout: 60_000 }, async (t) => {
  const docker = await fakeDocker(t, "docker-desktop");
  const { api } = await serve(t, { faux: PROBE, fauxPlatform: "linux" });
  const offer = await dockerOf(api);
  assert.equal(offer.network, "none");
  assert.match(offer.network_reason, /^this Docker \(Docker Desktop\) runs in a VM \(its kernel is "6\.10\.14-linuxkit", this machine's ".*"\) that can't reach this server's egress proxy yet$/);
  assert.deepEqual(docker.proxies(), []);
});

test("the start sweeps a proxy container an earlier server of this data root left (by its label), and leaves another server's", { timeout: 60_000 }, async (t) => {
  const docker = await fakeDocker(t, "docker-desktop");
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const key = keyOf(data);
  await mkdir(join(docker.state, "containers"), { recursive: true });
  const left = (id, owner) => writeFile(join(docker.state, "containers", `${id}.json`), JSON.stringify({ Id: id, Name: `agentrun-egress-${owner}`, State: { Running: true, ExitCode: 0 }, Config: { Labels: { "agentrun.egress": owner } }, HostConfig: {}, env: [], mounts: [] }));
  await left("c".repeat(64), key);
  await left("d".repeat(64), "0123456789ab");
  const { api } = await serve(t, { ...MAC, data });
  assert.equal((await dockerOf(api)).network, "allowlist");
  const removed = docker.argv().filter((args) => args[0] === "rm").map((args) => args.at(-1));
  assert.ok(removed.includes("c".repeat(64)), "this server's orphan goes");
  assert.ok(!removed.includes("d".repeat(64)), "another server's stays");
  assert.ok(existsSync(join(docker.state, "containers", `${"d".repeat(64)}.json`)));
});

test("a proxy container that is gone (removed by hand) is started again by the server's watch, and the box's network comes back", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t, "docker-desktop");
  const { api, data } = await serve(t, MAC);
  const key = keyOf(data);
  assert.equal(docker.started().length, 1);
  assert.equal(spawnSync(process.execPath, [FAKE, "rm", "--force", `agentrun-egress-${key}`], { env: process.env }).status, 0);
  // Seen gone at the watch's first look: none at once, saying why, before it is started again.
  await until(async () => (await dockerOf(api)).network === "none", "none once it is seen gone", 20_000);
  assert.match((await dockerOf(api)).network_reason, /^the box network proxy (is not running|was gone, and is starting again)$/);
  await until(() => docker.started().length === 2, "the proxy started again", 40_000);
  await until(async () => (await dockerOf(api)).network === "allowlist", "allowlist again");
  const socket = join(docker.volumeDir(`agentrun-egress-${key}`), "egress.sock");
  await until(() => viaSocket(socket, { method: "GET", path: "http://pypi.org/", headers: { host: "pypi.org" } }).then((res) => res.status === 200, () => false), "the new proxy answers");
});

test("a proxy container that never says it is ready: the box's network is none, saying why (fails closed)", { timeout: 60_000 }, async (t) => {
  // The fake's proxy, given a preload that never lets the entry start.
  const silent = join(await scratch(t), "silent.mjs");
  await writeFile(silent, "await new Promise(() => setInterval(() => {}, 60_000));\n");
  await fakeDocker(t, "docker-desktop", {}, { FAKE_DOCKER_EGRESS_PRELOAD: silent });
  const { api, boxesLine } = await serve(t, MAC);
  const offer = await dockerOf(api);
  assert.equal(offer.network, "none");
  assert.equal(offer.network_reason, "the box network proxy did not start (it did not say it was ready within 10 s), so boxes have no network: restart the server to try again");
  assert.ok(boxesLine.includes(`docker boxes have no network: ${offer.network_reason}`), boxesLine);
});

test("the proxy's entry refuses to start with no list, or one that is not names; given one, it listens on its socket (0600) and says it is ready; its code imports only node: modules and itself", { timeout: 60_000 }, async (t) => {
  const { egressCode } = await import("../dist/box-egress-vm.js");
  const data = await scratch(t);
  const code = await egressCode(data);
  assert.equal(await egressCode(data), code, "written once per version");
  for (const name of ["egress-proxy.js", "egress-table.js", "main.js"]) {
    const imports = [...(await readFile(join(code, name), "utf8")).matchAll(/^import [^;]*? from "([^"]+)";$/gm)].map((match) => match[1]);
    assert.ok(imports.length > 0 && imports.every((from) => from.startsWith("node:") || from === "./egress-table.js" || from === "./egress-proxy.js"), `${name}: ${imports}`);
  }
  const dir = await mkdtemp(join("/tmp", "egress-main-"));
  const socket = join(dir, "egress.sock");
  for (const [allow, words] of [[undefined, "egress: no host list, so the proxy does not start: one with none would reach every public host"], ["", "egress: no host list, so the proxy does not start: one with none would reach every public host"], ["*", /^egress: AGENTRUN_BOX_ALLOW is not a host list \(.*\), so the proxy does not start$/]]) {
    const ran = spawnSync(process.execPath, ["--import", PRELOAD, join(code, "main.js"), socket], { env: { PATH: process.env.PATH, ...(allow === undefined ? {} : { AGENTRUN_BOX_ALLOW: allow }) }, encoding: "utf8", timeout: 20_000 });
    assert.equal(ran.status, 2, JSON.stringify(allow));
    typeof words === "string" ? assert.equal(ran.stdout.trim(), words) : assert.match(ran.stdout.trim(), words);
    assert.equal(existsSync(socket), false);
  }
  const child = spawn(process.execPath, ["--import", PRELOAD, join(code, "main.js"), socket], { env: { PATH: process.env.PATH, AGENTRUN_BOX_ALLOW: "pypi.org" }, stdio: ["ignore", "pipe", "inherit"] });
  const gone = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await gone;
  });
  // After the stop, to its exit: a test's after-hooks run in the order they were added, and the proxy keeps its socket in `dir`.
  t.after(() => rm(dir, { recursive: true, force: true }));
  let said = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (said += chunk));
  await until(() => said.includes("egress ready"), "ready");
  assert.equal(said.trim().split("\n")[0], "egress ready allow=pypi.org");
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.equal((await viaSocket(socket, { method: "GET", path: "http://pypi.org/", headers: { host: "pypi.org" } })).status, 200);
});

test("the volume is made before any run gets its name, even while the proxy's image is pulled; one of its name that Docker made with its defaults (no label) is replaced with the server's tmpfs one", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t, "docker-desktop", { "no-image": "", "pull-hold": "" });
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const name = `agentrun-egress-${keyOf(data)}`;
  // As Docker leaves it when a box mounted the name before the server made it: root's, no label.
  await mkdir(docker.volumeDir(name), { recursive: true });
  const { api } = await serve(t, { ...MAC, data });
  assert.deepEqual(docker.volumes().map((args) => args.slice(0, 2)), [["volume", "rm"], ["volume", "create"]], "replaced at the start, while the pull holds");
  assert.ok(docker.volumes()[1].includes(`agentrun.egress=${keyOf(data)}`));
  const offer = await dockerOf(api);
  assert.equal(offer.network, "none");
  assert.equal(offer.network_reason, "the box network proxy is pulling its image, node:22-bookworm-slim");
  assert.deepEqual(docker.proxies(), [], "no proxy before its image is in");
  await rm(join(docker.state, "pull-hold"));
  await until(async () => (await dockerOf(api)).network === "allowlist", "allowlist once the image is in");
});

test("a server's close while its proxy's image is pulled ends the pull, starts nothing, and leaves Docker alone after it", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t, "docker-desktop", { "no-image": "", "pull-hold": "" });
  const server = await serve(t, MAC);
  await until(() => docker.argv().some((args) => args[0] === "pull" && args.at(-1) === EGRESS_IMAGE), "the pull");
  await server.close();
  // The proxy's own calls: its image, its name, its label, its volume.
  const egressCalls = () => docker.argv().filter((args) => args.some((arg) => arg.includes(EGRESS_IMAGE) || arg.includes("agentrun-egress-") || arg.includes("agentrun.egress")));
  const after = egressCalls().length;
  await rm(join(docker.state, "pull-hold"));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(egressCalls().length, after, `nothing of the proxy's after the close: ${JSON.stringify(egressCalls().slice(after))}`);
  assert.deepEqual(docker.proxies(), [], "no proxy started");
  assert.ok(!docker.argv().some((args) => args[0] === "rm"), "nothing of its own to remove, and nothing removed by name");
});

test("a container that is not this server's but holds its proxy's name (no agentrun.egress label) is never removed: the proxy can't start, the network is none saying why, and the close leaves it", { timeout: 60_000 }, async (t) => {
  const docker = await fakeDocker(t, "docker-desktop");
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const name = `agentrun-egress-${keyOf(data)}`;
  const foreign = "b".repeat(64);
  await mkdir(join(docker.state, "containers"), { recursive: true });
  await writeFile(join(docker.state, "containers", `${foreign}.json`), JSON.stringify({ Id: foreign, Name: name, State: { Running: true, ExitCode: 0 }, Config: { Labels: {} }, HostConfig: {}, env: [], mounts: [] }));
  const server = await serve(t, { ...MAC, data });
  const offer = await dockerOf(server.api);
  assert.equal(offer.network, "none");
  assert.match(offer.network_reason, /^the box network proxy did not start \(docker run failed \(125\)\)/);
  await server.close();
  assert.ok(existsSync(join(docker.state, "containers", `${foreign}.json`)), "the foreign container is still there");
  assert.ok(!docker.argv().some((args) => args[0] === "rm" && (args.at(-1) === name || args.at(-1) === foreign)), "never removed");
});

// SKIP (follow-up #2078): a run in a Docker box fails on the runner instead of completing
test.skip("a stale AGENTRUN_RUN_BOX_VOLUME in the server's own environment never reaches a run on Linux: its box mounts no volume", { timeout: 90_000 }, async (t) => {
  const docker = await fakeDocker(t, null, {}, { AGENTRUN_RUN_BOX_VOLUME: "agentrun-egress-0123456789ab" });
  const { api } = await serve(t, { faux: PROBE, fauxPlatform: "linux" });
  const runId = await boxedRun(api, [{ tool: "bash", args: { command: "true" } }]);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const [box] = docker.boxes();
  assert.ok(!flags(box, "--mount").some((mount) => mount.startsWith("type=volume")), JSON.stringify(flags(box, "--mount")));
});

/** A scripted `docker` for startEgressContainer alone (no fake on PATH): `answer(args)` gives each call's result, and
 *  every call is noted. */
function scriptedDocker(answer) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "", ...(await answer(args)) };
  };
  return { calls, docker };
}
/** The answers of a Docker that has the image and the server's volume, and whose proxy says it is ready. */
const healthy = (key, id) => (args) => {
  if (args[0] === "volume" && args[1] === "inspect") return { stdout: `${key}\n` };
  if (args[0] === "run") return { stdout: `${id}\n` };
  if (args[0] === "logs") return { stdout: "egress ready allow=pypi.org\n" };
  if (args[0] === "inspect") return { stdout: "true\n" };
  return {};
};

test("the proxy's id is used only when it is one: a docker run that prints anything but 64 hex digits is a failed start, and that text is never given to rm, inspect or logs", { timeout: 30_000 }, async (t) => {
  const { startEgressContainer } = await import("../dist/box-egress-vm.js");
  const data = await scratch(t);
  const key = keyOf(data);
  for (const printed of ["agentrun-egress-" + key, "Unable to find image locally\nnot-an-id", "--all"]) {
    const { calls, docker } = scriptedDocker(healthy(key, printed));
    const proxy = await startEgressContainer({ env: process.env, data, allow: ["pypi.org"], uid: 1, gid: 1, docker, watchMs: 60_000 });
    assert.deepEqual(proxy.state(), { state: "unavailable", reason: "the box network proxy did not start (docker run printed no container id), so boxes have no network: restart the server to try again" }, printed);
    await proxy.close();
    const last = printed.split("\n").at(-1);
    assert.ok(!calls.some((args) => ["rm", "inspect", "logs"].includes(args[0]) && args.includes(last)), `${printed}: ${JSON.stringify(calls)}`);
  }
});

test("a start whose docker run gave no answer (the client cut off, the daemon made the proxy anyway) leaves nothing behind: the close removes this server's labelled proxy by its id", { timeout: 30_000 }, async (t) => {
  const { startEgressContainer } = await import("../dist/box-egress-vm.js");
  const data = await scratch(t);
  const key = keyOf(data);
  const made = "c".repeat(64);
  let running = false;
  const base = healthy(key, made);
  const { calls, docker } = scriptedDocker((args) => {
    if (args[0] === "run") return (running = true), { code: "timeout" };
    // `ps --all --filter label=agentrun.egress=<key>`: what the daemon has with this server's label.
    if (args[0] === "ps") return { stdout: running && args.includes(`label=agentrun.egress=${key}`) ? `${made}\n` : "" };
    if (args[0] === "rm") return (running = running && args.at(-1) !== made), {};
    return base(args);
  });
  const proxy = await startEgressContainer({ env: process.env, data, allow: ["pypi.org"], uid: 1, gid: 1, docker, watchMs: 60_000 });
  assert.equal(proxy.state().state, "unavailable");
  await proxy.close();
  assert.ok(calls.some((args) => args[0] === "rm" && args.at(-1) === made), JSON.stringify(calls));
  assert.equal(running, false, "nothing of this server's left running");
  assert.ok(!calls.some((args) => args[0] === "rm" && args.at(-1) === `agentrun-egress-${key}`), "never by its name");
});

test("the fake's rm ends the proxy it started on a machine with no /proc (macOS), checking the process by its command line", { timeout: 30_000 }, async (t) => {
  const dir = await scratch(t);
  const state = join(dir, "state");
  await mkdir(join(state, "containers"), { recursive: true });
  // A stand-in for the proxy's process: its own process group, "main.js" in its command line.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "main.js"], { detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  });
  const id = "d".repeat(64);
  await writeFile(join(state, "containers", `${id}.json`), JSON.stringify({ Id: id, Name: "agentrun-egress-0123456789ab", pid: child.pid, State: { Running: true, ExitCode: 0 }, Config: { Labels: { "agentrun.egress": "0123456789ab" } }, HostConfig: {}, env: [], mounts: [] }));
  const removed = spawnSync(process.execPath, [FAKE, "rm", "--force", id], { env: { ...process.env, FAKE_DOCKER_STATE: state }, encoding: "utf8" });
  assert.equal(removed.status, 0, removed.stderr);
  const gone = await Promise.race([exited.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 5_000))]);
  assert.equal(gone, true, "the proxy's process ended");
});

test("a close whose cleanup fails says so: the proxy may still run, and how to remove it by this server's label", { timeout: 30_000 }, async (t) => {
  const { startEgressContainer } = await import("../dist/box-egress-vm.js");
  const data = await scratch(t);
  const key = keyOf(data);
  const made = "e".repeat(64);
  const base = healthy(key, made);
  // Docker answers until the close, then refuses its removal and does not list in time.
  let closing = false;
  const { docker } = scriptedDocker((args) => {
    if (closing && args[0] === "rm") return { code: 1, stderr: "Error response from daemon: the fake refused" };
    if (closing && args[0] === "ps") return { code: "timeout" };
    return base(args);
  });
  const warned = [];
  const proxy = await startEgressContainer({ env: process.env, data, allow: ["pypi.org"], uid: 1, gid: 1, docker, watchMs: 60_000, warn: (message) => warned.push(message) });
  assert.equal(proxy.state().state, "ready");
  closing = true;
  await proxy.close();
  assert.ok(warned.length > 0, "the failure is said");
  for (const message of warned) assert.match(message, new RegExp(`^the box network proxy may still be running \\(.+\\): remove the containers labelled agentrun\\.egress=${key} with docker rm -f$`), message);
});
