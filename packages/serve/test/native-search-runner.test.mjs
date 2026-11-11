// A pi run's own web_search, resolved native (the model provider's hosted search), runs on the runner (#2458): one
// request to the run's provider with its hosted search tool, through the run's one route (the session's model proxy:
// its policy, key, price and cap), its search fee booked with its tokens, and the tool answers the search, never
// "no model to search on". The provider is a loopback stand-in: pi's own turns scripted (a faux gateway's Messages), the
// hosted search answered as Anthropic streams it (faux-upstream.mjs).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { entriesOf } from "./learn-support.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const SEARCH_TOOL = "web_search_20250305";

/** pi's turn: a call of web_search once, then text. */
const script = ({ body }) => {
  const offers = (body?.tools ?? []).some((tool) => tool?.name === "web_search" && tool?.type !== SEARCH_TOOL);
  const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result"));
  return offers && !answered ? { name: "web_search", input: { query: "the answer" } } : undefined;
};

/** A provider on loopback: a request offering the hosted search tool is answered as Anthropic's search (faux-upstream),
 *  filed in `calls`; any other goes to the faux gateway, which scripts pi's turns. */
async function provider(t) {
  const gw = await startFauxGateway({ call: script, text: "Done." });
  t.after(() => gw.close());
  const calls = join(await scratch(t), "upstream.jsonl");
  const send = (await import("./fixtures/faux-upstream.mjs")).default;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    const hosted = (body.tools ?? []).some((tool) => tool?.type === SEARCH_TOOL);
    const answer = hosted
      ? await send(`http://upstream.invalid${req.url}`, { method: req.method, headers: req.headers, body: raw })
      : await fetch(`${gw.url}${req.url}`, { method: req.method, headers: { "content-type": "application/json", "x-api-key": String(req.headers["x-api-key"] ?? "") }, body: raw });
    res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

test("a pi run's own web_search, resolved native, searches on the runner through the run's route: the provider's hosted search, its fee booked, the tool answering the results", { timeout: 120_000 }, async (t) => {
  const { url, calls } = await provider(t);
  withEnv(t, { ANTHROPIC_API_KEY: ["not-a-secret", "anthropic"].join("-"), ANTHROPIC_BASE_URL: url, AGENT_MODEL: "anthropic/claude-sonnet-4-5", AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: calls }, ["PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "OPENROUTER_API_KEY", "AGENTRUN_TEST_FAUX_UPSTREAM"]);
  const { api, data } = await serve(t, { faux: undefined });
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "native" } })).status, 200);
  assert.equal((await api("POST", "/agents", agent("searcher", { harness: "pi", tools: ["web_search"], instructions: "Search for the answer." }))).status, 201);
  const started = await api("POST", "/agents/searcher/runs", { input: { content: "What is the answer?" }, max_cost_usd: 5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { rows } = await follow(api, started.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === "web_search");
  assert.equal(result?.tool_status, "success", JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.summary])));
  assert.doesNotMatch(JSON.stringify(result), /no model to search on/);
  assert.match(JSON.stringify(result), /public\.example/, JSON.stringify(result));
  const sent = readFileSync(calls, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => call.path), ["/v1/messages"], "one request to the provider's hosted search");
  // Booked on the run's one route: a side request labelled web_search, its search ($0.01) on top of its tokens.
  const records = await entriesOf({ data }, started.body.run_id, ["runner.request", "runner.turn"]);
  const search = records.filter((entry) => entry.kind === "runner.request" && entry.host === "web_search");
  assert.equal(search.length, 1, JSON.stringify(records));
  const turn = records.find((entry) => entry.kind === "runner.turn" && entry.turn === search[0].turn);
  // claude-sonnet-4-5 at $3 and $15 a million: 20,000 in and 40 out, plus one search at $0.01.
  assert.ok(Math.abs(turn.usd - (20_000 * 3 / 1e6 + 40 * 15 / 1e6 + 0.01)) < 1e-9, `its tokens and its search: ${JSON.stringify(turn)}`);
});
