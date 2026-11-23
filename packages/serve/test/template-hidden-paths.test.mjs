// A hidden file or folder (.env, .DS_Store, .cache/) is no part of a package anywhere: readPackage refuses agent.md
// naming one as the answer's schema, never reading it, and an upload leaves each hidden path out before it is stored, so a
// .env a client sends is neither kept nor read back. An export of a revision applied before its apply kept the package's
// key names says so, so the target knows to set them up.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { agentPackage } from "../dist/agent-package.js";
import { PackageError, readPackage } from "../dist/templates.js";
import { scratch, serve } from "./support.mjs";

const agentMd = (name, extra = []) => `---
name: ${name}
version: 1.0.0
description: Says what changed today.
${extra.join("\n")}
---
Say what changed.
`;
const SKILL = "---\nname: check\ndescription: Check what changed.\n---\nSay what changed.\n";
const SCHEMA = `${JSON.stringify({ type: "object", properties: { summary: { type: "string" } }, required: ["summary"] })}\n`;

/** The problems readPackage names for a folder `name` of these files (path -> text); [] when it reads. */
async function problemsOf(t, name, files) {
  const dir = join(await scratch(t), name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  try {
    readPackage(dir);
  } catch (error) {
    assert.ok(error instanceof PackageError, error.stack);
    return error.problems;
  }
  return [];
}

test("agent.md naming a hidden file as the answer's schema is refused, at the top or under evals/, naming it; a plain one reads", async (t) => {
  for (const at of [".answer.json", "evals/.cache/answer.json", "evals/today/.answer.json"]) {
    const problems = await problemsOf(t, "daily", { "agent.md": agentMd("daily", [`output: { schema: ${at} }`]), [at]: SCHEMA });
    assert.ok(problems.some((p) => p.includes(`output.schema ${at} is a hidden file`)), `${at}: ${JSON.stringify(problems)}`);
  }
  assert.deepEqual(await problemsOf(t, "daily", { "agent.md": agentMd("daily", ["output: { schema: answer.json }"]), "answer.json": SCHEMA }), []);
});

test("an upload leaves out every hidden path before it is stored: a .env at the top, directly under skills/ or in a skill folder is neither kept nor read back, and the upload's sha is its package's", { timeout: 120_000 }, async (t) => {
  const server = await serve(t, { runner: false });
  const { api } = server;
  const plain = [["agent.md", agentMd("daily")], ["skills/check/SKILL.md", SKILL]];
  const hidden = [[".env", "PARALLEL_API_KEY=not-a-secret\n"], ["skills/.env", "PARALLEL_API_KEY=not-a-secret\n"], ["skills/check/.env", "PARALLEL_API_KEY=not-a-secret\n"], [".cache/token", "not-a-secret\n"]];
  const files = [...plain, ...hidden].map(([path, content]) => ({ path, encoding: "utf8", content }));
  const stored = await api("POST", "/templates/import", { files });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  // The sha is the package's: its files without the hidden ones.
  const hash = createHash("sha256");
  for (const [path, content] of [...plain].sort(([a], [b]) => (a < b ? -1 : 1))) hash.update(path).update("\0").update(content).update("\0");
  assert.equal(stored.body.template.sha, hash.digest("hex"));
  const [row] = await server.store.importedTemplates.list();
  assert.deepEqual(Object.keys(row.files).sort(), ["agent.md", "skills/check/SKILL.md"], "no hidden path stored");
  const read = await api("GET", `/templates/${encodeURIComponent("upload:daily")}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(!JSON.stringify(read.body).includes("not-a-secret"), "never read back");
  assert.ok(!JSON.stringify(stored.body).includes("not-a-secret"), "nor answered");
});

test("an export of a revision applied before its apply kept the package's key names says so (remade, secrets), so the target sets them up; one whose apply kept them says nothing", () => {
  const input = (template) => ({
    agent: { id: "kyb-1", name: "KYB", description: "Checks a business." },
    definition: { instructions: "Check the business.", harness: "pi", tools: ["read"], max_cost_usd: 1 },
    skills: {}, template, origin: undefined, servers: new Map(), triggers: [], signIns: [], now: Date.parse("2026-11-23T00:00:00Z"),
  });
  const before = agentPackage(input({ id: "github:acme/agents/kyb", version: "1.2.0" }));
  const notes = before.report.remade.filter((note) => note.kind === "secrets");
  assert.deepEqual(notes.map((note) => note.name), ["github:acme/agents/kyb"], JSON.stringify(before.report));
  assert.match(notes[0].reason, /key names .*not kept/);
  assert.match(notes[0].reason, /secrets/);
  const kept = agentPackage(input({ id: "github:acme/agents/kyb", version: "1.2.0", secrets: ["PARALLEL_API_KEY"] }));
  assert.deepEqual(kept.report.remade.filter((note) => note.kind === "secrets"), []);
  const none = agentPackage(input(null));
  assert.deepEqual(none.report.remade.filter((note) => note.kind === "secrets"), [], "an agent no package made has no keys to name");
});
