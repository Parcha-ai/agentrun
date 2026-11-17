// A runner in its own process (`agentrun-serve runner`, beside a server started with --no-runner, or in a service of its
// own) takes the operator's loopback opt-in from its own environment alone, as the server takes its own (cli.ts
// mcpLoopback): started with AGENTRUN_MCP_ALLOW_LOOPBACK=1, its runs reach an MCP server on its loopback; without it they
// are refused, whatever the server was started with. It never reaches loopback at a server's own port (DEFAULT_PORT, a
// loopback AGENTRUN_PUBLIC_URL's, and the addresses the server kept in the store at its last start). The runner here is composed as runnerMain composes it (startRunnerProcess over
// runnerLoop, its environment the process's less test switches, with the faux model as --faux sets it). No socket leaves
// this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, retried, serve, withEnv } from "./support.mjs";

const { fauxEnvOf } = await import("../dist/server.js");
const { withoutFaux } = await import("../dist/model.js");
const main = await import("../dist/runner/main.js");
const { ofStore, runnerLoop, startRunnerProcess } = main;

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const MCP_TOKEN = `not-a-secret-${"runner-mcp-loopback-bearer"}`;
const CONTENT = 'Call mcp__fake__add with {"a":2,"b":3}';
/** The opt-in, as an operator sets it for a process. */
const OPT_IN = { AGENTRUN_MCP_ALLOW_LOOPBACK: "1" };

/** A server started with the opt-in and no runner, a fake MCP server on loopback saved on it, and an agent that calls its
 *  add unattended. `run()` starts one run of it (queued: nothing claims it yet). */
async function optedInServer(t) {
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
  return { server, fake, run, calls };
}

/** A runner in its own process's shape on `data`, with `env` beside the faux model (runnerMain: the process's
 *  environment less its test switches and the opt-in, then --faux's), until the test ends. What it says on stderr is
 *  kept in the array it answers. */
async function standalone(t, data, name, env = {}) {
  const { AGENTRUN_MCP_ALLOW_LOOPBACK: _inherited, AGENTRUN_PUBLIC_URL: _public, ...given } = withoutFaux(process.env);
  const runs = { ...given, ...fauxEnvOf({ faux: FAUX_MCP }), ...env };
  const said = [];
  const realWrite = process.stderr.write.bind(process.stderr);
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

test("a standalone runner started with its own AGENTRUN_MCP_ALLOW_LOOPBACK=1 reaches an MCP server on its loopback, and says it takes the variable", { timeout: 120_000 }, async (t) => {
  const { server, run, calls } = await optedInServer(t);
  const said = await standalone(t, server.data, "runner-opted-in", OPT_IN);
  assert.equal(await answered(server, await run()), "The tool said: 5");
  assert.equal(calls(), 1, "sent once");
  assert.ok(said.some((line) => line.includes("AGENTRUN_MCP_ALLOW_LOOPBACK=1: this runner's runs may reach an MCP server on this machine's loopback, never at http://127.0.0.1:7340")), `the runner says it takes the variable: ${said.join("")}`);
});

test("a standalone runner without AGENTRUN_MCP_ALLOW_LOOPBACK=1 is refused an MCP server on loopback, nothing sent, though the server was started with it: it never inherits the server's", { timeout: 120_000 }, async (t) => {
  const { server, run, calls } = await optedInServer(t);
  await standalone(t, server.data, "runner-unsaid");
  assert.match(await answered(server, await run()), /address is refused here/);
  assert.equal(calls(), 0, "nothing sent");
});

test("a standalone runner with the opt-in never reaches loopback at a server's own port: an MCP server at its AGENTRUN_PUBLIC_URL's loopback port is refused, nothing sent", { timeout: 120_000 }, async (t) => {
  const { server, fake, run, calls } = await optedInServer(t);
  // The MCP server stands where this runner's environment says its server is (a loopback public address).
  await standalone(t, server.data, "runner-own-port", { ...OPT_IN, AGENTRUN_PUBLIC_URL: new URL(fake.url).origin });
  assert.match(await answered(server, await run()), /address is refused here/);
  assert.equal(calls(), 0, "nothing sent");
});

test("a standalone runner with the opt-in never reaches loopback where its server listens, whatever its port: the server keeps its own addresses in the store at its start, and the runner reads them at each claim", { timeout: 120_000 }, async (t) => {
  const { server, fake, run, calls } = await optedInServer(t);
  const { MCP_SERVER_OWN_KEY, serverOwn } = await import("../dist/mcp-private-hosts.js");
  assert.deepEqual(await serverOwn(server.store), [...server.own], "the server kept where it listens");
  assert.ok(server.own.some((address) => new URL(address).port === String(server.port)), "its own port among them");
  await standalone(t, server.data, "runner-server-port", OPT_IN);
  assert.equal(await answered(server, await run()), "The tool said: 5", "another loopback port is reached");
  // The server started again on the MCP server's port, as a server beside the runner on a port of its own (--port).
  await server.store.settings.put(MCP_SERVER_OWN_KEY, { own: [new URL(fake.url).origin] });
  assert.match(await answered(server, await run()), /address is refused here/, "read at the next claim: refused");
  assert.equal(calls(), 1, "the second call never sent");
});

test("runnerLoopback: the opt-in from the runner's own environment alone, exactly 1; never at the default server port, nor at a loopback public address's", () => {
  const { runnerLoopback } = main;
  assert.equal(typeof runnerLoopback, "function", "a runner reads its own opt-in");
  assert.equal(runnerLoopback({}), undefined, "none: refused");
  assert.equal(runnerLoopback({ AGENTRUN_MCP_ALLOW_LOOPBACK: "true" }), undefined, "only 1 is the opt-in, as on the server");
  assert.deepEqual(runnerLoopback(OPT_IN), { own: ["http://127.0.0.1:7340"] });
  assert.deepEqual(runnerLoopback({ ...OPT_IN, AGENTRUN_PUBLIC_URL: "http://localhost:8443/console" }), { own: ["http://127.0.0.1:7340", "http://localhost:8443"] });
  assert.deepEqual(runnerLoopback({ ...OPT_IN, AGENTRUN_PUBLIC_URL: "https://agents.example.test" }), { own: ["http://127.0.0.1:7340"] }, "a public address off loopback is no port of this machine's");
});
