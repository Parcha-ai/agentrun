// An agent granted `mcp:<server>/<tool>` calls it, through the API: on pi (the faux model, the gateway in the run's
// process) and on claude-agent (the pinned Agent SDK and Claude CLI, whose own MCP client calls the session proxy's
// /mcp/<server>). The fake MCP server (fixtures/fake-mcp-server.mjs) takes one bearer token and logs whether each request
// carried an Authorization header, never its value. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, serve as serveOf, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
/** The fake server's bearer token: no real one. */
const TOKEN = `not-a-secret-${"mcp-bearer-0123456789"}`;
/** A server that seals saved credentials, under a seal key of its own. */
const serve = (t, options) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, options));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const { api, data } = await serve(t, { faux: FAUX_MCP });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("adder", { tools: ["mcp:fake/add"] }))).status, 201);
  const runId = await runOf(api, "adder", 'Call mcp__fake__add with {"a":2,"b":3}');
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.at(-1)));
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.result?.final_answer, "The tool said: 5");
  const call = rows.find((row) => row.kind === "tool_use" && row.tool_name === "mcp__fake__add");
  assert.equal(call?.summary, "fake · add", JSON.stringify(rows.filter((row) => row.kind === "tool_use")));
  assert.deepEqual(calls(fake).map((entry) => [entry.tool, entry.authorization]), [["add", true]], "one call, with the bearer");
  // The token is in no file of the run: its work/, its serve.json, its logs.
  const leaked = (await filesUnder(join(data, "runs", runId))).filter((file) => file.text.includes(TOKEN)).map((file) => file.path);
  assert.deepEqual(leaked, [], "no file of the run holds the token");
});

test("pi: the credential reaches only a run whose revision grants one of the server's tools", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { faux: FAUX_MCP });
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
  const { api } = await serve(t, { faux: FAUX_MCP });
  await addFake(t, api);
  const refused = await api("POST", "/agents", agent("nope", { tools: ["mcp:fake/nope"] }));
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  const said = JSON.stringify(refused.body);
  for (const tool of ["add", "slow_write", "delete_thing", "paid"]) assert.ok(said.includes(tool), `the refusal names ${tool}: ${said}`);
  const unknown = await api("POST", "/agents", agent("ghost", { tools: ["mcp:ghost/add"] }));
  assert.equal(unknown.status, 422, JSON.stringify(unknown.body));
});

test("pi: a run killed mid-call resumes with the call answered interrupted, and the server saw the call once", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { faux: FAUX_MCP });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("writer", { tools: ["mcp:fake/slow_write"] }))).status, 201);
  const runId = await runOf(api, "writer", 'Call mcp__fake__slow_write with {"line":"once","seconds":30}');
  for (let i = 0; calls(fake, "slow_write").length === 0; i++) {
    assert.ok(i < 600, "the call reaches the server");
    await sleep(100);
  }
  const record = async () => JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8").catch(() => "{}"));
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
  const { api } = await serve(t, { faux: FAUX_MCP });
  const fake = await addFake(t, api);
  assert.equal((await api("POST", "/agents", agent("mover", { tools: ["mcp:fake/add"] }))).status, 201);
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
  assert.deepEqual([fake.log.length - before, moved.log.length - movedBefore], [0, 0], "neither address was sent anything");
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
  assert.equal((await api("POST", "/agents", agent("claude-adder", { harness: "claude-agent", model: "anthropic/claude-haiku-4-5", tools: ["mcp:fake/add"] }))).status, 201);
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
  const leaked = (await filesUnder(join(data, "runs", runId))).filter((file) => file.text.includes(TOKEN)).map((file) => file.path);
  assert.deepEqual(leaked, [], "no file of the run, the CLI's own state among them, holds the token");
});
