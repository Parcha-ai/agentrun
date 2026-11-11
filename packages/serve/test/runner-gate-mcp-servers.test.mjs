// The runner's gate (adapterRunGate → RunGate.decide) knows the run's MCP servers, so a harness that names a session's MCP
// tool its own way (OpenCode's `<server>_<tool>`, its facts' toolAlias) is held to that tool's `mcp:<server>/<tool>`
// settings, never to a table tool's, and the read_skill_file shadow guard can fire: an agent's MCP server "read" with a
// tool "skill_file" is its own tool, never read's.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { openSqliteStore } = await import("../dist/store/index.js");
const { adapterRunGate } = await import("../dist/runner/adapter-run-spec.js");
const { deniedText } = await import("../dist/refusal-words.js");
const { mcpServersOf } = await import("../dist/tool-gate.js");

/** The runner's gate for an OpenCode revision with `toolSettings`, over a fresh store, knowing the run's MCP `servers`. */
async function openCodeGate(t, toolSettings, servers) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "runner-gate-mcp-servers-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const revision = { kind: "agentic", body: { toolSettings, harness: "opencode" } };
  return adapterRunGate(store, { runId: "run-1" }, revision, dir, servers);
}

test("the MCP servers a revision grants, by their catalog names: each once, a wildcard grant too, no table tool", () => {
  assert.deepEqual(mcpServersOf(["read", "mcp:fake/add", "mcp:fake/sub", "mcp:read/skill_file", "mcp:docs/*", "web_fetch"]), ["fake", "read", "docs"]);
  assert.deepEqual(mcpServersOf([]), []);
});

test("OpenCode on the runner: an agent's mcp:fake/add deny refuses fake_add, its wire name, in the gate's words by the catalog name", async (t) => {
  const gate = await openCodeGate(t, { "mcp:fake/add": { permission: "deny" } }, ["fake"]);
  assert.deepEqual(await gate({ callId: "c1", tool: "fake_add", args: { a: 1, b: 1 } }), { deny: deniedText("mcp:fake/add", "mcp:fake/add", "agent", "no") });
});

test("OpenCode on the runner: an agent's MCP server read with a tool skill_file set to deny is that tool, never read's allow", async (t) => {
  const gate = await openCodeGate(t, { "mcp:read/skill_file": { permission: "deny" } }, ["read"]);
  assert.deepEqual(await gate({ callId: "c2", tool: "read_skill_file", args: { name: "x", file: "SKILL.md" } }), { deny: deniedText("mcp:read/skill_file", "mcp:read/skill_file", "agent", "no") });
});

test("OpenCode on the runner, no MCP server read: read_skill_file follows read's setting", { skip: "waits on read_skill_file taking read's key (places/learning-seed-lay 9c83b8da6d)" }, async (t) => {
  const allowed = await openCodeGate(t, {}, []);
  assert.equal(await allowed({ callId: "c3", tool: "read_skill_file", args: { name: "x", file: "SKILL.md" } }), "allow");
  const denied = await openCodeGate(t, { read: { permission: "deny" } }, []);
  assert.deepEqual(await denied({ callId: "c4", tool: "read_skill_file", args: { name: "x", file: "SKILL.md" } }), { deny: deniedText("read_skill_file", "read", "agent", "no") });
});
