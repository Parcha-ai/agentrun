// The tool gate (tool-gate.ts), park mode: every tool call on pi (the faux model), claude-agent and codex (the faux
// harness) passes it. web_fetch set to ask parks each run as input_required, its `pending` (kind approval) and a
// tool_approval_requested row naming the call; an allow given more than a minute later runs the call once and resumes
// the session with one message that names the call and carries its result; a deny with a note resumes it with the
// refusal; a second, conflicting answer is 409. Only the owner's password session answers: a token is 403. An ask
// answered after the server restarted while the run was parked still runs the call once. A deny refuses a call at once;
// a workflow's call node calling a denied tool refuses its run. capabilities.tools and GET /v2/agents/{id}.tools show
// each tool's permission, its default and where it came from; a catalog tool (monid.*, mcp:<server>/<tool>) asks by
// default; an MCP server's wildcard key mcp:<server>/* is kept and applied. The reflect carve-out holds under ask,
// never under deny. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { REPLAY } from "../dist/host-tools.js";
import { deniedText, gateToolCall, RunGate, TURN_ORIGIN_FILE, waitingText } from "../dist/tool-gate.js";
import { permissionsOf, resolveCapability, settingsIssues } from "../dist/tool-plane.js";
import { TOOLS } from "../dist/tools.js";
import { schemaProblems } from "./schema-support.mjs";
import { KEY as MONID_KEY } from "./fixtures/faux-monid.mjs";
import { agent, call, cookieOf, follow, scratch, serve, withEnv } from "./support.mjs";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const GATE = { faux: fixture("faux-gate.mjs"), fauxHarness: fixture("faux-gate.mjs"), fauxWeb: fixture("faux-gate-web.mjs"), accounts: true, openSetup: true };
const PAGE = "http://public.example/";
const HARNESSES = ["pi", "claude-agent", "codex"];
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const quoted = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isCatalog = (name) => name.startsWith("monid.") || name.startsWith("mcp:");

/** A scratch file the fake network appends each URL it dials to, for test `t`, and a reader of it. */
async function network(t) {
  const file = join(await scratch(t), "dialled.txt");
  withEnv(t, { FAUX_WEB_LOG: file });
  return async () => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

/** The owner's password session on `server`: an answer to approval `approvalId` of run `runId`, as the console sends it. */
async function owner(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  return async (runId, approvalId, body) => {
    const res = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body });
    let parsed = null;
    try { parsed = JSON.parse(res.text); } catch {}
    return { status: res.status, body: parsed };
  };
}

