// The server takes two API tokens at once (api-token.ts): the token (AGENTRUN_TOKEN, else DIR/.token's) and, during a
// rotation, the next one (AGENTRUN_TOKEN_NEXT). Either opens /v2, /mcp and the store's /api/*; anything else is refused
// as before. Once the next token is the token and the old one is gone, the old one is refused. Every presented token is
// compared with node:crypto's timingSafeEqual, against every token the server takes, on equal-length digests, with no
// early return. The next token follows the token's rules, and no run or runner loop is handed it.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { startServe } from "../dist/index.js";
import { client, serve } from "./support.mjs";

const { acceptedTokens, bearerCheck, TOKEN_NEXT_ENV, tokenProblem } = await import("../dist/api-token.js");
const { banner } = await import("../dist/print.js");
const { runEnv } = await import("../dist/runner/main.js");

// Test tokens: plainly no secrets, 32 characters or more.
const OLD = "test-token-old-0000000000000000000000";
const NEXT = "test-token-next-111111111111111111111";
const OTHER = "test-token-other-22222222222222222222";

test("the next token is AGENTRUN_TOKEN_NEXT, and follows the token's rules", () => {
  assert.equal(TOKEN_NEXT_ENV, "AGENTRUN_TOKEN_NEXT");
  assert.equal(tokenProblem(NEXT), undefined);
  assert.equal(tokenProblem("short"), "the token must be 32 characters or more, with no whitespace");
  assert.equal(tokenProblem(`${NEXT} x`, "the next token"), "the next token must be 32 characters or more, with no whitespace");
});

test("the server takes the token, then the next one; a next token equal to the token is the one token", () => {
  assert.deepEqual(acceptedTokens(OLD, undefined), [OLD]);
  assert.deepEqual(acceptedTokens(OLD, NEXT), [OLD, NEXT]);
  assert.deepEqual(acceptedTokens(OLD, OLD), [OLD]);
});

test("a Bearer header with either token passes; any other header is refused", () => {
  const bearer = bearerCheck([OLD, NEXT]);
  assert.equal(bearer(`Bearer ${OLD}`), true);
  assert.equal(bearer(`Bearer ${NEXT}`), true);
  for (const header of [undefined, "", `Bearer ${OTHER}`, OLD, NEXT, `bearer ${OLD}`, `Bearer ${OLD} `, `Bearer ${OLD.slice(0, -1)}`, `Bearer ${OLD}${NEXT}`, `Basic ${OLD}`]) {
    assert.equal(bearer(header), false, JSON.stringify(header));
  }
  const one = bearerCheck([OLD]);
  assert.equal(one(`Bearer ${OLD}`), true);
  assert.equal(one(`Bearer ${NEXT}`), false, "with no next token, the next one is refused");
  assert.throws(() => bearerCheck([]), TypeError);
});

test("every check compares the header against every token, on two 32-byte digests, with no early return on a match", () => {
  const calls = [];
  const equal = (a, b) => (calls.push([a.length, b.length]), crypto.timingSafeEqual(a, b));
  const bearer = bearerCheck([OLD, NEXT], equal);
  for (const [header, expected] of [[`Bearer ${OLD}`, true], [`Bearer ${NEXT}`, true], [`Bearer ${OTHER}`, false], [undefined, false], ["x".repeat(10_000), false]]) {
    calls.length = 0;
    assert.equal(bearer(header), expected, String(header).slice(0, 40));
    assert.deepEqual(calls, [[32, 32], [32, 32]], `two comparisons, each of two digests, whatever was sent (${String(header).slice(0, 40)})`);
  }
});

test("by default the comparison is node:crypto's timingSafeEqual", (t) => {
  const spied = mock.method(crypto, "timingSafeEqual");
  syncBuiltinESMExports();
  t.after(() => (spied.mock.restore(), syncBuiltinESMExports()));
  const bearer = bearerCheck([OLD, NEXT]);
  assert.equal(bearer(`Bearer ${NEXT}`), true);
  assert.equal(spied.mock.callCount(), 2, "timingSafeEqual compared the header with each token");
});

