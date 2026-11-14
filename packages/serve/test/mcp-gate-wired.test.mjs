// Every MCP tool call passes the run's one tool gate on the CLI harnesses, claude-agent, codex and opencode, through the
// API: each gets the run's MCP tools as host tools on its own channel for them (Claude Code `mcp__hands__<wire>`, Codex
// a dynamic tool `mcp_<server>__<tool>`, OpenCode `hands_<wire>`). With the server's mcp:fake/* set to deny the call is
// refused and the fake MCP server sees nothing; with no setting it asks, parks, and the owner's allow runs it exactly
// once (or, set to allow while it waits, the setting's allow, the flip waking the run); set to allow it runs once with
// no one asked. pi's rows are mcp-gate.test.mjs's (deny by key and by mcp:fake/*, the ask, allow by key and by mcp:fake/*).
// claude-agent runs the pinned Agent SDK and Claude CLI against a scripted Messages endpoint; codex the stand-in for
// Codex's app-server, its "model" the turn's text said through serve's gateway; opencode the stand-in for `opencode
// serve`, its model a scripted Responses endpoint. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { withToolSearch } from "./fixtures/claude-tool-search.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { agent, call, clientOwnerSession, follow, scratch, serve as serveOf, whenFree, withEnv } from "./support.mjs";

const TOKEN = `not-a-secret-${"mcp-gate-wired-0123"}`;
const json = { "content-type": "application/json" };
const HARNESSES = [...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : []), "codex", "opencode"];
const OPENCODE = fileURLToPath(new URL("./fixtures/fake-opencode-serve.mjs", import.meta.url));
const calls = (fake) => fake.log.filter((entry) => entry.method === "tools/call");

/** The last tool result a Messages conversation holds, as its text; undefined when it holds none. */
function resultIn(messages) {
  const results = messages.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((block) => block.type === "tool_result");
  const content = results.at(-1)?.content;
  if (results.length === 0) return undefined;
  return typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
}

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

/** serve's gateway on loopback for opencode's stand-in, a Responses model: a request with the add tool and no call's
 *  output yet calls it; one with an output says what the tool said; any other says "Noted.". */
