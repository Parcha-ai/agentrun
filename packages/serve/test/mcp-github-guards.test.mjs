// A github_app MCP server over the store registry (mcp-servers-store.ts): its tools are listed with an installation
// token of the connected GitHub App (appToken), sent beside its static headers on a preview (inline and by name), a save
// and a refresh; with no App, the github_not_connected words. And the App's tokens go to GitHub's hosted MCP alone: a
// github_app server whose URL is not that origin (github.ts githubMcpUrl, the one check) is refused before anything is
// sent or minted, by the registry (422 on url), by the store's save (never written), and by the runner's claim (the run
// ends in words before its session opens: no mint, no pin row).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { queued, storeOn } from "./store-helpers.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { saveMcpServer } = await import("../dist/mcp-store.js");
const { mcpClaim, McpClaimRefused } = await import("../dist/runner/mcp-claim.js");
const { GITHUB_MCP_ONLY, GITHUB_MCP_ORIGIN } = await import("../dist/github.js");

const KEY = randomBytes(32);
const APP_TOKEN = `not-a-secret-${"ghs-listing"}`;
const reg = (store) => mcpServersOverStore(store, { AGENTRUN_SEAL_KEY: KEY.toString("base64") }, "test");
const BAD = [
  "https://mcp.example.com/mcp",
  "https://x@api.githubcopilot.com/mcp/",
  "https://api.githubcopilot.com:8443/mcp/",
  "http://api.githubcopilot.com/mcp/",
  "https://api.githubcopilot.com./mcp/",
  "https://api.githubcopilot.com.example.com/mcp/",
];
const urlRefusal = (error) => error.code === "input_invalid" && error.extra.fields.some((field) => field.field === "url" && field.message === GITHUB_MCP_ONLY);

/** Every request this process sends, refused at once: none may be. */
function noRequests(t) {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    sent.push(String(input instanceof Request ? input.url : input));
    throw new TypeError("fetch failed (no request may be sent, in a test)");
  });
  return sent;
}

test("a github_app server lists its tools with the App's listing token beside its static headers: inline preview, save, preview by name and refresh; with no App, github_not_connected", async (t) => {
  const { store } = await storeOn(t);
  const seen = [];
  const fake = await startFakeMcp({ token: (authorization) => (seen.push(authorization), authorization === `Bearer ${APP_TOKEN}`) });
  t.after(() => fake.close());
  const r = reg(store);
  r.appOrigin = new URL(fake.url).origin;
  let minted = 0;
  r.appToken = async () => (minted++, { token: APP_TOKEN });
  const preview = await r.preview({ url: fake.url, auth: { type: "github_app" } });
  assert.ok(preview.tools.length > 0, "listed with the App's token");
  const saved = await r.save("gh", { url: fake.url, auth: { type: "github_app", headers: { "x-extra": "kept" } } });
  assert.equal(saved.auth.type, "github_app");
  assert.deepEqual(saved.auth.headers, ["x-extra"], "its static headers' names, never the token");
  assert.ok(!JSON.stringify(saved).includes(APP_TOKEN), "the App's token is never kept or shown");
  assert.ok((await r.preview({ name: "gh" })).tools.length > 0, "by name");
  await r.refresh("gh");
  assert.equal(minted, 4, "a token for each listing");
  assert.ok(seen.every((authorization) => authorization === `Bearer ${APP_TOKEN}`), "every request carried the App's token");
  r.appToken = undefined;
  await assert.rejects(r.refresh("gh"), (error) => error.code === "github_not_connected" && /Connect GitHub in Settings/.test(error.message));
  r.appToken = async () => ({ unusable: "The GitHub App is not installed anywhere yet." });
  await assert.rejects(r.preview({ url: fake.url, auth: { type: "github_app" } }), (error) => error.code === "github_not_connected" && error.message === "The GitHub App is not installed anywhere yet.");
});

