// The MCP request validation the registries share (mcp-probe.ts): the github_app auth type, a server on the connected
// GitHub App's tokens. It takes no token of its own and never a saved Authorization: its installation token is minted for
// each use; it may carry static headers beside it.
import assert from "node:assert/strict";
import { test } from "node:test";

const { authOf, MCP_AUTH_TYPES } = await import("../dist/mcp-probe.js");

test("github_app is an auth type: with no credential, or with static headers beside the token the App mints, it is taken", () => {
  assert.ok(MCP_AUTH_TYPES.includes("github_app"));
  for (const [value, want] of [
    [{ type: "github_app" }, { type: "github_app" }],
    [{ type: "github_app", headers: { "X-MCP-Tools": "add" } }, { type: "github_app", headers: { "x-mcp-tools": "add" } }],
  ]) {
    const issues = [];
    assert.deepEqual(authOf(value, issues), want, JSON.stringify(value));
    assert.deepEqual(issues, [], JSON.stringify(value));
  }
});

test("a github_app body with a token, or a saved Authorization header, is refused on that field, in words", () => {
  const token = [];
  authOf({ type: "github_app", token: "not-a-secret-token" }, token);
  assert.deepEqual(token.map((i) => [i.field, i.reason]), [["auth.token", "not_allowed"]]);
  assert.match(token[0].message, /github_app takes no token: the connected GitHub App's installation token is minted for each run/);
  const header = [];
  authOf({ type: "github_app", headers: { Authorization: "Bearer not-a-secret" } }, header);
  assert.deepEqual(header.map((i) => [i.field, i.reason]), [["auth.headers.Authorization", "not_allowed"]]);
  assert.match(header[0].message, /Authorization is the installation token minted for each run, never a saved one/);
});
