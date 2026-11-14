// A template applied under approvals never, the owner ticking one of a saved MCP server's two tools: the tool left
// unticked is never offered to the model nor run, on pi, claude-agent and codex. The run's scripted model calls it
// anyway: the call is refused and the fake MCP server never sees it. The ticked tool runs with no one asked. Never only
// skips asking for a tool its owner ticked; it grants nothing. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { withToolSearch } from "./fixtures/claude-tool-search.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { OFFERED_ENV } from "./fixtures/faux-mcp-offered.mjs";
import { twoToolPackage } from "./fixtures/two-tool-template.mjs";
import { follow, scratch, serve, whenFree, withEnv } from "./support.mjs";

const HARNESSES = ["pi", ...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : []), "codex"];
const FAUX_OFFERED = new URL("./fixtures/faux-mcp-offered.mjs", import.meta.url).pathname;
const TICKED = "mcp:fake/add";
const UNTICKED = "mcp:fake/delete_thing";
const callsOf = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool);

/** serve's gateway on loopback for codex's stand-in: each Responses request answered with the text it carries. */
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

/** A server for `harness` whose scripted model makes the call each prompt names: `prompt(tool, args)`, the run's input
 *  that makes it; `offered()`, the tool names each model request offered (pi's and claude-agent's; codex's stand-in
 *  reports none, so its refusal is the offer); `wire(tool)`, the name the harness offers an MCP tool by (a host tool:
 *  pi's `mcp__<server>__<tool>`, Claude Code's `mcp__hands__` before it, Codex's `mcp_<server>__<tool>`). */
async function setup(t, harness, templates) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const offeredLists = [];
  let prompt;
  let offered = () => offeredLists;
  let options = { faux: undefined };
  let wire = (tool) => `mcp__fake__${tool}`;
  if (harness === "pi") {
    const file = join(await scratch(t), "offered.jsonl");
    withEnv(t, { [OFFERED_ENV]: file });
    options = { faux: FAUX_OFFERED };
    prompt = (tool, args) => `Call mcp__fake__${tool} with ${JSON.stringify(args)}`;
    offered = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  }
  if (harness === "claude-agent") {
    // The model calls the tool the prompt names whether or not it is offered, then answers with what came back. The MCP
    // tools are deferred behind the CLI's ToolSearch, so it searches first (withToolSearch), as a real model does.
    const answer = withToolSearch((request) => {
      if (Object.keys(request.results).length) return { text: `The tool said: ${Object.values(request.results)[0]}` };
      const asked = /CALL (\w+) (\{[^}]*\})/.exec(request.text);
      return asked ? { tool: { name: `mcp__hands__mcp__fake__${asked[1]}`, input: JSON.parse(asked[2]) } } : { text: "Noted." };
    });
    const anthropic = await fakeAnthropic({
      reply: (request) => {
        offeredLists.push(request.tools);
        return answer(request);
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
    prompt = (tool, args) => `CALL ${tool} ${JSON.stringify(args)}`;
    wire = (tool) => `mcp__hands__mcp__fake__${tool}`;
  }
  if (harness === "codex") {
    const standIn = join(await scratch(t), "codex-stand-in.mjs");
    await copyStandIn(standIn);
    withEnv(t, {
      AGENTRUN_CODEX_STANDIN: "1",
      AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
      AGENT_MODEL_BASE_URL: await echoGateway(t),
      AGENT_MODEL: "gpt-test",
      AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    prompt = (tool, args) => `call mcp_fake__${tool} ${JSON.stringify(args)}`;
    wire = (tool) => `mcp_fake__${tool}`;
  }
  const server = await serve(t, { ...options, templates, accounts: true, openSetup: true });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  assert.equal((await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" }, toolkit: "fake" })).status, 200);
  return { api: server.api, fake, prompt, offered, wire };
}

for (const harness of HARNESSES) {
  test(`${harness}: a template applied under never with one of two MCP tools ticked: the unticked one is never offered, a call of it is refused and never sent; the ticked one runs with no one asked`, { timeout: 240_000 }, async (t) => {
    const dir = join(await scratch(t), "templates");
    twoToolPackage(dir, `two-tools-${harness}`, harness);
    const { api, fake, prompt, offered, wire } = await setup(t, harness, dir);
    const applied = await whenFree(() => api("POST", `/templates/two-tools-${harness}/apply`, { grants: [TICKED] }));
    assert.equal(applied.status, 201, JSON.stringify(applied.body));
    const id = applied.body.agent_id;
    const agent = (await api("GET", `/agents/${id}`)).body;
    assert.deepEqual([agent.definition.harness, agent.definition.approvals], [harness, "never"]);

    // The model calls the unticked tool: refused, never parked on anyone, never sent.
    const refused = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: prompt("delete_thing", { id: "x1" }) } }));
    assert.equal(refused.status, 202, JSON.stringify(refused.body));
    const { last } = await follow(api, refused.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.notEqual(last.status, "input_required", "nothing asks: the call is refused outright");
    assert.deepEqual(callsOf(fake, "delete_thing"), [], "the unticked tool never reached the MCP server");
    for (const tools of offered()) assert.ok(!tools.includes(wire("delete_thing")), `the unticked tool was offered: ${JSON.stringify(tools)}`);

    // The ticked tool runs, unasked.
    const ran = await whenFree(() => api("POST", `/agents/${id}/runs`, { input: { content: prompt("add", { a: 2, b: 3 }) } }));
    assert.equal(ran.status, 202, JSON.stringify(ran.body));
    const done = await follow(api, ran.body.run_id, ["completed", "failed", "input_required"], { deadlineMs: 180_000 });
    assert.equal(done.last.status, "completed", JSON.stringify(done.last));
    assert.equal(callsOf(fake, "add").length, 1, "the ticked tool ran once, with no one asked");
    assert.match((await api("GET", `/runs/${ran.body.run_id}`)).body.result?.final_answer ?? "", /5/);
    if (harness !== "codex") assert.ok(offered().some((tools) => tools.includes(wire("add"))), `the ticked tool was offered: ${JSON.stringify(offered())}`);
    // At the source: the apply never granted it.
    assert.ok(!agent.definition.tools.includes(UNTICKED), `the unticked tool is not the agent's: ${JSON.stringify(agent.definition.tools)}`);
  });
}
