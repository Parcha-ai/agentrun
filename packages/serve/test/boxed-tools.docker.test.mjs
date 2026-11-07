// The demo on real Docker (AGENTRUN_SERVE_LIVE_DOCKER=1 only; CI's transport-docker job runs it, advisory): a run whose
// place is a Docker box runs read, write, edit and bash in a debian:bookworm-slim container as serve's user. What the
// faux box cannot show is checked here: no key or token in the box's environment, in any process's under /proc or in
// what Docker keeps of the container; no network, neither this host (on loopback, the bridge's gateway or its own
// address) nor a public address, and no name resolves; and nothing of the host outside the run's work/ in the box.
// With AGENTRUN_SERVE_LIVE_DOCKER_BUILD=1 too, the server also builds its default box image (python, git, curl, node,
// npm, rg, and socat) from its recipe, and a box from it runs each of them with no network; and, with a network list, a
// box from it reaches a listed host through its egress proxy (the tests' fake network) and nothing else.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, connect } from "node:net";
import { networkInterfaces } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { follow, runDir, serve, withEnv } from "./support.mjs";
import { DEFAULT_DOCKER_IMAGE, RECIPE_HASH, RECIPE_LABEL } from "../dist/box-image.js";

const LIVE = process.env.AGENTRUN_SERVE_LIVE_DOCKER === "1";
/** The build of the default box image on real Docker: a few minutes and the network, so a run asks for it by name. */
const LIVE_BUILD = LIVE && process.env.AGENTRUN_SERVE_LIVE_DOCKER_BUILD === "1";
const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const FAKE_EGRESS = new URL("./fixtures/fake-egress.mjs", import.meta.url).pathname;
const GUARD = new URL("./fixtures/net-guard.mjs", import.meta.url).pathname;
/** The proxy variables a box with the list has (box-egress.ts PROXY_ENV). */
const PROXY_NAMES = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
/** A run's proxy directory (box-egress.ts egressDir). */
const egressDirOf = (runId) => join("/tmp", `agentrun-egress-${process.getuid()}`, createHash("sha256").update(runId).digest("hex").slice(0, 16));
const SANDBOX = { mode: "sandbox", box: "docker" };
/** The image CI pulls before this file runs; the default image, built here, has a test of its own (below). */
const PULLED = "debian:bookworm-slim";
// Values planted in the server's environment, each one no box may hold: an unnamed key, OpenAI's, and the four keys a
// tester runs everything with: OpenRouter's (which a harness may be handed under another name), Monid's, Parallel's and
// Browserbase's. A box is searched for each value, so a key handed on under any name is found.
const planted = (name) => `planted-${name}-sentinel`;
const SENTINELS = { FOO_API_KEY: planted("foo"), OPENAI_API_KEY: planted("openai"), OPENROUTER_API_KEY: planted("openrouter"), MONID_API_KEY: planted("monid"), PARALLEL_API_KEY: planted("parallel"), BROWSERBASE_API_KEY: planted("browserbase") };
const ENV_PROBE = "env; cat /proc/self/environ 2>/dev/null | tr '\\0' '\\n'";
const SHELL_OWN = ["OLDPWD", "PWD", "SHLVL", "_", "HOSTNAME"];

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
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });
const until = async (done, what, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await done())) {
    assert.ok(Date.now() < end, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
const envNames = (text) => [...new Set(text.split("\n").map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]).filter(Boolean))];

/** A TCP listener on every address of this host, which the host itself reaches: the box must not. */
async function listener(t) {
  const server = createServer((socket) => socket.end("reached\n"));
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  await new Promise((resolve, reject) => connect(port, "127.0.0.1").once("connect", function () { this.end(); resolve(); }).once("error", reject));
  return port;
}

async function noSecretIn(text, server) {
  const door = readFileSync(join(server.data, ".door-token"), "utf8").trim();
  for (const [name, value] of Object.entries({ ...SENTINELS, token: server.token, door })) assert.ok(!text.includes(value), `${name} reached the box`);
}

