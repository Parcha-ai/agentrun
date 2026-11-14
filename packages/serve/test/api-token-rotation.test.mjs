// The server takes a list of API tokens, each with an id (api-token.ts): AGENTRUN_TOKENS holds `id:secret` entries, and
// AGENTRUN_TOKEN (else DIR/.token's) is the entry `default`. Any of them opens /v2 and /mcp, and setup (with accounts)
// takes any as its Bearer header or its code; anything else is refused as before. The request log names the id of the
// token used, never a secret. Once an entry is removed, its token is refused. Every presented token is compared with
// node:crypto's timingSafeEqual, against every token, on equal-length digests, with no early return. No run or runner
// loop is handed the list.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { startServe } from "../dist/index.js";
import { call, client, serve } from "./support.mjs";

const { acceptedTokens, bearerCheck, DEFAULT_TOKEN_ID, parseTokens, TOKENS_ENV, tokenProblem } = await import("../dist/api-token.js");
const { banner } = await import("../dist/print.js");
const { runEnv } = await import("../dist/runner/main.js");

// Test tokens: plainly no secrets, 32 characters or more.
const OLD = "test-token-old-0000000000000000000000";
const NEW = "test-token-new-1111111111111111111111";
const OTHER = "test-token-other-22222222222222222222";

test("the list is AGENTRUN_TOKENS, of id:secret entries separated by commas or whitespace", () => {
  assert.equal(TOKENS_ENV, "AGENTRUN_TOKENS");
  assert.equal(DEFAULT_TOKEN_ID, "default");
  assert.deepEqual(parseTokens(`old:${OLD},new:${NEW}`), [{ id: "old", token: OLD }, { id: "new", token: NEW }]);
  assert.deepEqual(parseTokens(` old:${OLD}\n  new:${NEW} ,\n`), [{ id: "old", token: OLD }, { id: "new", token: NEW }]);
  assert.deepEqual(parseTokens(`ci.2026-11_a:${OLD}:with-colon`), [{ id: "ci.2026-11_a", token: `${OLD}:with-colon` }], "the first : ends the id");
  assert.equal(parseTokens(undefined), undefined);
  assert.equal(parseTokens(""), undefined, "an empty list is none, as an empty AGENTRUN_TOKEN is");
  assert.equal(parseTokens(" \n"), undefined);
});

