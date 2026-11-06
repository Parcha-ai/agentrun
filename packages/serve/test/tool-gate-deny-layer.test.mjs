// A deny's words name where it was set: this agent's own tool settings, or this server's. The gate reads both layers
// (permissionFrom); its refusal says which one holds the deny, so a person changes the right one.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunGate } from "../dist/tool-gate.js";

const scratch = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "deny-layer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** One call of `name` through a pi run's gate, with the server's `settings` file and the agent's own `overrides`. */
async function called(t, { settings = {}, overrides = {}, name, mcpServers = [] }) {
  const [root, work, data] = [await scratch(t), await scratch(t), await scratch(t)];
  await writeFile(join(data, "tool-settings.json"), JSON.stringify(settings));
  const gate = new RunGate({ root, work, data, runId: "r1", harness: "pi", mcpServers }, overrides, true, true);
  let ran = 0;
  const registration = { name, description: name, parameters: {}, execute: async () => (ran++, { content: [{ type: "text", text: "ran" }] }) };
  const wrapped = gate.extension([registration]).wraps.find((wrap) => wrap.tool === name)?.wrap(registration) ?? registration;
  const api = { callId: `c-${name}`, commit: async (change) => change({ appendEntry: async () => undefined }) };
  const result = await wrapped.execute({}, api, {});
  return { text: (result.content ?? []).map((block) => block.text ?? "").join(""), ran };
}

test("an MCP tool denied in the agent's own tool settings is refused 'for this agent', never 'on this server'", async (t) => {
  const got = await called(t, { overrides: { "mcp:fake/add": { permission: "deny" } }, name: "mcp__fake__add", mcpServers: ["fake"] });
  assert.deepEqual([got.text, got.ran], ["Permission denied: mcp:fake/add is set to deny for this agent. Don't retry it.", 0]);
});

test("an MCP tool denied in the server's tool settings is refused 'on this server'", async (t) => {
  const got = await called(t, { settings: { "mcp:fake/add": { permission: "deny" } }, name: "mcp__fake__add", mcpServers: ["fake"] });
  assert.deepEqual([got.text, got.ran], ["Permission denied: mcp:fake/add is set to deny on this server. Don't retry it.", 0]);
});

test("a shell watcher following bash's deny set for this agent names the agent", async (t) => {
  const got = await called(t, { overrides: { bash: { permission: "deny" } }, name: "bash_output" });
  assert.deepEqual([got.text, got.ran], ["Permission denied: bash_output follows bash's setting, which is deny for this agent. Don't retry it.", 0]);
});
