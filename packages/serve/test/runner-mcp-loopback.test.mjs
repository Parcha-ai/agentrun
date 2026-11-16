// A runner in its own process (`agentrun-serve runner`, beside a server started with --no-runner on the same data
// directory) takes the operator's loopback opt-in as the runner beside the server does: with AGENTRUN_MCP_ALLOW_LOOPBACK=1
// set for it, and a server on that data directory started with the same, sharing its loopback (the same machine and
// network namespace, as the server's note there says), its runs reach an MCP server on loopback. Without its own opt-in,
// configured as on another host (AGENTRUN_RUNNER_LIVE_HOST), or with the note of a server whose loopback is not its own,
// it is refused as before, nothing sent. The runner here is composed as runnerMain composes it (startRunnerProcess over
// runnerLoop, its environment the process's less test switches, with the faux model as --faux sets it). No socket leaves
// this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, retried, scratch, serve, withEnv } from "./support.mjs";

const { fauxEnvOf } = await import("../dist/server.js");
const { withoutFaux } = await import("../dist/model.js");
const { ofStore, runnerLoop, startRunnerProcess } = await import("../dist/runner/main.js");
/** The note's module, read in the tests that name it (the runs above need only the runner and the server). */
const noted = () => import("../dist/mcp-local-install.js");

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const MCP_TOKEN = `not-a-secret-${"runner-mcp-loopback-bearer"}`;
const CONTENT = 'Call mcp__fake__add with {"a":2,"b":3}';

/** A local-install server with no runner, a fake MCP server on loopback saved on it, and an agent that calls its add
 *  unattended. `run()` starts one run of it (queued: nothing claims it yet). */
