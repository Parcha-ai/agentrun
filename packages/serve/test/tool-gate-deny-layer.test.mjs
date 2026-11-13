// A deny's words name where it was set: this agent's own tool settings, or this server's. The gate reads both layers
// (permissionFrom); its refusal says which one holds the deny, so a person changes the right one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runnerGate } from "./gate-support.mjs";

/** The gate's answer for one call of `name` on a pi run, with the server's `settings` and the agent's own `overrides`:
 *  its refusal's words. */
async function called({ settings = {}, overrides = {}, name, mcpServers = [] }) {
  const decided = await runnerGate({ settings, overrides, mcpServers }).decide(name, {});
  return decided.deny ?? decided;
}

test("an MCP tool denied in the agent's own tool settings is refused 'for this agent', never 'on this server'", async () => {
  const got = await called({ overrides: { "mcp:fake/add": { permission: "deny" } }, name: "mcp__fake__add", mcpServers: ["fake"] });
  assert.equal(got, "Permission denied: mcp:fake/add is set to deny for this agent. It was not run: nothing was sent and nothing was charged. Don't retry it.");
});

test("an MCP tool denied in the server's tool settings is refused 'on this server'", async () => {
  const got = await called({ settings: { "mcp:fake/add": { permission: "deny" } }, name: "mcp__fake__add", mcpServers: ["fake"] });
  assert.equal(got, "Permission denied: mcp:fake/add is set to deny on this server. It was not run: nothing was sent and nothing was charged. Don't retry it.");
});

test("a shell watcher following bash's deny set for this agent names the agent", async () => {
  const got = await called({ overrides: { bash: { permission: "deny" } }, name: "bash_output" });
  assert.equal(got, "Permission denied: bash_output follows bash's setting, which is deny for this agent. It was not run: nothing was sent and nothing was charged. Don't retry it.");
});
