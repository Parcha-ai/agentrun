// A skill edit reads every file from the exact revision it will replace, never the current revision by accident.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { nativeFixture } from "./native-fixtures/setup.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve, withEnv } from "./support.mjs";

test("revision skills return the complete immutable file map, including support files, without changing the agent", async (t) => {
  const { api } = await serve(t, { runner: false });
  const original = { "cite/SKILL.md": "# Cite\nKeep exact sources.\n", "cite/references/example.txt": "A & B — evidence\n", "review/SKILL.md": "# Review\n" };
  const made = await api("POST", "/agents", { ...agent("skills-reader", { skills: ["cite", "review"] }), skills: original });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const replacement = { "cite/SKILL.md": "# Cite\nUse the new rubric.\n", "cite/references/new.txt": "New supporting file.\n" };
  const saved = await api("PUT", "/agents/skills-reader/definition", { definition: { instructions: "Answer.", skills: ["cite"], tools: [] }, skills: replacement }, { "if-match": made.headers.get("etag") });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const before = await api("GET", "/agents/skills-reader");
  const revisions = (await api("GET", "/agents/skills-reader/revisions")).body;
  const doc = (await api("GET", "/openapi.json")).body;
  for (const [revision, skills] of [[made.body.revision, original], [saved.body.revision, replacement], [made.body.revision, original]]) {
    const read = await api("GET", `/agents/skills-reader/revisions/${revision}/skills`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body, { revision, skills });
    const schema = doc.paths["/agents/{agent_id}/revisions/{revision}/skills"].get.responses["200"].content["application/json"].schema;
    assert.deepEqual(schemaProblems(doc, schema, read.body), []);
  }
  const after = await api("GET", "/agents/skills-reader");
  assert.deepEqual(after.body, before.body);
  assert.equal(after.headers.get("etag"), before.headers.get("etag"));
  assert.deepEqual((await api("GET", "/agents/skills-reader/revisions")).body, revisions);
  await api("POST", "/agents/skills-reader/archive", {});
  assert.deepEqual((await api("GET", `/agents/skills-reader/revisions/${made.body.revision}/skills`)).body, { revision: made.body.revision, skills: original });
});

test("revision skills require authentication and an exact revision owned by the named agent", async (t) => {
  const { api, baseUrl } = await serve(t, { runner: false });
  const first = (await api("POST", "/agents", agent("first-skills"))).body;
  const second = (await api("POST", "/agents", { ...agent("other-skills", { skills: ["private"] }), skills: { "private/SKILL.md": "Other agent's skill.\n" } })).body;
  const route = `/agents/first-skills/revisions/${first.revision}/skills`;
  assert.equal((await fetch(`${baseUrl}${route}`)).status, 401);
  assert.deepEqual((await api("GET", route)).body, { revision: first.revision, skills: {} });
  for (const path of [
    "/agents/missing/revisions/missing/skills",
    "/agents/first-skills/revisions/missing/skills",
    `/agents/first-skills/revisions/${second.revision}/skills`,
  ]) {
    const read = await api("GET", path);
    assert.equal(read.status, 404, JSON.stringify(read.body));
    assert.equal(read.body.error.code, "not_found");
    assert.equal(JSON.stringify(read.body).includes("Other agent's skill"), false);
  }
  const write = await api("PUT", route, {});
  assert.equal(write.status, 405);
  assert.equal(write.headers.get("allow"), "GET");
});

test("native revision skills do not read the connected project's skill files", async (t) => {
  const f = await nativeFixture(t);
  await f.put(join(f.project, ".agents", "skills", "source-only", "SKILL.md"), "Source-owned instructions stay on the source machine.\n");
  withEnv(t, Object.fromEntries(["PATH", "HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "NATIVE_TEST_LOG"].map((key) => [key, f.env[key]])), ["NATIVE_TEST_AUTH", "NATIVE_TEST_EVENTS", "NATIVE_TEST_HOLD"]);
  const { api } = await serve(t, { runner: false });
  const connected = await api("POST", "/native/connect", { project: f.project, runtime: "codex", selector: { kind: "project" } });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  const current = connected.body.agent;
  assert.ok(current.definition.native.skills.includes("source-only"));
  const read = await api("GET", `/agents/${encodeURIComponent(current.agent_id)}/revisions/${current.revision}/skills`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body, { revision: current.revision, skills: {} });
});
