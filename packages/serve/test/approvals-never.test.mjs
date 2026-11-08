// An agent's `approvals` (definition.approvals): "ask", the default, is today's gate; "never" runs it unattended. Under
// never, a tool that would ask is allowed, decided at the gate at each call, so a tool added later and an MCP tool are
// covered, on every harness. A deny (the server's or the agent's own) still refuses: never turns ask into allow as the
// gate's last step, after every refusal. A wrong value is a 422. The agent read serves it, its tools say where an allow
// came from ("unattended"), and the run read serves the run's own, as it started. A workflow's call node on a tool set
// to ask runs under never; under ask its run is refused, as before. A template apply's overrides set it. No socket
// leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { deniedText, permissionFrom, RunGate } from "../dist/tool-gate.js";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), harnessTable: fauxTable(fixture("faux-gate.mjs")), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };
const PAGE = "http://public.example/";
const HARNESSES = ["pi", "claude-agent", "codex"];
const FAUX_MCP = fixture("faux-mcp.mjs");
const MCP_TOKEN = `not-a-secret-${"approvals-never-bearer"}`;

/** A scratch file the fake network appends each URL it dials to, for test `t`, and a reader of it. */
async function network(t) {
  const file = join(await scratch(t), "dialled.txt");
  withEnv(t, { FAUX_WEB_LOG: file });
  return async () => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

/** Agent `id` on `harness` that fetches PAGE once with web_fetch (`extra` beside it), and one run of it. */
async function fetching(api, id, harness, extra = {}) {
  const ask = `Fetch ${PAGE} once.`;
  const made = await api("POST", "/agents", agent(id, { harness, instructions: ask, tools: ["web_fetch"], ...extra }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: ask } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

test("permissionFrom: never turns an ask into an allow from unattended, as its last step; a deny, a set allow and ask stay as they were", () => {
  const ask = { web_fetch: { permission: "ask" } };
  assert.deepEqual(permissionFrom("web_fetch", ask, {}, "never"), { permission: "allow", from: "unattended" });
  assert.deepEqual(permissionFrom("web_fetch", ask, {}, "ask"), { permission: "ask", from: "server" });
  assert.deepEqual(permissionFrom("web_fetch", ask, {}), { permission: "ask", from: "server" }, "none given is ask");
  assert.deepEqual(permissionFrom("web_fetch", { web_fetch: { permission: "deny" } }, {}, "never"), { permission: "deny", from: "server" });
  assert.deepEqual(permissionFrom("web_fetch", ask, { web_fetch: { permission: "deny" } }, "never"), { permission: "deny", from: "agent" });
  assert.deepEqual(permissionFrom("web_fetch", { web_fetch: { permission: "allow" } }, {}, "never"), { permission: "allow", from: "server" }, "a set allow keeps its own source");
  // An MCP tool asks by default: never allows it; a server's wildcard deny still refuses it.
  assert.deepEqual(permissionFrom("mcp:fake/add", {}, {}, "never"), { permission: "allow", from: "unattended" });
  assert.deepEqual(permissionFrom("mcp:fake/add", { "mcp:fake/*": { permission: "deny" } }, {}, "never"), { permission: "deny", from: "server" });
  // A shell watcher is held to bash's setting: under never, bash's ask is an allow, and so is the watcher's.
  assert.equal(permissionFrom("bash_background", { bash: { permission: "ask" } }, {}, "never").permission, "allow");
  assert.equal(permissionFrom("bash_background", { bash: { permission: "deny" } }, {}, "never").permission, "deny");
});

test("RunGate under never: an ask is allowed, a deny refuses, and a name nothing maps still asks (fail closed)", async (t) => {
  const dir = await scratch(t);
  writeFileSync(join(dir, "tool-settings.json"), JSON.stringify({ web_fetch: { permission: "ask" }, read: { permission: "deny" } }));
  const where = { root: join(dir, "runs", "r"), work: join(dir, "work"), data: dir, runId: "r", harness: "pi" };
  const never = new RunGate(where, {}, true, true, "never");
  const asked = new RunGate(where, {}, true, true, "ask");
  assert.equal(asked.policy("web_fetch"), "ask");
  assert.equal(never.policy("web_fetch"), "allow", "an ask under ask is an allow under never");
  assert.equal(never.policy("read"), "deny", "a server deny is never lifted");
  assert.equal(never.policy("no_such_tool_anyone_maps"), "ask", "a name nothing maps fails closed, never lifted");
});

test("under never, web_fetch set to ask runs without parking on pi, claude-agent and codex; the agent and run reads say never; its tools say unattended; ask (the default) still parks", { timeout: 150_000 }, async (t) => {
  const dialled = await network(t);
  const { api } = await serve(t, GATE);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const runs = await Promise.all(HARNESSES.map(async (harness) => ({ harness, runId: await fetching(api, `never-${harness}`, harness, { approvals: "never" }) })));
  for (const { harness, runId } of runs) {
    const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
    const view = (await api("GET", `/runs/${runId}`)).body;
    assert.equal(view.pending, null, `${harness}: nothing pending`);
    assert.equal(view.approvals, "never", `${harness}: the run read says never`);
    assert.deepEqual(rows.filter((row) => row.kind === "tool_approval_requested"), [], `${harness}: no approval row`);
    const read = (await api("GET", `/agents/never-${harness}`)).body;
    assert.equal(read.definition.approvals, "never", `${harness}: the agent read says never`);
    const fetchTool = read.tools.find((tool) => tool.name === "web_fetch");
    assert.deepEqual([fetchTool.permission, fetchTool.permission_from], ["allow", "unattended"], `${harness}: its tool says where the allow came from`);
  }
  assert.equal((await dialled()).filter((url) => url.startsWith(PAGE)).length, HARNESSES.length, "each harness fetched once, unasked");

  // The default: none set reads ask, and the call parks as before.
  const askRun = await fetching(api, "ask-pi", "pi");
  await follow(api, askRun, ["input_required"], { deadlineMs: 60_000 });
  const askView = (await api("GET", `/runs/${askRun}`)).body;
  assert.equal(askView.pending?.kind, "approval", "ask parks");
  assert.equal(askView.approvals, "ask");
  assert.equal((await api("GET", "/agents/ask-pi")).body.definition.approvals, "ask", "none set reads ask");
});

test("under never a deny still refuses: the server's, and the agent's own", { timeout: 120_000 }, async (t) => {
  const dialled = await network(t);
  const { api } = await serve(t, GATE);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "deny" } })).status, 200);
  const serverDenied = await fetching(api, "never-server-deny", "pi", { approvals: "never" });
  const own = await fetching(api, "never-own-deny", "pi", { approvals: "never", tool_settings: { web_fetch: { permission: "deny" } } });
  for (const [runId, from] of [[serverDenied, "server"], [own, "agent"]]) {
    const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
    const result = rows.find((row) => row.kind === "tool_result");
    assert.deepEqual([result?.tool_status, result?.tool_result_preview], ["failed", deniedText("web_fetch", undefined, from)], from);
  }
  assert.deepEqual(await dialled(), [], "a denied call never ran");
});

