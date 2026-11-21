import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sourceSnapshotDigest } from "../dist/native/source-snapshot-types.js";
import { prepareSource } from "../dist/source-sync/prepare.js";

const sign = value => ({ ...value, digest: sourceSnapshotDigest(value) });
function snapshot() {
  const text = "---\nname: inspect\ndescription: Inspect the supplied project.\n---\nRead assets/data.bin before running scripts/check.sh.\n";
  const blobs = {}, entries = [{ path: "project", role: "project", type: "directory", bytes: 0, mode: 0o750 }];
  for (const [path, value, mode] of [["skills/owned/inspect/SKILL.md", text, 0o644], ["skills/owned/inspect/assets/data.bin", Buffer.from([0, 255, 128]), 0o600], ["skills/owned/inspect/scripts/check.sh", "#!/bin/sh\nprintf checked\n", 0o755]]) {
    const bytes = Buffer.from(value), sha256 = createHash("sha256").update(bytes).digest("hex");
    entries.push({ path, role: "skill", type: "file", bytes: bytes.length, sha256, mode }); blobs[sha256] = bytes.toString("base64");
  }
  return sign({ version: 1, complete: true, source: { runtime: "codex", machine_id: "fixture", project: "/fixture/project", selector: { kind: "project" } }, entries, blobs,
    instructions: { text: "Keep the original instruction whitespace.\n\n", layers: [] }, skills: [{ name: "inspect", path: "skills/owned/inspect", source: "fixture" }],
    configuration: { model: "source-model", tools: [{ name: "tracker", transport: "http", url: "https://tools.example/mcp", credentials: ["tracker-account"] }], permissions: { sandbox_mode: "workspace-write", approval_policy: "on-request" }, credentials: ["model-provider"] }, project: { git: null }, blockers: [] });
}
const guard = { key: "destination.fixture", fields: { generation: "current" } };
function destination(overrides = {}) {
  return {
    model: async s => ({ sourceModel: s.configuration.model, model: "openai/fixture-model", harness: "pi", guards: [guard] }),
    tool: async source => ({ source, tools: ["mcp:tracker/read_issue"], guards: [guard] }),
    policy: async s => ({ source: s.configuration.permissions, tools: ["read", "write", "edit", "bash"], computer: { kind: "container" }, toolSettings: { bash: { permission: "ask" } } }),
    credentials: async names => ({ resolved: names, guards: [guard] }),
    check: async () => ({ warnings: [], stamp: { mcpPin: { fixture: "validated destination pin" } } }), ...overrides,
  };
}
const refused = (promise, code) => assert.rejects(promise, error => error.blockers?.some(b => b.code === code));

test("prepare keeps original instructions, authored skill metadata and exact supported destination settings", async () => {
  const s = snapshot(), before = structuredClone(s); let checked;
  const made = await prepareSource(s, destination({ check: async revision => { checked = structuredClone(revision); return { warnings: [], stamp: { mcpPin: { fixture: "validated" } } }; } }));
  assert.equal(made.revision.kind, "agentic");
  assert.equal(made.revision.body.instructions, s.instructions.text);
  assert.equal(made.revision.body.model, "openai/fixture-model");
  assert.deepEqual(made.revision.body.tools, ["read", "write", "edit", "bash", "mcp:tracker/read_issue"]);
  assert.deepEqual(made.revision.body.toolSettings, { bash: { permission: "ask" } });
  assert.deepEqual(made.revision.body.computer, { kind: "container" });
  assert.equal(made.revision.skills["inspect/SKILL.md"], Buffer.from(s.blobs[s.entries[1].sha256], "base64").toString());
  assert.equal(made.revision.body.skills["inspect/SKILL.md"], s.entries[1].sha256);
  assert.equal(made.revision.body.maxCostUsd, undefined, "Move invents no spending cap");
  for (const field of ["native", "sdk", "cli_learning", "sourceSync"]) assert.equal(made.revision.body[field], undefined);
  assert.deepEqual(made.revision.mcpPin, { fixture: "validated" });
  assert.equal(checked.body.model, made.revision.body.model, "ordinary checks see the final managed definition");
  assert.ok(made.guards.some(item => item.key === guard.key));
  assert.deepEqual(s, before, "binary assets, scripts and their modes remain exact in the immutable snapshot");
});

