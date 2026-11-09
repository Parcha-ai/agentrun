// GitHub tokens through the server: the mint itself (github.ts mintInstallationToken), an MCP server saved with auth
// {type: "github_app"} listing its tools with a token of the connected App (the fake GitHub of github-support.mjs), and
// what a GitHub event's payload tag carries. A run's own token is the runner's, minted per claim from the App in the store
// (runner/github-app.ts, store-github-app.test.mjs; runner/mcp-github.ts, store-mcp-github.test.mjs).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { connect, connectable, deliver, firstInput, INSTALLED, PUBLIC, storeOf } from "./github-support.mjs";
import { agent, follow, runDir, serve } from "./support.mjs";
import { firings } from "./trigger-support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ALLOW = { "mcp:gh/*": { permission: "allow" } };
const pr = { action: "opened", number: 12, pull_request: { draft: false }, repository: { full_name: "acme/widgets" }, installation: { id: 777 } };

/** A connected server with an MCP server `gh` on the App's tokens: the fake takes only a token GitHub minted, and keeps
 *  what each request's Authorization and X-MCP-Tools said. */
async function withGitHubMcp(t) {
  const seen = [];
  let server;
  const minted = () => server.github.tokens.map((entry) => `Bearer ${entry.token}`);
  const fake = await startFakeMcp({ token: (authorization) => minted().includes(authorization), inspect: (headers) => seen.push({ authorization: headers.authorization, tools: headers["x-mcp-tools"] }) });
  t.after(() => fake.close());
  // The fake stands in for GitHub's hosted MCP: its origin is the one a github_app server may have (the server's seam).
  server = await connectable(t, { faux: FAUX_MCP, harnesses: true, githubMcpOrigin: new URL(fake.url).origin });
  await connect(server);
  // A tool that answers what it was called with: the credential, as a careless server might echo it.
  fake.tools.whoami = { description: "Say who called.", input: { type: "object", properties: {}, additionalProperties: false }, run: () => ({ content: [{ type: "text", text: String(seen.at(-1)?.authorization) }] }) };
  const saved = await server.api("PUT", "/settings/mcp-servers/gh", { url: fake.url, auth: { type: "github_app", headers: { "X-MCP-Tools": "add,whoami" } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.auth.type, "github_app");
  return { server, fake, seen };
}
/** The tokens minted for runs, each narrowed to its repository: the save's own, to list the tools, covers the installation. */
const runTokens = (server) => server.github.tokens.filter((entry) => entry.repositories && !entry.permissions);
/** The tokens a save minted to list a server's tools: a metadata-read one GitHub alone saw (revoked), then one narrowed to a
 *  single repository, the one sent. */
const listingTokens = (server) => server.github.tokens.filter((entry) => entry.permissions);


const files = async (dir) => Promise.all((await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map(async (e) => ({ path: join(e.parentPath, e.name), text: await readFile(join(e.parentPath, e.name), "utf8").catch(() => "") })));

test("mintInstallationToken: the repository's installation looked up with the App's JWT, a token narrowed to that one repository; not installed, no repository, and GitHub out of reach each said", { timeout: 60_000 }, async (t) => {
  const { mintInstallationToken } = await import("../dist/github.js");
  const { fakeGitHub } = await import("./github-support.mjs");
  const github = await fakeGitHub(t);
  const now = Date.now();
  const ok = await mintInstallationToken(github.url, String(github.app.id), github.app.pem, { repo: "acme/widgets" }, now);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual([ok.token, github.tokens.at(-1).repositories, github.tokens.at(-1).installation], [github.tokens.at(-1).token, ["widgets"], 777]);
  assert.ok(ok.expires_at > now, "when it ends, in ms");
  const given = await mintInstallationToken(github.url, String(github.app.id), github.app.pem, { installation: 777, repo: "acme/widgets" }, now);
  assert.equal(given.ok, true);
  const missing = await mintInstallationToken(github.url, String(github.app.id), github.app.pem, { repo: "acme/private" }, now);
  assert.deepEqual([missing.ok, missing.reason], [false, "not_installed"]);
  assert.match(missing.message, /The GitHub App isn't installed on acme\/private/);
  const none = await mintInstallationToken(github.url, String(github.app.id), github.app.pem, { repo: "" }, now);
  assert.deepEqual([none.ok, none.reason], [false, "no_repo"]);
  const away = await mintInstallationToken("http://127.0.0.1:9", String(github.app.id), github.app.pem, { repo: "acme/widgets" }, now);
  assert.deepEqual([away.ok, away.reason], [false, "github_failed"]);
});

test("an inline preview of a github_app server lists its tools with a token of the App, as a saved one's does", { timeout: 60_000 }, async (t) => {
  let server;
  const minted = () => server.github.tokens.map((entry) => `Bearer ${entry.token}`);
  const fake = await startFakeMcp({ token: (authorization) => minted().includes(authorization) });
  t.after(() => fake.close());
  server = await connectable(t, { githubMcpOrigin: new URL(fake.url).origin });
  await connect(server);
  const preview = await server.api("POST", "/settings/mcp-servers/preview", { url: fake.url, auth: { type: "github_app", headers: { "X-MCP-Tools": "add" } } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(preview.body.tools.some((tool) => tool.name === "add"));
  assert.deepEqual(listingTokens(server).map((entry) => entry.repositories ?? null), [null, ["widgets"]], "with a token of one repository (the first only found it, and is revoked)");
});

test("a github_app server moved off GitHub's hosted MCP is refused on url, and nothing reaches the new address: neither its static headers nor a token", { timeout: 60_000 }, async (t) => {
  let server;
  const minted = () => server.github.tokens.map((entry) => `Bearer ${entry.token}`);
  const [a, b] = [await startFakeMcp({ token: (authorization) => minted().includes(authorization) }), await startFakeMcp({ token: (authorization) => minted().includes(authorization) })];
  t.after(() => Promise.all([a.close(), b.close()]));
  server = await connectable(t, { githubMcpOrigin: new URL(a.url).origin });
  await connect(server);
  assert.equal((await server.api("PUT", "/settings/mcp-servers/gh", { url: a.url, auth: { type: "github_app", headers: { "X-MCP-Tools": "add" } } })).status, 200);
  const tokens = server.github.tokens.length;
  const moved = await server.api("PUT", "/settings/mcp-servers/gh", { url: b.url, auth: { type: "github_app" } });
  assert.deepEqual([moved.status, moved.body.error?.fields?.map((f) => f.field)], [422, ["url"]], JSON.stringify(moved.body));
  assert.deepEqual(b.log, [], "nothing reached the new address");
  assert.equal(server.github.tokens.length, tokens, "no token minted for it");
});

test("a pull_request's number and head sha, and a comment's number, ride on the payload's tag from the signed body, whatever the 16 KiB cut leaves of the payload; a comment's tag has no head_sha", { timeout: 120_000 }, async (t) => {
  const { server } = await withGitHubMcp(t);
  const { readFile: read } = await import("node:fs/promises");
  assert.equal((await server.api("POST", "/agents", agent("long", { tools: [] }))).status, 201);
  const make = async (name, accept) => (await server.api("POST", "/triggers", { name, source: { kind: "github", accept }, target: { kind: "start_run", agent_id: "long", input: { content: "Review it." }, max_cost_usd: 0.5 } })).body;
  const prs = await make("prs", [{ event: "pull_request" }]);
  const comments = await make("comments", [{ event: "issue_comment" }]);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  // The PR's own description comes before its head: past the cut, so the payload loses number and head.sha.
  const pr = { action: "opened", pull_request: { body: "x".repeat(40 * 1024), head: { sha }, number: 41 }, repository: { full_name: "acme/widgets" }, installation: { id: 777 } };
  assert.equal((await deliver(server.baseUrl, server.github.app.webhook_secret, "pull_request", pr)).status, 202);
  const comment = { action: "created", issue: { body: "y".repeat(40 * 1024), number: 42, pull_request: { url: "u" } }, comment: { body: "@bot review" }, repository: { full_name: "acme/widgets" }, installation: { id: 777 } };
  assert.equal((await deliver(server.baseUrl, server.github.app.webhook_secret, "issue_comment", comment)).status, 202);
  const tagOf = async (triggerId) => {
    const [fired] = await firings(server.api, triggerId, 1);
    const { content } = await firstInput(t, server, fired.run_id);
    assert.match(content, /\[cut: the payload was \d+ bytes, past 16384\]/, "the payload itself is cut");
    return content.slice(content.indexOf("<trigger-payload "), content.indexOf(">", content.indexOf("<trigger-payload ")) + 1);
  };
  const prTag = await tagOf(prs.id);
  assert.match(prTag, / number="41" /);
  assert.match(prTag, new RegExp(` head_sha="${sha}" `));
  const commentTag = await tagOf(comments.id);
  assert.match(commentTag, / number="42" /);
  assert.ok(!commentTag.includes("head_sha"), `a comment's tag has no head_sha at all: ${commentTag}`);
});

test("a github_app server is GitHub's hosted MCP only: a preview or a save at any other URL (another host, a port, http, userinfo, a trailing dot, a host that only starts with GitHub's) is 422 on url, and no token of the App is minted", { timeout: 60_000 }, async (t) => {
  const server = await connectable(t);
  await connect(server);
  const mints = () => server.github.requests.filter((r) => r.url.endsWith("/access_tokens")).length;
  const before = mints();
  for (const url of ["https://mcp.example.com/mcp", "https://x@api.githubcopilot.com/mcp/", "https://api.githubcopilot.com:8443/mcp/", "http://api.githubcopilot.com/mcp/", "https://api.githubcopilot.com./mcp/", "https://api.githubcopilot.com.example.com/mcp/"]) {
    for (const [method, path] of [["POST", "/settings/mcp-servers/preview"], ["PUT", "/settings/mcp-servers/gh"]]) {
      const res = await server.api(method, path, { url, auth: { type: "github_app" } });
      assert.deepEqual([res.status, res.body.error?.fields?.map((f) => f.field)], [422, ["url"]], `${method} ${url}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error.fields[0].message, /api\.githubcopilot\.com/);
    }
  }
  assert.equal(mints(), before, "no token minted for any of them");
});

test("the token that lists a github_app server's tools as it is saved asks for the least: metadata read, of one repository; the one that found that repository never left the server and is revoked", { timeout: 60_000 }, async (t) => {
  const { server, seen } = await withGitHubMcp(t);
  const [scout, listing] = listingTokens(server);
  assert.deepEqual([scout.repositories, scout.permissions], [undefined, { metadata: "read" }]);
  assert.deepEqual([listing.repositories, listing.permissions], [["widgets"], { metadata: "read" }], "one repository, metadata read");
  assert.deepEqual(server.github.revoked, [scout.token], "revoked once it named the repository");
  assert.ok(!seen.some((request) => request.authorization === `Bearer ${scout.token}`), "never sent to the MCP server");
  assert.ok(seen.some((request) => request.authorization === `Bearer ${listing.token}`), "the narrowed one listed the tools");
});

test("a github_app server saved at an origin that is no longer GitHub's hosted MCP gets no token: its preview by name is refused (a run's claim refuses it too: store-mcp-github G6)", { timeout: 120_000 }, async (t) => {
  const { server } = await withGitHubMcp(t);
  await server.close();
  // The same data on a server whose hosted-MCP origin is GitHub's own: the row saved before is at another origin.
  const again = await serve(t, { data: server.data, publicUrl: PUBLIC, githubApi: server.github.url, faux: FAUX_MCP, harnesses: true });
  const before = server.github.tokens.length;
  const preview = await again.api("POST", "/settings/mcp-servers/preview", { name: "gh" });
  assert.deepEqual([preview.status, preview.body.error?.fields?.map((f) => f.field)], [422, ["url"]], JSON.stringify(preview.body));
  assert.equal(server.github.tokens.length, before, "no token minted for it");
});

test("a repository named in the owner's words ends where the sentence does: trailing punctuation and a .git are not its name", async () => {
  const { githubTargetOf } = await import("../dist/github.js");
  for (const [words, repo] of [
    ["Review https://github.com/acme/widgets.", "acme/widgets"],
    ["Is it https://github.com/acme/widgets?", "acme/widgets"],
    ["(see https://github.com/acme/widgets), then", "acme/widgets"],
    ["Clone https://github.com/acme/widgets.git; then", "acme/widgets"],
    ["Look at https://github.com/acme/widgets!", "acme/widgets"],
    ["Use https://github.com/acme/my.widgets: it has it", "acme/my.widgets"],
    ["https://github.com/acme/widgets/pull/7", "acme/widgets"],
  ]) assert.deepEqual(githubTargetOf(words), { repo }, words);
});

test("githubMcpUrl: GitHub's hosted MCP at its origin, any path, the default port written or not; nothing else", async () => {
  const { githubMcpUrl } = await import("../dist/github.js");
  for (const url of ["https://api.githubcopilot.com/mcp/", "https://api.githubcopilot.com:443/mcp/", "https://API.githubcopilot.com/x/readonly", "https://api.githubcopilot.com"]) assert.equal(githubMcpUrl(url), true, url);
  for (const url of ["https://x@api.githubcopilot.com/mcp/", "https://x:y@api.githubcopilot.com/mcp/", "https://api.githubcopilot.com:8443/mcp/", "http://api.githubcopilot.com/mcp/", "https://api.githubcopilot.com./mcp/", "https://api.githubcopilot.com.example.com/mcp/", "https://mcp.example.com/mcp", "not a url"]) assert.equal(githubMcpUrl(url), false, url);
});

test("a github_app run's MCP call carries an installation token the runner minted from the store's App for the run's repository, through the run spec's githubAppAccess", { timeout: 120_000 }, async (t) => {
  let server;
  const minted = () => server.github.tokens.filter((entry) => entry.repositories).map((entry) => `Bearer ${entry.token}`);
  const seen = [];
  const fake = await startFakeMcp({ token: (authorization) => minted().includes(authorization), inspect: (headers) => seen.push(headers.authorization) });
  t.after(() => fake.close());
  // The fake stands in for GitHub's hosted MCP, for each server and its runner alike (each's test-only seam): the first
  // server's runner lives on to the test's end, beside the second's, and either may claim the run.
  const githubMcpOrigin = new URL(fake.url).origin;
  server = await connectable(t, { faux: FAUX_MCP, harnesses: true, githubMcpOrigin });
  await connect(server);
  // The registry row as a save keeps it (no credential: the token is minted per claim), written while the server is
  // down (the store registry takes no github_app save yet), so the server reads it at its next start.
  await server.close();
  const reader = await storeOf(t, server);
  const add = { name: "add", title: "Add", description: "Add two numbers.", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } };
  await reader.mcp.put({ name: "gh", url: fake.url, auth: "github_app", tools: [add], sealed: null });
  const again = await serve(t, { data: server.data, publicUrl: PUBLIC, githubApi: server.github.url, githubMcpOrigin, faux: FAUX_MCP, harnesses: true });
  assert.equal((await again.api("POST", "/agents", agent("review", { tools: ["mcp:gh/add"], tool_settings: { "mcp:gh/*": { permission: "allow" } } }))).status, 201);
  const run = await again.api("POST", "/agents/review/runs", { input: { content: 'Call mcp__gh__add with {"a":2,"b":3}\n\nThe repository is https://github.com/acme/widgets.' }, max_cost_usd: 1 });
  assert.ok([201, 202].includes(run.status), JSON.stringify(run.body));
  const { last } = await follow(again.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const answer = (await again.api("GET", `/runs/${run.body.run_id}`)).body.result?.final_answer;
  assert.deepEqual([last.status, answer], ["completed", "The tool said: 5"]);
  const tokens = server.github.tokens.filter((entry) => entry.repositories);
  assert.deepEqual(tokens.map((entry) => [entry.installation, entry.repositories]), [[777, ["widgets"]]], "minted once, for the run's repository");
  assert.ok(seen.includes(`Bearer ${tokens[0].token}`), "the MCP server got it");
});

/** A connected server whose MCP server lists its tools with the App's tokens, before any is saved: the fake takes only a
 *  token GitHub minted. */
async function connectedForListing(t) {
  let server;
  const minted = () => server.github.tokens.map((entry) => `Bearer ${entry.token}`);
  const fake = await startFakeMcp({ token: (authorization) => minted().includes(authorization) });
  t.after(() => fake.close());
  server = await connectable(t, { githubMcpOrigin: new URL(fake.url).origin });
  await connect(server);
  return { server, fake, entry: { url: fake.url, auth: { type: "github_app", headers: { "X-MCP-Tools": "add" } } } };
}

test("the token that lists a github_app server's tools comes from the first installation that covers a repository: one whose account has none selected is passed over, and each scout is revoked", { timeout: 60_000 }, async (t) => {
  const { server, entry } = await connectedForListing(t);
  const { installations, app } = server.github;
  // acme's installation has no repository selected; other's, installed after it, has one.
  installations.get(777).repositories = [];
  installations.set(778, { account: "other", suspended_at: null, repositories: ["other/gadgets"] });
  assert.equal((await deliver(server.baseUrl, app.webhook_secret, "installation", { action: "created", installation: { id: 778, account: { login: "other" }, app_id: 4242 } })).status, 200);
  assert.deepEqual((await server.api("GET", "/integrations/github")).body.installations, [{ id: 777, account: "acme" }, { id: 778, account: "other" }]);
  const preview = await server.api("POST", "/settings/mcp-servers/preview", entry);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(preview.body.tools.some((tool) => tool.name === "add"));
  const listing = listingTokens(server);
  assert.deepEqual(listing.map((token) => [token.installation, token.repositories ?? null]), [[777, null], [778, null], [778, ["gadgets"]]], "a scout on each installation in turn, then the token narrowed to the second's repository");
  assert.deepEqual(server.github.revoked, [listing[0].token, listing[1].token], "both scouts revoked");
});

test("GitHub not answering the listing's read of an installation's repositories (a 503, a 429) is 502 github_failed, \"GitHub didn't answer: try again\", never github_not_connected: a preview, a save and a refresh each, and nothing stored changes", { timeout: 60_000 }, async (t) => {
  const { server, entry } = await connectedForListing(t);
  assert.equal((await server.api("PUT", "/settings/mcp-servers/gh", entry)).status, 200);
  const before = (await server.api("GET", "/settings/mcp-servers/gh")).body;
  for (const status of [503, 429]) {
    server.github.failures.repositories = status;
    const tries = [["POST", "/settings/mcp-servers/preview", entry], ["PUT", "/settings/mcp-servers/other", entry], ["POST", "/settings/mcp-servers/gh/refresh"]];
    for (const [method, path, body] of tries) {
      const refused = await server.api(method, path, body);
      assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.retryable], [502, "github_failed", true], `${status} ${method} ${path}: ${JSON.stringify(refused.body)}`);
      assert.match(refused.body.error.message, /GitHub didn't answer: try again/);
    }
  }
  assert.equal((await server.api("GET", "/settings/mcp-servers/other")).status, 404, "nothing saved");
  assert.deepEqual((await server.api("GET", "/settings/mcp-servers/gh")).body, before, "the saved one unchanged");
  const scouts = listingTokens(server).filter((token) => !token.repositories);
  assert.deepEqual(server.github.revoked, scouts.map((token) => token.token), "every scout revoked, the refused ones too");
});

test("a GitHub rate limit answered 403 (a secondary limit's words, X-RateLimit-Remaining 0, a Retry-After), on the repositories read or on the scout's mint, is 502 github_failed too; a 403 that is no rate limit is a refusal, never \"try again\"", { timeout: 60_000 }, async (t) => {
  const { server, entry } = await connectedForListing(t);
  const { failures } = server.github;
  const limited = [
    ["repositories", { status: 403, message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }],
    ["repositories", { status: 403, message: "Forbidden", headers: { "x-ratelimit-remaining": "0" } }],
    ["mint", { status: 403, message: "API rate limit exceeded for installation ID 777." }],
    ["mint", { status: 403, message: "Forbidden", headers: { "retry-after": "60" } }],
  ];
  for (const [what, failure] of limited) {
    Object.assign(failures, { repositories: undefined, mint: undefined, [what]: failure });
    const refused = await server.api("POST", "/settings/mcp-servers/preview", entry);
    assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.retryable], [502, "github_failed", true], `${what} ${JSON.stringify(failure)}: ${JSON.stringify(refused.body)}`);
  }
  // A 403 that names no limit (the token cannot read here) is said as it is, not as GitHub being away.
  Object.assign(failures, { repositories: { status: 403, message: "Resource not accessible by integration" }, mint: undefined });
  const denied = await server.api("POST", "/settings/mcp-servers/preview", entry);
  assert.deepEqual([denied.status, denied.body.error?.code], [409, "github_not_connected"], JSON.stringify(denied.body));
});
