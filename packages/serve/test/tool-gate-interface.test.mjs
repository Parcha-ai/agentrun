// The tool gate's interface (tool-gate.ts): the permission a tool's calls get, MCP's server-wide key and its
// precedence, and the owner's defaults.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPermission, isCatalogTool, isMcpTool, mcpToolName, permissionFrom, permissionKeys, permissionOf, runGate } from "../dist/tool-gate.js";

test("an MCP tool's name is mcp:<server>/<tool>, a catalog tool, asked by default; a built-in tool is allowed by default", () => {
  assert.equal(mcpToolName("srv", "echo"), "mcp:srv/echo");
  assert.ok(isMcpTool("mcp:srv/echo") && !isMcpTool("mcp:srv") && !isMcpTool("web_fetch"));
  assert.ok(isCatalogTool("mcp:srv/echo") && isCatalogTool("monid.run") && !isCatalogTool("bash"));
  assert.deepEqual(["mcp:srv/echo", "monid.run", "web_fetch", "write"].map(defaultPermission), ["ask", "ask", "allow", "allow"]);
  assert.deepEqual(permissionKeys("mcp:srv/a/b"), ["mcp:srv/a/b", "mcp:srv/*"]);
  assert.deepEqual(permissionKeys("web_fetch"), ["web_fetch"]);
});

test("on a run with no computer a tool no setting names takes the kernel's ruled default: bash asks first, the background tools are refused; a setting still wins, and a computer allows them as before", async () => {
  const none = { computer: false };
  assert.deepEqual(["bash", "bash_background", "bash_output", "bash_input", "bash_signal", "bash_list", "read", "write", "web_fetch", "mcp:srv/echo"].map((name) => defaultPermission(name, none)), ["ask", "deny", "deny", "deny", "deny", "deny", "allow", "allow", "allow", "ask"]);
  assert.deepEqual(["bash", "bash_background"].map((name) => defaultPermission(name, { computer: true })), ["allow", "allow"]);
  assert.deepEqual(["bash", "bash_background"].map((name) => defaultPermission(name)), ["allow", "allow"], "no run in view: the computer's defaults");
  // As the permission in force reads it (permissionFrom): the default where nothing is set, a setting where one is.
  assert.deepEqual(permissionFrom("bash", {}, {}, "ask", none), { permission: "ask", from: "default" });
  assert.deepEqual(permissionFrom("bash_background", {}, {}, "ask", none), { permission: "deny", from: "default" });
  assert.deepEqual(permissionFrom("bash", { bash: { permission: "allow" } }, {}, "ask", none), { permission: "allow", from: "server" }, "the server's setting over the default");
  assert.deepEqual(permissionFrom("bash", {}, { bash: { permission: "allow" } }, "ask", none), { permission: "allow", from: "agent" }, "the agent's own over the default");
  // The run's gate on the runner: built with no computer (adapterRunGate, from the run's shell), a bash call no setting
  // names is asked first, never run unasked.
  const dir = mkdtempSync(join(tmpdir(), "tool-gate-none-"));
  try {
    const gate = runGate({ root: dir, work: dir, computer: false }, "run-1", { kind: "agentic", body: {} }, () => ({ settings: {}, problems: [] }), true);
    assert.equal(gate.policy("bash"), "ask");
    assert.equal(await gate.decide("bash", { command: "ls" }), "ask");
    assert.equal(gate.policy("bash_background"), "deny");
    const onComputer = runGate({ root: dir, work: dir, computer: true }, "run-2", { kind: "agentic", body: {} }, () => ({ settings: {}, problems: [] }), true);
    assert.equal(await onComputer.decide("bash", { command: "ls" }), "allow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
