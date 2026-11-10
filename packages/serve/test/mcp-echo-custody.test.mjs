// A remote MCP server that answers a tool call with the very credential it was sent: its bearer and a saved header's value.
// Through the API, on pi (the faux model, the runner's host tool) and on codex (the stand-in for Codex's app-server, whose
// own MCP client calls the session's door): after the run, neither value is in any journal entry or row of the store, any
// timeline row or the run's view, any file under the data directory, or anything the server or its runner logged. The
// scrub is the gateway's (each call's credential values, and any refreshed while it was out); nothing else holds them.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, scratch, serve, storeBytes, withEnv } from "./support.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
/** The server's bearer and a header value saved beside it: no real ones. */
const TOKEN = `not-a-secret-${"echoed-bearer-0123456789"}`;
const VALUE = `not-a-secret-${"echoed-header-value-98765"}`;
const ALLOW = { "mcp:echo/*": { permission: "allow" } };

/** The fake MCP server with a tool `whoami` that answers with the Authorization header and the X-Region-Key header its
 *  call carried, word for word, and a count of its calls. */
async function echoServer(t) {
  let seen = {};
  const fake = await startFakeMcp({ token: TOKEN, inspect: (headers) => (seen = headers) });
  t.after(() => fake.close());
  fake.tools.whoami = {
    description: "Say who called.",
    input: { type: "object", properties: {}, additionalProperties: false },
    run: () => ({ content: [{ type: "text", text: `authorization: ${seen.authorization}; region key: ${seen["x-region-key"]}` }] }),
  };
  return fake;
}

/** Everything the server process writes to its stdout and stderr while the test runs (the runner is in-process). */
function logsOf(t) {
  const chunks = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write;
    stream.write = function (chunk, ...rest) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return write.call(this, chunk, ...rest);
    };
    t.after(() => (stream.write = write));
  }
  return () => chunks.join("");
}

/** Every file under `dir`, recursively, as text (latin1: bytes kept one to one). */
async function filesUnder(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push({ path: join(entry.parentPath, entry.name), text: await readFile(join(entry.parentPath, entry.name), "latin1").catch(() => "") });
  }
  return out;
}

/** Saves the echo server with its bearer and a header beside it, makes `name` granted its whoami on `harness`, runs
 *  `content`, and checks the run answered from the tool, and where neither value is. */
async function echoRun(t, { api, data }, logs, { harness, content, answered }) {
  const fake = await echoServer(t);
  const saved = await api("PUT", "/settings/mcp-servers/echo", { url: fake.url, auth: { type: "headers", headers: { Authorization: `Bearer ${TOKEN}`, "X-Region-Key": VALUE } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await api("POST", "/agents", agent(`echo-${harness}`, { ...(harness === "pi" ? {} : { harness }), tools: ["mcp:echo/whoami"], tool_settings: ALLOW }))).status, 201);
  const run = await api("POST", `/agents/echo-${harness}/runs`, { input: { content } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const runId = run.body.run_id;
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  // The call went, with both values, and its answer echoed them: the run answered from that answer.
  assert.deepEqual(fake.log.filter((entry) => entry.method === "tools/call").map((entry) => [entry.tool, entry.authorization]), [["whoami", true]], `${harness}: one call, with the bearer`);
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.match(view.result?.final_answer ?? "", answered, `${harness}: the run read the tool's answer`);
  const where = [
    { path: "the run's view", text: JSON.stringify(view) },
    { path: "the timeline", text: JSON.stringify((await api("GET", `/runs/${runId}/timeline?limit=500`)).body) },
    { path: "the store's files (its journal and rows)", text: storeBytes(data).toString("latin1") },
    ...(await filesUnder(data)),
    { path: "the server's and runner's logs", text: logs() },
  ];
  assert.ok(storeBytes(data).length > 0 && where.length > 5, `${harness}: the store and the data directory are read`);
  for (const [name, secret] of [["bearer", TOKEN], ["header value", VALUE]]) {
    assert.deepEqual(where.filter((place) => place.text.includes(secret)).map((place) => place.path), [], `${harness}: the ${name} is nowhere`);
  }
}

test("pi: an MCP server that echoes its bearer and a header value in its answer: neither reaches a journal entry, a row, a file or a log", { timeout: 90_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const logs = logsOf(t);
  const server = await serve(t, { faux: FAUX_MCP, harnesses: true });
  await echoRun(t, server, logs, { harness: "pi", content: "Call mcp__echo__whoami with {}", answered: /^The tool said: authorization: .+; region key: .+$/ });
});

/** serve's model gateway on loopback: each Responses request answered with the text it carries, and its usage. */
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

test("codex: an MCP server that echoes its bearer and a header value to Codex's own MCP client: neither reaches a journal entry, a row, a file or a log", { timeout: 90_000 }, async (t) => {
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyStandIn(standIn);
  withEnv(t, {
    AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"),
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: await echoGateway(t),
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
  }, ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  const logs = logsOf(t);
  const server = await serve(t, { faux: undefined });
  await echoRun(t, server, logs, { harness: "codex", content: "mcp echo whoami {}", answered: /^whoami returned: authorization: .+; region key: .+ \(item \S+\)$/ });
});