test("live Docker (pi): bash runs in the box, and write, read and edit on the work/ it binds; no key or token in its environment, /proc or Docker's record of it; no network; nothing of the host outside work/", { skip: !LIVE && "set AGENTRUN_SERVE_LIVE_DOCKER=1 with a Docker daemon and debian:bookworm-slim", timeout: 300_000 }, async (t) => {
  withEnv(t, { ...SENTINELS, AGENTRUN_BOXES: "docker", AGENTRUN_DOCKER_IMAGE: PULLED });
  const server = await serve(t, { faux: PROBE });
  const { api, data } = server;
  assert.equal((await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "docker")?.available, true, "Docker is available to this server");
  const port = await listener(t);
  const gateway = docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}").trim();
  const own = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  const targets = [["127.0.0.1", port], [gateway, port], ...(own ? [[own, port]] : []), ["1.1.1.1", 443]];
  const reach = targets.map(([host, p]) => `if timeout 5 bash -c 'echo > /dev/tcp/${host}/${p}' 2>/dev/null; then echo "OPEN ${host}"; else echo "CLOSED ${host}"; fi`).join("; ");
  assert.equal((await api("POST", "/agents", { definition: { id: "boxed", name: "boxed", instructions: "Probe.", place: SANDBOX, tools: ["read", "write", "edit", "bash"] } })).status, 201);
  const canonical = realpathSync(data);
  const plan = [
    { tool: "bash", args: { command: "printf hi > out.txt" } },
    { tool: "write", args: { path: "note.txt", content: "written in the box" } },
    { tool: "edit", args: { path: "note.txt", edits: [{ oldText: "written", newText: "edited" }] } },
    { tool: "read", args: { path: "note.txt" } },
    { tool: "bash", args: { command: ENV_PROBE } },
    { tool: "bash", args: { command: "for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null; tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done" } },
    { tool: "bash", args: { command: "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '" } },
    { tool: "bash", args: { command: `${reach}; getent hosts example.com >/dev/null && echo RESOLVED || echo NO_NAME` } },
    { tool: "bash", args: { command: `ls -A /run/agentrun; ls -A /run/agentrun/run; ls ${canonical} 2>&1; cat ${join(canonical, ".token")} 2>&1; true` } },
    { tool: "read", args: { path: join(canonical, ".token") } },
    { tool: "bash", args: { command: "grep -h '^ID=' /etc/os-release; id -u; id -g; pwd" } },
    { tool: "read", args: { path: "missing.md" } },
    // Holds the box while the test reads Docker's record of it.
    { tool: "bash", args: { command: "sleep 20" } },
  ];
  const run = await api("POST", "/agents/boxed/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  // Docker's own record of the box, while it lives: no key or token in it either.
  let container;
  await until(() => (container = docker("ps", "--quiet", "--no-trunc", "--filter", `label=agentrun.run=${runId}`).trim()), "the run's box");
  const inspected = docker("inspect", container);
  await noSecretIn(inspected, server);
  const [record] = JSON.parse(inspected);
  assert.equal(record.HostConfig.NetworkMode, "none");
  // Its work/, read-write; and, on a Docker of this Linux machine's own, its proxy's directory, read-only (the default
  // network list; box-network.test.mjs).
  const listed = (await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "docker")?.network === "allowlist";
  assert.deepEqual(record.Mounts.map((m) => [m.Type, m.Source, m.Destination, m.RW]), [
    ["bind", join(runDir(canonical, runId), "work"), "/run/agentrun/run/work", true],
    ...(listed ? [["bind", egressDirOf(runId), "/run/agentrun/egress", false]] : []),
  ]);
  assert.equal(record.Config.User, `${process.getuid()}:${process.getgid()}`);
  await follow(api, runId, ["completed"], { deadlineMs: 180_000 });
  const said = answers(data, runId);
  const at = (i) => said[i].text;
  assert.deepEqual(said.slice(0, 9).map((a) => a.error), Array(9).fill(false), JSON.stringify(said));
  assert.equal(at(3), "edited in the box");
  const out = join(runDir(data, runId), "work", "out.txt");
  assert.equal(readFileSync(out, "utf8"), "hi");
  assert.equal(statSync(out).uid, process.getuid(), "a file the box made is serve's");
  assert.ok((await api("GET", `/runs/${runId}/files`)).body.files.some((f) => f.path === "out.txt"));
  // The environment: the fixed one (and the proxy's, with the list), with the image's PATH and Docker's HOSTNAME.
  assert.deepEqual(envNames(at(4)).filter((name) => !SHELL_OWN.includes(name)).sort(), ["HOME", "LANG", "PATH", ...(listed ? PROXY_NAMES : [])].sort(), at(4));
  await noSecretIn(at(4), server);
  await noSecretIn(at(5), server);
  assert.ok(at(5).includes("sleep"), "PID 1, the box's sleep, was read");
  assert.deepEqual(at(6).trim().split("\n"), ["lo"], "loopback only");
  assert.deepEqual(at(7).trim().split("\n"), [...targets.map(([host]) => `CLOSED ${host}`), "NO_NAME"]);
  assert.match(at(8), listed ? /^egress\nrun\nwork\n/ : /^run\nwork\n/, "the box holds the run's work/ alone (and its proxy's directory)");
  assert.match(at(8), /No such file or directory/);
  assert.ok(!at(8).includes(server.token));
  assert.equal(said[9].error, true, "the data root is not in the box");
  const [id, uid, gid, cwd] = at(10).trim().split("\n");
  assert.deepEqual([id, uid, gid, cwd], ["ID=debian", String(process.getuid()), String(process.getgid()), "/run/agentrun/run/work"]);
  assert.match(at(11), /\/run\/agentrun\/run\/work\/missing\.md/, "an error names the box's path");
  assert.ok(!at(11).includes(canonical), "never the data root");
  assert.match(at(9), /: outside the workspace(\n<\/harness>)?$/, "a host path is refused as given, never mapped, and no other path is named");
  await until(() => docker("ps", "--all", "--quiet", "--filter", `label=agentrun.run=${runId}`).trim() === "", "the box's destroy at the run's end");
});

