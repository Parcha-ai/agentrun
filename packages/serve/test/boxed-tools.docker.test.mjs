// The demo on real Docker (AGENTRUN_SERVE_LIVE_DOCKER=1 only; CI's transport-docker job runs it, advisory): a run whose
// place is a Docker box runs read, write, edit and bash in a debian:bookworm-slim container as serve's user. What the
// faux box cannot show is checked here: no key or token in the box's environment, in any process's under /proc or in
// what Docker keeps of the container; no network, neither this host (on loopback, the bridge's gateway or its own
// address) nor a public address, and no name resolves; and nothing of the host outside the run's work/ in the box.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { follow, serve, withEnv } from "./support.mjs";

const LIVE = process.env.AGENTRUN_SERVE_LIVE_DOCKER === "1";
const PROBE = new URL("./fixtures/faux-probe.mjs", import.meta.url).pathname;
const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const SANDBOX = { mode: "sandbox", box: "docker" };
// Values planted in the server's environment, each one no box may hold: an unnamed key, OpenAI's, and the four keys a
// tester runs everything with: OpenRouter's (which a harness may be handed under another name), Monid's, Parallel's and
// Browserbase's. A box is searched for each value, so a key handed on under any name is found.
const planted = (name) => `planted-${name}-sentinel`;
const SENTINELS = { FOO_API_KEY: planted("foo"), OPENAI_API_KEY: planted("openai"), OPENROUTER_API_KEY: planted("openrouter"), MONID_API_KEY: planted("monid"), PARALLEL_API_KEY: planted("parallel"), BROWSERBASE_API_KEY: planted("browserbase") };
const ENV_PROBE = "env; cat /proc/self/environ 2>/dev/null | tr '\\0' '\\n'";
const SHELL_OWN = ["OLDPWD", "PWD", "SHLVL", "_", "HOSTNAME"];

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
  withEnv(t, { ...SENTINELS, AGENTRUN_BOXES: "docker" });
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
  assert.deepEqual(record.Mounts.map((m) => [m.Type, m.Source, m.Destination, m.RW]), [["bind", join(canonical, "runs", runId, "work"), "/run/agentrun/run/work", true]]);
  assert.equal(record.Config.User, `${process.getuid()}:${process.getgid()}`);
  await follow(api, runId, ["completed"], { deadlineMs: 180_000 });
  const said = answers(data, runId);
  const at = (i) => said[i].text;
  assert.deepEqual(said.slice(0, 9).map((a) => a.error), Array(9).fill(false), JSON.stringify(said));
  assert.equal(at(3), "edited in the box");
  const out = join(data, "runs", runId, "work", "out.txt");
  assert.equal(readFileSync(out, "utf8"), "hi");
  assert.equal(statSync(out).uid, process.getuid(), "a file the box made is serve's");
  assert.ok((await api("GET", `/runs/${runId}/files`)).body.files.some((f) => f.path === "out.txt"));
  // The environment: the fixed one, with the image's PATH and Docker's HOSTNAME.
  assert.deepEqual(envNames(at(4)).filter((name) => !SHELL_OWN.includes(name)).sort(), ["HOME", "LANG", "PATH"], at(4));
  await noSecretIn(at(4), server);
  await noSecretIn(at(5), server);
  assert.ok(at(5).includes("sleep"), "PID 1, the box's sleep, was read");
  assert.deepEqual(at(6).trim().split("\n"), ["lo"], "loopback only");
  assert.deepEqual(at(7).trim().split("\n"), [...targets.map(([host]) => `CLOSED ${host}`), "NO_NAME"]);
  assert.match(at(8), /^run\nwork\n/, "the box holds the run's work/ alone");
  assert.match(at(8), /No such file or directory/);
  assert.ok(!at(8).includes(server.token));
  assert.equal(said[9].error, true, "the data root is not in the box");
  const [id, uid, gid, cwd] = at(10).trim().split("\n");
  assert.deepEqual([id, uid, gid, cwd], ["ID=debian", String(process.getuid()), String(process.getgid()), "/run/agentrun/run/work"]);
  assert.match(at(11), /\/run\/agentrun\/run\/work\/missing\.md/, "an error names the box's path");
  assert.ok(!at(11).includes(canonical), "never the data root");
  assert.match(at(9), /: outside the workspace \/run\/agentrun\/run\/work/, "a host path is refused, never mapped");
  await until(() => docker("ps", "--all", "--quiet", "--filter", `label=agentrun.run=${runId}`).trim() === "", "the box's destroy at the run's end");
});

test("live Docker (claude-agent, codex on the faux harness): bash writes out.txt in the box through the host tools, with no key or token there", { skip: !LIVE && "set AGENTRUN_SERVE_LIVE_DOCKER=1", timeout: 300_000 }, async (t) => {
  withEnv(t, { ...SENTINELS, AGENTRUN_BOXES: "docker" });
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
    assert.ok(existsSync(join(data, "runs", run.body.run_id, "work", "out.txt")), harness);
    await noSecretIn(said[1].text, server);
  }
});
