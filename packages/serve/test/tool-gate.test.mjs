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
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { REPLAY } from "../dist/host-tools.js";
import { runsTestHooks } from "../dist/runs.js";
import { BOX_WORK } from "../dist/place.js";
import { deniedText, RESUME_PREFIX, RunGate, TURN_ORIGIN_FILE, waitingText } from "../dist/tool-gate.js";
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

test("the end-of-run turn writes no file under work/.learning/: its write or edit there is refused, whatever the tool's permission and by this machine's path or the box's, in words that keep its notes to its answer; outside .learning/, on any other turn, a write follows its permission, and a read is untouched; a run's gate reads the settings at each call, parks one call at a time, and a workflow's model node cannot park", async (t) => {
  const work = await scratch(t);
  await mkdir(join(work, ".learning", "sub"), { recursive: true });
  const quiet = { commit: async (change) => change({ appendEntry: async () => undefined }), parked: () => undefined };
  const gateOf = async (permission, origin) => {
    const [at, settings] = [await scratch(t), await scratch(t)];
    if (origin) await writeFile(join(at, TURN_ORIGIN_FILE), JSON.stringify({ origin }));
    return new RunGate({ root: at, work, data: settings, runId: "rg" }, { write: { permission }, edit: { permission }, read: { permission } });
  };
  for (const permission of ["allow", "ask", "deny"]) {
    const reflecting = await gateOf(permission, "reflect");
    for (const [tool, path] of [["write", ".learning/notes.md"], ["edit", ".learning/sub/notes.md"], ["write", ".learning/new/deeper/x.md"], ["write", join(work, ".learning", "x.md")], ["write", `${BOX_WORK}/.learning/x.md`], ["write", "@.learning/x.md"]]) {
      assert.deepEqual(await reflecting.enter(tool, { path, content: "x" }, `c-${permission}-${tool}-${path}`, quiet), { text: NOTE_ONLY, isError: true }, `${permission}: ${tool} ${path}`);
    }
  }
  const allowed = await gateOf("allow", "reflect");
  for (const path of ["notes.md", ".learning-other/x.md", ".learning/../notes.md"]) assert.equal(await allowed.enter("write", { path, content: "x" }, `c-out-${path}`, quiet), undefined, `outside .learning/, its permission: ${path}`);
  assert.equal(await allowed.enter("read", { path: ".learning/notes.md" }, "c-read", quiet), undefined, "a read is untouched");
  assert.equal(await (await gateOf("allow")).enter("write", { path: ".learning/notes.md", content: "x" }, "c-person", quiet), undefined, "a person's turn: allowed, it runs");
  assert.equal((await (await gateOf("ask")).enter("write", { path: ".learning/notes.md", content: "x" }, "c-person-ask", quiet))?.parked, true, "a person's turn: under ask, it parks");

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
  assert.deepEqual(await gate.enter("write", { path: ".learning/notes.md", content: "x" }, "c2", park), { text: NOTE_ONLY, isError: true }, "a reflect write in work/.learning/ is refused");
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

test("two ask calls entered at once, as pi runs a turn's calls in parallel: exactly one parks, and the other is refused in the usual words", async (t) => {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  const gate = new RunGate({ root, work, data, runId: "r1" }, { write: { permission: "ask" } });
  const written = [];
  // A commit answers after its own await, as the run's store does.
  const park = { commit: async (change) => change({ appendEntry: async (_conversation, entry) => written.push(entry) }), parked: (id) => written.push({ parked: id }) };
  const [first, second] = await Promise.all([gate.enter("write", { path: "a.md" }, "c1", park), gate.enter("write", { path: "b.md" }, "c2", park)]);
  assert.deepEqual(first, { text: waitingText("write"), isError: false, parked: true }, "the first parks");
  assert.equal(second.parked, undefined, "the second does not");
  assert.match(second.text, /^This write call was not run: the write call c1 already waits for a person's approval\./);
  assert.deepEqual(written.filter((entry) => entry.kind).map((entry) => entry.data.call_id), ["c1"], "one request in the run's store");
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
  // Every harness the server has (main's opencode among them), each as before: pi's native, claude-agent's keyless Exa.
  assert.deepEqual(after.web_search.resolves, { ...after.web_search.resolves, pi: "native", "claude-agent": "exa-keyless" }, "web_search allowed: as before");

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
  const denied = byName((await api("GET", "/capabilities")).body.tools).web_search.resolves;
  assert.ok(["pi", "claude-agent", "codex"].every((harness) => harness in denied), "every harness is shown");
  assert.deepEqual(denied, Object.fromEntries(Object.keys(denied).map((harness) => [harness, "unavailable: denied"])), "no provider is asked, on any harness");
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

test("a codex run whose process dies between the approval's commit and the parked turn's settle reopens with that turn settled: it is never run again, and the approval's result reaches the model once", { timeout: 180_000 }, async (t) => {
  const dialled = await network(t);
  const exited = join(await scratch(t), "exited");
  withEnv(t, { AGENTRUN_SERVE_TEST_CRASH_AFTER_ANSWER: exited });
  const server = await serve(t, GATE);
  const answer = await owner(server);
  assert.equal((await server.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const seen = async (id) => {
    const runId = await fetching(server.api, id, "codex");
    // Its request's id from its row (the gate names a request by its call: ap_ and the call's digest): the crashed run's
    // parked turn holds its end, so that run never reads input_required with a pending approval.
    let row;
    for (let i = 0; !row; i++) {
      assert.ok(i < 600, "the call did not park");
      row = ((await server.api("GET", `/runs/${runId}/timeline`)).body.rows ?? []).find((r) => r.kind === "tool_approval_requested");
      if (!row) await sleep(100);
    }
    const approval = `ap_${createHash("sha256").update(JSON.stringify([row.tool_use_id, "web_fetch", { url: PAGE }])).digest("hex").slice(0, 16)}`;
    assert.equal((await answer(runId, approval, { decision: "allow" })).status, 204);
    const { rows } = await resumed(server.api, runId);
    const resume = rows.findIndex((row) => row.kind === "user_message" && row.text?.startsWith(RESUME_PREFIX));
    return {
      results: rows.filter((row) => row.kind === "tool_result" && row.tool_name === "web_fetch").length,
      resumes: rows.filter((row) => row.kind === "user_message" && row.text?.startsWith(RESUME_PREFIX)).length,
      answers: rows.filter((row) => row.text === "Fetched once.").length,
      // The parked turn says nothing more: the model answers once it has read the approval's result, never before.
      answeredBeforeResult: rows.findIndex((row) => row.text === "Fetched once.") < resume,
    };
  };
  // The first run's process goes by a signal after the answer's commit, before its parked turn's end (the seam marks it
  // once); the second's does not.
  const crashed = await seen("crashed");
  assert.ok(existsSync(exited), "the first run's process went after the answer's commit");
  const control = await seen("control");
  assert.deepEqual(crashed, control, "the reopened run reads as one that never crashed: no turn run again, one resume");
  assert.equal(crashed.resumes, 1, "the approval's result reaches the model once");
  assert.equal(crashed.answeredBeforeResult, false, "the old turn was not run again before the result");
  assert.deepEqual(await dialled(), [PAGE, PAGE], "each call ran once");
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

test("a deny refuses the call at once and the run goes on, on every harness; a workflow's call node calling a tool set to deny or ask refuses its run, and a catalog tool is no call node's tool", { timeout: 120_000 }, async (t) => {
  const dialled = await network(t);
  const { api } = await serve(t, GATE);
  const denied = await Promise.all(HARNESSES.map(async (harness) => ({ harness, runId: await fetching(api, `denied-${harness}`, harness, PAGE, { tool_settings: { web_fetch: { permission: "deny" } } }) })));
  for (const { harness, runId } of denied) {
    const { answer, rows } = await resumed(api, runId);
    const result = rows.find((row) => row.kind === "tool_result");
    // Denied in the agent's own tool settings: the words name the agent, not the server.
    assert.deepEqual([result.tool_status, result.tool_result_preview], ["failed", deniedText("web_fetch", undefined, "agent")], harness);
    assert.match(result.tool_result_preview, /is set to deny for this agent/, harness);
    assert.equal(answer, harness === "pi" ? `Saw: ${deniedText("web_fetch", undefined, "agent")}` : "Fetched once.", `${harness}: the run went on`);
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
  // The same deny set in the agent's own tool settings names the agent.
  assert.equal((await api("PUT", "/settings/tools", {})).status, 200);
  const own = await api("POST", "/agents", { definition: { id: "site-own", name: "site-own", workflow: flow, tools: ["web_fetch"], tool_settings: { web_fetch: { permission: "deny" } } } });
  assert.deepEqual([own.status, own.body.warnings?.map((w) => w.message)], [201, ["This workflow's call node calls web_fetch, which is set to deny for this agent."]]);
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "deny" } })).status, 200);
  const refused = await api("POST", "/agents/site/runs", { input: { website: PAGE } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details.denied], [409, "agent_not_runnable", ["web_fetch"]]);
  // Ask too: a call node cannot wait for an approval, so it never runs unapproved (fails closed).
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const asked = await api("POST", "/agents/site/runs", { input: { website: PAGE } });
  assert.deepEqual([asked.status, asked.body.error?.code, asked.body.error?.details?.asks], [409, "agent_not_runnable", ["web_fetch"]]);
  assert.match(asked.body.error.message, new RegExp(quoted(ASKS("web_fetch"))));
  // A catalog tool (default ask) is no call node's tool here: a workflow whose call node names one is refused at its save,
  // so none runs unapproved.
  const monidFlow = { ...flow, name: "monid-call", root: { node: "chain", steps: [{ node: "call", label: "Run monid", via: "tool", tool: "monid.run", args: { endpoint: "/x" }, out: "Page", as: "home", deadline_s: 60 }] } };
  const catalog = await api("POST", "/agents", { definition: { id: "monid-call", name: "monid-call", workflow: monidFlow, tools: ["monid.run"] } });
  assert.deepEqual([catalog.status, catalog.body.error?.code, catalog.body.error?.fields?.[0]?.reason], [422, "input_invalid", "not_an_option"], JSON.stringify(catalog.body));
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "allow" } })).status, 200);
  const allowed = await api("POST", "/agents/site/runs", { input: { website: PAGE } });
  assert.equal(allowed.status, 202, "allowed, the author's step runs");
  await follow(api, allowed.body.run_id, ["completed"], { deadlineMs: 30_000 });
});