/** Agent `id` on `harness` that fetches `url` once with web_fetch, and one run of it. */
async function fetching(api, id, harness, url = PAGE, extra = {}) {
  const ask = `Fetch ${url} once.`;
  const made = await api("POST", "/agents", agent(id, { harness, instructions: ask, tools: ["web_fetch"], ...extra }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: ask } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
}

/** Run `runId` parked for an approval: its view and its rows, and the call's result row. */
async function parked(api, runId) {
  const { rows } = await follow(api, runId, ["input_required"], { deadlineMs: 55_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === "web_fetch");
  return { view, rows, result };
}

/** The one message that resumed run `runId` once it completed, its final answer and its rows. */
async function resumed(api, runId) {
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  return { message: rows.filter((row) => row.kind === "user_message").at(-1)?.text, answer: view.result?.final_answer, view, rows };
}

test("the gate's settings: ask offered where the kernel runs the approved call itself and for catalog tools; the owner's defaults; settings it takes, an MCP server's wildcard among them; web_search under ask and deny", () => {
  for (const name of Object.keys(REPLAY)) assert.ok(permissionsOf(name).includes("ask"), `${name}: the kernel runs its approved call`);
  for (const name of ["browser", "ask_person", "pdf_pages", "llm"]) assert.deepEqual([...permissionsOf(name)], ["allow", "deny"], name);
  for (const name of ["monid.run", "mcp:srv/echo"]) assert.deepEqual([...permissionsOf(name)], ["allow", "ask", "deny"], name);
  for (const name of Object.keys(TOOLS).filter((name) => !isCatalog(name))) assert.ok(!isCatalog(name), name);
  assert.deepEqual(settingsIssues({ web_fetch: { provider: "parallel", permission: "ask" }, read: { permission: "deny" }, "monid.run": { permission: "allow" }, "mcp:srv/*": { permission: "deny" }, "mcp:srv/echo": { permission: "allow" } }), []);
  assert.deepEqual(settingsIssues({ web_fetch: { permission: "maybe" }, browser: { permission: "ask" }, read: { provider: "native" }, nothing: { permission: "deny" }, "mcp:srv": { permission: "deny" } }).map((i) => [i.field, i.reason]), [
    ["web_fetch.permission", "not_an_option"], ["browser.permission", "not_an_option"], ["read.provider", "not_allowed"], ["nothing", "not_allowed"], ["mcp:srv", "not_allowed"],
  ]);
  const base = { gateway: false, parallelKey: false };
  for (const harness of HARNESSES) assert.equal(resolveCapability("web_search", { ...base, harness, model: "anthropic/claude-sonnet-5-5", permission: "deny" }), "unavailable: denied", harness);
  assert.equal(resolveCapability("web_search", { ...base, harness: "codex", permission: "ask" }), "exa-keyless", "a CLI's own search cannot wait for a person");
  assert.equal(resolveCapability("web_search", { ...base, harness: "codex", permission: "ask", pick: "native" }), "unavailable: native search cannot wait for an approval", "native only stays native only");
  assert.equal(resolveCapability("web_search", { ...base, harness: "codex", permission: "ask", pick: "parallel", parallelKey: true }), "parallel");
  assert.equal(resolveCapability("web_search", { ...base, harness: "pi", model: "anthropic/claude-sonnet-5-5", permission: "ask" }), "native", "pi's native search is a tool of the run's, which the gate holds");
});

test("the reflect carve-out: under ask, a reflect turn's write or edit inside work/.learning/ runs, resolved as pi's file tools resolve it with no link followed; never under deny, never for a person's turn; a run's gate reads the settings at each call, parks one call at a time, and a workflow's model node cannot park", async (t) => {
  const work = await scratch(t);
  await mkdir(join(work, ".learning", "sub"), { recursive: true });
  await mkdir(join(work, "elsewhere"));
  await symlink(join(work, "elsewhere"), join(work, ".learning", "link"));
  const verdict = (tool, path, turnOrigin, permission = "ask", at = work) => gateToolCall({ tool, args: { path } }, { ...(turnOrigin ? { turnOrigin } : {}), work: at, policy: () => permission });
  assert.equal(verdict("write", ".learning/notes.md", "reflect"), "allow");
  assert.equal(verdict("edit", ".learning/sub/notes.md", "reflect"), "allow");
  assert.equal(verdict("write", ".learning/new/deeper/notes.md", "reflect"), "allow", "a path not made yet");
  assert.equal(verdict("write", join(work, ".learning", "notes.md"), "reflect"), "allow", "absolute, inside");
  for (const path of ["notes.md", ".learning", ".learning/../notes.md", ".learning-other/notes.md", ".learning/link/notes.md", "/etc/passwd", 7]) assert.equal(verdict("write", path, "reflect"), "ask", String(path));
  assert.equal(verdict("write", ".learning/notes.md"), "ask", "a person's turn asks");
  assert.equal(verdict("read", ".learning/notes.md", "reflect"), "ask", "writes and edits only");
  assert.equal(verdict("write", ".learning/notes.md", "reflect", "deny"), "deny", "no carve-out under deny");

  const [root, data] = [await scratch(t), await scratch(t)];
  const gate = new RunGate({ root, work, data, runId: "r1" }, { web_fetch: { permission: "deny" } });
  const written = [];
  const park = { commit: async (change) => change({ appendEntry: async (_conversation, entry) => written.push(entry) }), parked: (id) => written.push({ parked: id }) };
  assert.equal(gate.policy("write"), "allow");
  await writeFile(join(data, "tool-settings.json"), JSON.stringify({ write: { permission: "ask" }, web_fetch: { permission: "allow" }, "mcp:srv/*": { permission: "deny" } }));
  assert.equal(gate.policy("write"), "ask", "the server's setting, read again");
  assert.equal(gate.policy("web_fetch"), "deny", "the revision's own over it");
  assert.equal(gate.policy("mcp:srv/echo"), "deny", "an MCP server's wildcard");
  assert.equal(gate.policy("mcp:other/echo"), "ask", "another server's tool: the default");
  assert.deepEqual(await gate.enter("web_fetch", { url: PAGE }, "c1", park), { text: deniedText("web_fetch"), isError: true });
  await writeFile(join(root, TURN_ORIGIN_FILE), JSON.stringify({ origin: "reflect" }));
  assert.equal(await gate.enter("write", { path: ".learning/notes.md", content: "x" }, "c2", park), undefined, "a reflect write in work/.learning/ runs");
  assert.deepEqual(written, []);
  const parkedWrite = await gate.enter("write", { path: "notes.md", content: "x" }, "c3", park);
  assert.deepEqual(parkedWrite, { text: waitingText("write"), isError: false, parked: true }, "outside it, the reflect turn asks");
  assert.deepEqual([written[0].kind, written[0].data.phase, written[0].data.tool, written[0].data.call_id, written[0].data.args_preview, written[1]], ["agentrun.tool_approval", "requested", "write", "c3", '{"path":"notes.md","content":"x"}', { parked: "c3" }]);
  assert.deepEqual(await gate.enter("write", { path: "notes.md", content: "x" }, "c3", park), parkedWrite, "the same call again parks as the same request");
  assert.equal(written.filter((entry) => entry.kind).length, 1, "written once");
  assert.match((await gate.enter("write", { path: "b.md" }, "c4", park)).text, /^This write call was not run: the write call c3 already waits for a person's approval\./, "one call waits at a time");
  const node = new RunGate({ root, work, data, runId: "r2" }, {}, false);
  assert.deepEqual(await node.enter("write", { path: "notes.md" }, "c5", park), { text: "This write call needs a person's approval, which a workflow's model node cannot wait for; it was not run.", isError: true });
});

test("capabilities and an agent's tools show each tool's permission, its default and where it came from; a catalog tool asks by default; an MCP server's wildcard is kept; settings refuse a permission not offered", async (t) => {
  withEnv(t, { AGENT_MODEL: "anthropic/claude-sonnet-5-5" }, ["PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL"]);
  const { api } = await serve(t);
  const doc = (await api("GET", "/openapi.json")).body;
  const caps = (await api("GET", "/capabilities")).body;
  assert.equal(caps.features.tool_permissions, true);
  const byName = (tools) => Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const view = byName(caps.tools);
  for (const name of Object.keys(TOOLS)) {
    assert.deepEqual([view[name].permission, view[name].default_permission, view[name].permissions], [isCatalog(name) ? "ask" : "allow", isCatalog(name) ? "ask" : "allow", [...permissionsOf(name)]], name);
  }
  const put = await api("PUT", "/settings/tools", { "monid.run": { permission: "allow" }, web_fetch: { permission: "ask" }, read: { permission: "deny" }, "mcp:srv/*": { permission: "deny" }, "mcp:srv/echo": { permission: "allow" } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual([put.body["monid.run"], put.body.web_fetch.permission, put.body.read, put.body["mcp:srv/*"], put.body["mcp:srv/echo"]], [{ permission: "allow" }, "ask", { permission: "deny" }, { permission: "deny" }, { permission: "allow" }]);
  const after = byName((await api("GET", "/capabilities")).body.tools);
  assert.deepEqual([after["monid.run"].permission, after["monid.run"].default_permission, after.web_fetch.permission, after.web_fetch.default_permission, after.read.permission], ["allow", "ask", "ask", "allow", "deny"]);
  assert.deepEqual(after.web_search.resolves, { pi: "native", "claude-agent": "exa-keyless", codex: after.web_search.resolves.codex }, "web_search allowed: as before");

  const made = await api("POST", "/agents", agent("set", { tools: ["read", "web_fetch"], tool_settings: { read: { permission: "allow" }, web_fetch: { permission: "deny" }, "mcp:srv/*": { permission: "ask" } } }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const own = byName((await api("GET", "/agents/set")).body.tools);
  assert.deepEqual([own.read.permission, own.read.permission_from, own.read.default_permission], ["allow", "agent", "deny"], "the agent's own over the server's, which is its default");
  assert.deepEqual([own.web_fetch.permission, own.web_fetch.permission_from, own.web_fetch.default_permission], ["deny", "agent", "ask"]);
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Capabilities, (await api("GET", "/capabilities")).body), [], "capabilities as documented");

  for (const [body, fields] of [
    [{ web_fetch: { permission: "maybe" } }, [["web_fetch.permission", "not_an_option"]]],
    [{ browser: { permission: "ask" } }, [["browser.permission", "not_an_option"]]],
    [{ nothing: { permission: "deny" } }, [["nothing", "not_allowed"]]],
  ]) {
    const refused = await api("PUT", "/settings/tools", body);
    assert.deepEqual([refused.status, refused.body.error.fields.map((f) => [f.field, f.reason])], [422, fields], JSON.stringify(body));
  }
  assert.equal((await api("PUT", "/settings/tools", { web_search: { permission: "deny" } })).status, 200);
  assert.deepEqual(byName((await api("GET", "/capabilities")).body.tools).web_search.resolves, { pi: "unavailable: denied", "claude-agent": "unavailable: denied", codex: "unavailable: denied" }, "no provider is asked");
});

test("web_fetch set to ask on pi, claude-agent and codex at once: each run parks with its pending approval; answered more than a minute later by the owner's session, allow runs the call once and resumes with one message naming it, deny with a note resumes with the refusal; a token is 403; a second, conflicting answer is 409", { timeout: 240_000 }, async (t) => {
  const dialled = await network(t);
  const server = await serve(t, GATE);
  const { api } = server;
  const answer = await owner(server);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const doc = (await api("GET", "/openapi.json")).body;
  const runs = await Promise.all(HARNESSES.flatMap((harness) => ["allow", "deny"].map(async (decision) => ({ harness, decision, runId: await fetching(api, `${decision}-${harness}`, harness) }))));
  for (const run of runs) {
    const { view, rows, result } = await parked(api, run.runId);
    const at = `${run.decision} on ${run.harness}`;
    assert.deepEqual([view.status, view.state, view.pending?.kind, view.pending?.tool], ["input_required", "waiting", "approval", "web_fetch"], at);
    assert.match(view.pending.id, /^ap_[0-9a-f]{16}$/);
    assert.deepEqual(JSON.parse(view.pending.args_preview), { url: PAGE });
    assert.ok(Date.parse(view.pending.requested_at) > 0);
    assert.deepEqual(schemaProblems(doc, doc.components.schemas.Run.properties.pending, view.pending), [], at);
    assert.equal(result.tool_result_preview, waitingText("web_fetch"), `${at}: the call answered that it waits`);
    const row = rows.find((r) => r.kind === "tool_approval_requested");
    assert.deepEqual([row?.tool_name, row?.tool_use_id], ["web_fetch", result.tool_use_id], `${at}: its row`);
    Object.assign(run, { approval: view.pending.id, callId: result.tool_use_id });
  }
  assert.deepEqual(await dialled(), [], "nothing ran while they wait");
  // A real wait, past any CLI's own tool timeout: no CLI sits in a call meanwhile.
  await sleep(61_000);
  for (const run of runs) assert.equal((await api("GET", `/runs/${run.runId}`)).body.status, "input_required", `${run.harness} still parked`);

  const byToken = await api("POST", `/runs/${runs[0].runId}/approvals/${runs[0].approval}`, { decision: "allow" });
  assert.deepEqual([byToken.status, byToken.body.error.code], [403, "forbidden"], "a token never answers an approval: an agent's MCP client or a script may hold one");
  const note = "That host is off limits.";
  for (const run of runs) {
    const body = run.decision === "allow" ? { decision: "allow" } : { decision: "deny", note };
    assert.equal((await answer(run.runId, run.approval, body)).status, 204);
    assert.equal((await answer(run.runId, run.approval, body)).status, 204, "the same answer again");
    const other = await answer(run.runId, run.approval, { decision: run.decision === "allow" ? "deny" : "allow" });
    assert.deepEqual([other.status, other.body.error.code, other.body.error.details], [409, "not_continuable", { reason: "already_answered", decision: run.decision }]);
  }
  assert.equal((await answer(runs[0].runId, "ap_0000000000000000", { decision: "allow" })).status, 404);
  assert.equal((await answer(runs[0].runId, runs[0].approval, { decision: "maybe" })).status, 422);
  for (const run of runs) {
    const { message, answer: final, view, rows } = await resumed(api, run.runId);
    const at = `${run.decision} on ${run.harness}`;
    assert.match(message, new RegExp(`^\\[tool approval\\] This answers your web_fetch call ${quoted(run.callId)} \\(arguments \\{"url":"http://public\\.example/"\\}\\), which waited for a person's approval; it is not a new message from them\\.`), at);
    if (run.decision === "allow") assert.match(message, /They allowed it, and it ran\. Its result:\n\{"ok":true,"url":"http:\/\/public\.example\/","status":200/, at);
    else assert.match(message, /\nThe user denied this web_fetch call\. Reason: That host is off limits\.$/, at);
    assert.equal(rows.filter((r) => r.kind === "user_message").length, 2, `${at}: one message resumed it`);
    assert.equal(view.pending, null);
    assert.equal(final, run.harness === "pi" ? `Saw: ${message}` : "Fetched once.", `${at}: the model took it as the call's answer`);
  }
  assert.deepEqual(await dialled(), [PAGE, PAGE, PAGE], "each allowed call ran once, no denied one ran");
});

test("an ask answered after the server restarted while the run was parked still runs the call once, on pi and on codex; a cancel marks a call that waits canceled", { timeout: 180_000 }, async (t) => {
  const dialled = await network(t);
  const first = await serve(t, GATE);
  const answerFirst = await owner(first);
  assert.equal((await first.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const runs = await Promise.all(["pi", "codex", "claude-agent"].map(async (harness) => ({ harness, runId: await fetching(first.api, `again-${harness}`, harness) })));
  for (const run of runs) run.approval = (await parked(first.api, run.runId)).view.pending.id;
  const cancelled = runs.pop();
  assert.equal((await first.api("POST", `/runs/${cancelled.runId}/cancel`)).status, 202);
  await follow(first.api, cancelled.runId, ["cancelled"], { deadlineMs: 30_000 });
  const late = await answerFirst(cancelled.runId, cancelled.approval, { decision: "allow" });
  assert.deepEqual([late.status, late.body.error.details], [409, { reason: "already_answered", decision: "canceled" }]);
  assert.equal((await first.api("GET", `/runs/${cancelled.runId}`)).body.pending, null);

  await first.close();
  const again = await serve(t, { ...GATE, data: first.data, openSetup: false });
  const answerAgain = await ownerAgain(again);
  for (const run of runs) {
    const view = (await again.api("GET", `/runs/${run.runId}`)).body;
    assert.deepEqual([view.status, view.pending?.kind, view.pending?.id], ["input_required", "approval", run.approval], `${run.harness}: still parked after the restart`);
  }
  for (const run of runs) assert.equal((await answerAgain(run.runId, run.approval, { decision: "allow" })).status, 204);
  for (const run of runs) {
    const { message } = await resumed(again.api, run.runId);
    assert.match(message, /They allowed it, and it ran\. Its result:\n\{"ok":true/, run.harness);
  }
  assert.deepEqual(await dialled(), [PAGE, PAGE], "each ran once, the cancelled one never");
});

/** The owner's password session on a server that already has its owner (a restart): signed in with the same phrase. */
async function ownerAgain(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const login = await call(server.port, { method: "POST", path: "/v2/auth/sign-in", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.ok(login.status === 200 || login.status === 204, login.text);
  const cookie = cookieOf(login);
  return async (runId, approvalId, body) => {
    const res = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body });
    let parsed = null;
    try { parsed = JSON.parse(res.text); } catch {}
    return { status: res.status, body: parsed };
  };
}

test("a deny refuses the call at once and the run goes on, on every harness; a workflow's call node calling a denied tool refuses its run, and ask does not apply to the author's own step", { timeout: 120_000 }, async (t) => {
  const dialled = await network(t);
  const { api } = await serve(t, GATE);
  const denied = await Promise.all(HARNESSES.map(async (harness) => ({ harness, runId: await fetching(api, `denied-${harness}`, harness, PAGE, { tool_settings: { web_fetch: { permission: "deny" } } }) })));
  for (const { harness, runId } of denied) {
    const { answer, rows } = await resumed(api, runId);
    const result = rows.find((row) => row.kind === "tool_result");
    assert.deepEqual([result.tool_status, result.tool_result_preview], ["failed", deniedText("web_fetch")], harness);
    assert.equal(answer, harness === "pi" ? `Saw: ${deniedText("web_fetch")}` : "Fetched once.", `${harness}: the run went on`);
  }
  assert.deepEqual(await dialled(), [], "a denied call never ran");

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
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "deny" } })).status, 200);
  const saved = await api("POST", "/agents", { definition: { id: "site", name: "site", workflow: flow, tools: ["web_fetch"] } });
  assert.deepEqual([saved.status, saved.body.warnings?.map((w) => w.message)], [201, ["This workflow's call node calls web_fetch, which is set to deny on this server."]]);
  const refused = await api("POST", "/agents/site/runs", { input: { website: PAGE } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details.denied], [409, "agent_not_runnable", ["web_fetch"]]);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const started = await api("POST", "/agents/site/runs", { input: { website: PAGE } });
  assert.equal(started.status, 202, "ask does not apply to a call node: the author's own step runs");
  await follow(api, started.body.run_id, ["completed"], { deadlineMs: 30_000 });
});

const NO_APPROVER = (tool) => `Permission denied: ${tool} needs the owner's approval, and this server has accounts off (AGENTRUN_ACCOUNTS=0), so no one can give it: set the tool to allow or deny in the agent's Tools.`;

test("with accounts off no one can approve: an ask, a catalog tool's default or a setting, is refused with words saying so, never parked, and capabilities say an ask needs the password sign-in; with accounts on it parks", { timeout: 120_000 }, async (t) => {
  // The run's gate, told no one can approve here: a catalog tool at its default ask is refused, and nothing is recorded.
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  const written = [];
  const park = { commit: async (change) => change({ appendEntry: async (_conversation, entry) => written.push(entry) }), parked: (id) => written.push({ parked: id }) };
  const lone = new RunGate({ root, work, data, runId: "r1" }, {}, true, false);
  assert.deepEqual(await lone.enter("monid.run", { path: "/person/enrich" }, "c1", park), { text: NO_APPROVER("monid.run"), isError: true }, "a catalog tool's default ask");
  assert.deepEqual(written, [], "no request kept, no park");
  assert.equal((await new RunGate({ root, work, data, runId: "r2" }, {}, true, true).enter("monid.run", { path: "/person/enrich" }, "c2", park)).parked, true, "where someone can approve, it parks");

  // A server with accounts off: web_fetch set to ask is refused on every harness, and the run goes on.
  const dialled = await network(t);
  const off = await serve(t, { ...GATE, accounts: false, openSetup: false });
  assert.equal((await off.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const caps = (await off.api("GET", "/capabilities")).body;
  const doc = (await off.api("GET", "/openapi.json")).body;
  assert.deepEqual(Object.fromEntries(caps.tools.filter((tool) => ["web_fetch", "monid.run", "browser"].includes(tool.name)).map((tool) => [tool.name, tool.ask_needs])), { web_fetch: "password", "monid.run": "password", browser: undefined }, "every tool ask is offered for, none other");
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Capabilities, caps), [], "capabilities as documented");
  const runs = await Promise.all(HARNESSES.map(async (harness) => ({ harness, runId: await fetching(off.api, `lone-${harness}`, harness) })));
  for (const { harness, runId } of runs) {
    const { answer, rows, view } = await resumed(off.api, runId);
    const result = rows.find((row) => row.kind === "tool_result");
    assert.deepEqual([result.tool_status, result.tool_result_preview], ["failed", NO_APPROVER("web_fetch")], harness);
    assert.equal(rows.some((row) => row.kind === "tool_approval_requested"), false, `${harness}: no approval row`);
    assert.equal(view.pending, null, harness);
    assert.equal(answer, harness === "pi" ? `Saw: ${NO_APPROVER("web_fetch")}` : "Fetched once.", `${harness}: the run went on`);
  }
  assert.deepEqual(await dialled(), [], "nothing ran");

  // Accounts on: the same setting shows no ask_needs.
  const on = await serve(t, GATE);
  assert.equal((await on.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  assert.equal((await on.api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "web_fetch").ask_needs, undefined);
});

/** A held key, made at runtime (no credential-shaped literal), and whether `text` holds any 8 characters of it. */
const HELD = ["not-a-secret", "gate-held-key", randomBytes(6).toString("hex")].join("-");
const holdsPiece = (text, secret) => [...Array(Math.max(0, secret.length - 7)).keys()].some((i) => text.includes(secret.slice(i, i + 8)));

test("a parked call whose arguments hold a held key shows no 8 characters of it on its approval row or its pending approval, as the Timeline redacts a call's arguments", { timeout: 90_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: HELD });
  await network(t);
  const server = await serve(t, GATE);
  assert.equal((await server.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const runId = await fetching(server.api, "keyed", "pi", `${PAGE}?k=${HELD}`);
  const { view, rows } = await parked(server.api, runId);
  const row = rows.find((r) => r.kind === "tool_approval_requested");
  assert.ok(row && view.pending?.kind === "approval", "parked, with its row and its pending approval");
  assert.equal(holdsPiece(JSON.stringify(row), HELD), false, `the approval row: ${JSON.stringify(row)}`);
  assert.equal(holdsPiece(JSON.stringify(view.pending), HELD), false, `the pending approval: ${JSON.stringify(view.pending)}`);
  const summary = (await server.api("GET", "/runs")).body.runs.find((r) => r.run_id === runId);
  assert.equal(holdsPiece(JSON.stringify(summary.pending), HELD), false, "the run's summary in the list");
});

test("on pi, monid's calls at their default ask park by their settings keys, and each approved one runs once through the kernel", { timeout: 120_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: MONID_KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const server = await serve(t, { accounts: true, openSetup: true, fauxMonid: fixture("faux-monid.mjs") });
  const answer = await owner(server);
  const { api } = server;
  assert.equal((await api("POST", "/agents", agent("enrich-asks", { tools: ["monid.discover", "monid.inspect", "monid.run"] }))).status, 201);
  const started = await api("POST", "/agents/enrich-asks/runs", { input: { content: "Enrich with monid: Ada at Example." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  for (const tool of ["monid.discover", "monid.inspect", "monid.run"]) {
    await follow(api, runId, ["input_required"], { deadlineMs: 55_000 });
    const { pending } = (await api("GET", `/runs/${runId}`)).body;
    assert.equal(pending?.tool, tool, "parked by its settings key");
    assert.equal((await answer(runId, pending.id, { decision: "allow" })).status, 204);
    await follow(api, runId, ["working", "completed"], { deadlineMs: 55_000 });
  }
  await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
  assert.match((await api("GET", `/runs/${runId}`)).body.result.final_answer, /"full_name":"Ada"/);
  const seen = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(seen.map((call) => call.path), ["/v1/discover", "/v1/inspect", "/v1/run"], "each approved call once");
});
