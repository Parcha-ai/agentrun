// The self-hosted layout with an MCP server reachable only on loopback, in real processes: a server started with
// --no-runner, listening on every interface behind a public address, and two `agentrun-serve runner` processes on its data
// directory, each started with AGENTRUN_MCP_ALLOW_LOOPBACK=1 as the server is. On a store upgraded from the build before
// pins were made at save (revisions.mcp_pin added by the server's open, every earlier revision with none), a revision
// saved then is pinned at its first run and its call is reached; a new save pins at once; both runs reach the MCP server
// on loopback from a standalone runner. A server started without the variable refuses that revision's run in words that
// name it. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, client, follow, printed, scratch } from "./support.mjs";

const CLI = new URL("../dist/cli.js", import.meta.url).pathname;
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const TOKEN = `ar_test_${"m".repeat(40)}`;
const MCP_TOKEN = `not-a-secret-${"runner-mcp-loopback-cli-bearer"}`;
const ADD = "mcp:fake/add";
const CALL = { content: 'Call mcp__fake__add with {"a":2,"b":3}' };

/** A port free now on this machine, for a server whose address the runs' MCP rule must know before it starts. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/** `args` of the CLI as its own process, with `env` beside this one's, until `ready` is printed; stopped at the test's end. */
async function started(t, args, env, ready) {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let err = "";
  child.stderr.on("data", (chunk) => void (err += chunk));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  };
  t.after(stop);
  await printed(child, ready);
  return { stop, stderr: () => err };
}

/** The store as the build before pins were made at save left it: revisions with no mcp_pin column (the server's next
 *  open adds it, empty, store/sqlite/store.ts) and each run's pin in mcp_pins (which that open drops). */
function asBeforePins(data) {
  const raw = new DatabaseSync(join(data, "store.sqlite"), { timeout: 10_000 });
  try {
    raw.exec("ALTER TABLE revisions DROP COLUMN mcp_pin");
    raw.exec("CREATE TABLE IF NOT EXISTS mcp_pins (run_id TEXT PRIMARY KEY, mcp_pin TEXT NOT NULL, created_at INTEGER NOT NULL)");
  } finally {
    raw.close();
  }
}

/** The run's last state and final answer, once it ends. */
async function ended(api, runId) {
  const { last } = await follow(api, runId, ["completed", "failed", "cancelled"], { deadlineMs: 90_000 });
  const read = (await api("GET", `/runs/${runId}`)).body;
  return { status: last.status, answer: read.result?.final_answer, read };
}

test("a --no-runner server and two standalone runners, all with AGENTRUN_MCP_ALLOW_LOOPBACK=1, on a store upgraded from before pins: an earlier revision pins at its first run, a new save pins at once, and both runs reach the MCP server on loopback", { timeout: 240_000 }, async (t) => {
  const data = join(await scratch(t), "data");
  const fake = await startFakeMcp({ token: MCP_TOKEN });
  t.after(() => fake.close());
  assert.equal(new URL(fake.url).hostname, "127.0.0.1", "the MCP server is on loopback");
  const port = await freePort();
  const base = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TOKEN: TOKEN, AGENTRUN_MCP_ALLOW_LOOPBACK: "1" };
  const serverArgs = ["--data", data, "--listen", "0.0.0.0", "--port", String(port), "--faux", FAUX_MCP, "--no-runner"];
  const serverEnv = { ...base, AGENTRUN_PUBLIC_URL: "https://agents.example.test" };
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  const calls = () => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length;

  // The earlier build's data: the MCP server and an agent granting its tool, saved, then the store as that build left it.
  const before = await started(t, serverArgs, serverEnv, /^agentrun-serve on /m);
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: MCP_TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await api("POST", "/agents", agent("earlier", { tools: [ADD], approvals: "never" }))).status, 201);
  await before.stop();
  asBeforePins(data);

  // The upgrade: the server again, then two runners in their own processes on its data directory.
  await started(t, serverArgs, serverEnv, /^agentrun-serve on /m);
  assert.equal((await api("GET", "/agents/earlier")).body.mcp_pin, null, "the earlier revision has no pin after the upgrade");
  const runners = [];
  for (const name of ["r1", "r2"]) runners.push(await started(t, ["runner", "--data", data, "--name", name, "--faux", FAUX_MCP], base, /^Runner \S+ ready: /m));

  const first = await api("POST", "/agents/earlier/runs", { input: CALL });
  assert.equal(first.status, 202, `the earlier revision starts: ${JSON.stringify(first.body)}`);
  const earlier = await ended(api, first.body.run_id);
  assert.equal(earlier.answer, "The tool said: 5", `the earlier revision's run reached the loopback MCP server: ${JSON.stringify(earlier.read)}`);
  assert.deepEqual((await api("GET", "/agents/earlier")).body.mcp_pin?.fake?.tools?.map((tool) => tool.name), ["add"], "its first run pinned it");

  const made = await api("POST", "/agents", agent("fresh", { tools: [ADD], approvals: "never" }));
  assert.equal(made.status, 201, `a new save pins the loopback server's tools: ${JSON.stringify(made.body)}`);
  const second = await api("POST", "/agents/fresh/runs", { input: CALL });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  const fresh = await ended(api, second.body.run_id);
  assert.equal(fresh.answer, "The tool said: 5", `the new revision's run reached it: ${JSON.stringify(fresh.read)}`);
  assert.equal(calls(), 2, "each run's call sent once");
  assert.ok(runners.some((runner) => runner.stderr().includes("shares the local-install server's loopback")), "a runner said it takes the opt-in");
});

test("a server started without AGENTRUN_MCP_ALLOW_LOOPBACK=1 refuses an upgraded revision's run on a loopback MCP server in words that name the variable, not by asking for a save it would refuse too", { timeout: 120_000 }, async (t) => {
  const data = join(await scratch(t), "data");
  const fake = await startFakeMcp({ token: MCP_TOKEN });
  t.after(() => fake.close());
  const port = await freePort();
  const base = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), AGENTRUN_TOKEN: TOKEN };
  const serverArgs = ["--data", data, "--port", String(port), "--faux", FAUX_MCP, "--no-runner"];
  const api = client(`http://127.0.0.1:${port}/v2`, TOKEN);
  const before = await started(t, serverArgs, { ...base, AGENTRUN_MCP_ALLOW_LOOPBACK: "1" }, /^agentrun-serve on /m);
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: MCP_TOKEN } })).status, 200);
  assert.equal((await api("POST", "/agents", agent("earlier", { tools: [ADD], approvals: "never" }))).status, 201);
  await before.stop();
  asBeforePins(data);

  await started(t, serverArgs, base, /^agentrun-serve on /m);
  const refused = await api("POST", "/agents/earlier/runs", { input: CALL });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error.message, /The MCP tool mcp:fake\/add was not pinned when this revision was saved: its server fake can't be listed here to pin it: 127\.0\.0\.1 is this machine; set AGENTRUN_MCP_ALLOW_LOOPBACK=1 when starting the server/);
  const resaved = await api("POST", "/agents", agent("again", { tools: [ADD], approvals: "never" }));
  assert.equal(resaved.status, 422, "a save is refused the same way");
  assert.match(JSON.stringify(resaved.body), /set AGENTRUN_MCP_ALLOW_LOOPBACK=1/);
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call").length, 0, "nothing called");
});