/** The first web_fetch result of run `runId`, once it has one. */
async function firstFetch(api, runId) {
  for (let i = 0; ; i++) {
    const row = ((await api("GET", `/runs/${runId}/timeline`)).body.rows ?? []).find((r) => r.kind === "tool_result" && r.tool_name === "web_fetch" && r.tool_status !== null);
    if (row) return row;
    assert.ok(i < 600, "the run made no first call");
    await sleep(100);
  }
}

test("a deny lifted mid-run is lifted at the next call: a run launched with web_fetch denied runs its next call once the setting reads allow, and parks it once it reads ask, which an allow runs once", { timeout: 150_000 }, async (t) => {
  const dialled = await network(t);
  const server = await serve(t, GATE);
  const { api } = server;
  const answer = await owner(server);
  const go = await scratch(t);
  for (const [lifted, url] of [["allow", PAGE], ["ask", `${PAGE}notes.txt`]]) {
    assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "deny" } })).status, 200);
    const file = join(go, lifted);
    const ask = `Fetch ${url} again once ${file} exists.`;
    assert.equal((await api("POST", "/agents", agent(`lifted-${lifted}`, { harness: "pi", instructions: ask, tools: ["web_fetch"] }))).status, 201);
    const runId = (await api("POST", `/agents/lifted-${lifted}/runs`, { input: { content: ask } })).body.run_id;
    const first = await firstFetch(api, runId);
    assert.deepEqual([first.tool_status, first.tool_result_preview], ["failed", deniedText("web_fetch")], `${lifted}: launched denied`);
    assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: lifted } })).status, 200);
    await writeFile(file, "");
    if (lifted === "ask") {
      const { view } = await parked(api, runId);
      assert.deepEqual([view.pending?.kind, view.pending?.tool], ["approval", "web_fetch"], "ask: the next call parks");
      assert.equal((await answer(runId, view.pending.id, { decision: "allow" })).status, 204);
    }
    const { rows } = await resumed(api, runId);
    const results = rows.filter((row) => row.kind === "tool_result" && row.tool_name === "web_fetch");
    assert.ok(!results.slice(1).some((row) => row.tool_status === "failed"), `${lifted}: the next call ran, ${JSON.stringify(results.map((row) => [row.tool_status, row.tool_result_preview]))}`);
    assert.deepEqual((await dialled()).filter((dial) => dial === url), [url], `${lifted}: dialled once`);
  }
});

