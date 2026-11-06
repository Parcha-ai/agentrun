// An agent granted `mcp:<server>/<tool>` calls it, through the API: on pi (the faux model, the gateway in the run's
// process), on claude-agent (the pinned Agent SDK and Claude CLI, whose own MCP client calls the session proxy's
// /mcp/<server>) and on codex (the stand-in for Codex's app-server, whose MCP client calls the same route). The fake MCP
// server (fixtures/fake-mcp-server.mjs) takes one bearer token and logs whether each request carried an Authorization
// header, never its value. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, runDir, runRecordOf, scratch, serve as serveOf, withEnv } from "./support.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
/** The fake server's bearer token: no real one. */
const TOKEN = `not-a-secret-${"mcp-bearer-0123456789"}`;
/** A server that seals saved credentials, under a seal key of its own. */
const serve = (t, options) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, options));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The agents' own setting that lets the fake's tools run with no one asked: an MCP tool asks by default (the tool gate). */
const ALLOW_FAKE = { "mcp:fake/*": { permission: "allow" } };
const calls = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && (tool === undefined || entry.tool === tool));

/** The fake MCP server, saved on the server as `name` with its bearer token. */
async function addFake(t, api, name = "fake", fake) {
  fake ??= await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const saved = await api("PUT", `/settings/mcp-servers/${name}`, { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return fake;
}

/** Every file under `dir`, with its text. */
async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (entry.isFile()) out.push({ path: join(entry.parentPath, entry.name), text: await readFile(join(entry.parentPath, entry.name), "utf8").catch(() => "") });
  }
  return out;
}

const runOf = async (api, id, content) => {
  const run = await api("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
};

test("pi: an agent granted mcp:fake/add calls it with the server's bearer; the timeline reads fake · add; the run's environment and work/ hold no token", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("adder", { tools: ["mcp:fake/add"], tool_settings: ALLOW_FAKE }))).status, 201);
  const runId = await runOf(api, "adder", 'Call mcp__fake__add with {"a":2,"b":3}');
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.result?.final_answer, "The tool said: 5");
  const call = rows.find((row) => row.kind === "tool_use" && row.tool_name === "mcp__fake__add");
  assert.equal(call?.summary, "fake · add", JSON.stringify(rows.filter((row) => row.kind === "tool_use")));
  assert.deepEqual(calls(fake).map((entry) => [entry.tool, entry.authorization]), [["add", true]], "one call, with the bearer");
  // The token is in no file of the run: its work/, its serve.json, its logs.
  const leaked = (await filesUnder(join(runDir(data, runId)))).filter((file) => file.text.includes(TOKEN)).map((file) => file.path);
  assert.deepEqual(leaked, [], "no file of the run holds the token");
});

// The fake's SDK server cannot list a tool named toString itself; mcp-gateway.test.mjs pins one, mcp-route.test.mjs serves one.
test("pi: a server named like an object's own property (constructor) grants, launches and calls through", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await addFake(t, api, "constructor");
  assert.equal((await api("POST", "/agents", agent("proto", { tools: ["mcp:constructor/add"], tool_settings: { "mcp:constructor/*": { permission: "allow" } } }))).status, 201);
  const runId = await runOf(api, "proto", 'Call mcp__constructor__add with {"a":2,"b":3}');
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "The tool said: 5");
  assert.equal(rows.find((row) => row.kind === "tool_use")?.summary, "constructor · add");
  assert.deepEqual(calls(fake).map((entry) => [entry.tool, entry.authorization]), [["add", true]]);
});

test("pi: the credential reaches only a run whose revision grants one of the server's tools", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("granted", { tools: ["mcp:fake/add"] }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("plain", { tools: [] }))).status, 201);
  const held = {};
  for (const id of ["granted", "plain"]) {
    const runId = await runOf(api, id, "Report the MCP credentials");
    await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
    held[id] = (await api("GET", `/runs/${runId}`)).body.result?.final_answer;
  }
  assert.deepEqual(held, { granted: 'Held: ["fake"]', plain: "Held: []" });
  assert.equal(calls(fake).length, 0, "no run called the server");
});