async function callingGateway(t) {
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body || "{}");
    const output = (request.input ?? []).find((item) => item.type === "function_call_output")?.output;
    const tool = (request.tools ?? []).find((each) => each.name === "hands_mcp__fake__add");
    const text = output !== undefined ? `The tool said: ${output}` : "Noted.";
    const item = output === undefined && tool
      ? { type: "function_call", id: "fc_add", call_id: "call_add", name: tool.name, arguments: JSON.stringify({ a: 2, b: 3 }), status: "completed" }
      : { type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const events = [
      ...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text }] : []),
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "r1", object: "response", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 10 } } },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}` };
}

/** A server for `harness` with the fake MCP server saved, an owner who can answer approvals, and the run's prompt. */
async function setup(t, harness) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  let extra;
  let content;
  if (harness === "claude-agent") {
    const anthropic = await fakeAnthropic({
      // A model that answers from the call's result wherever the conversation holds it: on a resume the CLI goes on
      // past the parked call's result (written into its transcript before it starts) with a turn of its own. The MCP tool
      // is deferred behind the CLI's ToolSearch: the model finds it first (withToolSearch).
      reply: withToolSearch((request) => {
        const said = resultIn(request.messages);
        if (said !== undefined) return { text: `The tool said: ${said}` };
        return request.tools.includes("mcp__hands__mcp__fake__add") ? { tool: { name: "mcp__hands__mcp__fake__add", input: { a: 2, b: 3 } } } : { text: "Noted." };
      }),
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
    content = 'call mcp_fake__add {"a":2,"b":3}';
  }
  if (harness === "opencode") {
    const standIn = join(await scratch(t), "opencode-stand-in.mjs");
    await copyFile(OPENCODE, standIn);
    const gateway = await callingGateway(t);
    withEnv(t, {
      AGENTRUN_OPENCODE_STANDIN: "1",
      AGENTRUN_SERVE_OPENCODE_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn] }),
      AGENT_MODEL_BASE_URL: gateway.url,
      AGENT_MODEL: "gpt-test",
      AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    extra = { harness: "opencode" };
    content = "Add 2 and 3 with the add tool.";
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
    const made = await whenFree(() => server.api("POST", "/agents", agent(id, { tools: ["mcp:fake/add"], ...extra })));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const started = await whenFree(() => server.api("POST", `/agents/${id}/runs`, { input: { content } }));
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  return { api: server.api, fake, answer, run, model };
}

const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "";

/** The resumed call's answer reached the model. Codex's resume runs the parked call again under its own id
 *  (`callId`), hands Codex its result and nudges the turn on (its stand-in only echoes the nudge): its result row reads 5
 *  under that id. Every other harness's model answers from the result. */
async function answered(api, runId, rows, callId) {
  if (callId === undefined) return assert.match(await answerOf(api, runId), /5/);
  const results = rows.filter((row) => row.kind === "tool_result" && row.tool_name === "mcp__fake__add");
  assert.deepEqual(results.map((row) => [row.tool_use_id, row.tool_result_preview]), [[callId, "5"]], JSON.stringify(results));
}

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

  test(`${harness}: with no setting the call asks and parks, the MCP server sees nothing, and the owner's allow runs it exactly once`, { timeout: 240_000 }, async (t) => {
    const { api, fake, answer, run, model } = await setup(t, harness);
    const runId = await run(`ask-${harness}`);
    const { rows } = await follow(api, runId, ["input_required"], { deadlineMs: 180_000 });
    const pending = (await api("GET", `/runs/${runId}`)).body.pending;
    assert.deepEqual([pending?.kind, pending?.tool], ["approval", "mcp:fake/add"], JSON.stringify(pending));
    assert.equal(calls(fake).length, 0, "nothing sent while it waits");
    if (harness === "codex") {
      // What parks is Codex's own call id (its dynamicToolCall item's id), the one its Timeline rows carry, by the host's name.
      assert.match(pending.call_id, /^call_[0-9a-f]{20}$/);
      assert.deepEqual([...new Set(rows.filter((row) => row.tool_name === "mcp__fake__add").map((row) => row.tool_use_id))], [pending.call_id], JSON.stringify(rows.filter((row) => row.kind.startsWith("tool"))));
      // The turn ended at the parked result: the stand-in's next request (its answer after the call) never left.
      assert.deepEqual(model.seen, ["Calling mcp_fake__add."]);
    }
    assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
    const after = await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 });
    await answered(api, runId, after.rows, harness === "codex" ? pending.call_id : undefined);
    assert.equal(calls(fake).length, 1, "run exactly once");
  });

  test(`${harness}: a call parked on its person, its tool then set to allow, is answered by the setting, the flip alone waking the run: it runs once and its approval row reads allowed by the setting`, { timeout: 240_000 }, async (t) => {
    const { api, fake, run } = await setup(t, harness);
    const runId = await run(`flip-${harness}`);
    await follow(api, runId, ["input_required"], { deadlineMs: 180_000 });
    const pending = (await api("GET", `/runs/${runId}`)).body.pending;
    assert.equal(pending?.kind, "approval", "parked on the call's approval");
    assert.equal(calls(fake).length, 0, "nothing sent while it waits");
    // No one answers: the flip wakes the run, and its claim finds the setting at allow.
    assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } })).status, 200);
    const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 });
    await answered(api, runId, rows, harness === "codex" ? pending.call_id : undefined);
    assert.equal(calls(fake).length, 1, "run exactly once");
    const shown = JSON.stringify(rows.map((r) => `${r.kind}: ${r.summary}`));
    assert.deepEqual(rows.filter((r) => r.kind === "tool_approval_requested").map((r) => r.summary.split(":")[0]), ["Allowed by the tool's setting"], shown);
  });

  test(`${harness}: mcp:fake/* set to allow runs the call once with no one asked`,{ timeout: 240_000 }, async (t) => {
    const { api, fake, run } = await setup(t, harness);
    assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } })).status, 200);
    const runId = await run(`allow-${harness}`);
    const { last } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(last.status, "completed");
    assert.match(await answerOf(api, runId), harness === "codex" ? /^mcp_fake__add returned: 5/ : /The tool said: 5/);
    assert.equal(calls(fake).length, 1);
  });
}