test("a workflow's call node calling fetch_page, web_fetch's legacy name, is held to web_fetch's permission: set to deny, its run is refused before it starts", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, GATE);
  const flow = {
    v: 2, name: "read-site-legacy",
    schemas: {
      In: { type: "object", required: ["website"], properties: { website: { type: "string" } } },
      Page: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    },
    input: { schemaId: "In" },
    output: { schemaId: "Page", path: "home" },
    root: { node: "chain", steps: [{ node: "call", label: "Read the home page", via: "tool", tool: "fetch_page", args: { url: "{website}" }, out: "Page", as: "home", deadline_s: 60 }] },
  };
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "deny" } })).status, 200);
  const saved = await api("POST", "/agents", { definition: { id: "legacy", name: "legacy", workflow: flow, tools: ["fetch_page"] } });
  assert.deepEqual([saved.status, saved.body.warnings?.map((w) => w.message)], [201, ["This workflow's call node calls fetch_page (web_fetch), which is set to deny on this server."]]);
  const refused = await api("POST", "/agents/legacy/runs", { input: { website: PAGE } });
  assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.details?.denied], [409, "agent_not_runnable", ["web_fetch"]]);
});

for (const switched of ["deny", "ask"]) test(`a workflow's call node reads its tool's permission as it runs: set to ${switched} while the first of two call nodes runs, the second is refused in the gate's words and never dials`, { timeout: 90_000 }, async (t) => {
  const dialled = await network(t);
  const hold = join(await scratch(t), "go");
  withEnv(t, { FAUX_WEB_HOLD: hold });
  const server = await serve(t, GATE);
  const { api } = server;
  const Page = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  const flow = {
    v: 2, name: "read-twice",
    schemas: { In: { type: "object", required: ["website"], properties: { website: { type: "string" } } }, Page },
    input: { schemaId: "In" },
    output: { schemaId: "Page", path: "second" },
    root: { node: "chain", steps: [
      { node: "call", label: "First read", via: "tool", tool: "web_fetch", args: { url: "http://public.example/?hold" }, out: "Page", as: "first", deadline_s: 60 },
      { node: "call", label: "Second read", via: "tool", tool: "web_fetch", args: { url: "{website}" }, out: "Page", as: "second", deadline_s: 60 },
    ] },
  };
  assert.equal((await api("POST", "/agents", { definition: { id: "twice", name: "twice", workflow: flow, tools: ["web_fetch"] } })).status, 201);
  const started = await api("POST", "/agents/twice/runs", { input: { website: `${PAGE}notes.txt` } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; !existsSync(`${hold}.waiting`); i++) {
    assert.ok(i < 600, "the first call node did not run");
    await sleep(100);
  }
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: switched } })).status, 200);
  await writeFile(hold, "");
  await follow(api, started.body.run_id, ["failed", "completed"], { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${started.body.run_id}`)).body;
  assert.equal(run.status, "failed", "the second call node is refused");
  assert.match(run.error?.message ?? "", /failed at Second read/, "at its second call node");
  const ended = (await readFile(join(server.data, "runs", started.body.run_id, "nodes.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.t === "effect.end");
  assert.deepEqual(ended.map((line) => [line.label, line.status]), [["First read", "done"], ["Second read", "failed"]]);
  assert.equal(ended[1].error, switched === "deny" ? deniedText("web_fetch") : "This web_fetch call needs a person's approval, which a workflow's call node cannot wait for; it was not run.", "in the gate's words");
  assert.deepEqual((await dialled()).filter((dial) => dial.endsWith("notes.txt")), [], "and never dials");
});

test("a settings key the agent store would refuse is refused before the agent is made: 422, and its id stays free", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, GATE);
  for (const key of ["monid.foo.bar", "mcp:srv/a/b"]) {
    const refused = await api("POST", "/agents", agent("keyed", { instructions: "Answer.", tools: ["web_fetch"], tool_settings: { [key]: { permission: "ask" } } }));
    assert.deepEqual([refused.status, refused.body.error?.code], [422, "input_invalid"], `${key}: ${JSON.stringify(refused.body)}`);
  }
  assert.equal((await api("GET", "/agents/keyed")).status, 404, "nothing was stored");
  assert.equal((await api("POST", "/agents", agent("keyed", { instructions: "Answer.", tools: ["web_fetch"] }))).status, 201, "the same id makes an agent");
});

const ASKS = (tool) => `This workflow's call node calls ${tool}, which is set to ask, and a workflow's call node can't wait for an approval: set it to allow for this agent.`;
const NOTE_ONLY = "A note is kept only from your answer: write it in a ```note block, not to a file.";
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

/** A held key for the cut cases, its words none a row says itself. */
const CUT_KEY = ["not-a-secret", "gate-cut-key", randomBytes(6).toString("hex")].join("-");

test("a held key straddling the 2 KiB cut of a parked call's arguments shows no 8 characters of it: the arguments are redacted whole, then cut", { timeout: 90_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: CUT_KEY });
  await network(t);
  const server = await serve(t, GATE);
  assert.equal((await server.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  // {"url":"<PAGE>?pad=<pad>&k=<key>"}: the key starts 20 bytes before the cut (ARGS_PREVIEW_BYTES less its "…").
  const pad = "a".repeat(2048 - 3 - 20 - `{"url":"${PAGE}?pad=&k=`.length);
  const runId = await fetching(server.api, "straddle", "pi", `${PAGE}?pad=${pad}&k=${CUT_KEY}`);
  const { view, rows } = await parked(server.api, runId);
  const row = rows.find((r) => r.kind === "tool_approval_requested");
  assert.ok(row && view.pending?.kind === "approval", "parked");
  assert.equal(holdsPiece(JSON.stringify(row), CUT_KEY), false, "the approval row");
  assert.equal(holdsPiece(JSON.stringify(view.pending), CUT_KEY), false, "GET /runs/{id}'s pending");
  const listed = (await server.api("GET", "/runs")).body.runs.find((r) => r.run_id === runId);
  assert.equal(holdsPiece(JSON.stringify(listed.pending), CUT_KEY), false, "the run list's pending");
});

/** A held key for the resume case, its words none a row says itself. */
const RESUME_KEY = ["not-a-secret", "gate-resume-key", randomBytes(6).toString("hex")].join("-");

test("once a parked call with a held key in its arguments is approved, the resume message, its timeline row, the run's answer and the run list show no 8 characters of the key, on pi and codex", { timeout: 150_000 }, async (t) => {
  withEnv(t, { PARALLEL_API_KEY: RESUME_KEY });
  await network(t);
  const server = await serve(t, GATE);
  const answer = await owner(server);
  assert.equal((await server.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  for (const harness of ["pi", "codex"]) {
    const runId = await fetching(server.api, `resume-${harness}`, harness, `${PAGE}?k=${RESUME_KEY}`);
    const { view } = await parked(server.api, runId);
    assert.equal((await answer(runId, view.pending.id, { decision: "allow" })).status, 204);
    const { message, rows, view: done } = await resumed(server.api, runId);
    assert.match(message, /^\[tool approval\] /, `${harness}: resumed by the gate's message`);
    // The person's own message (and the title made of it) shows as written: their redaction is a later change.
    const [first, ...rest] = rows.filter((row) => row.kind === "user_message");
    const shown = rows.filter((row) => row !== first);
    assert.equal(rest.length, 1);
    assert.equal(holdsPiece(JSON.stringify(shown), RESUME_KEY), false, `${harness}: the timeline but the person's message: ${JSON.stringify(rest[0])}`);
    const { title: _title, result, ...run } = done;
    assert.equal(holdsPiece(JSON.stringify(run), RESUME_KEY), false, `${harness}: GET /runs/{id}`);
    // pi's model answers with the whole message, the call's result in it (web_fetch's names its URL): a model quoting
    // a tool's result is the run view's final_answer redaction, a change of its own. What the gate wrote is checked.
    const quoted = harness === "pi" ? /\(arguments (.*?)\), which waited/s.exec(result.final_answer)?.[1] ?? "" : result.final_answer;
    assert.ok(harness !== "pi" || quoted.length > 0, "pi's answer quotes the message");
    assert.equal(holdsPiece(quoted, RESUME_KEY), false, `${harness}: final_answer: ${quoted}`);
    const { title: _listed, ...listed } = (await server.api("GET", "/runs")).body.runs.find((r) => r.run_id === runId);
    assert.equal(holdsPiece(JSON.stringify(listed), RESUME_KEY), false, `${harness}: the run list`);
  }
});

test("a stop of a parked run withdraws the call: stopped, no pending approval, its row reads withdrawn, and a later answer is 409 and never runs it, across a restart; a cancel does the same and ends the run cancelled", { timeout: 150_000 }, async (t) => {
  const dialled = await network(t);
  const first = await serve(t, GATE);
  const answer = await owner(first);
  assert.equal((await first.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const stopRun = await fetching(first.api, "stop-parked", "pi");
  const stopId = (await parked(first.api, stopRun)).view.pending.id;
  const stop = await first.api("POST", `/runs/${stopRun}/stop`, {});
  assert.deepEqual([stop.status, stop.body.stopped], [200, true], JSON.stringify(stop.body));
  const stopped = (await first.api("GET", `/runs/${stopRun}`)).body;
  assert.deepEqual([stopped.status, stopped.state, stopped.pending], ["input_required", "idle", null], "stopped, as a stop leaves a run");
  const row = (await first.api("GET", `/runs/${stopRun}/timeline`)).body.rows.find((r) => r.kind === "tool_approval_requested");
  assert.match(row.summary, /^Withdrawn/, "its row says it was withdrawn");
  const late = await answer(stopRun, stopId, { decision: "allow" });
  assert.deepEqual([late.status, late.body.error.details], [409, { reason: "already_answered", decision: "withdrawn" }]);

  const cancelRun = await fetching(first.api, "cancel-parked", "codex");
  const cancelId = (await parked(first.api, cancelRun)).view.pending.id;
  assert.equal((await first.api("POST", `/runs/${cancelRun}/cancel`)).status, 202);
  await follow(first.api, cancelRun, ["cancelled"], { deadlineMs: 30_000 });
  // A cancel with no answered call in flight waits on nothing: its serve.json says no such wait.
  assert.equal(JSON.parse(await readFile(join(first.data, "runs", cancelRun, "serve.json"), "utf8")).cancel_waits_for, undefined, "a plain cancel waits on nothing");
  const cancelRow = (await first.api("GET", `/runs/${cancelRun}/timeline`)).body.rows.find((r) => r.kind === "tool_approval_requested");
  assert.match(cancelRow.summary, /^Withdrawn/);
  assert.deepEqual((await answer(cancelRun, cancelId, { decision: "deny" })).status, 409);

  await first.close();
  const again = await serve(t, { ...GATE, data: first.data, openSetup: false });
  const answerAgain = await ownerAgain(again);
  assert.equal((await answerAgain(stopRun, stopId, { decision: "allow" })).status, 409, "after a restart too");
  assert.equal((await again.api("GET", `/runs/${stopRun}`)).body.pending, null);
  await sleep(3_000);
  assert.deepEqual(await dialled(), [], "neither call ever ran");
});

test("a stop while an approval waits and a later turn runs withdraws the call and aborts the turn: stopped, idle, nothing pending, the turn cut, and a later answer is 409 and never runs the call; a cancel too", { timeout: 150_000 }, async (t) => {
  const dialled = await network(t);
  const server = await serve(t, GATE);
  const answer = await owner(server);
  const { api } = server;
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  for (const end of ["stop", "cancel"]) {
    const runId = await fetching(api, `turn-${end}`, "pi");
    const approval = (await parked(api, runId)).view.pending.id;
    // The message declines the waiting call, and the gate's resume is the one turn that follows: it streams for 8 s
    // unless it is stopped. The stop or the cancel lands while that turn runs (its message is on the timeline).
    assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "Slowly, please." })).status, 202);
    for (const end = Date.now() + 30_000; ; await sleep(100)) {
      const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
      if (rows.some((row) => row.kind === "user_message" && (row.text ?? "").startsWith("[tool approval] "))) break;
      assert.ok(Date.now() < end, "the gate's resume turn started");
    }
    if (end === "stop") {
      const stop = await api("POST", `/runs/${runId}/stop`, {});
      assert.equal(stop.body.stopped, true, JSON.stringify(stop.body));
      await follow(api, runId, ["input_required"], { deadlineMs: 30_000 });
      const view = (await api("GET", `/runs/${runId}`)).body;
      assert.deepEqual([view.status, view.state, view.pending], ["input_required", "idle", null], "stopped: idle, nothing pending");
      // Past the turn's 8 s: a turn the stop did not cut would have answered by now.
      await sleep(10_000);
      const after = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
      assert.ok(!after.some((row) => (row.text ?? "").includes("Done slowly.")), `the turn was cut, never answered: ${JSON.stringify(after.map((row) => [row.kind, (row.text ?? "").slice(0, 40)]))}`);
    } else {
      assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
      await follow(api, runId, ["cancelled"], { deadlineMs: 30_000 });
      await sleep(10_000);
      const after = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
      assert.ok(!after.some((row) => (row.text ?? "").includes("Done slowly.")), "the turn was cut");
    }
    assert.equal((await answer(runId, approval, { decision: "allow" })).status, 409, `${end}: a later allow`);
  }
  await sleep(2_000);
  assert.deepEqual(await dialled(), [], "the call never ran");
});

test("a person's message while an approval waits declines the call, with the message as the reason, in one turn: on pi and codex the model reads the refusal and the message together, the row says so, and a later allow is 409", { timeout: 150_000 }, async (t) => {
  const dialled = await network(t);
  const server = await serve(t, GATE);
  const answer = await owner(server);
  const { api } = server;
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const said = "use the cached copy instead";
  for (const harness of ["pi", "codex"]) {
    const runId = await fetching(api, `declined-${harness}`, harness);
    const approval = (await parked(api, runId)).view.pending.id;
    const sent = await api("POST", `/runs/${runId}/messages`, { content: said });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const { message, rows, answer: final } = await resumed(api, runId);
    // One turn: the gate's message, the refusal with the person's words as its reason; no separate turn of theirs.
    assert.equal(rows.filter((row) => row.kind === "user_message").length, 2, `${harness}: the first message and one more`);
    assert.match(message, new RegExp(`^\\[tool approval\\] [\\s\\S]*\\nThe user denied this web_fetch call\\. Reason: ${said}$`), harness);
    if (harness === "pi") assert.match(final, new RegExp(`Reason: ${said}$`), "the model read the refusal and the message together");
    const row = rows.find((r) => r.kind === "tool_approval_requested");
    assert.match(row.summary, /^Declined by your message: web_fetch /, harness);
    const late = await answer(runId, approval, { decision: "allow" });
    assert.deepEqual([late.status, late.body.error.details], [409, { reason: "already_answered", decision: "deny" }], harness);
  }
  await sleep(2_000);
  assert.deepEqual(await dialled(), [], "neither call ran");
});

test("an answer or a stop that lands while a declining message is on its way stands: an allow stays allow and runs once, and a stop stays withdrawn with no resume", { timeout: 150_000 }, async (t) => {
  const dialled = await network(t);
  const server = await serve(t, GATE);
  const { api } = server;
  const answer = await owner(server);
  t.after(() => (runsTestHooks.personsTurn = undefined));
  for (const [lands, url] of [["allow", PAGE], ["stop", `${PAGE}notes.txt`]]) {
    const runId = await fetching(api, `latched-${lands}`, "pi", url, { tool_settings: { web_fetch: { permission: "ask" } } });
    const id = (await parked(api, runId)).view.pending.id;
    // The message has read the call waiting, and is held as it sends its turn (runs.ts personsTurn).
    let release, reached;
    const held = new Promise((resolve) => (release = resolve));
    const at = new Promise((resolve) => (reached = resolve));
    runsTestHooks.personsTurn = () => (reached(), held);
    const sent = api("POST", `/runs/${runId}/messages`, { content: "Never mind." });
    await at;
    if (lands === "allow") assert.equal((await answer(runId, id, { decision: "allow" })).status, 204);
    else assert.deepEqual(((await api("POST", `/runs/${runId}/stop`, {})).body ?? {}).stopped, true);
    runsTestHooks.personsTurn = undefined;
    release();
    assert.ok([200, 202].includes((await sent).status), `${lands}: the message is taken`);
    const { rows } = await follow(api, runId, ["completed", "input_required"], { deadlineMs: 55_000 });
    const kept = JSON.parse(await readFile(join(server.data, "runs", runId, "serve.json"), "utf8")).approvals[id];
    const resumes = rows.filter((row) => row.kind === "user_message" && row.text?.startsWith(RESUME_PREFIX));
    if (lands === "allow") {
      assert.deepEqual([kept.decision, kept.by], ["allow", undefined], "the allow stands: first answer wins");
      await follow(api, runId, ["completed"], { deadlineMs: 55_000 });
      assert.deepEqual((await dialled()).filter((dial) => dial === url), [url], "and its call ran once");
    } else {
      assert.equal(kept.decision, "withdrawn", "the stop stands");
      assert.deepEqual(resumes, [], "nothing resumes the parked call");
      assert.deepEqual((await dialled()).filter((dial) => dial === url), [], "and it never ran");
    }
  }
});

test("a declining message is held to the call it read: when that call is answered and another parks while the message is on its way, the message declines nothing, and the new call still waits for its own answer", { timeout: 150_000 }, async (t) => {
  const server = await serve(t, GATE);
  const { api } = server;
  const answer = await owner(server);
  t.after(() => (runsTestHooks.personsTurn = undefined));
  const file = join(await scratch(t), "go");
  const ask = `Fetch ${PAGE} again once ${file} exists.`;
  assert.equal((await api("POST", "/agents", agent("pinned", { harness: "pi", instructions: ask, tools: ["web_fetch"], tool_settings: { web_fetch: { permission: "ask" } } }))).status, 201);
  const runId = (await api("POST", "/agents/pinned/runs", { input: { content: ask } })).body.run_id;
  const first = (await parked(api, runId)).view.pending.id;
  let release, reached;
  const held = new Promise((resolve) => (release = resolve));
  const at = new Promise((resolve) => (reached = resolve));
  runsTestHooks.personsTurn = () => (reached(), held);
  const sent = api("POST", `/runs/${runId}/messages`, { content: "Never mind." });
  await at;
  // The call the message read is allowed and runs; the model then makes its next call, which parks.
  assert.equal((await answer(runId, first, { decision: "allow" })).status, 204);
  await writeFile(file, "");
  let second;
  for (let i = 0; !(second && second !== first); i++) {
    assert.ok(i < 600, "the next call did not park");
    second = (await api("GET", `/runs/${runId}`)).body.pending?.id;
    await sleep(100);
  }
  runsTestHooks.personsTurn = undefined;
  release();
  assert.ok([200, 202].includes((await sent).status), "the message is taken");
  await follow(api, runId, ["input_required"], { deadlineMs: 55_000 });
  const kept = JSON.parse(await readFile(join(server.data, "runs", runId, "serve.json"), "utf8")).approvals;
  assert.deepEqual([kept[first]?.decision, kept[second]], ["allow", undefined], "the call it read keeps its allow, and the new one is not declined");
  assert.equal((await api("GET", `/runs/${runId}`)).body.pending?.id, second, "the new call still waits for its own answer");
});

test("a long message that declines a waiting call reaches the model whole: all 5000 of its characters, as its reason", { timeout: 120_000 }, async (t) => {
  await network(t);
  const server = await serve(t, GATE);
  const { api } = server;
  assert.equal((await api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const runId = await fetching(api, "declined-long", "pi");
  await parked(api, runId);
  const [head, tail] = ["start of the reason ", " end of the reason"];
  const long = `${head}${"x".repeat(5000 - head.length - tail.length)}${tail}`;
  assert.equal(long.length, 5000);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: long })).status, 202);
  // pi's faux model answers with the whole of what it was told: the refusal, and the reason in it, all of it.
  const { answer: final } = await resumed(api, runId);
  assert.ok(final.endsWith(`Reason: ${long}`), `the model got ${final.length} characters, ending ${JSON.stringify(final.slice(-40))}`);
});