test("a save that grants a tool the server does not have is refused, naming the server's tools", async (t) => {
  const { api } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  await addFake(t, api);
  const refused = await api("POST", "/agents", agent("nope", { tools: ["mcp:fake/nope"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  const said = JSON.stringify(refused.body);
  for (const tool of ["add", "slow_write", "delete_thing", "paid"]) assert.ok(said.includes(tool), `the refusal names ${tool}: ${said}`);
  const unknown = await api("POST", "/agents", agent("ghost", { tools: ["mcp:ghost/add"] }));
  assert.equal(unknown.status, 422, JSON.stringify(unknown.body));
  // hands, the name the harnesses keep for their own tools, is no server's name: it is refused at the save, so it is
  // never granted either.
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const named = await api("PUT", "/settings/mcp-servers/hands", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(named.status, 422, JSON.stringify(named.body));
  assert.match(JSON.stringify(named.body), /reserved for AgentRun's own tools/);
  const reserved = await api("POST", "/agents", agent("own", { harness: "claude-agent", tools: ["mcp:hands/add"] }));
  assert.equal(reserved.status, 422, JSON.stringify(reserved.body));
});

test("a tool whose schema the Claude CLI would drop (a root anyOf) is refused on claude-agent at the save, in words; on pi it saves and runs", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await startFakeMcp({ token: TOKEN });
  const either = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, anyOf: [{ required: ["a"] }, { required: ["b"] }] };
  fake.tools.pick = { description: "Picks one.", input: either, run: ({ a, b }) => ({ content: [{ type: "text", text: `picked ${a ?? b}` }] }) };
  await addFake(t, api, "fake", fake);
  const refused = await api("POST", "/agents", agent("claude-pick", { harness: "claude-agent", tools: ["mcp:fake/pick"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /tool pick cannot be offered on claude-agent: \/anyOf: the Claude Agent CLI drops a tool whose root has anyOf/);
  assert.equal((await api("POST", "/agents", agent("pi-pick", { tools: ["mcp:fake/pick"], tool_settings: { "mcp:fake/*": { permission: "allow" } } }))).status, 201);
  const runId = await runOf(api, "pi-pick", 'Call mcp__fake__pick with {"a":"x"}');
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "The tool said: picked x");
});

test("a tool whose schema Codex would drop or retype (a not) is refused on codex at the save, in words; on pi it saves", async (t) => {
  const { api } = await serve(t);
  const fake = await startFakeMcp({ token: TOKEN });
  const odd = { type: "object", properties: { name: { type: "string", not: { const: "root" } } }, required: ["name"] };
  fake.tools.greet = { description: "Greets anyone but root.", input: odd, run: ({ name }) => ({ content: [{ type: "text", text: `hello ${name}` }] }) };
  await addFake(t, api, "fake", fake);
  const listed = (await api("GET", "/settings/mcp-servers/fake")).body.tools.find((tool) => tool.name === "greet");
  assert.ok(listed?.input_schema?.properties?.name?.not, `the server listed the not: ${JSON.stringify(listed)}`);
  const refused = await api("POST", "/agents", agent("codex-greet", { harness: "codex", tools: ["mcp:fake/greet"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /tool greet cannot be offered on codex: \/properties\/name\/not: not is not supported by Codex 0\.164\.0 \(it drops or retypes it\)/);
  assert.equal((await api("POST", "/agents", agent("pi-greet", { tools: ["mcp:fake/greet"] }))).status, 201, "pi takes the schema whole");
  // A nearby shape Codex takes: a bound it only strips (minLength) is no refusal; the server still checks it.
  fake.tools.name = { description: "Names anyone.", input: { type: "object", properties: { name: { type: "string", minLength: 2 } }, required: ["name"] }, run: ({ name }) => ({ content: [{ type: "text", text: `named ${name}` }] }) };
  assert.equal((await api("POST", "/settings/mcp-servers/fake/refresh", {})).status, 200);
  assert.equal((await api("POST", "/agents", agent("codex-name", { harness: "codex", tools: ["mcp:fake/name"] }))).status, 201, "codex takes a bound it only strips");
});

test("a tool whose header declaration a refresh made unsendable refuses the run in words, naming it, and nothing is sent", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await startFakeMcp({ token: TOKEN });
  fake.tools.tagged = { description: "Tagged.", input: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } }, run: () => ({ content: [{ type: "text", text: "ok" }] }) };
  await addFake(t, api, "fake", fake);
  assert.equal((await api("POST", "/agents", agent("tagged", { tools: ["mcp:fake/tagged"], tool_settings: ALLOW_FAKE }))).status, 201);
  fake.tools.tagged.input = { type: "object", properties: { region: { type: "object", "x-mcp-header": "Region" } } };
  assert.equal((await api("POST", "/settings/mcp-servers/fake/refresh")).status, 200);
  const refused = await api("POST", "/agents/tagged/runs", { input: { content: 'Call mcp__fake__tagged with {"region":{}}' } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error?.message ?? "", /tool tagged declares a header it cannot send: region: x-mcp-header is only allowed on a string, integer or boolean/);
  assert.equal(calls(fake).length, 0);
});

test("a granted tool whose server was deleted, or whose tool a refresh removed, before the run's pin is made again fails the relaunch in words, and the call is never sent again", { timeout: 180_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await addFake(t, api, "fake");
  const other = await addFake(t, api, "other");
  // Each run holds a slow call; its process is killed with its pin gone, so the relaunch makes the pin again, as a first
  // launch does after the run's check: the window in which a server can go.
  const held = async (id, server, source) => {
    assert.equal((await api("POST", "/agents", agent(id, { tools: [`mcp:${server}/slow_write`], tool_settings: { [`mcp:${server}/*`]: { permission: "allow" } } }))).status, 201);
    const runId = await runOf(api, id, `Call mcp__${server}__slow_write with {"line":"once","seconds":60}`);
    for (let i = 0; calls(source, "slow_write").length === 0; i++) {
      assert.ok(i < 600, `${id}: the call reaches the server`);
      await sleep(100);
    }
    await rm(join(runDir(data, runId), "mcp-tools.json"));
    return runId;
  };
  const refreshed = await held("refreshed", "fake", fake);
  const deleted = await held("deleted", "other", other);
  delete fake.tools.slow_write;
  assert.equal((await api("POST", "/settings/mcp-servers/fake/refresh")).status, 200);
  assert.equal((await api("DELETE", "/settings/mcp-servers/other")).status, 204);
  const failedWith = async (runId) => {
    const pid = runRecordOf(data, runId).holder.pid;
    process.kill(pid, "SIGKILL");
    const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    return [last.status, (await api("GET", `/runs/${runId}`)).body.error?.message];
  };
  assert.deepEqual(await failedWith(refreshed), ["failed", "The MCP tool mcp:fake/slow_write cannot be pinned: slow_write is no longer one of its tools since the last refresh."]);
  assert.deepEqual(await failedWith(deleted), ["failed", "The MCP tool mcp:other/slow_write cannot be pinned: the MCP server other is no longer saved."]);
  assert.deepEqual([calls(fake, "slow_write").length, calls(other, "slow_write").length], [1, 1], "each call was sent once, never again");
});

test("a save that checks a deeply nested tool schema leaves the server answering: /health meanwhile, and a readable refusal past the bounds", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await startFakeMcp({ token: TOKEN });
  let deep = { type: "string" };
  for (let i = 0; i < 80; i++) deep = { type: "object", properties: { [`p${i}`]: { type: "string" } }, additionalProperties: deep };
  fake.tools.deep = { description: "A deep schema.", input: deep, run: () => ({ content: [{ type: "text", text: "deep" }] }) };
  await addFake(t, api, "fake", fake);
  const started = Date.now();
  const [saved, health] = await Promise.all([api("POST", "/agents", agent("deep", { tools: ["mcp:fake/deep"] })), api("GET", "/health")]);
  assert.equal(health.status, 200);
  assert.ok(Date.now() - started < 5_000, `the save and the health check answered in ${Date.now() - started} ms`);
  assert.equal(saved.status, 422, JSON.stringify(saved.body));
  assert.match(JSON.stringify(saved.body), /nests deeper than 64 levels/);
});

test("pi: a run killed mid-call resumes with the call answered interrupted, and the server saw the call once", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("writer", { tools: ["mcp:fake/slow_write"], tool_settings: ALLOW_FAKE }))).status, 201);
  const runId = await runOf(api, "writer", 'Call mcp__fake__slow_write with {"line":"once","seconds":30}');
  for (let i = 0; calls(fake, "slow_write").length === 0; i++) {
    assert.ok(i < 600, "the call reaches the server");
    await sleep(100);
  }
  const record = async () => runRecordOf(data, runId);
  const pid = (await record()).holder.pid;
  // Mid-call, the run's process: its environment holds no token.
  const environ = await readFile(`/proc/${pid}/environ`, "utf8");
  assert.ok(!environ.includes(TOKEN), "the run's environment holds no token");
  process.kill(pid, "SIGKILL");
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === "mcp__fake__slow_write");
  assert.match(`${result?.summary} ${result?.tool_result_preview}`, /interrupted/i, JSON.stringify(rows.filter((row) => row.kind.startsWith("tool"))));
  assert.equal(calls(fake, "slow_write").length, 1, "the call was never sent again");
});

test("pi: a server whose address changed after the run started answers the run's calls with that, and nothing is sent", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_MCP, claudeSdk: true });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("mover", { tools: ["mcp:fake/add"], tool_settings: ALLOW_FAKE }))).status, 201);
  const runId = await runOf(api, "mover", "Hello.");
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const moved = await addFake(t, api, "fake", await startFakeMcp({ token: TOKEN }));
  // What the save itself sent (its preview), before the run's call.
  const [before, movedBefore] = [fake.log.length, moved.log.length];
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: 'Call mcp__fake__add with {"a":2,"b":3}' })).status, 202);
  await sleep(500);
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.match(view.result?.final_answer ?? "", /address changed since this run started/);
  // A save's own preview may still be closing its exchange as it answers: what the run sent is any call, or any
  // request after the run's turn began.
  const sent = (log, from) => log.slice(from).filter((entry) => entry.method !== "notifications/cancelled" && entry.http !== "DELETE");
  assert.deepEqual([calls(fake).length, calls(moved).length], [0, 0], "no call reached either address");
  assert.deepEqual([sent(fake.log, before), sent(moved.log, movedBefore)].map((log) => log.filter((entry) => entry.method === "initialize" || entry.method === "server/discover").length), [0, 0], `the run connected to neither: ${JSON.stringify([fake.log.slice(before), moved.log.slice(movedBefore)])}`);
});