test("a listing token GitHub didn't answer for is 502 github_failed in its words, retryable: nothing listed, saved or changed, and no request reaches the MCP server", async (t) => {
  const { store } = await storeOn(t);
  const fake = await startFakeMcp({ token: (authorization) => authorization === `Bearer ${APP_TOKEN}` });
  t.after(() => fake.close());
  const r = reg(store);
  r.appOrigin = new URL(fake.url).origin;
  r.appToken = async () => ({ token: APP_TOKEN });
  const kept = await r.save("gh", { url: fake.url, auth: { type: "github_app" } });
  const sent = fake.log.length;
  r.appToken = async () => ({ failed: "GitHub didn't answer: try again." });
  const failed = (error) => error.code === "github_failed" && error.status === 502 && error.message === "GitHub didn't answer: try again." && error.body("req").error.retryable === true;
  await assert.rejects(r.preview({ url: fake.url, auth: { type: "github_app" } }), failed, "an inline preview");
  await assert.rejects(r.preview({ name: "gh" }), failed, "a preview by name");
  await assert.rejects(r.save("other", { url: fake.url, auth: { type: "github_app" } }), failed, "a new save");
  await assert.rejects(r.save("gh", { url: fake.url, auth: { type: "github_app", headers: { "x-extra": "new" } } }), failed, "a save over a kept one");
  await assert.rejects(r.refresh("gh"), failed, "a refresh");
  assert.equal(fake.log.length, sent, "no request reached the MCP server");
  assert.deepEqual((await r.list()).servers.map((server) => server.name), ["gh"], "nothing new saved");
  assert.deepEqual(await r.get("gh"), kept, "the kept one unchanged");
});

test("the registry refuses a github_app server off GitHub's hosted MCP before anything is sent or minted: inline preview, save, preview by name and refresh, each 422 on url", async (t) => {
  const { store } = await storeOn(t);
  const sent = noRequests(t);
  const r = reg(store);
  let minted = 0;
  r.appToken = async () => (minted++, { token: APP_TOKEN });
  assert.equal(r.appOrigin, GITHUB_MCP_ORIGIN, "GitHub's hosted MCP by default");
  for (const url of BAD) {
    await assert.rejects(r.preview({ url, auth: { type: "github_app" } }), urlRefusal, `preview ${url}`);
    await assert.rejects(r.save("gh", { url, auth: { type: "github_app" } }), urlRefusal, `save ${url}`);
    assert.equal(await store.mcp.server("gh"), undefined, `nothing saved for ${url}`);
    // A row at that address written past the registry (as an older server might have): read by name and refreshed.
    await store.mcp.put({ name: "old", url, auth: "github_app", tools: [], sealed: null });
    await assert.rejects(r.preview({ name: "old" }), urlRefusal, `preview by name ${url}`);
    await assert.rejects(r.refresh("old"), urlRefusal, `refresh ${url}`);
  }
  assert.equal(minted, 0, "no token minted");
  assert.deepEqual(sent, [], "no request sent");
});

test("the store's save never writes a github_app row off GitHub's hosted MCP; GitHub's own is written", async (t) => {
  const { store } = await storeOn(t);
  for (const url of BAD) {
    await assert.rejects(saveMcpServer(store, KEY, { name: "gh", url, auth: "github_app", tools: [] }), (error) => error.message.includes(GITHUB_MCP_ONLY), url);
    assert.equal(await store.mcp.server("gh"), undefined, url);
  }
  const row = await saveMcpServer(store, KEY, { name: "gh", url: `${GITHUB_MCP_ORIGIN}/mcp/`, auth: "github_app", tools: [] });
  assert.equal(row.auth, "github_app");
});

test("the runner's claim refuses a github_app row off GitHub's hosted MCP at the pin step: the run ends in words, nothing minted, no pin row", async (t) => {
  // One store: a row and a run of its own for each URL.
  const { store } = await storeOn(t);
  const sent = noRequests(t);
  for (const [i, url] of BAD.entries()) {
    const name = `gh${i}`;
    const run = `run-${i}`;
    await store.mcp.put({ name, url, auth: "github_app", tools: [{ name: "add", inputSchema: { type: "object" } }], sealed: null });
    await queued(store, run);
    const claim = await store.claim(run, "runner-a", { leaseMs: 60_000 });
    let mints = 0;
    const githubApp = { mint: async () => (mints++, { ok: true, token: APP_TOKEN, expires_at: Date.now() + 3_600_000 }), target: { installation: 7, repo: "acme/widgets" } };
    await assert.rejects(
      mcpClaim({ store, claim, grants: [`mcp:${name}/add`], sealKey: KEY, signal: new AbortController().signal, githubApp }),
      (error) => error instanceof McpClaimRefused && error.message.includes(GITHUB_MCP_ONLY) && error.message.includes(name),
      url,
    );
    assert.equal(mints, 0, `${url}: no token minted`);
    assert.equal(await store.mcp.pin(run), undefined, `${url}: no pin row`);
  }
  assert.deepEqual(sent, [], "no request sent");
});
