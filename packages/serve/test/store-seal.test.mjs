// The store's one sealing rule (store/seal.ts): a sealed column is today's AES-256-GCM seal under the server's seal key,
// bound to where it lives, AAD "<table>|<row key>|<column>", so a value moved to another row, column or table does not
// open. An MCP server's credential is one sealed column whose plaintext carries the server's origin: opened for a row whose
// url points elsewhere (a direct edit of the url column), it is refused as damaged and never handed out.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const { aadOf, openMcpCredential, sealColumn, sealedAt, sealMcpCredential, unsealColumn } = await import("../dist/store/seal.js");

const KEY = randomBytes(32);
const at = (table, row, column) => ({ table, row, column });

test("a sealed column opens where it was sealed, and only there: another row, column or table, or another key, refuses it", () => {
  const where = sealedAt.mcpServer("github");
  assert.equal(aadOf(where), "mcp_servers|github|sealed");
  const sealed = sealColumn(KEY, where, "a credential");
  assert.notEqual(Buffer.from(sealed).toString("utf8").includes("a credential"), true, "ciphertext, not the value");
  assert.equal(unsealColumn(KEY, where, sealed).toString("utf8"), "a credential");
  assert.throws(() => unsealColumn(KEY, sealedAt.mcpServer("linear"), sealed), "moved to another row");
  assert.throws(() => unsealColumn(KEY, at("mcp_servers", "github", "other"), sealed), "to another column");
  assert.throws(() => unsealColumn(KEY, at("sealed_keys", "github", "sealed"), sealed), "to another table");
  assert.throws(() => unsealColumn(randomBytes(32), where, sealed), "under another key");
});

test("a pending sign-in's secret parts seal at mcp_oauth_pending|<state>|sealed", () => {
  const where = sealedAt.oauthPending("state-1");
  assert.equal(aadOf(where), "mcp_oauth_pending|state-1|sealed");
  const secret = JSON.stringify({ verifier: "verifier-abc", client: { client_id: "c", client_secret: `not-a-secret-${"c"}` } });
  assert.equal(unsealColumn(KEY, where, sealColumn(KEY, where, secret)).toString("utf8"), secret);
  assert.throws(() => unsealColumn(KEY, sealedAt.oauthPending("state-2"), sealColumn(KEY, where, secret)));
});

test("a row key or column with the AAD's separator in it is refused, so no two places share an AAD", () => {
  assert.throws(() => sealColumn(KEY, at("mcp_servers", "git|hub", "sealed"), "x"), /\|/);
  assert.throws(() => sealColumn(KEY, at("mcp_servers", "github", "sea|led"), "x"), /\|/);
});

test("an MCP credential opens for its server's row with the origin it was sealed for, and is refused as damaged for another", () => {
  const credential = { type: "headers", headers: { authorization: `Bearer not-a-secret-${"x"}` } };
  const sealed = sealMcpCredential(KEY, "github", credential, "https://mcp.example.com/github");
  const row = { name: "github", url: "https://mcp.example.com/github/v2", sealed };
  assert.deepEqual(openMcpCredential(KEY, row), { credential: { ...credential, origin: "https://mcp.example.com" } }, "the same origin, another path: opens");
  const moved = openMcpCredential(KEY, { ...row, url: "https://attacker.example/github" });
  assert.equal(moved.unusable, "damaged", "the url's origin is not the sealed one: refused");
  assert.equal("credential" in moved, false, "and never handed out");
  assert.equal(openMcpCredential(KEY, { ...row, name: "linear" }).unusable, "unopened", "another row's credential does not open");
  assert.equal(openMcpCredential(randomBytes(32), row).unusable, "unopened", "nor under another key");
  assert.equal(openMcpCredential(KEY, { ...row, sealed: null }).unusable, "none", "a server with no credential");
});