/** One request to the server's MCP endpoint with `token`: its status. */
async function mcpStatus(server, token) {
  const res = await fetch(`${server.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  await res.text();
  return res.status;
}

/** One read of the store page's data (/api/store) with `token`: its status. */
async function apiStatus(server, token) {
  const res = await fetch(`${server.url}/api/store`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  await res.text();
  return res.status;
}

test("a server given the token and the next one answers either on /v2, /mcp and /api/*, and refuses any other", async (t) => {
  const lines = [];
  const server = await serve(t, { token: OLD, nextToken: NEXT, runner: false, log: (line) => lines.push(line) });
  assert.equal(server.token, OLD, "the token is still the server's token");
  for (const token of [OLD, NEXT]) {
    const who = token === OLD ? "the token" : "the next token";
    assert.equal((await client(server.baseUrl, token)("GET", "/agents")).status, 200, `${who} on /v2`);
    assert.equal(await mcpStatus(server, token), 200, `${who} on /mcp`);
    assert.equal(await apiStatus(server, token), 200, `${who} on /api/*`);
  }
  assert.equal((await client(server.baseUrl, OTHER)("GET", "/agents")).status, 401, "another token on /v2");
  assert.equal((await client(server.baseUrl)("GET", "/agents")).status, 401, "no token on /v2");
  assert.equal(await mcpStatus(server, OTHER), 401, "another token on /mcp");
  assert.equal(await apiStatus(server, OTHER), 401, "another token on /api/*");
  assert.ok(lines.every((line) => !line.includes(OLD) && !line.includes(NEXT)), "no log line holds either token");
});

test("after the rotation (the next token made the token, the old one removed) the old token is refused", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-rotate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  // Step 1: the next token beside the old one, on the same data directory as the steps after it.
  const before = await startServe({ data, port: 0, token: OLD, nextToken: NEXT });
  try {
    assert.equal((await client(before.baseUrl, OLD)("GET", "/agents")).status, 200);
    assert.equal((await client(before.baseUrl, NEXT)("GET", "/agents")).status, 200);
  } finally {
    await before.close();
  }
  // Step 3: the next token is the token, and there is no next one.
  const lines = [];
  const after = await startServe({ data, port: 0, token: NEXT, log: (line) => lines.push(line) });
  t.after(() => after.close());
  assert.equal((await client(after.baseUrl, NEXT)("GET", "/agents")).status, 200, "the new token");
  const old = await client(after.baseUrl, OLD)("GET", "/agents");
  assert.equal(old.status, 401, "the old token is refused");
  assert.equal(old.headers.get("www-authenticate"), "Bearer");
  assert.equal(await mcpStatus(after, OLD), 401, "on /mcp too");
  assert.equal(await apiStatus(after, OLD), 401, "and on /api/*");
  assert.ok(lines.some((line) => / event=auth_failed /.test(line) && / route=\/v2\/agents /.test(line) && / reason=wrong_token$/.test(line)), `logged as wrong_token: ${lines.join("\n")}`);
});

test("a next token that breaks the token's rules stops the start, in words", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-rotate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(startServe({ data: join(dir, "agents"), port: 0, token: OLD, nextToken: "too-short" }), /^Error: the next token \(AGENTRUN_TOKEN_NEXT\) must be 32 characters or more, with no whitespace$/);
});

test("the banner says a next token is taken, and never prints it", () => {
  const lines = banner({ url: "http://127.0.0.1:7340", baseUrl: "http://127.0.0.1:7340/v2", data: "/data", token: OLD, source: "env", next: true, accounts: true });
  assert.ok(lines.includes("The next token ($AGENTRUN_TOKEN_NEXT) is taken beside it: move every caller to it, then make it AGENTRUN_TOKEN."), lines.join("\n"));
  assert.ok(lines.every((line) => !line.includes(OLD) && !line.includes(NEXT)));
  assert.ok(!banner({ url: "http://127.0.0.1:7340", baseUrl: "http://127.0.0.1:7340/v2", data: "/data", token: OLD, source: "env", accounts: true }).some((line) => line.includes("AGENTRUN_TOKEN_NEXT")), "and says nothing of one without it");
});

test("a runner's loops are never handed the next token", () => {
  const env = runEnv({ AGENTRUN_TOKEN: OLD, AGENTRUN_TOKEN_NEXT: NEXT, PATH: "/usr/bin" });
  assert.equal(env.AGENTRUN_TOKEN_NEXT, undefined);
  assert.equal(env.AGENTRUN_TOKEN, undefined);
  assert.equal(env.PATH, "/usr/bin");
});
