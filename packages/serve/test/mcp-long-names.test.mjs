// An MCP tool whose `mcp__<server>__<tool>` is past the 52 characters every harness's tool names share (Composio's Slack
// tool SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION: mcp__slack__SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION, 58)
// is granted like any other: the save keeps it, each harness is offered it under its wire name (catalog.ts wireName,
// hashed to 52), a call of that name reaches the server's tool, and the timeline and the analytics' top tools name it by
// its catalog name. Two grants
// whose wire names are one name are refused by name. A fake MCP server on loopback; no key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { withToolSearch } from "./fixtures/claude-tool-search.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { OFFERED_ENV } from "./fixtures/faux-mcp-offered.mjs";
import { stranger } from "./fixtures/stranger.mjs";
import { agent, follow, retried, scratch, serve as serveOf, withEnv } from "./support.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { wireName } from "../dist/catalog.js";

const FAUX_OFFERED = new URL("./fixtures/faux-mcp-offered.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"mcp-long-names-bearer"}`;
/** Composio's Slack tool for a thread's replies: there is no shorter tool for them. */
const LONG = "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION";
const CATALOG = `mcp:slack/${LONG}`;
const WIRE = wireName(CATALOG);
const ALLOW_SLACK = { "mcp:slack/*": { permission: "allow" } };
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const threadTool = { description: "Fetch a thread's replies.", input: object({ channel: { type: "string" }, ts: { type: "string" } }), run: ({ channel, ts }) => ({ content: [{ type: "text", text: `3 replies in ${channel} at ${ts}` }] }) };
const ARGS = { channel: "C1", ts: "1.5" };
const ANSWER = "3 replies in C1 at 1.5";
const serve = (t, options) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, options));
const callsOf = (fake) => fake.log.filter((entry) => entry.method === "tools/call").map((entry) => entry.tool);

/** The fake MCP server with the long tool (and `more` beside it), saved as `slack`. */
async function addSlack(t, api, more = {}) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  fake.tools[LONG] = threadTool;
  Object.assign(fake.tools, more);
  const saved = await api("PUT", "/settings/mcp-servers/slack", { url: fake.url, auth: { type: "bearer", token: TOKEN } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { fake, saved: saved.body };
}

const runOf = async (api, id, content) => {
  const run = await retried(api)("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return run.body.run_id;
};

/** The run's call of the long tool, read off its timeline: named by its catalog name, said `slack · <tool>`. */
function assertCatalogRow(rows) {
  const tools = rows.filter((row) => row.kind.startsWith("tool"));
  const call = rows.find((row) => row.kind === "tool_use" && row.tool_name === CATALOG);
  assert.ok(call, `the call's row names ${CATALOG}: ${JSON.stringify(tools)}`);
  assert.equal(call.summary, `slack · ${LONG}`, JSON.stringify(tools));
  assert.ok(!tools.some((row) => row.tool_name === WIRE), "no row names the wire name");
}

/** The analytics' top tools (GET /stats) count the run's call of the long tool under its catalog name, said
 *  `slack · <tool>`, as its timeline row reads: never under the hashed name the harness called it by. */
async function assertCatalogAnalytics(api) {
  const stats = await api("GET", "/stats");
  assert.equal(stats.status, 200, JSON.stringify(stats.body));
  const tools = stats.body.analytics.tools;
  assert.deepEqual(tools.filter((row) => row.label.includes("SLACK_")), [{ tool: CATALOG, label: `slack · ${LONG}`, calls: 1, errors: 0 }], JSON.stringify(tools));
}

test("the wire name of a 58-character MCP name is 52 characters, its own, and every harness's prefix keeps it within 64", () => {
  assert.equal(`mcp__slack__${LONG}`.length, 58);
  assert.ok(WIRE.length <= 52, WIRE);
  assert.match(WIRE, /^mcp__slack__SLACK_FETCH_MESSAGE_THREAD_FROM[A-Za-z0-9_]*-[0-9a-f]{8}$/);
  // Claude Code's `mcp__hands__<name>`, OpenCode's `hands_<name>`, Codex's `mcp_<server>__<tool>`.
  for (const offered of [`mcp__hands__${WIRE}`, `hands_${WIRE}`, WIRE.replace(/^mcp__/, "mcp_")]) assert.ok(offered.length <= 64, offered);
});

test("pi: a grant of the long Slack tool saves, the model is offered it under a wire name of 52 or fewer, its call reaches the tool, and the timeline names it by its catalog name", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const offered = join(dir, "offered.jsonl");
  withEnv(t, { [OFFERED_ENV]: offered });
  const { api } = await serve(t, { faux: FAUX_OFFERED, harnesses: true });
  const { fake, saved } = await addSlack(t, api);
  assert.equal(saved.tools.find((tool) => tool.name === LONG)?.grant_problems, undefined, "the server's read refuses no grant of it");
  const save = await retried(api)("POST", "/agents", agent("threads", { tools: [CATALOG], tool_settings: ALLOW_SLACK }));
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const runId = await runOf(api, "threads", `Call ${WIRE} with ${JSON.stringify(ARGS)}`);
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind.startsWith("tool"))));
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, `The tool said: ${ANSWER}`);
  const names = readFileSync(offered, "utf8").trim().split("\n").flatMap((line) => JSON.parse(line));
  assert.ok(names.includes(WIRE), `the model is offered ${WIRE}: ${JSON.stringify([...new Set(names)])}`);
  assert.deepEqual(names.filter((name) => name.length > 52), [], "no name the model is offered is past 52");
  assert.deepEqual(callsOf(fake), [LONG], "one call, of the server's own tool");
  assertCatalogRow(rows);
  await assertCatalogAnalytics(api);
});