test("prepare refuses incomplete or corrupt source bytes before any destination resolver runs", async () => {
  let calls = 0; const deps = destination({ model: async () => { calls++; throw new Error("must not resolve"); } });
  const s = snapshot(); await refused(prepareSource(sign({ ...s, complete: false, blockers: [{ code: "missing_file", message: "Sync the missing file." }] }), deps), "missing_file");
  const corrupt = structuredClone(s); corrupt.blobs[s.entries[1].sha256] = Buffer.from("changed").toString("base64");
  await assert.rejects(prepareSource(corrupt, deps)); assert.equal(calls, 0);
});

test("a matching tool name with a different endpoint is not the required capability identity", async () => {
  await refused(prepareSource(snapshot(), destination({ tool: async source => ({ source: { ...source, url: "https://different.example/mcp" }, tools: ["mcp:tracker/read_issue"], guards: [guard] }) })), "tool_identity");
});

test("unsupported permissions, unresolved aliases and missing destination credentials cannot be silently dropped", async () => {
  await refused(prepareSource(snapshot(), destination({ policy: async () => ({ source: {}, tools: ["read"] }) })), "policy_mapping");
  await refused(prepareSource(snapshot(), destination({ model: async () => ({ sourceModel: "different-model", model: "openai/fixture-model", harness: "pi" }) })), "model_mapping");
  const unknown = snapshot(); unknown.configuration.model = null;
  await refused(prepareSource(sign(unknown), destination()), "model_mapping");
  await refused(prepareSource(snapshot(), destination({ credentials: async () => ({ resolved: ["model-provider"] }) })), "credentials_missing");
  await refused(prepareSource(snapshot(), destination({ policy: async () => ({ blockers: [{ code: "unsupported_policy", path: "approval_policy", message: "Select an equivalent destination approval policy." }] }) })), "unsupported_policy");
});

test("Move treats ordinary host setup warnings as blockers and preserves their actionable field", async () => {
  await assert.rejects(prepareSource(snapshot(), destination({ check: async () => ({ warnings: [{ field: "definition.computer", reason: "not_set_up_here", message: "Configure a destination executor." }], stamp: {} }) })), error => {
    assert.deepEqual(error.blockers, [{ code: "not_set_up_here", path: "definition.computer", message: "Configure a destination executor." }]); return true;
  });
});

test("authored UTF-8 BOM bytes remain part of the skill metadata and digest", async () => {
  const s = snapshot(), entry = s.entries[1], previous = entry.sha256;
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s.blobs[previous], "base64")]);
  entry.sha256 = createHash("sha256").update(bytes).digest("hex"); entry.bytes = bytes.length;
  delete s.blobs[previous]; s.blobs[entry.sha256] = bytes.toString("base64");
  const made = await prepareSource(sign(s), destination());
  assert.deepEqual(Buffer.from(made.revision.skills["inspect/SKILL.md"]), bytes);
  assert.equal(made.revision.body.skills["inspect/SKILL.md"], entry.sha256);
});

test("destination MCP account guards survive preparation without entering the revision", async () => {
  const sealed = Buffer.from([5, 9, 17, 33]), mcpGuard = { name: "tracker", url: "https://tools.example/mcp", auth: "bearer", credentialChangedAt: 123, tools: [{ name: "read_issue" }], sealed };
  const made = await prepareSource(snapshot(), destination({ tool: async source => ({ source, tools: ["mcp:tracker/read_issue"], guards: [guard], mcpGuards: [mcpGuard] }) }));
  assert.deepEqual(made.mcpGuards, [mcpGuard]);
  assert.equal(made.mcpGuards[0].sealed, sealed, "the transaction compares the original prepared account generation");
  assert.equal(made.revision.mcpGuards, undefined);
  assert.equal(made.revision.body.mcpGuards, undefined);
  assert.equal(JSON.stringify(made.revision).includes(JSON.stringify([...sealed])), false, "sealed account bytes are not revision content or pins");
});