test("claude-agent: the Claude CLI's own MCP client calls mcp:fake/add through the session's proxy; the fake saw the bearer, the CLI never held it", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const anthropic = await fakeAnthropic({
    // The CLI's own background requests offer no tools: they get a plain answer.
    reply: (request) => (Object.keys(request.results).length ? { text: `The tool said: ${Object.values(request.results)[0]}` } : request.tools.includes("mcp__fake__add") ? { tool: { name: "mcp__fake__add", input: { a: 2, b: 3 } } } : { text: "Noted." }),
  });
  t.after(() => anthropic.close());
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" });
  const { api, data } = await serve(t, { faux: undefined });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("claude-adder", { harness: "claude-agent", model: "anthropic/claude-haiku-4-5", tools: ["mcp:fake/add"], tool_settings: ALLOW_FAKE }))).status, 201);
  const runId = await runOf(api, "claude-adder", "Add 2 and 3 with the add tool.");
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 150_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind.startsWith("tool"))));
  const view = (await api("GET", `/runs/${runId}`)).body;
  // The CLI's own note may follow the tool's text in its result.
  assert.match(view.result?.final_answer ?? "", /^The tool said: 5\b/);
  assert.ok(anthropic.requests.some((request) => request.tools.includes("mcp__fake__add")), "the model was offered the granted tool");
  const call = rows.find((row) => row.kind === "tool_use" && row.tool_name === "mcp__fake__add");
  assert.equal(call?.summary, "fake · add", JSON.stringify(rows.filter((row) => row.kind === "tool_use")));
  assert.deepEqual(calls(fake).map((entry) => [entry.tool, entry.authorization]), [["add", true]], "one call, with the bearer");
  const leaked = (await filesUnder(join(runDir(data, runId)))).filter((file) => file.text.includes(TOKEN)).map((file) => file.path);
  assert.deepEqual(leaked, [], "no file of the run, the CLI's own state among them, holds the token");
});

