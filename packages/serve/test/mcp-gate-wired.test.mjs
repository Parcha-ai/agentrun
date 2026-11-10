// Every MCP tool call passes the run's one tool gate on a harness with its own MCP client, claude-agent and codex,
// through the API: with the server's mcp:fake/* set to deny the call is refused and the fake MCP server sees nothing;
// with no setting it asks, parks, and the owner's allow runs it exactly once; set to allow it runs once with no one
// asked. pi's rows are mcp-gate.test.mjs's (deny by key and by mcp:fake/*, the ask, allow by key and by mcp:fake/*).
// claude-agent runs the pinned Agent SDK and Claude CLI against a scripted Messages endpoint; codex the stand-in for
// Codex's app-server, whose MCP client calls the session proxy as Codex does, its "model" the turn's text said through
// serve's gateway. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { agent, call, clientOwnerSession, follow, scratch, serve as serveOf, withEnv } from "./support.mjs";

const TOKEN = `not-a-secret-${"mcp-gate-wired-0123"}`;
const json = { "content-type": "application/json" };
const HARNESSES = [...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : []), "codex"];
const calls = (fake) => fake.log.filter((entry) => entry.method === "tools/call");

/** serve's gateway on loopback for codex's stand-in: each Responses request answered with the text it carries; `seen`
 *  is those texts, in order. */
async function echoGateway(t) {
  const seen = [];
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const text = JSON.parse(body || "{}").input?.[0]?.content?.[0]?.text ?? "";
    seen.push(text);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 10 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A server for `harness` with the fake MCP server saved, an owner who can answer approvals, and the run's prompt. */
async function setup(t, harness) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  let extra;
  let content;
  if (harness === "claude-agent") {
    const anthropic = await fakeAnthropic({
      reply: (request) => {
        const at = request.text.lastIndexOf("[tool approval]");
        if (at >= 0) return { text: `The tool said: ${request.text.slice(at).split("\n")[1] ?? ""}` };
        if (Object.keys(request.results).length) return { text: `The tool said: ${Object.values(request.results)[0]}` };
        return request.tools.includes("mcp__fake__add") ? { tool: { name: "mcp__fake__add", input: { a: 2, b: 3 } } } : { text: "Noted." };
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
    extra = { harness: "claude-agent", model: "anthropic/claude-haiku-4-5" };
    content = "Add 2 and 3 with the add tool.";
  }
  let model;
  if (harness === "codex") {
    const standIn = join(await scratch(t), "codex-stand-in.mjs");
    await copyStandIn(standIn);
    model = await echoGateway(t);
    withEnv(t, {
      AGENTRUN_CODEX_STANDIN: "1",
      AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
      AGENT_MODEL_BASE_URL: model.url,
      AGENT_MODEL: "gpt-test",
      AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    extra = { harness: "codex" };
    content = 'mcp fake add {"a":2,"b":3}';
  }
  const server = await serveOf(t, { faux: undefined, accounts: true, openSetup: true });
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const saved = await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  // The owner's session the test client holds (its one owner on this server), as the console sends an answer.
  const { cookie, origin } = await clientOwnerSession(server);
  const answer = async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
  const run = async (id) => {
    assert.equal((await server.api("POST", "/agents", agent(id, { tools: ["mcp:fake/add"], ...extra }))).status, 201);
    const started = await server.api("POST", `/agents/${id}/runs`, { input: { content } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  return { api: server.api, fake, answer, run, model };
}

const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";

for (const harness of HARNESSES) {
  test(`${harness}: mcp:fake/* set to deny refuses the call, and the MCP server sees nothing`, { timeout: 240_000 }, async (t) => {
    const { api, fake, run } = await setup(t, harness);
    assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "deny" } })).status, 200);
    const runId = await run(`deny-${harness}`);
    const { last } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(last.status, "completed");
    assert.match(await answerOf(api, runId), /denied|deny/i);
    assert.equal(calls(fake).length, 0, "nothing was sent");
  });

  // Codex's parked call through its own MCP client writes no call record yet (its rows have no call to read).
  test(`${harness}: with no setting the call asks and parks, the MCP server sees nothing, and the owner's allow runs it exactly once`, { timeout: 240_000, skip: harness === "codex" && "#21: a parked door call writes its call record (MCP, next)" }, async (t) => {
    const { api, fake, answer, run, model } = await setup(t, harness);
    const runId = await run(`ask-${harness}`);
    const { rows } = await follow(api, runId, ["input_required"], { deadlineMs: 180_000 });
    const pending = (await api("GET", `/runs/${runId}`)).body.pending;
    assert.deepEqual([pending?.kind, pending?.tool], ["approval", "mcp:fake/add"], JSON.stringify(pending));
    assert.equal(calls(fake).length, 0, "nothing sent while it waits");
    if (harness === "codex") {
      // What parks is Codex's own call id (tools/call's _meta.callId, its mcpToolCall item's id), the one its Timeline rows carry.
      assert.match(pending.call_id, /^call_[0-9a-f]{20}$/);
      assert.deepEqual([...new Set(rows.filter((row) => row.tool_name === "mcp__fake__add").map((row) => row.tool_use_id))], [pending.call_id], JSON.stringify(rows.filter((row) => row.kind.startsWith("tool"))));
      // The turn ended at the parked result: the stand-in's next request (its answer after the call) never left.
      assert.deepEqual(model.seen, ["Calling fake add."]);
    }
    assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 });
    assert.match(await answerOf(api, runId), /5/);
    // The resume answers the parked call by the same id.
    if (harness === "codex") assert.ok((await answerOf(api, runId)).includes(pending.call_id), await answerOf(api, runId));
    assert.equal(calls(fake).length, 1, "run exactly once");
  });

  test(`${harness}: mcp:fake/* set to allow runs the call once with no one asked`, { timeout: 240_000 }, async (t) => {
    const { api, fake, run } = await setup(t, harness);
    assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } })).status, 200);
    const runId = await run(`allow-${harness}`);
    const { last } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(last.status, "completed");
    assert.match(await answerOf(api, runId), harness === "codex" ? /^add returned: 5 / : /The tool said: 5/);
    assert.equal(calls(fake).length, 1);
  });
}
