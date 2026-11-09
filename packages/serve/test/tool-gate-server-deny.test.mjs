// A deny set on this server (its tool settings, PUT /v2/settings/tools) is absolute: under any key the tool is read by
// (its own, its MCP server's wildcard, bash's for a shell tool), it refuses the call "on this server", over any ask or
// allow in the agent's own tool settings, whatever the agent's approvals. With no server deny, the agent's own setting
// still comes first, as before. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deniedText, permissionFrom, RunGate } from "../dist/tool-gate.js";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), harnessTable: fauxTable(fixture("faux-gate.mjs")), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };
const PAGE = "http://public.example/";
const DENY = { permission: "deny" };

test("permissionFrom: a server deny wins over the agent's own ask or allow, under its own key, its MCP wildcard and bash's for a shell tool, with approvals ask or never", () => {
  const cases = [
    ["web_fetch", { web_fetch: DENY }, { web_fetch: { permission: "ask" } }],
    ["web_fetch", { web_fetch: DENY }, { web_fetch: { permission: "allow" } }],
    ["mcp:fake/add", { "mcp:fake/*": DENY }, { "mcp:fake/add": { permission: "allow" } }],
    ["mcp:fake/add", { "mcp:fake/add": DENY }, { "mcp:fake/*": { permission: "allow" } }],
    ["bash", { bash: DENY }, { bash: { permission: "allow" } }],
    ["bash_background", { bash: DENY }, { bash: { permission: "allow" } }],
  ];
  for (const [name, server, agentSettings] of cases)
    for (const approvals of ["ask", "never"])
      assert.deepEqual(permissionFrom(name, server, agentSettings, approvals), { permission: "deny", from: "server" }, `${name} ${JSON.stringify([server, agentSettings])} ${approvals}`);
});

test("permissionFrom with no server deny is as before: the agent's own deny names the agent, and its ask comes before the server's allow or none", () => {
  assert.deepEqual(permissionFrom("web_fetch", {}, { web_fetch: DENY }), { permission: "deny", from: "agent" });
  assert.deepEqual(permissionFrom("web_fetch", { web_fetch: { permission: "allow" } }, { web_fetch: { permission: "ask" } }), { permission: "ask", from: "agent" });
  assert.deepEqual(permissionFrom("web_fetch", {}, { web_fetch: { permission: "ask" } }), { permission: "ask", from: "agent" });
  assert.deepEqual(permissionFrom("web_fetch", { web_fetch: { permission: "ask" } }, { web_fetch: { permission: "allow" } }), { permission: "allow", from: "agent" });
  // The server's own exact allow under its own wildcard deny is the server's answer for that tool: no deny to hold.
  assert.deepEqual(permissionFrom("mcp:fake/add", { "mcp:fake/*": DENY, "mcp:fake/add": { permission: "allow" } }, { "mcp:fake/add": { permission: "ask" } }), { permission: "ask", from: "agent" });
  assert.deepEqual(permissionFrom("mcp:fake/other", { "mcp:fake/*": DENY, "mcp:fake/add": { permission: "allow" } }, { "mcp:fake/other": { permission: "allow" } }), { permission: "deny", from: "server" });
});

/** One call of `name` through a pi run's gate, with the server's `settings` file and the agent's own `overrides`. */
async function called(t, { settings = {}, overrides = {}, name, approvals = "ask" }) {
  const dirs = [];
  for (let i = 0; i < 3; i++) dirs.push(await mkdtemp(join(tmpdir(), "server-deny-")));
  t.after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
  const [root, work, data] = dirs;
  await writeFile(join(data, "tool-settings.json"), JSON.stringify(settings));
  const gate = new RunGate({ root, work, data, runId: "r1", harness: "pi" }, overrides, true, true, approvals);
  let ran = 0;
  const registration = { name, description: name, parameters: {}, execute: async () => (ran++, { output: [{ type: "text", text: "ran" }] }) };
  const wrapped = gate.extension([registration]).wraps.find((wrap) => wrap.tool === name)?.wrap(registration) ?? registration;
  const api = { callId: `c-${name}`, commit: async (change) => change({ appendEntry: async () => undefined }) };
  const result = await wrapped.execute({}, api, {});
  return { text: (result.output ?? []).map((block) => block.text ?? "").join(""), ran };
}

test("through a run's gate: the agent's own ask or allow on a tool the server denies is refused 'on this server' and never run, with approvals ask or never", async (t) => {
  for (const permission of ["ask", "allow"])
    for (const approvals of ["ask", "never"]) {
      const got = await called(t, { settings: { web_fetch: DENY }, overrides: { web_fetch: { permission } }, name: "web_fetch", approvals });
      assert.deepEqual([got.text, got.ran], [deniedText("web_fetch", undefined, "server"), 0], `agent ${permission}, approvals ${approvals}`);
    }
});

/** A scratch file the fake network appends each URL it dials to, for test `t`, and a reader of it. */
async function network(t) {
  const file = join(await scratch(t), "dialled.txt");
  withEnv(t, { FAUX_WEB_LOG: file });
  return async () => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

test("a pi run whose agent sets web_fetch to ask, on a server that denies it: the call is refused 'on this server', the run does not park, nothing is fetched, and the agent read says deny from the server", { timeout: 120_000 }, async (t) => {
  const dialled = await network(t);
  const { api } = await serve(t, GATE);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: DENY })).status, 200);
  for (const approvals of ["ask", "never"]) {
    const id = `server-deny-${approvals}`;
    const ask = `Fetch ${PAGE} once.`;
    const made = await api("POST", "/agents", agent(id, { harness: "pi", instructions: ask, tools: ["web_fetch"], approvals, tool_settings: { web_fetch: { permission: "ask" } } }));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const run = await api("POST", `/agents/${id}/runs`, { input: { content: ask } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const { rows } = await follow(api, run.body.run_id, ["completed"], { deadlineMs: 60_000 });
    const view = (await api("GET", `/runs/${run.body.run_id}`)).body;
    assert.equal(view.pending, null, `${approvals}: nothing pending, the run did not park`);
    const result = rows.find((row) => row.kind === "tool_result");
    assert.deepEqual([result?.tool_status, result?.tool_result_preview], ["failed", deniedText("web_fetch", undefined, "server")], `${approvals}: refused on this server`);
    const tool = (await api("GET", `/agents/${id}`)).body.tools.find((entry) => entry.name === "web_fetch");
    assert.deepEqual([tool?.permission, tool?.permission_from], ["deny", "server"], `${approvals}: the agent read says deny, from the server`);
  }
  assert.deepEqual(await dialled(), [], "nothing was fetched");
});
