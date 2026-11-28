// The switches only the operator sets, in the server's environment at its start (never the API's nor the console's):
// GET /v2/capabilities lists each in one place, `switches`, with whether it is on, the value the server read and what it
// allows, so a first setup reads them at once instead of meeting them one refusal at a time. Never a secret's value: each
// is a yes or no, a host list or a size.
import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, withEnv } from "./support.mjs";

const NAMES = ["AGENTRUN_MCP_ALLOW_LOOPBACK", "AGENTRUN_WEBHOOK_PRIVATE_TARGETS", "AGENTRUN_PRIVATE_HOSTS", "AGENTRUN_BOX_ALLOW", "AGENTRUN_BOX_CPUS", "AGENTRUN_BOX_MEMORY", "AGENTRUN_BOX_PIDS", "AGENTRUN_BOX_MAX_TUNNELS", "AGENTRUN_API_ONLY_MCP_ORIGINS", "AGENTRUN_API_ONLY_WORKSPACE_MCP_PUBLIC_HTTPS"];

/** Each switch's on and value, by name, in the order capabilities list them. */
const read = (switches) => Object.entries(switches).map(([name, { on, value }]) => [name, on, value]);

test("capabilities list the start-time switches: each off, with no value, on a server started with none of them", async (t) => {
  withEnv(t, {}, NAMES);
  // mcpLoopback: false, as the CLI starts a server whose operator did not set AGENTRUN_MCP_ALLOW_LOOPBACK=1.
  const { api } = await serve(t, { runner: false, mcpLoopback: false });
  const caps = await api("GET", "/capabilities");
  assert.equal(caps.status, 200);
  assert.deepEqual(read(caps.body.switches), NAMES.map((name) => [name, false, null]));
  for (const [name, entry] of Object.entries(caps.body.switches)) {
    assert.deepEqual(Object.keys(entry).sort(), ["allows", "on", "value"], name);
    assert.ok(typeof entry.allows === "string" && entry.allows.length > 0, `${name} says what it allows`);
  }
  assert.match(caps.body.switches.AGENTRUN_MCP_ALLOW_LOOPBACK.allows, /only on a machine you alone use/);
  assert.match(caps.body.switches.AGENTRUN_WEBHOOK_PRIVATE_TARGETS.allows, /only on a machine you alone use/);
});

test("capabilities list the start-time switches as the server was started: on, with the value it read", async (t) => {
  withEnv(t, { AGENTRUN_WEBHOOK_PRIVATE_TARGETS: "1", AGENTRUN_PRIVATE_HOSTS: "10.20.0.0/16", AGENTRUN_BOX_ALLOW: "PyPI.org, *.pythonhosted.org", AGENTRUN_BOX_MEMORY: "512m", AGENTRUN_BOX_MAX_TUNNELS: "128" }, NAMES);
  // The CLI turns mcpLoopback on from AGENTRUN_MCP_ALLOW_LOOPBACK=1 (cli.ts); the server reads its option.
  const { api } = await serve(t, { runner: false, mcpLoopback: true });
  const caps = await api("GET", "/capabilities");
  assert.equal(caps.status, 200);
  assert.deepEqual(read(caps.body.switches), [
    ["AGENTRUN_MCP_ALLOW_LOOPBACK", true, "1"],
    ["AGENTRUN_WEBHOOK_PRIVATE_TARGETS", true, "1"],
    ["AGENTRUN_PRIVATE_HOSTS", true, "10.20.0.0/16"],
    ["AGENTRUN_BOX_ALLOW", true, "pypi.org,*.pythonhosted.org"],
    ["AGENTRUN_BOX_CPUS", false, null],
    ["AGENTRUN_BOX_MEMORY", true, "512m"],
    ["AGENTRUN_BOX_PIDS", false, null],
    ["AGENTRUN_BOX_MAX_TUNNELS", true, "128"],
    // A full server holds no API-only list: off.
    ["AGENTRUN_API_ONLY_MCP_ORIGINS", false, null],
    ["AGENTRUN_API_ONLY_WORKSPACE_MCP_PUBLIC_HTTPS", false, null],
  ]);
  assert.match(caps.body.switches.AGENTRUN_API_ONLY_MCP_ORIGINS.allows, /per_run/);
  // The webhook does what the listing says: a receiver on this machine is taken.
  const saved = await api("PUT", "/settings/webhook", { url: "http://127.0.0.1:9/hook" }); // key-gate: denylist allowed by the switch under test
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
});

test("AGENTRUN_API_ONLY_MCP_ORIGINS on an API-only server: the token's capabilities say it is set and hold no origin it lists", async (t) => {
  withEnv(t, {}, NAMES);
  // The CLI reads the variable on an API-only start alone and hands the server its list (ServeOptions.apiOnlyMcpOrigins).
  const { api } = await serve(t, { runner: false, apiOnly: true, apiOnlyMcpOrigins: ["https://tools.example", "https://edge.example:8443"] });
  const caps = await api("GET", "/capabilities");
  assert.equal(caps.status, 200, JSON.stringify(caps.body));
  const listed = caps.body.switches.AGENTRUN_API_ONLY_MCP_ORIGINS;
  assert.ok(listed, `capabilities list AGENTRUN_API_ONLY_MCP_ORIGINS: ${Object.keys(caps.body.switches).join(", ")}`);
  assert.deepEqual([listed.on, listed.value], [true, null]);
  for (const origin of ["tools.example", "edge.example"]) assert.ok(!JSON.stringify(caps.body).includes(origin), `the answer names ${origin}`);
});

test("AGENTRUN_API_ONLY_WORKSPACE_MCP_PUBLIC_HTTPS on an API-only server is listed as on; on a full server the option is held off", async (t) => {
  withEnv(t, {}, NAMES);
  // The CLI reads the variable on an API-only start alone (ServeOptions.workspaceMcpPublicHttps).
  const apiOnly = await serve(t, { runner: false, apiOnly: true, workspaceMcpPublicHttps: true });
  const on = (await apiOnly.api("GET", "/capabilities")).body.switches.AGENTRUN_API_ONLY_WORKSPACE_MCP_PUBLIC_HTTPS;
  assert.deepEqual([on.on, on.value], [true, "1"]);
  assert.match(on.allows, /per_run/);
  const full = await serve(t, { runner: false, workspaceMcpPublicHttps: true });
  assert.equal((await full.api("GET", "/capabilities")).body.switches.AGENTRUN_API_ONLY_WORKSPACE_MCP_PUBLIC_HTTPS.on, false);
});

test("AGENTRUN_BOX_ALLOW=none is listed as on, its value none", async (t) => {
  withEnv(t, { AGENTRUN_BOX_ALLOW: "none" }, NAMES);
  const { api } = await serve(t, { runner: false });
  const { on, value } = (await api("GET", "/capabilities")).body.switches.AGENTRUN_BOX_ALLOW;
  assert.deepEqual([on, value], [true, "none"]);
});
