// Every MCP tool call passes the run's one tool gate, on pi and on claude-agent, through the API: with the server's
// mcp:fake/* set to deny the call is refused and the fake MCP server sees nothing; with no setting it asks, parks, and
// the owner's allow runs it exactly once; set to allow it runs once with no one asked. claude-agent runs the pinned
// Agent SDK and Claude CLI against a scripted Messages endpoint. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, call, cookieOf, follow, serve as serveOf, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"mcp-gate-wired-0123"}`;
const PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
const HARNESSES = ["pi", ...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : [])];
const calls = (fake) => fake.log.filter((entry) => entry.method === "tools/call");

/** A server for `harness` with the fake MCP server saved, an owner who can answer approvals, and the run's prompt. */
async function setup(t, harness) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  let extra = {};
  let content = 'Call mcp__fake__add with {"a":2,"b":3}';
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
  const server = await serveOf(t, { faux: harness === "pi" ? FAUX_MCP : undefined, accounts: true, openSetup: true });
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const saved = await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const origin = `http://127.0.0.1:${server.port}`;
  const signedIn = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: PHRASE } });
  assert.equal(signedIn.status, 201, signedIn.text);
  const cookie = cookieOf(signedIn);
  const answer = async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
  const run = async (id) => {
    assert.equal((await server.api("POST", "/agents", agent(id, { tools: ["mcp:fake/add"], ...extra }))).status, 201);
    const started = await server.api("POST", `/agents/${id}/runs`, { input: { content } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    return started.body.run_id;
  };
  return { api: server.api, fake, answer, run };
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

  test(`${harness}: with no setting the call asks and parks, the MCP server sees nothing, and the owner's allow runs it exactly once`, { timeout: 240_000 }, async (t) => {
    const { api, fake, answer, run } = await setup(t, harness);
    const runId = await run(`ask-${harness}`);
    await follow(api, runId, ["input_required"], { deadlineMs: 180_000 });
    const pending = (await api("GET", `/runs/${runId}`)).body.pending;
    assert.deepEqual([pending?.kind, pending?.tool], ["approval", "mcp:fake/add"], JSON.stringify(pending));
    assert.equal(calls(fake).length, 0, "nothing sent while it waits");
    assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 180_000 });
    assert.match(await answerOf(api, runId), /5/);
    assert.equal(calls(fake).length, 1, "run exactly once");
  });

  test(`${harness}: mcp:fake/* set to allow runs the call once with no one asked`, { timeout: 240_000 }, async (t) => {
    const { api, fake, run } = await setup(t, harness);
    assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } })).status, 200);
    const runId = await run(`allow-${harness}`);
    const { last } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(last.status, "completed");
    assert.match(await answerOf(api, runId), /The tool said: 5/);
    assert.equal(calls(fake).length, 1);
  });
}