test("claude-agent: a run killed mid-call resumes with the call reported interrupted to the model, and the server saw the call once", { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  // The model asks for the call once; every later answer says what it was told of it.
  let asked = false;
  const anthropic = await fakeAnthropic({
    reply: (request) => {
      if (!request.tools.includes("mcp__fake__slow_write")) return { text: "Noted." };
      if (asked) return { text: "Done after the cut." };
      asked = true;
      return { tool: { name: "mcp__fake__slow_write", input: { line: "once", seconds: 60 } } };
    },
  });
  t.after(() => anthropic.close());
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" });
  const { api, data } = await serve(t, { faux: undefined });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("claude-writer", { harness: "claude-agent", model: "anthropic/claude-haiku-4-5", tools: ["mcp:fake/slow_write"], tool_settings: ALLOW_FAKE }))).status, 201);
  const runId = await runOf(api, "claude-writer", "Write the line once with the slow_write tool.");
  for (let i = 0; calls(fake, "slow_write").length === 0; i++) {
    assert.ok(i < 1200, "the call reaches the server");
    await sleep(100);
  }
  // While the call runs, the Timeline has its row, as on codex.
  const isCall = (row) => row.tool_name === "mcp__fake__slow_write";
  let running = [];
  for (let i = 0; i < 50 && !running.some((row) => row.kind === "tool_use" && isCall(row)); i++) {
    if (i) await sleep(100);
    running = (await api("GET", `/runs/${runId}/timeline`)).body.rows ?? [];
  }
  assert.ok(running.some((row) => row.kind === "tool_use" && isCall(row)), `the running call has its row: ${JSON.stringify(running.map((row) => [row.kind, row.summary]))}`);
  const record = async () => runRecordOf(data, runId);
  process.kill((await record()).holder.pid, "SIGKILL");
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind.startsWith("tool"))));
  // After the cut, its row stays, once, and its result reads interrupted.
  const tools = rows.filter((row) => row.kind.startsWith("tool") && isCall(row));
  assert.equal(tools.filter((row) => row.kind === "tool_use").length, 1, JSON.stringify(tools));
  assert.match(JSON.stringify(tools.find((row) => row.kind === "tool_result") ?? null), /interrupted/i, JSON.stringify(tools));
  // The resumed session's model is told the call was cut and not run again, in the harness's recovery note.
  const resumed = anthropic.messages().filter((request) => request.tools.includes("mcp__fake__slow_write")).slice(1);
  assert.ok(resumed.some((request) => /interrupted[\s\S]*none was run again[\s\S]*mcp__fake__slow_write/.test(JSON.stringify(request.body.system ?? ""))), "the recovery note names the interrupted call");
  assert.equal(calls(fake, "slow_write").length, 1, "the call was never sent again");
});