test("under never an MCP tool (which asks by default) runs unasked; a server's deny on it still refuses", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serve(t, { faux: FAUX_MCP, accounts: true, openSetup: true });
  const fake = await startFakeMcp({ token: MCP_TOKEN });
  t.after(() => fake.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: MCP_TOKEN } })).status, 200);
  const content = 'Call mcp__fake__add with {"a":2,"b":3}';
  const made = await api("POST", "/agents", agent("mcp-never", { tools: ["mcp:fake/add"], approvals: "never" }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", "/agents/mcp-never/runs", { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
  assert.equal(view.result?.final_answer, "The tool said: 5");
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length, 1, "sent once, unasked");

  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "deny" } })).status, 200);
  const denied = await api("POST", "/agents/mcp-never/runs", { input: { content } });
  assert.equal(denied.status, 202, JSON.stringify(denied.body));
  await follow(api, denied.body.run_id, ["completed"], { deadlineMs: 60_000 });
  assert.equal(fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === "add").length, 1, "the denied call was never sent");
});

test("a workflow's call node on a tool set to ask runs under never, and its run is refused under ask, as before", { timeout: 120_000 }, async (t) => {
  await network(t);
  const { api } = await serve(t, GATE);
  const flow = {
    v: 2, name: "read-site",
    schemas: {
      In: { type: "object", required: ["website"], properties: { website: { type: "string" } } },
      Page: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Page", path: "home" },
    root: { node: "chain", steps: [{ node: "call", label: "Read the home page", via: "tool", tool: "web_fetch", args: { url: "{website}" }, out: "Page", as: "home", deadline_s: 60 }] },
  };
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  assert.equal((await api("POST", "/agents", { definition: { id: "site-ask", name: "site-ask", workflow: flow, tools: ["web_fetch"] } })).status, 201);
  const refused = await api("POST", "/agents/site-ask/runs", { input: { website: PAGE } });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.asks], [409, "agent_not_runnable", ["web_fetch"]]);
  const saved = await api("POST", "/agents", { definition: { id: "site-never", name: "site-never", workflow: flow, tools: ["web_fetch"], approvals: "never" } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings ?? [], [], "no call-node warning under never");
  const ran = await api("POST", "/agents/site-never/runs", { input: { website: PAGE } });
  assert.equal(ran.status, 202, JSON.stringify(ran.body));
  await follow(api, ran.body.run_id, ["completed"], { deadlineMs: 30_000 });
});

test("approvals takes ask or never: anything else is a 422 naming the field", async (t) => {
  const { api } = await serve(t);
  const bad = await api("POST", "/agents", agent("bad-approvals", { approvals: "sometimes" }));
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  const field = bad.body.error.fields.find((f) => f.field === "definition.approvals");
  assert.equal(field?.reason, "not_an_option", JSON.stringify(bad.body.error.fields));
  assert.match(field.message, /ask.*never/);
});

test("an apply's overrides.approvals sets the agent's approvals; none given asks; a wrong value is a 422", async (t) => {
  const { api } = await serve(t);
  const applied = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" }, overrides: { approvals: "never" } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.equal((await api("GET", `/agents/${applied.body.agent_id}`)).body.definition.approvals, "never");
  const plain = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" } });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal((await api("GET", `/agents/${plain.body.agent_id}`)).body.definition.approvals, "ask", "none given: the agent asks");
  const wrong = await api("POST", "/templates/code-review/apply", { parameters: { repo: "Parcha-ai/agentrun" }, overrides: { approvals: "sometimes" } });
  assert.equal(wrong.status, 422, JSON.stringify(wrong.body));
  assert.equal(wrong.body.error.fields.find((f) => f.field === "overrides.approvals")?.reason, "not_an_option", JSON.stringify(wrong.body.error.fields));
});