test("claude-agent: the Claude CLI is offered the long Slack tool as mcp__hands__<wire name>, within 64, and its call reaches the tool", { timeout: 180_000, skip: process.platform !== "linux" ? "Linux only" : !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const HANDS = `mcp__hands__${WIRE}`;
  const anthropic = await fakeAnthropic({
    reply: withToolSearch((request) => (Object.keys(request.results).length ? { text: `The tool said: ${Object.values(request.results)[0]}` } : request.tools.includes(HANDS) ? { tool: { name: HANDS, input: ARGS } } : { text: "Noted." })),
  });
  t.after(() => anthropic.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" }, ["AGENT_MODEL_BASE_URL"]);
  const { api } = await serve(t, { faux: undefined });
  const { fake } = await addSlack(t, api);
  const save = await retried(api)("POST", "/agents", agent("claude-threads", { harness: "claude-agent", model: "anthropic/claude-haiku-4-5", tools: [CATALOG], tool_settings: ALLOW_SLACK }));
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const runId = await runOf(api, "claude-threads", "Fetch the thread's replies.");
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 150_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind.startsWith("tool"))));
  assert.match((await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "", new RegExp(`^The tool said: ${ANSWER}`));
  const offered = [...new Set(anthropic.requests.flatMap((request) => request.tools))];
  assert.ok(offered.includes(HANDS), `the model is offered ${HANDS}: ${JSON.stringify(offered)}`);
  assert.deepEqual(offered.filter((name) => name.length > 64), [], "no name the model is offered is past 64");
  assert.deepEqual(callsOf(fake), [LONG], "one call, of the server's own tool");
  assertCatalogRow(rows);
  await assertCatalogAnalytics(api);
});

/** serve's gateway on loopback: each Responses request answered with the text it carries. */
async function echoGateway(t) {
  const server = createServer(async (req, res) => {
    if (stranger(req, res, { own: (path) => path.startsWith("/v1/") })) return;
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

test("codex: Codex is given the long Slack tool as mcp_<wire name>, its call reaches the tool, and the timeline names it by its catalog name", { timeout: 90_000 }, async (t) => {
  const dir = await scratch(t);
  const standIn = join(dir, "codex-stand-in.mjs");
  await copyStandIn(standIn);
  withEnv(t, {
    AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"),
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: await echoGateway(t),
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
  }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  const { api } = await serveOf(t, { faux: undefined });
  const { fake } = await addSlack(t, api);
  const save = await retried(api)("POST", "/agents", agent("codex-threads", { harness: "codex", tools: [CATALOG], tool_settings: ALLOW_SLACK }));
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const given = WIRE.replace(/^mcp__/, "mcp_");
  const runId = await runOf(api, "codex-threads", `call ${given} ${JSON.stringify(ARGS)}`);
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind.startsWith("tool"))));
  assert.equal((await api("GET", `/runs/${runId}`)).body.result?.final_answer, `${given} returned: ${ANSWER}`);
  assert.deepEqual(callsOf(fake), [LONG], "one call, of the server's own tool");
  assertCatalogRow(rows);
  await assertCatalogAnalytics(api);
});

test("two grants whose wire names are one name are refused by name; either alone saves", async (t) => {
  const { api } = await serve(t, { faux: FAUX_OFFERED, harnesses: true });
  // A tool whose own `mcp__slack__<tool>` is, character for character, the long tool's hashed wire name.
  const twin = WIRE.slice("mcp__slack__".length);
  assert.equal(wireName(`mcp:slack/${twin}`), WIRE, "the two wire names are one");
  await addSlack(t, api, { [twin]: threadTool });
  const both = await retried(api)("POST", "/agents", agent("both", { tools: [CATALOG, `mcp:slack/${twin}`], tool_settings: ALLOW_SLACK }));
  assert.equal(both.status, 422, JSON.stringify(both.body));
  assert.ok(JSON.stringify(both.body).includes(`mcp:slack/${twin} and ${CATALOG} are called by one name on every harness (${WIRE}): grant one of them by name.`), JSON.stringify(both.body));
  for (const [id, tool] of [["long-alone", CATALOG], ["twin-alone", `mcp:slack/${twin}`]]) {
    const one = await retried(api)("POST", "/agents", agent(id, { tools: [tool], tool_settings: ALLOW_SLACK }));
    assert.equal(one.status, 201, `${tool} alone: ${JSON.stringify(one.body)}`);
  }
});