test("pi: a saved credential that can't be opened refuses the call before anything is sent, in words; a server that takes no credential is unaffected", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX_MCP });
  const fake = await addFake(t, api);
  const open = await startFakeMcp({});
  t.after(() => open.close());
  assert.equal((await api("PUT", "/settings/mcp-servers/open", { url: open.url, auth: { type: "none" } })).status, 200);
  // The sealed bearer damaged at rest, as one sealed under another seal key reads.
  const file = join(data, "mcp-servers.json");
  const doc = JSON.parse(await readFile(file, "utf8"));
  doc.servers.fake.auth.sealed.authorization = Buffer.from("not what was sealed").toString("base64");
  await writeFile(file, JSON.stringify(doc));
  assert.equal((await api("POST", "/agents", agent("unopened", { tools: ["mcp:fake/add", "mcp:open/add"], tool_settings: { ...ALLOW_FAKE, "mcp:open/*": { permission: "allow" } } }))).status, 201);
  const before = fake.log.length;
  const runId = await runOf(api, "unopened", 'Call mcp__fake__add with {"a":2,"b":3}');
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "The tool said: The MCP server fake's credential can't be opened on this server (sealed under another seal key, or damaged); update it in Settings → MCP servers.");
  // A save's own preview may still be closing its exchange: what the run would send is a call or a handshake.
  assert.deepEqual(fake.log.slice(before).filter((entry) => ["tools/call", "initialize", "server/discover"].includes(entry.method)), [], "nothing reached the server");
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: 'Call mcp__open__add with {"a":2,"b":3}' })).status, 202);
  await sleep(500);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "The tool said: 5");
  assert.deepEqual(calls(open).map((entry) => [entry.tool, entry.authorization]), [["add", false]]);
});

