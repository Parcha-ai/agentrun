// The tool gate's interface (tool-gate.ts): the permission a tool's calls get, MCP's server-wide key and its
// precedence, and the owner's defaults.
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultPermission, isCatalogTool, isMcpTool, mcpToolName, permissionKeys, permissionOf } from "../dist/tool-gate.js";

test("an MCP tool's name is mcp:<server>/<tool>, a catalog tool, asked by default; a built-in tool is allowed by default", () => {
  assert.equal(mcpToolName("srv", "echo"), "mcp:srv/echo");
  assert.ok(isMcpTool("mcp:srv/echo") && !isMcpTool("mcp:srv") && !isMcpTool("web_fetch"));
  assert.ok(isCatalogTool("mcp:srv/echo") && isCatalogTool("monid.run") && !isCatalogTool("bash"));
  assert.deepEqual(["mcp:srv/echo", "monid.run", "web_fetch", "write"].map(defaultPermission), ["ask", "ask", "allow", "allow"]);
  assert.deepEqual(permissionKeys("mcp:srv/a/b"), ["mcp:srv/a/b", "mcp:srv/*"]);
  assert.deepEqual(permissionKeys("web_fetch"), ["web_fetch"]);
});

test("a permission is looked up most specific first: agent exact, agent server-wide, server exact, server server-wide, default", () => {
  const tool = "mcp:srv/echo";
  assert.equal(permissionOf(tool, {}), "ask", "default");
  assert.equal(permissionOf(tool, { "mcp:srv/*": { permission: "deny" } }), "deny", "server server-wide");
  assert.equal(permissionOf(tool, { "mcp:srv/*": { permission: "deny" }, [tool]: { permission: "allow" } }), "allow", "server exact over server server-wide");
  assert.equal(permissionOf(tool, { [tool]: { permission: "allow" } }, { "mcp:srv/*": { permission: "ask" } }), "ask", "agent server-wide over server exact");
  assert.equal(permissionOf(tool, { [tool]: { permission: "allow" } }, { "mcp:srv/*": { permission: "ask" }, [tool]: { permission: "deny" } }), "deny", "agent exact over all");
  assert.equal(permissionOf("mcp:other/echo", { "mcp:srv/*": { permission: "allow" } }), "ask", "another server's wildcard does not apply");
  assert.equal(permissionOf("web_fetch", { web_fetch: { permission: "deny" } }), "deny", "a built-in tool by its name");
});
