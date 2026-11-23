// A per_run MCP server a run was handed no credential for (no mcp_auth for it). On a harness that takes its tools again at
// each claim (pi here; Claude Code, OpenCode and the ACP agents the same way), its tools are left out of the claim's, so
// the model is never offered a tool whose every call would be refused, and the run's timeline says which server and why
// (mcp-probe.ts unconnectedWords); a message that hands the credential brings them back at the run's next claim. Codex
// keeps the dynamic tools its thread was started with (thread/resume takes none: AdapterFacts.toolsFixedAtStart), so its
// run is given the server's tools from the start, a call of one refused unsent until the credential comes, and then
// answered. One run each, its first claim with no mcp_auth and a message carrying it. A fake MCP server on loopback; no
// key, no network.
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

/** `id` started with `content` and run to its end: its id, timeline rows and final answer. */
async function start(api, id, content) {
  const started = await retried(api)("POST", `/agents/${id}/runs`, { input: { content } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return { id: started.body.run_id, ...(await settled(api, started.body.run_id)) };
}

/** Run `runId` sent `content` with `mcp_auth` and run to its end again: its timeline rows and final answer. */
async function message(api, runId, content, mcp_auth) {
  const sent = await api("POST", `/runs/${runId}/messages`, { content, mcp_auth });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  return settled(api, runId);
}

async function settled(api, runId) {
  const { rows, last } = await follow(api, runId, ["completed", "failed"], { after: 0, deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind === "phase" || row.kind.startsWith("tool"))));
  return { rows, answer: String((await api("GET", `/runs/${runId}`)).body.result?.final_answer ?? "") };
}

test("pi: a run's first claim, handed no credential for a per_run server, is offered none of its tools and says why on the timeline; a message that hands the credential brings them back on the same run, and its call reaches the server", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const offered = join(dir, "offered.jsonl");
  withEnv(t, { [OFFERED_ENV]: offered, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await serveOf(t, { faux: FAUX_OFFERED, harnesses: true });
  const fake = await addGw(t, api);
  const save = await retried(api)("POST", "/agents", agent("reader", { tools: ["mcp:gw/add"], tool_settings: ALLOW }));
  assert.equal(save.status, 201, JSON.stringify(save.body));
  const offeredNames = () => readFileSync(offered, "utf8").trim().split("\n").flatMap((line) => JSON.parse(line));

  const bare = await start(api, "reader", "Hi");
  assert.deepEqual(offeredNames().filter((name) => name.startsWith("mcp__gw__")), [], `no tool of gw offered: ${JSON.stringify([...new Set(offeredNames())])}`);
  assert.deepEqual(notesOf(bare.rows), [unconnectedWords("gw")], "one note naming the server and why");
  assert.deepEqual(callsOf(fake), [], "nothing sent to the server");

  const given = await message(api, bare.id, 'Call mcp__gw__add with {"a":2,"b":3}', handed);
  assert.ok(offeredNames().includes("mcp__gw__add"), "the next claim of the same run is offered the server's tool");
  assert.equal(given.answer, "The tool said: 5");
  assert.deepEqual(callsOf(fake), ["add"], "its call reached the server");
  assert.deepEqual(notesOf(given.rows), [unconnectedWords("gw")], "and no second note");
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

test("codex: a run handed no credential for a per_run server is given its tools from its thread's start, a call of one refused unsent with no note; a message that hands the credential reaches the same thread, and its call reaches the server", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const standIn = join(dir, "codex-stand-in.mjs");
  await copyStandIn(standIn);
  // The stand-in's own note of the dynamic tools its thread has, at each start and resume (FAKE_CODEX_OFFERED).
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

  const bare = await start(api, "codex-reader", 'call mcp_gw__add {"a":2,"b":3}');
  const [first] = offered();
  assert.ok(first.includes("mcp_gw__add"), `the thread is started with the server's tool: ${JSON.stringify(first)}`);
  assert.match(bare.answer, /^mcp_gw__add failed: .*this run was handed none/, "its call refused in the per_run missing words");
  assert.deepEqual(callsOf(fake), [], "nothing sent to the server");
  assert.deepEqual(notesOf(bare.rows), [], "no note: nothing was left out");

  const given = await message(api, bare.id, 'call mcp_gw__add {"a":2,"b":3}', handed);
  assert.ok(offered().length >= 2 && offered().at(-1).includes("mcp_gw__add"), `the resumed thread still has the server's tool: ${JSON.stringify(offered())}`);
  assert.equal(given.answer, "mcp_gw__add returned: 5");
  assert.deepEqual(callsOf(fake), ["add"], "its call reached the server with the message's credential");
});