async function localInstall(t) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serve(t, { faux: FAUX_MCP, runner: false, mcpLoopback: true });
  const fake = await startFakeMcp({ token: MCP_TOKEN });
  t.after(() => fake.close());
  assert.equal(new URL(fake.url).hostname, "127.0.0.1", "the MCP server is on loopback");
  const saved = await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: MCP_TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const made = await retried(server.api)("POST", "/agents", agent("loopback-caller", { tools: ["mcp:fake/add"], approvals: "never" }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = async () => {
    const started = await server.api("POST", "/agents/loopback-caller/runs", { input: { content: CONTENT } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  const calls = () => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length;
  return { server, run, calls };
}

/** A runner in its own process's shape on `data`, with `env` beside the faux model (runnerMain: the process's
 *  environment less its test switches, then --faux's), until the test ends. Its warnings are kept in `said`. */
async function standalone(t, data, name, env = {}) {
  const runs = { ...withoutFaux(process.env), ...fauxEnvOf({ faux: FAUX_MCP }), ...env };
  const said = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  // runnerLoop says its loopback lines on stderr, as the runner process does: kept here too.
  process.stderr.write = (chunk, ...rest) => (said.push(String(chunk)), realWrite(chunk, ...rest));
  t.after(() => void (process.stderr.write = realWrite));
  const runner = await startRunnerProcess({ dataDir: data, name, env: runs, createLoop: ofStore((store, sealKey) => runnerLoop(store, data, runs, sealKey)), warn: (line) => said.push(line) });
  t.after(() => runner.close());
  return said;
}

/** The run's final answer once it ends. */
async function answered(server, runId) {
  await follow(server.api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  return (await server.api("GET", `/runs/${runId}`)).body.result?.final_answer;
}

test("a standalone runner whose operator set AGENTRUN_MCP_ALLOW_LOOPBACK=1, on the data directory of a local install that shares its loopback, reaches an MCP server on loopback", { timeout: 120_000 }, async (t) => {
  const { server, run, calls } = await localInstall(t);
  const said = await standalone(t, server.data, "runner-loopback", { AGENTRUN_MCP_ALLOW_LOOPBACK: "1" });
  assert.equal(await answered(server, await run()), "The tool said: 5");
  assert.equal(calls(), 1, "sent once");
  assert.ok(said.some((line) => line.includes("shares the local-install server's loopback")), `the runner says why it reaches loopback: ${said.join("")}`);
});

test("a standalone runner without its own AGENTRUN_MCP_ALLOW_LOOPBACK=1 is refused an MCP server on loopback, nothing sent, beside a local install as before", { timeout: 120_000 }, async (t) => {
  const { server, run, calls } = await localInstall(t);
  await standalone(t, server.data, "runner-unsaid");
  assert.match(await answered(server, await run()), /address is refused here/);
  assert.equal(calls(), 0, "nothing sent");
});

test("a standalone runner configured as on another host (AGENTRUN_RUNNER_LIVE_HOST) is refused an MCP server on loopback even with the opt-in, nothing sent, and says why", { timeout: 120_000 }, async (t) => {
  const { server, run, calls } = await localInstall(t);
  const said = await standalone(t, server.data, "runner-remote", { AGENTRUN_MCP_ALLOW_LOOPBACK: "1", AGENTRUN_RUNNER_LIVE_HOST: "runner-b.example.test" });
  assert.match(await answered(server, await run()), /address is refused here/);
  assert.equal(calls(), 0, "nothing sent");
  assert.ok(said.some((line) => line.includes("AGENTRUN_RUNNER_LIVE_HOST=runner-b.example.test")), `the runner says why: ${said.join("")}`);
});

test("a standalone runner with the opt-in, on a shared data directory whose server's loopback is another machine's (its note's mark is not the runner's), is refused, nothing sent", { timeout: 120_000 }, async (t) => {
  const { LOCAL_INSTALL_NOTE, loopbackMark } = await noted();
  const { server, run, calls } = await localInstall(t);
  const file = join(server.data, LOCAL_INSTALL_NOTE);
  const note = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(note.mark, loopbackMark(), "the server noted its own loopback");
  assert.ok(note.own.includes(server.url), "and its own address, whose port a runner's loopback read never goes to");
  writeFileSync(file, JSON.stringify({ ...note, mark: "linux boot another-machine net:[1]" }));
  await standalone(t, server.data, "runner-elsewhere", { AGENTRUN_MCP_ALLOW_LOOPBACK: "1" });
  assert.match(await answered(server, await run()), /address is refused here/);
  assert.equal(calls(), 0, "nothing sent");
});

test("the note: a local install's start leaves it, any other start takes it away; a runner reads it at each claim, and reads none without its own opt-in or configured as remote", async (t) => {
  const { LOCAL_INSTALL_NOTE, noteLocalInstall, readLocalInstallNote, standaloneLoopback } = await noted();
  const data = await scratch(t);
  const lines = [];
  const local = standaloneLoopback({ AGENTRUN_MCP_ALLOW_LOOPBACK: "1" }, data, (line) => lines.push(line), "mark-a");
  assert.equal(local(), undefined, "no note yet: refused");
  await noteLocalInstall(data, true, ["http://127.0.0.1:7340"], "mark-a");
  assert.deepEqual(local(), { own: ["http://127.0.0.1:7340"] }, "read at the next claim, with the server's own addresses");
  assert.deepEqual(readLocalInstallNote(data), { mark: "mark-a", own: ["http://127.0.0.1:7340"] });
  await noteLocalInstall(data, false, ["http://127.0.0.1:7340"], "mark-a");
  assert.equal(existsSync(join(data, LOCAL_INSTALL_NOTE)), false, "a start without the opt-in takes the note away");
  assert.equal(local(), undefined, "and the runner's next claim is refused again");
  assert.equal(lines.length, 3, `each change said once: ${lines.join(" | ")}`);
  await noteLocalInstall(data, true, [], "mark-b");
  assert.equal(local(), undefined, "another loopback's note: refused");
  writeFileSync(join(data, LOCAL_INSTALL_NOTE), "{not json");
  assert.equal(local(), undefined, "a note that is no note: refused");
  assert.equal(standaloneLoopback({}, data, () => {}, "mark-a"), undefined, "no opt-in: nothing read");
  assert.equal(standaloneLoopback({ AGENTRUN_MCP_ALLOW_LOOPBACK: "true" }, data, () => {}, "mark-a"), undefined, "only 1 is the opt-in, as on the server");
  assert.equal(standaloneLoopback({ AGENTRUN_MCP_ALLOW_LOOPBACK: "1", AGENTRUN_RUNNER_LIVE_HOST: "runner-b.example.test" }, data, () => {}, "mark-a"), undefined, "configured as remote: nothing read");
  assert.equal(typeof standaloneLoopback({ AGENTRUN_MCP_ALLOW_LOOPBACK: "1", AGENTRUN_RUNNER_LIVE_HOST: "127.0.0.1" }, data, () => {}, "mark-a"), "function", "a live host on loopback is this machine");
});

test("loopbackMark: on Linux, the booted kernel and the network namespace; two processes share a loopback when both match", async () => {
  if (process.platform !== "linux") return;
  const { loopbackMark } = await noted();
  const files = { "/proc/sys/kernel/random/boot_id": "b-1\n", "/proc/self/ns/net": "net:[4026531840]" };
  assert.equal(loopbackMark((path) => files[path]), "linux boot b-1 net:[4026531840]");
  assert.notEqual(loopbackMark((path) => ({ ...files, "/proc/self/ns/net": "net:[4026532999]" })[path]), loopbackMark((path) => files[path]), "another container's namespace");
  assert.notEqual(loopbackMark((path) => ({ ...files, "/proc/sys/kernel/random/boot_id": "b-2\n" })[path]), loopbackMark((path) => files[path]), "another machine, the same first namespace");
});
