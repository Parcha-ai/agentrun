// A server for one harness (pi, claude-agent or codex) whose scripted model makes the MCP call each run's input names,
// with the fake MCP server (fake-mcp-server.mjs) saved as `fake`: what the gate tests of MCP tools under approvals never
// share. No socket leaves this machine and no real key is used.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { copyStandIn } from "../../../run-adapters-codex/test/stand-in.mjs";
import { withToolSearch } from "./claude-tool-search.mjs";
import { startFakeMcp } from "./fake-mcp-server.mjs";
import { OFFERED_ENV } from "./faux-mcp-offered.mjs";
import { scratch, serve, withEnv } from "../support.mjs";

/** The harnesses these tests run on: claude-agent where its sandbox can start (setpriv). */
export const HARNESSES = ["pi", ...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : []), "codex"];
const FAUX_OFFERED = new URL("./faux-mcp-offered.mjs", import.meta.url).pathname;
/** The calls of `tool` the fake MCP server was sent. */
export const callsOf = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && entry.tool === tool);

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

/** A server for `harness` (its templates from `templates`) whose scripted model makes the call each prompt names:
 *  `prompt(tool, args)`, the run's input that makes it (args may nest objects); `host(tool, args)`, the input that calls
 *  the run's host tool `tool` (tools_call, codemode) by its bare name, as the harness offers it (Claude Code's under
 *  `mcp__hands__`); from inside one, an MCP tool is named by its host name, `mcp__<server>__<tool>`; `offered()`, the tool names each model
 *  request offered (pi's and claude-agent's; codex's stand-in reports none, so its refusal is the offer); `wire(tool)`,
 *  the name the harness offers an MCP tool by (a host tool: pi's `mcp__<server>__<tool>`, Claude Code's `mcp__hands__`
 *  before it, Codex's `mcp_<server>__<tool>`). `tools`: tools added to the fake's before it is saved, by name. */
export async function harnessSetup(t, harness, templates, { tools = {} } = {}) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const offeredLists = [];
  let prompt;
  let offered = () => offeredLists;
  let options = { faux: undefined };
  let wire = (tool) => `mcp__fake__${tool}`;
  let host;
  if (harness === "pi") {
    const file = join(await scratch(t), "offered.jsonl");
    withEnv(t, { [OFFERED_ENV]: file });
    options = { faux: FAUX_OFFERED };
    prompt = (tool, args) => `Call mcp__fake__${tool} with ${JSON.stringify(args)}`;
    host = (tool, args) => `Call ${tool} with ${JSON.stringify(args)}`;
    offered = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  }
  if (harness === "claude-agent") {
    // The model calls the tool the prompt names whether or not it is offered, then answers with what came back. The MCP
    // tools are deferred behind the CLI's ToolSearch, so it searches first (withToolSearch), as a real model does.
    const answer = withToolSearch((request) => {
      if (Object.keys(request.results).length) return { text: `The tool said: ${Object.values(request.results)[0]}` };
      const own = /CALLHOST (\w+) (\{.*\})/.exec(request.text);
      if (own) return { tool: { name: `mcp__hands__${own[1]}`, input: JSON.parse(own[2]) } };
      const asked = /CALL (\w+) (\{.*\})/.exec(request.text);
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
    host = (tool, args) => `CALLHOST ${tool} ${JSON.stringify(args)}`;
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
    host = (tool, args) => `call ${tool} ${JSON.stringify(args)}`;
    wire = (tool) => `mcp_fake__${tool}`;
  }
  const server = await serve(t, { ...options, templates, accounts: true, openSetup: true });
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  Object.assign(fake.tools, tools);
  assert.equal((await server.api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "none" } })).status, 200);
  return { api: server.api, fake, prompt, host, offered, wire };
}
