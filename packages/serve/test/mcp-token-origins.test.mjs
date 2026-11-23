// AGENTRUN_MCP_TOKEN_ORIGINS (mcp-token-origins.ts): the origins an API-only server's token may save a per_run MCP server
// at, as the operator lists them. Each entry is https://host[:port], or one loopback origin http://127.0.0.1:<port> (or
// http://[::1]:<port>) with its port, which counts only when AGENTRUN_MCP_ALLOW_LOOPBACK is on; anything else is refused
// in words at the start, never skipped. The one exact check (tokenOriginListed) is the save's and the claim's.
import assert from "node:assert/strict";
import { test } from "node:test";

const { MCP_TOKEN_ORIGINS_ENV, mcpTokenOriginsFrom, tokenOriginListed } = await import("../dist/mcp-token-origins.js");

const at = (value, loopback = false) => mcpTokenOriginsFrom({ AGENTRUN_MCP_TOKEN_ORIGINS: value }, loopback);

test("AGENTRUN_MCP_TOKEN_ORIGINS: unset or blank lists none; each entry is an exact origin, normalised by URL", () => {
  assert.equal(MCP_TOKEN_ORIGINS_ENV, "AGENTRUN_MCP_TOKEN_ORIGINS");
  assert.deepEqual(mcpTokenOriginsFrom({}), []);
  for (const value of ["", "  "]) assert.deepEqual(at(value), [], JSON.stringify(value));
  assert.deepEqual(at("https://tools.example, https://edge.example:8443"), ["https://tools.example", "https://edge.example:8443"]);
  assert.deepEqual(at("HTTPS://Tools.Example:443"), ["https://tools.example"], "scheme and host lowercased, the default port dropped");
});

test("a loopback entry counts only with AGENTRUN_MCP_ALLOW_LOOPBACK: http on 127.0.0.1 or [::1] with its port, or https on loopback", () => {
  assert.deepEqual(at("http://127.0.0.1:4001", true), ["http://127.0.0.1:4001"]);
  assert.deepEqual(at("http://[::1]:4001", true), ["http://[::1]:4001"]);
  assert.deepEqual(at("https://tools.example,http://127.0.0.1:4001", false), ["https://tools.example"], "listed, but not counted without the switch");
  assert.deepEqual(at("https://127.0.0.1:4443", false), []);
  assert.deepEqual(at("https://127.0.0.1:4443", true), ["https://127.0.0.1:4443"]);
});

test("an entry that is not an exact origin is refused in words naming the variable, never skipped; a password is never echoed", () => {
  for (const value of [
    "https://tools.example/mcp", "https://tools.example/", "https://tools.example?x=1", "https://tools.example#top",
    "https://user@tools.example", "https://*.tools.example", "*", "tools.example", "ftp://tools.example",
    "http://tools.example", "http://127.0.0.1", "http://localhost:4001",
    "http://10.0.0.1:4001", // key-gate: denylist a private-range entry the parser must refuse
    "https://tools.example,,https://edge.example", "https://tools.example,", "http://127.0.0.1:4001,http://127.0.0.1:4002",
  ]) {
    assert.throws(() => at(value, true), (error) => error instanceof TypeError && error.message.includes("AGENTRUN_MCP_TOKEN_ORIGINS"), value);
  }
  // An entry with a user and password, put together here so no line of the source reads as a credential URL.
  const withPassword = ["https://user", "hunter2-not-a-secret@tools.example"].join(":");
  assert.throws(() => at(withPassword, true), (error) => error instanceof TypeError && !error.message.includes("hunter2"));
});

test("tokenOriginListed: the URL's origin exactly one listed; no prefix, suffix, other port, other scheme or user", () => {
  const origins = ["https://tools.example", "http://127.0.0.1:4001"];
  for (const url of ["https://tools.example/mcp", "https://tools.example:443/mcp?v=2", "HTTPS://TOOLS.example/x", "http://127.0.0.1:4001/mcp"]) assert.equal(tokenOriginListed(url, origins), true, url);
  for (const url of [
    "https://tools.example.evil.test/mcp", "https://a.tools.example/mcp", "https://eviltools.example/mcp", "https://tools.example:8443/mcp",
    "http://tools.example/mcp", "https://user@tools.example/mcp", "https://evil.test/https://tools.example", "http://127.0.0.1:4002/mcp",
    "http://localhost:4001/mcp", "https://127.0.0.1:4001/mcp", "not a url",
  ]) assert.equal(tokenOriginListed(url, origins), false, url);
  assert.equal(tokenOriginListed("https://tools.example/mcp", []), false, "none listed: none");
});
