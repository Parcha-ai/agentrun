// A run's GitHub token, through the API: an MCP server saved with auth {type: "github_app"} holds no token of its own;
// at each launch of a run that grants its tools, the server mints an installation token from the connected App (the
// fake GitHub of github-support.mjs), narrowed to the one repository the run is about (its GitHub event's, or the one
// its input names), and hands it to the run's gateway beside the entry's static headers. The token is never in a file
// of the run, and never shown: what a run shows is cut of it.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { connect, connectable, deliver } from "./github-support.mjs";
import { agent, follow, runDir } from "./support.mjs";
import { firings } from "./trigger-support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ALLOW = { "mcp:gh/*": { permission: "allow" } };
const pr = { action: "opened", number: 12, pull_request: { draft: false }, repository: { full_name: "acme/widgets" }, installation: { id: 777 } };

/** A connected server with an MCP server `gh` on the App's tokens: the fake takes only a token GitHub minted, and keeps
 *  what each request's Authorization and X-MCP-Tools said. */
async function withGitHubMcp(t) {
  const server = await connectable(t, { faux: FAUX_MCP, harnesses: true });
  await connect(server);
  const seen = [];
  const minted = () => server.github.tokens.map((entry) => `Bearer ${entry.token}`);
  const fake = await startFakeMcp({ token: (authorization) => minted().includes(authorization), inspect: (headers) => seen.push({ authorization: headers.authorization, tools: headers["x-mcp-tools"] }) });
  t.after(() => fake.close());
  // A tool that answers what it was called with: the credential, as a careless server might echo it.
  fake.tools.whoami = { description: "Say who called.", input: { type: "object", properties: {}, additionalProperties: false }, run: () => ({ content: [{ type: "text", text: String(seen.at(-1)?.authorization) }] }) };
  const saved = await server.api("PUT", "/settings/mcp-servers/gh", { url: fake.url, auth: { type: "github_app", headers: { "X-MCP-Tools": "add,whoami" } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.auth.type, "github_app");
  return { server, fake, seen };
}

const files = async (dir) => Promise.all((await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map(async (e) => ({ path: join(e.parentPath, e.name), text: await readFile(join(e.parentPath, e.name), "utf8").catch(() => "") })));

test("demo: a github trigger's run calls the MCP server with an installation token minted for it, narrowed to the event's repository, beside the entry's static headers; no file of the run holds the token", { timeout: 120_000 }, async (t) => {
  const { server, seen } = await withGitHubMcp(t);
  assert.equal((await server.api("POST", "/agents", agent("review", { tools: ["mcp:gh/add"], tool_settings: ALLOW }))).status, 201);
  const made = await server.api("POST", "/triggers", { name: "reviews", source: { kind: "github", accept: [{ event: "pull_request" }] }, target: { kind: "start_run", agent_id: "review", input: { content: 'Call mcp__gh__add with {"a":2,"b":3}' }, max_cost_usd: 0.5 } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal((await deliver(server.baseUrl, server.github.app.webhook_secret, "pull_request", pr)).status, 202);
  const [fired] = await firings(server.api, made.body.id, 1);
  const { last } = await follow(server.api, fired.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  assert.equal((await server.api("GET", `/runs/${fired.run_id}`)).body.result?.final_answer, "The tool said: 5");
  const mints = server.github.tokens;
  assert.equal(mints.length, 1, "one token, for this run's launch");
  assert.deepEqual([mints[0].installation, mints[0].repositories], [777, ["widgets"]], "the event's installation, narrowed to its one repository");
  const calls = seen.filter((request) => request.authorization === `Bearer ${mints[0].token}`);
  assert.ok(calls.length > 0, "the MCP server got the minted token");
  assert.ok(calls.every((request) => request.tools === "add,whoami"), "with the entry's static header as written");
  const leaked = (await files(runDir(server.data, fired.run_id))).filter((file) => file.text.includes(mints[0].token)).map((file) => file.path);
  assert.deepEqual(leaked, [], "the token is in no file of the run: not its journal, not its record");
  assert.ok(!server.lines.some((line) => line.includes(mints[0].token)), "nor in a log line");
});

test("a run with no GitHub event mints by the repository its input names: the App's installation for it, asked with the App's JWT; one the App does not cover answers the call in words", { timeout: 120_000 }, async (t) => {
  const { server } = await withGitHubMcp(t);
  assert.equal((await server.api("POST", "/agents", agent("helper", { tools: ["mcp:gh/add"], tool_settings: ALLOW }))).status, 201);
  const run = async (content) => {
    const started = await server.api("POST", "/agents/helper/runs", { input: { content } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(server.api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    return (await server.api("GET", `/runs/${started.body.run_id}`)).body.result?.final_answer;
  };
  assert.equal(await run('Call mcp__gh__add with {"a":1,"b":1}\nLook at https://github.com/acme/widgets/pull/12'), "The tool said: 2");
  assert.ok(server.github.requests.some((r) => r.method === "GET" && r.url === "/repos/acme/widgets/installation" && /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(String(r.headers.authorization))), "asked GitHub which installation covers it, with the App's JWT");
  assert.deepEqual(server.github.tokens.map((m) => m.repositories), [["widgets"]]);
  const uncovered = await run('Call mcp__gh__add with {"a":1,"b":1}\nLook at https://github.com/acme/private');
  assert.match(uncovered, /The GitHub App isn't installed on acme\/private/, "in words, not a crash");
  const none = await run('Call mcp__gh__add with {"a":1,"b":1}');
  assert.match(none, /No GitHub repository/, "a run that names none is told so");
  assert.equal(server.github.tokens.length, 1, "no token for either");
});

test("a run that resumes gets a token minted again; what a run shows is cut of every live token", { timeout: 120_000 }, async (t) => {
  const { server, seen } = await withGitHubMcp(t);
  assert.equal((await server.api("POST", "/agents", agent("echo", { tools: ["mcp:gh/add", "mcp:gh/whoami"], tool_settings: ALLOW }))).status, 201);
  const started = await server.api("POST", "/agents/echo/runs", { input: { content: "Call mcp__gh__whoami with {}\nhttps://github.com/acme/widgets" } });
  const runId = started.body.run_id;
  await follow(server.api, runId, ["completed"], { deadlineMs: 60_000 });
  const first = server.github.tokens.at(-1).token;
  const shown = (await server.api("GET", `/runs/${runId}`)).body.result?.final_answer;
  assert.ok(shown.startsWith("The tool said:") && !shown.includes(first), `the run shows no live token: ${shown}`);
  // A follow-up opens the completed run again: a new launch, a new token.
  assert.equal((await server.api("POST", `/runs/${runId}/messages`, { content: 'Call mcp__gh__add with {"a":3,"b":4}' })).status, 202);
  for (const end = Date.now() + 60_000; (await server.api("GET", `/runs/${runId}`)).body.result?.final_answer !== "The tool said: 7"; await new Promise((resolve) => setTimeout(resolve, 200))) assert.ok(Date.now() < end, "the follow-up was answered");
  assert.equal(server.github.tokens.length, 2, "minted again at the resume");
  const second = server.github.tokens.at(-1).token;
  assert.notEqual(second, first);
  assert.equal(seen.at(-1).authorization, `Bearer ${second}`, "the resumed run calls with the new one");
});