test("an entry that is not id:secret, a bad id or a short secret is refused, in words that hold no secret", () => {
  for (const [text, message] of [
    [OLD, "AGENTRUN_TOKENS entry 1 is not id:secret"],
    [`a:${OLD},${NEW}`, "AGENTRUN_TOKENS entry 2 is not id:secret"],
    [`:${OLD}`, /entry 1's id must be/],
    [`-x:${OLD}`, /entry 1's id must be/],
    [`${"i".repeat(33)}:${OLD}`, /entry 1's id must be/],
    ["short:too-short", "AGENTRUN_TOKENS entry short's secret must be 32 characters or more, with no whitespace"],
  ]) {
    assert.throws(() => parseTokens(text), (error) => (typeof message === "string" ? error.message === message : message.test(error.message)) && !error.message.includes(OLD) && !error.message.includes(NEW), text);
  }
  assert.equal(tokenProblem("short"), "the token must be 32 characters or more, with no whitespace");
});

test("AGENTRUN_TOKEN is the entry default, first; an id or a secret used twice is refused", () => {
  assert.deepEqual(acceptedTokens(OLD, undefined), [{ id: "default", token: OLD }]);
  assert.deepEqual(acceptedTokens(OLD, [{ id: "new", token: NEW }]), [{ id: "default", token: OLD }, { id: "new", token: NEW }]);
  assert.deepEqual(acceptedTokens(undefined, [{ id: "new", token: NEW }]), [{ id: "new", token: NEW }]);
  assert.throws(() => acceptedTokens(OLD, [{ id: "default", token: NEW }]), /^Error: the API token id default is used twice \(AGENTRUN_TOKEN is default\)$/);
  assert.throws(() => acceptedTokens(undefined, [{ id: "a", token: OLD }, { id: "a", token: NEW }]), /^Error: the API token id a is used twice$/);
  assert.throws(() => acceptedTokens(OLD, [{ id: "again", token: OLD }]), /^Error: the API token again has the same secret as another token$/);
  assert.throws(() => acceptedTokens(undefined, []), TypeError);
});

test("a Bearer header with any token answers its id; any other header is refused", () => {
  const bearer = bearerCheck([{ id: "old", token: OLD }, { id: "new", token: NEW }]);
  assert.equal(bearer(`Bearer ${OLD}`), "old");
  assert.equal(bearer(`Bearer ${NEW}`), "new");
  for (const header of [undefined, "", `Bearer ${OTHER}`, OLD, NEW, `bearer ${OLD}`, `Bearer ${OLD} `, `Bearer ${OLD.slice(0, -1)}`, `Bearer ${OLD}${NEW}`, `Basic ${OLD}`]) {
    assert.equal(bearer(header), undefined, JSON.stringify(header));
  }
  assert.equal(bearerCheck([{ id: "old", token: OLD }])(`Bearer ${NEW}`), undefined, "a token not on the list is refused");
  assert.throws(() => bearerCheck([]), TypeError);
});

test("every check compares the header against every token, on two 32-byte digests, with no early return on a match", () => {
  const calls = [];
  const equal = (a, b) => (calls.push([a.length, b.length]), crypto.timingSafeEqual(a, b));
  const bearer = bearerCheck([{ id: "a", token: OLD }, { id: "b", token: NEW }, { id: "c", token: OTHER }], equal);
  for (const [header, expected] of [[`Bearer ${OLD}`, "a"], [`Bearer ${NEW}`, "b"], [`Bearer ${OTHER}`, "c"], ["Bearer nope", undefined], [undefined, undefined], ["x".repeat(10_000), undefined]]) {
    calls.length = 0;
    assert.equal(bearer(header), expected, String(header).slice(0, 40));
    assert.deepEqual(calls, [[32, 32], [32, 32], [32, 32]], `three comparisons, each of two digests, whatever was sent (${String(header).slice(0, 40)})`);
  }
});

test("by default the comparison is node:crypto's timingSafeEqual", (t) => {
  const spied = mock.method(crypto, "timingSafeEqual");
  syncBuiltinESMExports();
  t.after(() => (spied.mock.restore(), syncBuiltinESMExports()));
  const bearer = bearerCheck([{ id: "old", token: OLD }, { id: "new", token: NEW }]);
  assert.equal(bearer(`Bearer ${OLD}`), "old");
  assert.equal(spied.mock.callCount(), 2, "timingSafeEqual compared the header with each token, the first matching");
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

/** The request lines of `lines` for `path`. */
const requestLines = (lines, path) => lines.filter((line) => / event=request /.test(line) && line.includes(` path=${path} `));

test("a server given AGENTRUN_TOKEN and a list answers any of them on /v2 and /mcp, logs the id used, and refuses any other", async (t) => {
  const lines = [];
  const server = await serve(t, { token: OLD, tokens: [{ id: "ci-new", token: NEW }], runner: false, log: (line) => lines.push(line) });
  assert.equal(server.token, OLD, "AGENTRUN_TOKEN's is still the server's token");
  assert.deepEqual(server.tokenIds, ["default", "ci-new"]);
  for (const [token, id] of [[OLD, "default"], [NEW, "ci-new"]]) {
    lines.length = 0;
    assert.equal((await client(server.baseUrl, token)("GET", "/agents")).status, 200, `${id} on /v2`);
    assert.equal(await mcpStatus(server, token), 200, `${id} on /mcp`);
    const v2 = requestLines(lines, "/v2/agents");
    const mcp = requestLines(lines, "/v2/mcp").concat(requestLines(lines, "/mcp"));
    assert.equal(v2.length, 1, lines.join("\n"));
    assert.match(v2[0], new RegExp(` token=${id}( |$)`), "the /v2 request line names the token's id");
    assert.ok(mcp.length === 1 && new RegExp(` token=${id}( |$)`).test(mcp[0]), `the /mcp request line names it too: ${lines.join("\n")}`);
  }
  lines.length = 0;
  assert.equal((await client(server.baseUrl, OTHER)("GET", "/agents")).status, 401, "another token on /v2");
  assert.equal((await client(server.baseUrl)("GET", "/agents")).status, 401, "no token on /v2");
  assert.equal(await mcpStatus(server, OTHER), 401, "another token on /mcp");
  assert.ok(requestLines(lines, "/v2/agents").every((line) => !/ token=/.test(line)), "a refused request names no token");
  assert.ok(lines.every((line) => !line.includes(OLD) && !line.includes(NEW) && !line.includes(OTHER)), "no log line holds a secret");
});

test("a list alone takes DIR/.token's place: none is read or made, and the first entry is the server's token", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tokens-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  const server = await serve(t, { data, tokens: [{ id: "a", token: OLD }, { id: "b", token: NEW }], runner: false });
  assert.equal(server.token, OLD);
  assert.equal(server.tokenFile, null);
  assert.equal(existsSync(join(data, ".token")), false);
  assert.equal((await client(server.baseUrl, NEW)("GET", "/agents")).status, 200);
});

test("a rotation (add the new entry, move callers, remove the old) refuses no caller until the old entry is gone", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-rotate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  // Before: the one token, as a single-token server has it.
  const before = await startServe({ data, port: 0, token: OLD });
  try {
    assert.equal((await client(before.baseUrl, OLD)("GET", "/agents")).status, 200);
  } finally {
    await before.close();
  }
  // Step 1: the new token added as an entry; both work.
  const during = await startServe({ data, port: 0, token: OLD, tokens: [{ id: "next", token: NEW }] });
  try {
    assert.equal((await client(during.baseUrl, OLD)("GET", "/agents")).status, 200);
    assert.equal((await client(during.baseUrl, NEW)("GET", "/agents")).status, 200);
  } finally {
    await during.close();
  }
  // Step 3: the old one removed (AGENTRUN_TOKEN unset); the list alone.
  const lines = [];
  const after = await startServe({ data, port: 0, tokens: [{ id: "next", token: NEW }], log: (line) => lines.push(line) });
  t.after(() => after.close());
  assert.equal((await client(after.baseUrl, NEW)("GET", "/agents")).status, 200, "the new token");
  const old = await client(after.baseUrl, OLD)("GET", "/agents");
  assert.equal(old.status, 401, "the old token is refused");
  assert.equal(old.headers.get("www-authenticate"), "Bearer");
  assert.equal(await mcpStatus(after, OLD), 401, "on /mcp too");
  assert.ok(lines.some((line) => / event=auth_failed /.test(line) && / route=\/v2\/agents /.test(line) && / reason=wrong_token$/.test(line)), `logged as wrong_token: ${lines.join("\n")}`);
});

/** A first password for a server with accounts, plainly no secret (as owner-auth.test.mjs makes them). */
const PASSWORD = `not-a-secret-${"owner"}`;
/** POST /v2/setup on `server` with `body`, from its own page unless `headers` says otherwise. */
const setup = (server, body, headers = { "content-type": "application/json", origin: `http://127.0.0.1:${server.port}` }) => call(server.port, { method: "POST", path: "/v2/setup", headers, body });

test("setup with accounts takes a listed token as its Bearer header, as it takes the token", async (t) => {
  const server = await serve(t, { accounts: true, token: OLD, tokens: [{ id: "new", token: NEW }], runner: false });
  const made = await setup(server, { password: PASSWORD }, { "content-type": "application/json", authorization: `Bearer ${NEW}` });
  assert.equal(made.status, 201, made.text);
});

test("setup with accounts takes a listed token in its code field, as it takes the token", async (t) => {
  const server = await serve(t, { accounts: true, token: OLD, tokens: [{ id: "new", token: NEW }], runner: false });
  const made = await setup(server, { password: PASSWORD, code: NEW });
  assert.equal(made.status, 201, made.text);
});

test("after the rotation, setup refuses the removed token as its Bearer header and as its code", async (t) => {
  const server = await serve(t, { accounts: true, tokens: [{ id: "new", token: NEW }], runner: false });
  const byHeader = await setup(server, { password: PASSWORD }, { "content-type": "application/json", authorization: `Bearer ${OLD}` });
  assert.equal(byHeader.status, 401, byHeader.text);
  const byCode = await setup(server, { password: PASSWORD, code: OLD });
  assert.equal(byCode.status, 403, byCode.text);
  assert.ok(!byHeader.text.includes(OLD) && !byCode.text.includes(OLD), "no refusal says the token");
  assert.equal((await setup(server, { password: PASSWORD, code: NEW })).status, 201, "the token now in force still sets the password");
});

test("a list that breaks the rules stops the start, in words", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "agentrun-rotate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, "agents");
  await assert.rejects(startServe({ data, port: 0, token: OLD, tokens: [{ id: "new", token: "too-short" }] }), /^Error: the API token new must be 32 characters or more, with no whitespace$/);
  await assert.rejects(startServe({ data, port: 0, token: OLD, tokens: [{ id: "default", token: NEW }] }), /^Error: the API token id default is used twice/);
  await assert.rejects(startServe({ data, port: 0, token: OLD, tokens: [{ id: "same", token: OLD }] }), /^Error: the API token same has the same secret as another token$/);
});

test("the banner names the ids of the tokens taken, and never a secret", () => {
  const base = { url: "http://127.0.0.1:7340", baseUrl: "http://127.0.0.1:7340/v2", data: "/data", token: OLD, accounts: true };
  const both = banner({ ...base, source: "env", tokenIds: ["default", "ci-new"] });
  assert.ok(both.includes("API tokens taken (ids): default, ci-new"), both.join("\n"));
  const listed = banner({ ...base, source: "list", tokenIds: ["ci-new"] });
  assert.ok(listed.includes("AGENTRUN_API_KEY=<a secret in $AGENTRUN_TOKENS>"), listed.join("\n"));
  assert.ok(listed.includes("API tokens taken (ids): ci-new"), listed.join("\n"));
  for (const lines of [both, listed]) assert.ok(lines.every((line) => !line.includes(OLD) && !line.includes(NEW)));
  assert.ok(!banner({ ...base, source: "env", tokenIds: ["default"] }).some((line) => line.startsWith("API tokens")), "one token from AGENTRUN_TOKEN: no ids line");
});

test("a runner's loops are never handed the token list", () => {
  const env = runEnv({ AGENTRUN_TOKEN: OLD, AGENTRUN_TOKENS: `new:${NEW}`, PATH: "/usr/bin" });
  assert.equal(env.AGENTRUN_TOKENS, undefined);
  assert.equal(env.AGENTRUN_TOKEN, undefined);
  assert.equal(env.PATH, "/usr/bin");
});