test("a stop or a cancel that lands after an answer, before the run's process acts on it, wins: nothing runs, nothing resumes, the row says withdrawn, and the record keeps the answer it superseded", { timeout: 240_000 }, async (t) => {
  const dialled = await network(t);
  const first = await serve(t, GATE);
  await owner(first);
  assert.equal((await first.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200);
  const cases = [["allow-stop", "pi"], ["decline-stop", "pi"], ["allow-cancel", "codex"]];
  const runs = {};
  for (const [name, harness] of cases) {
    const runId = await fetching(first.api, `race-${name}`, harness);
    runs[name] = { runId, approval: (await parked(first.api, runId)).view.pending.id };
  }
  // A restart leaves each parked run with no process: an answer starts one, which takes far longer than the next request.
  await first.close();
  const again = await serve(t, { ...GATE, data: first.data, openSetup: false });
  const answer = await ownerAgain(again);
  const { api } = again;
  const timeline = async (runId) => (await api("GET", `/runs/${runId}/timeline`)).body.rows;
  const meta = async (runId) => JSON.parse(await readFile(join(first.data, "runs", runId, "serve.json"), "utf8"));

  // (a) allow, then stop at once.
  const a = runs["allow-stop"];
  assert.equal((await answer(a.runId, a.approval, { decision: "allow" })).status, 204);
  const stopA = await api("POST", `/runs/${a.runId}/stop`, {});
  assert.equal(stopA.body.stopped, true, JSON.stringify(stopA.body));
  // (b) a message that declines the call, then stop at once.
  const b = runs["decline-stop"];
  assert.equal((await api("POST", `/runs/${b.runId}/messages`, { content: "never mind, skip it" })).status, 202);
  const stopB = await api("POST", `/runs/${b.runId}/stop`, {});
  assert.equal(stopB.body.stopped, true, JSON.stringify(stopB.body));
  // (c) allow, then cancel at once.
  const c = runs["allow-cancel"];
  assert.equal((await answer(c.runId, c.approval, { decision: "allow" })).status, 204);
  assert.equal((await api("POST", `/runs/${c.runId}/cancel`)).status, 202);
  await follow(api, c.runId, ["cancelled"], { deadlineMs: 30_000 });

  // Long enough for each run's process to come up and act, had the answer stood.
  await sleep(8_000);
  for (const [name, { runId, approval }] of Object.entries(runs)) {
    const rows = await timeline(runId);
    assert.equal(rows.filter((row) => row.kind === "user_message").length, 1, `${name}: no resume turn`);
    assert.match(rows.find((row) => row.kind === "tool_approval_requested").summary, /^Withdrawn when the run was (stopped|cancelled)/, name);
    const kept = (await meta(runId)).approvals[approval];
    assert.equal(kept.decision, name.endsWith("cancel") ? "canceled" : "withdrawn", name);
    assert.equal(kept.superseded?.decision, name.startsWith("allow") ? "allow" : "deny", `${name}: the record keeps the answer it superseded`);
    if (name === "decline-stop") {
      // Nothing a person typed vanishes: the row says their words were not sent, and the record keeps them whole.
      const row = rows.find((r) => r.kind === "tool_approval_requested");
      assert.match(row.text, /Not sent: the run was stopped\. Your message: never mind, skip it/, "the row says the message was not sent");
      assert.equal(kept.superseded.note, "never mind, skip it", "the record keeps the message whole");
    }
    assert.equal((await answer(runId, approval, { decision: "allow" })).status, 409, `${name}: a later answer`);
  }
  for (const name of ["allow-stop", "decline-stop"]) {
    const view = (await api("GET", `/runs/${runs[name].runId}`)).body;
    assert.deepEqual([view.status, view.state, view.pending], ["input_required", "idle", null], `${name}: stopped`);
  }
  assert.deepEqual(await dialled(), [], "no call ran");
});

test("a stop or a cancel cuts an approved call in flight: the tool sees the abort (monid is asked to stop the run), its result never reaches the model, and the row says withdrawn", { timeout: 150_000 }, async (t) => {
  const log = join(await scratch(t), "monid-calls.jsonl");
  withEnv(t, { MONID_API_KEY: MONID_KEY, AGENTRUN_TEST_FAUX_MONID_CALLS: log });
  const server = await serve(t, { accounts: true, openSetup: true, fauxMonid: fixture("faux-monid.mjs") });
  const answer = await owner(server);
  const { api } = server;
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  for (const [end, said] of [["stop", "stopped"], ["cancel", "cancelled"]]) {
    // monid.run asks by default: the call parks; monid's /slow then runs until its caller stops it.
    assert.equal((await api("POST", "/agents", agent(`slow-${end}`, { tools: ["monid.run"] }))).status, 201);
    const runId = (await api("POST", `/agents/slow-${end}/runs`, { input: { content: "Run monid's /slow." } })).body.run_id;
    const { view } = await parked(api, runId);
    const before = (await calls()).length;
    assert.equal((await answer(runId, view.pending.id, { decision: "allow" })).status, 204);
    // The approved call is in flight: monid's run started, and it runs until stopped.
    for (const until = Date.now() + 30_000; !(await calls()).slice(before).some((call) => call.path === "/v1/run"); await sleep(50)) assert.ok(Date.now() < until, `${end}: the approved call is in flight`);
    if (end === "stop") assert.equal((await api("POST", `/runs/${runId}/stop`, {})).body.stopped, true);
    else {
      assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
      // The cancel overrode an answer the run's process was acting on, and waited for its gate to cut that call.
      assert.deepEqual(JSON.parse(await readFile(join(server.data, "runs", runId, "serve.json"), "utf8")).cancel_waits_for, [view.pending.id], "the cancel says it waits for the approved call to be cut");
    }
    for (const until = Date.now() + 15_000; !(await calls()).slice(before).some((call) => /^\/v1\/runs\/[^/]+\/stop$/.test(call.path)); await sleep(50)) assert.ok(Date.now() < until, `${end}: the tool saw the abort, and monid was asked to stop the run`);
    await sleep(2_000);
    const rows = (await api("GET", `/runs/${runId}/timeline`)).body.rows;
    assert.equal(rows.filter((row) => row.kind === "user_message").length, 1, `${end}: no resume turn`);
    assert.ok(!rows.some((row) => row.kind === "final_answer" && row.text === "Ran."), `${end}: the result never reached the model`);
    assert.match(rows.find((row) => row.kind === "tool_approval_requested").summary, new RegExp(`^Withdrawn when the run was ${said}`), end);
  }
});
