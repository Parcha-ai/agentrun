// A per_run MCP server a run was handed no credential for (no mcp_auth for it): its tools are left out of the run's, so
// the model is never offered a tool whose every call would be refused, and the run's timeline says which server and why
// (mcp-probe.ts unconnectedWords). A run handed one is offered its tools as before, and its call reaches the server. Both
// spec builders: pi's (adapter-run-spec.ts) and a CLI harness's (cli-run-spec.ts, Codex's stand-in here). A fake MCP
// server on loopback; no key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { OFFERED_ENV } from "./fixtures/faux-mcp-offered.mjs";
import { stranger } from "./fixtures/stranger.mjs";
import { agent, follow, retried, scratch, serve as serveOf, withEnv } from "./support.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";

const { unconnectedWords } = await import("../dist/mcp-probe.js");

const FAUX_OFFERED = new URL("./fixtures/faux-mcp-offered.mjs", import.meta.url).pathname;
const LIST = `not-a-secret-${"left-out-list-token"}`;
const RUN = `not-a-secret-${"left-out-run-token"}`;
const ALLOW = { "mcp:gw/add": { permission: "allow" } };
const handed = { gw: { headers: { authorization: `Bearer ${RUN}` } } };
const callsOf = (fake) => fake.log.filter((entry) => entry.method === "tools/call").map((entry) => entry.tool);
/** The server's phase rows on a run's timeline that speak of the server `gw` (not a call's "Not metered" row). */
const notesOf = (rows) => rows.filter((row) => row.kind === "phase" && String(row.summary ?? "").startsWith("The MCP server gw")).map((row) => row.summary);

/** The fake MCP server saved as the per_run server `gw`: it lists its tools to the save's token and answers a run's. */
async function addGw(t, api) {
  const fake = await startFakeMcp({ token: (authorization) => [LIST, RUN].some((token) => authorization === `Bearer ${token}`) });
  t.after(() => fake.close());
  const saved = await api("PUT", "/settings/mcp-servers/gw", { url: fake.url, auth: { type: "per_run", headers: { authorization: `Bearer ${LIST}` } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return fake;
}

/** `id` run once to its end with `content` (and `mcp_auth`, when given): its timeline's rows and its final answer. */
async function runOnce(api, id, content, mcp_auth) {
  const started = await retried(api)("POST", `/agents/${id}/runs`, { input: { content }, ...(mcp_auth ? { mcp_auth } : {}) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows, last } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind === "phase" || row.kind.startsWith("tool"))));
  return { rows, answer: String((await api("GET", `/runs/${started.body.run_id}`)).body.result?.final_answer ?? "") };
}

test("pi: a run handed no credential for a per_run server is offered none of its tools and is told why on its timeline; a run handed one is offered them and its call reaches the server", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const offered = join(dir, "offered.jsonl");
  withEnv(t, { [OFFERED_ENV]: offered, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serveOf(t, { faux: FAUX_OFFERED, harnesses: true });
  const fake = await addGw(t, api);
  const save = await retried(api)("POST", "/agents", agent("reader", { tools: ["mcp:gw/add"], tool_settings: ALLOW }));
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const offeredNames = () => readFileSync(offered, "utf8").trim().split("\n").flatMap((line) => JSON.parse(line));

  const bare = await runOnce(api, "reader", "Hi");
  assert.deepEqual(offeredNames().filter((name) => name.startsWith("mcp__gw__")), [], `no tool of gw offered: ${JSON.stringify([...new Set(offeredNames())])}`);
  assert.deepEqual(notesOf(bare.rows), [unconnectedWords("gw")], "one note naming the server and why");
  assert.deepEqual(callsOf(fake), [], "nothing sent to the server");

  const given = await runOnce(api, "reader", 'Call mcp__gw__add with {"a":2,"b":3}', handed);
  assert.ok(offeredNames().includes("mcp__gw__add"), "the handed run is offered the server's tool");
  assert.equal(given.answer, "The tool said: 5");
  assert.deepEqual(callsOf(fake), ["add"], "its call reached the server");
  assert.deepEqual(notesOf(given.rows), [], "and no note");
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

test("codex: a run handed no credential for a per_run server is given none of its tools and is told why on its timeline; a run handed one is given them and its call reaches the server", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const standIn = join(dir, "codex-stand-in.mjs");
  await copyStandIn(standIn);
  // The stand-in's own note of the dynamic tools each thread is given (FAKE_CODEX_OFFERED).
  const offeredFile = join(dir, "offered.jsonl");
  const offered = () => readFileSync(offeredFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  withEnv(t, {
    AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"),
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote", FAKE_CODEX_OFFERED: offeredFile } }),
    AGENT_MODEL_BASE_URL: await echoGateway(t),
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
  }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  const { api } = await serveOf(t, { faux: undefined });
  const fake = await addGw(t, api);
  const save = await retried(api)("POST", "/agents", agent("codex-reader", { harness: "codex", tools: ["mcp:gw/add"], tool_settings: ALLOW }));
  assert.equal(save.status, 201, JSON.stringify(save.body));

  const bare = await runOnce(api, "codex-reader", "Hi");
  const [first] = offered();
  assert.ok(Array.isArray(first), "the run's thread was started");
  assert.deepEqual(first.filter((name) => name.includes("gw")), [], `no tool of gw given: ${JSON.stringify(first)}`);
  assert.deepEqual(notesOf(bare.rows), [unconnectedWords("gw")], "one note naming the server and why");
  assert.deepEqual(callsOf(fake), [], "nothing sent to the server");

  const given = await runOnce(api, "codex-reader", 'call mcp_gw__add {"a":2,"b":3}', handed);
  const second = offered().at(-1);
  assert.ok(second.includes("mcp_gw__add"), `the handed run is given the server's tool: ${JSON.stringify(second)}`);
  assert.equal(given.answer, "mcp_gw__add returned: 5");
  assert.deepEqual(callsOf(fake), ["add"], "its call reached the server");
  assert.deepEqual(notesOf(given.rows), [], "and no note");
});
