// A Docker box's network on a Mac (box-egress-vm.ts): where Docker runs in a VM that docker info names (Docker Desktop,
// OrbStack, colima), the server runs the kernel's egress proxy in one container inside that VM, its socket in a tmpfs
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
  // Every proxy process the fake started ends with the test, whatever else happens.
  t.after(() => {
    for (const { pid } of lines("egress.jsonl")) {
      let cmdline = "";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {}
      if (cmdline.includes("main.js")) try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
  });
  return {
    state,
    argv: () => lines("argv.jsonl"),
    runs,
    proxies: () => runs().filter((args) => args.some((arg) => arg.startsWith("agentrun.egress="))),
    boxes: () => runs().filter((args) => args.includes("agentrun.box=run")),
    volumes: () => lines("volumes.jsonl"),
    relays: () => lines("relays.jsonl"),
    started: () => lines("egress.jsonl"),
  };
}

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
  assert.deepEqual(as("Ubuntu 24.04.2 LTS", "colima", "6.8.0-64-generic"), { runtime: "colima" });
  assert.deepEqual(as("Ubuntu 24.04 LTS", "colima-work", "6.8.0-39-generic"), { runtime: "colima" }, "a colima profile's VM is colima-<profile>");
  // Known by name, but on this machine's own kernel: no VM in between.
  assert.equal(as("Docker Desktop", "docker-desktop", "24.6.0").reason, "this Docker (Docker Desktop) runs on this machine's own kernel, not in a VM this server knows, so its boxes get no network");
  // Runtimes this server does not know, and a colima whose host name was changed: offline, naming what was seen.
  for (const [os, name, kernel] of [["Alpine Linux v3.23", "lima-rancher-desktop", "6.6.119-0-virt"], ["fedora", "localhost.localdomain", "6.7.4-200.fc39.aarch64"], ["Ubuntu 24.04.2 LTS", "my-vm", "6.8.0-64-generic"], ["docker desktop", "docker-desktop", "6.10.14-linuxkit"]]) {
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

test("demo through the API, Docker Desktop on a Mac: capabilities say allowlist; one proxy container, its argv golden (Docker's default network, the tmpfs volume of the server's uid, the code read-only, the digest image, the list its only variable); the box stays --network none with the volume read-only; the proxy reaches a listed host and refuses another in words; the server's stop removes it", { timeout: 120_000 }, async (t) => {
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
  const socket = join(docker.state, "volumes", `agentrun-egress-${key}`, "egress.sock");
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  const listed = await viaSocket(socket, { method: "GET", path: "http://pypi.org/simple/", headers: { host: "pypi.org" } });
  assert.equal(listed.status, 200, JSON.stringify(listed));
  assert.match(listed.body, /^fake origin: GET pypi\.org\/simple\/\n/);
  for (const [method, path, host] of [["CONNECT", "example.com:443", "example.com:443"], ["GET", "http://example.com/", "example.com"]]) {
    const refused = await viaSocket(socket, { method, path, headers: { host } });
    assert.equal(refused.status, 403, `${method}: ${JSON.stringify(refused)}`);
    assert.equal(refused.reason, `example.com is not on this box's network list: ${ALLOW_HINT}`);
  }
  // The VM's own host and gateway, listed or not, are never reached: an address is refused before any lookup.
  for (const host of ["0.250.250.254", "192.168.65.254", "host.docker.internal"]) {
    assert.equal((await viaSocket(socket, { method: "CONNECT", path: `${host}:443`, headers: { host: `${host}:443` } })).status, 403, host);
  }
  const [{ pid }] = docker.started();
  await server.close();
  assert.ok(docker.argv().some((args) => args[0] === "rm" && args.at(-1) === `agentrun-egress-${key}`), "the stop removes it");
  await until(() => !existsSync(`/proc/${pid}`) || !readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("main.js"), "the proxy's process gone");
});

test("each VM runtime a Mac runs: OrbStack and colima get the proxy container too; a runtime this server does not know (Rancher Desktop) stays offline with why, and its boxes get no volume", { timeout: 120_000 }, async (t) => {
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
  await until(() => docker.started().length === 2, "the proxy started again", 40_000);
  await until(async () => (await dockerOf(api)).network === "allowlist", "allowlist again");
  const socket = join(docker.state, "volumes", `agentrun-egress-${key}`, "egress.sock");
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
  t.after(() => rm(dir, { recursive: true, force: true }));
  const socket = join(dir, "egress.sock");
  for (const [allow, words] of [[undefined, "egress: no host list, so the proxy does not start: one with none would reach every public host"], ["", "egress: no host list, so the proxy does not start: one with none would reach every public host"], ["*", /^egress: AGENTRUN_BOX_ALLOW is not a host list \(.*\), so the proxy does not start$/]]) {
    const ran = spawnSync(process.execPath, ["--import", PRELOAD, join(code, "main.js"), socket], { env: { PATH: process.env.PATH, ...(allow === undefined ? {} : { AGENTRUN_BOX_ALLOW: allow }) }, encoding: "utf8", timeout: 20_000 });
    assert.equal(ran.status, 2, JSON.stringify(allow));
    typeof words === "string" ? assert.equal(ran.stdout.trim(), words) : assert.match(ran.stdout.trim(), words);
    assert.equal(existsSync(socket), false);
  }
  const child = spawn(process.execPath, ["--import", PRELOAD, join(code, "main.js"), socket], { env: { PATH: process.env.PATH, AGENTRUN_BOX_ALLOW: "pypi.org" }, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  let said = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (said += chunk));
  await until(() => said.includes("egress ready"), "ready");
  assert.equal(said.trim().split("\n")[0], "egress ready allow=pypi.org");
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  assert.equal((await viaSocket(socket, { method: "GET", path: "http://pypi.org/", headers: { host: "pypi.org" } })).status, 200);
});