test("live Docker (claude-agent, codex on the faux harness): bash writes out.txt in the box through the host tools, with no key or token there", { skip: !LIVE && "set AGENTRUN_SERVE_LIVE_DOCKER=1", timeout: 300_000 }, async (t) => {
  withEnv(t, { ...SENTINELS, AGENTRUN_BOXES: "docker", AGENTRUN_DOCKER_IMAGE: PULLED });
  const server = await serve(t, { faux: PROBE, fauxHarness: FAUX_HARNESS });
  const { api, data } = server;
  for (const harness of ["claude-agent", "codex"]) {
    const calls = [{ call: "bash", args: { command: "printf hi > out.txt" } }, { call: "bash", args: { command: `${ENV_PROBE}; tr '\\0' '\\n' < /proc/1/environ` } }];
    const id = `boxed-${harness}`;
    assert.equal((await api("POST", "/agents", { definition: { id, name: id, harness, instructions: `Box calls: ${JSON.stringify(calls)}`, place: SANDBOX, tools: ["bash"] } })).status, 201);
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: "go" } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    await follow(api, run.body.run_id, ["completed"], { deadlineMs: 180_000 });
    const said = answers(data, run.body.run_id);
    assert.deepEqual(said.map((a) => [a.tool, a.error]), [["bash", false], ["bash", false]], `${harness}: ${JSON.stringify(said)}`);
    assert.ok(existsSync(join(runDir(data, run.body.run_id), "work", "out.txt")), harness);
    await noSecretIn(said[1].text, server);
  }
});