test("pi: a saved header named unopened is a header like any other: the call is sent with it, and its value reaches no answer or file", { timeout: 90_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX_MCP });
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const value = `not-a-secret-${"unopened-header-value"}`;
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "headers", headers: { Authorization: `Bearer ${TOKEN}`, unopened: value } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await api("POST", "/agents", agent("named-unopened", { tools: ["mcp:fake/add"], tool_settings: ALLOW_FAKE }))).status, 201);
  const runId = await runOf(api, "named-unopened", 'Call mcp__fake__add with {"a":2,"b":3}');
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, "The tool said: 5");
  assert.deepEqual(calls(fake).map((entry) => [entry.tool, entry.authorization]), [["add", true]]);
  const timeline = JSON.stringify((await api("GET", `/runs/${runId}/timeline?limit=500`)).body);
  assert.ok(!timeline.includes(value), "the header's value is in no row");
  const files = await filesUnder(runDir(data, runId));
  assert.ok(files.length > 0, "the run's directory is read");
  const leaked = files.filter((file) => file.text.includes(value)).map((file) => file.path);
  assert.deepEqual(leaked, [], "no file of the run holds the header's value");
});

/** serve's gateway on loopback: each Responses request answered with the text it carries, and its usage. */
async function echoGateway(t) {
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const text = JSON.parse(body || "{}").input?.[0]?.content?.[0]?.text ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 10 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** serve with codex on a copy of the repo's stand-in for Codex's app-server (no Codex binary): its "model" is the turn's
 *  text, said through serve's gateway, and `mcp <server> <tool> <json>` a call of a server's tool through the MCP client
 *  Codex has, at the URL its config.toml names. `standInEnv` is the stand-in's own. */
async function codexServe(t, standInEnv = {}) {
  const dir = await scratch(t);
  const standIn = join(dir, "codex-stand-in.mjs");
  await copyStandIn(standIn);
  withEnv(t, {
    AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"),
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote", ...standInEnv } }),
    AGENT_MODEL_BASE_URL: await echoGateway(t),
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
  }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  return serveOf(t, { faux: undefined });
}

/** The config.toml Codex was given for a run, from the run's own directory. */
const codexConfigOf = async (data, runId) => (await filesUnder(runDir(data, runId))).filter((file) => file.path.endsWith("/config.toml")).map((file) => file.text);

test("codex: an agent granted mcp:fake/add calls it through the session's proxy; the timeline reads fake · add, the fake saw the bearer, no file holds it", { timeout: 90_000 }, async (t) => {
  const { api, data } = await codexServe(t);
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("codex-adder", { harness: "codex", tools: ["mcp:fake/add"], tool_settings: ALLOW_FAKE }))).status, 201);
  const runId = await runOf(api, "codex-adder", 'mcp fake add {"a":2,"b":3}');
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind.startsWith("tool"))));
  const answer = /^add returned: 5 \(item (\S+)\)$/.exec((await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "");
  assert.ok(answer, "the stand-in answered with the tool's result and its mcpToolCall item's id");
  const call = rows.find((row) => row.kind === "tool_use" && row.tool_name === "mcp__fake__add");
  assert.equal(call?.summary, "fake · add", JSON.stringify(rows.filter((row) => row.kind.startsWith("tool"))));
  // The call is keyed by the id Codex sends in tools/call's _meta.callId, which is its mcpToolCall item's id: a host that
  // acts on a call's result event (a parked call ends the turn) finds the call by it.
  assert.deepEqual(rows.filter((row) => row.tool_name === "mcp__fake__add").map((row) => [row.kind, row.tool_use_id]), [["tool_use", answer[1]], ["tool_result", answer[1]]]);
  assert.deepEqual(calls(fake).map((entry) => [entry.tool, entry.authorization]), [["add", true]], "one call, with the bearer");
  const configs = await codexConfigOf(data, runId);
  assert.ok(configs.some((text) => /^\[mcp_servers\.fake\]$/m.test(text) && /^default_tools_approval_mode = "approve"$/m.test(text) && /^enabled_tools = \["add"\]$/m.test(text)), `Codex was given the server, its grant and approve mode: ${configs.join("\n---\n")}`);
  const files = await filesUnder(runDir(data, runId));
  assert.ok(files.length > 0, "the run's directory is read");
  const leaked = files.filter((file) => file.text.includes(TOKEN)).map((file) => file.path);
  assert.deepEqual(leaked, [], "no file of the run, Codex's own home among them, holds the token");
});

test("codex: a run that grants nothing from the server gets no MCP server and the server sees nothing", { timeout: 90_000 }, async (t) => {
  const { api, data } = await codexServe(t);
  const fake = await addFake(t, api);
  const before = fake.log.length;
  assert.equal((await api("POST", "/agents", agent("codex-plain", { harness: "codex", tools: [] }))).status, 201);
  const runId = await runOf(api, "codex-plain", 'mcp fake add {"a":2,"b":3}');
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  const configs = await codexConfigOf(data, runId);
  assert.ok(configs.length > 0 && configs.every((text) => !text.includes("mcp_servers")), "Codex was given no MCP server");
  assert.deepEqual(fake.log.slice(before), [], "the server saw nothing of the run");
});

test("codex: a server that does not start fails the run, naming it, rather than running it without its tools", { timeout: 90_000 }, async (t) => {
  const { api } = await codexServe(t, { FAKE_CODEX_MCP_START: "fail" });
  await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("codex-down", { harness: "codex", tools: ["mcp:fake/add"] }))).status, 201);
  const runId = await runOf(api, "codex-down", 'mcp fake add {"a":2,"b":3}');
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "failed");
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.match(JSON.stringify(view.error ?? view), /MCP servers failed to initialize: fake\b/);
});

test("codex: a run killed mid-call shows the call's row while it runs and its interrupted result after, resumes with the call answered interrupted, and the server saw the call once", { timeout: 120_000 }, async (t) => {
  const { api, data } = await codexServe(t);
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("codex-writer", { harness: "codex", tools: ["mcp:fake/slow_write"], tool_settings: ALLOW_FAKE }))).status, 201);
  const runId = await runOf(api, "codex-writer", 'mcp fake slow_write {"line":"once","seconds":30}');
  for (let i = 0; calls(fake, "slow_write").length === 0; i++) {
    assert.ok(i < 600, "the call reaches the server");
    await sleep(100);
  }
  // While the call runs, the Timeline has its row: the call's intent is in the session before it is sent.
  const isCall = (row) => row.tool_name === "mcp__fake__slow_write";
  let running = [];
  for (let i = 0; i < 50 && !running.some((row) => row.kind === "tool_use" && isCall(row)); i++) {
    if (i) await sleep(100);
    running = (await api("GET", `/runs/${runId}/timeline`)).body.rows ?? [];
  }
  assert.ok(running.some((row) => row.kind === "tool_use" && isCall(row) && row.summary === "fake · slow_write"), `the running call has its row: ${JSON.stringify(running.map((row) => [row.kind, row.summary]))}`);
  const { holder } = runRecordOf(data, runId);
  process.kill(holder.pid, "SIGKILL");
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
  // After the cut, the call's row stays, once, and its result reads interrupted, from the session's record of the call.
  const tools = rows.filter((row) => row.kind.startsWith("tool") && isCall(row));
  assert.equal(tools.filter((row) => row.kind === "tool_use").length, 1, JSON.stringify(tools));
  const result = tools.find((row) => row.kind === "tool_result");
  assert.match(`${result?.summary} ${result?.tool_result_preview}`, /interrupted[\s\S]*may or may not have taken effect/i, JSON.stringify(tools));
  // What the model reads of the call in the resumed thread: Codex was told it was interrupted.
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "outputs" })).status, 202);
  await sleep(500);
  const { last: after } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(after.status, "completed");
  assert.match((await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "", /interrupted/i);
  assert.equal(calls(fake, "slow_write").length, 1, "the call was never sent again");
});