test("live Docker, the default image: the server builds it once from its recipe (its network is the build's alone), with python 3.12, git, curl, node and rg, labelled with the recipe's hash; a box from it reaches no host off its list", { skip: !LIVE_BUILD && "set AGENTRUN_SERVE_LIVE_DOCKER=1 and AGENTRUN_SERVE_LIVE_DOCKER_BUILD=1 with a Docker daemon that can reach Docker Hub and Debian's mirrors", timeout: 900_000 }, async (t) => {
  withEnv(t, { ...SENTINELS, AGENTRUN_BOXES: "docker" }, ["AGENTRUN_DOCKER_IMAGE"]);
  const { api, data } = await serve(t, { faux: PROBE });
  const offer = async () => (await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "docker");
  // Built on this start, or already built by an earlier one with this recipe.
  await until(async () => (await offer()).state !== "preparing", "the box image's build", 840_000);
  // On a Docker of this Linux machine's own, the box reaches the default list (box-network.test.mjs).
  assert.deepEqual(await offer(), { id: "docker", available: true, state: "ready", network: "allowlist" });
  assert.equal(docker("image", "inspect", "--format", `{{ index .Config.Labels "${RECIPE_LABEL}" }}`, DEFAULT_DOCKER_IMAGE).trim(), RECIPE_HASH);
  assert.equal((await api("POST", "/agents", { definition: { id: "built", name: "built", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } })).status, 201);
  const plan = [
    { tool: "bash", args: { command: "python3 --version && git --version && curl --version | head -1 && node --version && npm --version && rg --version | head -1 && command -v socat" } },
    { tool: "bash", args: { command: "if timeout 5 curl -sS https://deb.debian.org >/dev/null 2>&1; then echo OPEN; else echo CLOSED; fi" } },
  ];
  const run = await api("POST", "/agents/built/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 180_000 });
  const said = answers(data, run.body.run_id);
  assert.deepEqual(said.map((a) => [a.tool, a.error]), [["bash", false], ["bash", false]], JSON.stringify(said));
  assert.match(said[0].text, /Python 3\.12\.\d+/);
  assert.match(said[0].text, /git version \d/);
  assert.match(said[0].text, /curl \d/);
  assert.match(said[0].text, /^v\d+\.\d+\.\d+$/m, "node");
  assert.match(said[0].text, /ripgrep \d/);
  assert.match(said[0].text, /^\d+\.\d+\.\d+$/m, "npm");
  assert.match(said[0].text, /\/socat$/m, "socat, the relay to a box's network proxy");
  assert.equal(said[1].text.trim(), "CLOSED", "the box has no network, whatever its image's build had");
});

// Last in this file: it loads the net guard into this process, which stays for the file's life.
test("live Docker, a network list: the box stays --network none, reaches a listed host through its egress proxy (the tests' fake network), is refused another in words, and a program that skips the proxy is unreachable; no key in the box, and nothing here or in the run's process reaches past loopback", { skip: !LIVE_BUILD && "set AGENTRUN_SERVE_LIVE_DOCKER=1 and AGENTRUN_SERVE_LIVE_DOCKER_BUILD=1: the box's relay is the default image's socat", timeout: 900_000 }, async (t) => {
  const guardLog = join(await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "net-guard-")), "guard.jsonl");
  withEnv(t, { ...SENTINELS, AGENTRUN_BOXES: "docker", AGENTRUN_BOX_ALLOW: "pypi.org", NET_GUARD_LOG: guardLog, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}` }, ["AGENTRUN_DOCKER_IMAGE"]);
  await import(pathToFileURL(GUARD).href);
  const server = await serve(t, { faux: PROBE, fauxEgress: FAKE_EGRESS });
  const { api, data } = server;
  const offer = async () => (await api("GET", "/capabilities")).body.places.boxes.find((b) => b.id === "docker");
  await until(async () => (await offer()).state !== "preparing", "the box image's build", 840_000);
  assert.equal((await offer()).state, "ready");
  assert.equal((await api("POST", "/agents", { definition: { id: "netted", name: "netted", instructions: "Probe.", place: SANDBOX, tools: ["bash"] } })).status, 201);
  const plan = [
    { tool: "bash", args: { command: "curl -sS http://pypi.org/simple/six/" } },
    { tool: "bash", args: { command: "curl -sS -i http://example.com/ 2>&1; echo; curl -sS https://example.com/ 2>&1; echo \"exit=$?\"" } },
    { tool: "bash", args: { command: "curl -sS --noproxy '*' --max-time 5 http://1.1.1.1/ 2>&1; echo \"curl exit=$?\"; python3 -c 'import socket; socket.create_connection((\"1.1.1.1\", 80), timeout=5)' 2>&1 | tail -1" } },
    { tool: "bash", args: { command: ENV_PROBE } },
  ];
  const run = await api("POST", "/agents/netted/runs", { input: { content: JSON.stringify({ probe: plan }) } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  await follow(api, runId, ["completed"], { deadlineMs: 180_000 });
  const said = answers(data, runId);
  assert.deepEqual(said.map((a) => a.tool), ["bash", "bash", "bash", "bash"], JSON.stringify(said));
  // Listed: the fake's page, through the proxy.
  assert.match(said[0].text, /^fake origin: GET pypi\.org\/simple\/six\//m, said[0].text);
  // Off the list: 403, in words, for plain HTTP and for a tunnel.
  assert.match(said[1].text, /HTTP\/1\.1 403 example\.com is not on this box's network list: use web_fetch for web pages, or ask the operator to add it to AGENTRUN_BOX_ALLOW/, said[1].text);
  assert.match(said[1].text, /CONNECT tunnel failed, response 403/, said[1].text);
  // Past the proxy: no route.
  assert.match(said[2].text, /curl exit=7/, said[2].text);
  assert.match(said[2].text, /Network is unreachable/, said[2].text);
  // No key in the box: its environment is the fixed one and the proxy's, and the image's own (what it declares, read
  // from Docker: python's PATH, GPG_KEY and PYTHON_*), nothing else.
  const imageEnv = JSON.parse(docker("image", "inspect", "--format", "{{json .Config.Env}}", DEFAULT_DOCKER_IMAGE)).map((pair) => pair.slice(0, pair.indexOf("=")));
  const shown = envNames(said[3].text).filter((name) => !SHELL_OWN.includes(name)).sort();
  assert.deepEqual(shown, [...new Set(["HOME", "LANG", ...PROXY_NAMES, ...imageEnv])].sort(), said[3].text);
  for (const name of PROXY_NAMES) assert.ok(shown.includes(name), `${name} is set`);
  await noSecretIn(said.map((a) => a.text).join("\n"), server);
  // Nothing reached past loopback: not this process, not the run's (each loaded the guard).
  const lines = readFileSync(guardLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.filter((line) => line.kind === "refused"), [], "no outbound attempt");
  assert.ok(new Set(lines.filter((line) => line.kind === "loaded").map((line) => line.pid)).size >= 2, "the guard was in this process and the run's");
});
