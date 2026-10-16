import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { AgentHomeError, carryBack, createAgentHome, projectForExport, readAgentHome, refreshAgentHome, startRun } from "../dist/index.js";
import { DEFINITION, scratch } from "./support.mjs";

const SHA_1 = "1f0c9e2b7d4a8e3c5b6a7f8d9e0c1b2a3d4e5f60";
const SHA_2 = "9a8b7c6d5e4f30211203f4e5d6c7b8a990a1b2c3";
const SHA_256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const T0 = Date.parse("2026-10-16T04:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

const refused = (code, pattern) => (error) => error instanceof AgentHomeError && error.code === code && (!pattern || pattern.test(error.message));

/** pi-durable's last commit sequence in an agent store, and each document: its kind, key, the seq of its latest kept
 *  revision, and the seq that retired it (pi drops a retired document's revisions). */
function revisions(home) {
  const db = new DatabaseSync(path.join(home.dir, "agent.sqlite"), { readOnly: true });
  try {
    const head = Number(db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get().next_seq) - 1;
    const docs = db.prepare(`SELECT d.kind AS kind, d.key_value AS key, d.retired_at AS retired, MAX(r.seq) AS seq
      FROM documents d LEFT JOIN document_revisions r ON r.document_id = d.id GROUP BY d.id`).all()
      .map((row) => ({ kind: JSON.parse(row.kind), key: JSON.parse(row.key), seq: row.seq === null ? null : Number(row.seq), retired: row.retired === null ? null : Number(row.retired) }));
    return { head, docs, of: (kind, key = "") => docs.filter((doc) => doc.kind === kind && doc.key === key).at(-1) };
  } finally {
    db.close();
  }
}

test("a home created with a sha keeps it as agent.source, written in the creation commit; a home without one has none", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n" }, sha: SHA_1, now: T0 });
  assert.deepEqual((await readAgentHome(home)).source, { sha: SHA_1, refreshedAt: iso(T0) });
  const { head, of } = revisions(home);
  assert.equal(head, 1, "one commit");
  for (const [kind, key] of [["agent.identity"], ["agent.definition"], ["agent.source"], ["agent.skills", "cite/SKILL.md"]]) assert.equal(of(kind, key)?.seq, 1, kind);
  const plain = await readAgentHome(await createAgentHome(await scratch(), { definition: DEFINITION }));
  assert.equal("source" in plain, false);
  const wide = await createAgentHome(await scratch(), { definition: DEFINITION, sha: SHA_256 });
  assert.equal((await readAgentHome(wide)).source.sha, SHA_256, "a SHA-256 commit is a sha too");
});

test("startRun records the home's sha and returns it, with or without asking for it, and carryBack keeps it", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, sha: SHA_1 });
  const asked = await startRun(home, { runId: "asked", host: "test", sha: SHA_1 });
  const unasked = await startRun(home, { runId: "unasked", host: "test" });
  assert.deepEqual([asked.sha, unasked.sha], [SHA_1, SHA_1]);
  assert.deepEqual([(await readAgentHome(home)).runs.asked.sha, (await readAgentHome(home)).runs.unasked.sha], [SHA_1, SHA_1]);
  await carryBack(home, asked, { outcome: "completed" });
  const record = (await readAgentHome(home)).runs.asked;
  assert.deepEqual([record.sha, record.outcome], [SHA_1, "completed"]);
  const plain = await createAgentHome(await scratch(), { definition: DEFINITION });
  const run = await startRun(plain, { runId: "plain", host: "test" });
  assert.equal("sha" in run, false);
  assert.equal("sha" in (await readAgentHome(plain)).runs.plain, false);
});

test("a run asked at another sha, or at a sha the home has none of, is refused as stale and starts nothing", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, sha: SHA_1 });
  await assert.rejects(startRun(home, { runId: "behind", host: "test", sha: SHA_2 }), refused("stale", new RegExp(`at ${SHA_1} and must be refreshed to ${SHA_2}`)));
  assert.deepEqual((await readAgentHome(home)).runs, {});
  assert.equal(existsSync(path.join(home.dir, "runs", "behind")), false);
  const plain = await createAgentHome(await scratch(), { definition: DEFINITION });
  await assert.rejects(startRun(plain, { runId: "untied", host: "test", sha: SHA_1 }), refused("stale", new RegExp(`at no commit and must be refreshed to ${SHA_1}`)));
  assert.deepEqual(readdirSync(path.join(plain.dir, "runs")), []);
});

test("refresh replaces the definition and the skill set, renames the identity and moves agent.source, all in one commit", async () => {
  const home = await createAgentHome(await scratch(), {
    definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n", "old/SKILL.md": "# Old\n" }, sha: SHA_1, now: T0,
  });
  const before = revisions(home).head;
  const definition = { ...DEFINITION, id: home.identity.id, name: "Researcher v2", instructions: "Cite twice.", skills: ["cite", "new"] };
  const result = await refreshAgentHome(home, { sha: SHA_2, definition, skills: { "cite/SKILL.md": "# Cite v2\n", "new/SKILL.md": "# New\n" }, now: T0 + 1000 });
  assert.deepEqual(result, { changed: true });
  const state = await readAgentHome(home);
  assert.deepEqual(state.definition, definition);
  assert.deepEqual(state.identity, { ...home.identity, name: "Researcher v2" });
  assert.deepEqual(Object.keys(state.skills).sort(), ["cite/SKILL.md", "new/SKILL.md"], "the skill absent from the new set is gone");
  assert.deepEqual([state.skills["cite/SKILL.md"].content, state.skills["new/SKILL.md"].content], ["# Cite v2\n", "# New\n"]);
  assert.deepEqual(state.source, { sha: SHA_2, refreshedAt: iso(T0 + 1000) });
  const { head, of } = revisions(home);
  assert.equal(head, before + 1, "one commit");
  for (const [kind, key] of [["agent.identity"], ["agent.definition"], ["agent.source"], ["agent.skills", "cite/SKILL.md"], ["agent.skills", "new/SKILL.md"]]) {
    assert.equal(of(kind, key)?.seq, head, `${kind} ${key ?? ""} changed in the refresh's commit`);
  }
  assert.equal(of("agent.skills", "old/SKILL.md")?.retired, head, "the removed skill is retired in that same commit");
});

test("refresh at the sha the home is already at changes nothing and commits nothing", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n" }, sha: SHA_1 });
  const before = { state: await readAgentHome(home), head: revisions(home).head };
  const result = await refreshAgentHome(home, { sha: SHA_1, definition: { ...DEFINITION, name: "Ignored" }, skills: {} });
  assert.deepEqual(result, { changed: false });
  assert.deepEqual(await readAgentHome(home), before.state);
  assert.equal(revisions(home).head, before.head);
});

test("refresh refuses another agent's id, a missing skill set, and a definition it would refuse at creation", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n" }, sha: SHA_1 });
  const before = await readAgentHome(home);
  await assert.rejects(refreshAgentHome(home, { sha: SHA_2, definition: { ...DEFINITION, id: "another-agent" }, skills: {} }), refused("invalid", /not this agent's id/));
  await assert.rejects(refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION }), refused("invalid", /names its skills/));
  await assert.rejects(refreshAgentHome(home, { sha: SHA_2, definition: { ...DEFINITION, model: "some-model" }, skills: {} }), refused("invalid", /model/));
  await assert.rejects(refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION, skills: { "../escape.md": "x" } }), refused("invalid", /skill path/));
  assert.deepEqual(await readAgentHome(home), before);
});

test("a run started before a refresh keeps its sha and its skills; the next run gets the new ones", async () => {
  const home = await createAgentHome(await scratch(), { definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite\n", "old/SKILL.md": "# Old\n" }, sha: SHA_1 });
  const first = await startRun(home, { runId: "first", host: "test" });
  await refreshAgentHome(home, { sha: SHA_2, definition: DEFINITION, skills: { "cite/SKILL.md": "# Cite v2\n", "new/SKILL.md": "# New\n" } });
  await assert.rejects(startRun(home, { runId: "behind", host: "test", sha: SHA_1 }), refused("stale"));
  const second = await startRun(home, { runId: "second", host: "test", sha: SHA_2 });
  const skill = (run, file) => path.join(run.workspace, ".agents", "skills", file);
  assert.deepEqual([first.sha, second.sha], [SHA_1, SHA_2]);
  assert.equal(readFileSync(skill(first, "old/SKILL.md"), "utf8"), "# Old\n");
  assert.equal(readFileSync(skill(first, "cite/SKILL.md"), "utf8"), "# Cite\n");
  assert.equal(existsSync(skill(first, "new/SKILL.md")), false);
  assert.equal(readFileSync(skill(second, "new/SKILL.md"), "utf8"), "# New\n");
  assert.equal(readFileSync(skill(second, "cite/SKILL.md"), "utf8"), "# Cite v2\n");
  assert.equal(existsSync(skill(second, "old/SKILL.md")), false);
  await carryBack(home, first, { outcome: "completed" });
  const runs = (await readAgentHome(home)).runs;
  assert.deepEqual([runs.first.sha, runs.second.sha], [SHA_1, SHA_2]);
});

test("projectForExport keeps agent.source and a run's sha, and still strips the run's host", () => {
  const source = { sha: SHA_1, refreshedAt: iso(T0) };
  assert.deepEqual(projectForExport("agent.source", source), source);
  const run = { path: "runs/r1", host: "laptop", startedAt: iso(T0), sha: SHA_1, outcome: "completed" };
  assert.deepEqual(projectForExport("agent.runs", run), { path: "runs/r1", startedAt: iso(T0), sha: SHA_1, outcome: "completed" });
});

test("a sha that is not 40 or 64 lowercase hex digits is refused by create, refresh and startRun", async () => {
  const root = await scratch();
  const home = await createAgentHome(path.join(root, "home"), { definition: DEFINITION, sha: SHA_1 });
  const bad = ["", "abc", SHA_1.toUpperCase(), SHA_1.slice(1), `${SHA_1}0`, SHA_256.slice(1), `${SHA_256}0`, `${SHA_1.slice(1)}g`, ` ${SHA_1.slice(1)}`, 123, null];
  for (const [index, sha] of bad.entries()) {
    const dir = path.join(root, `bad-${index}`);
    await assert.rejects(createAgentHome(dir, { definition: DEFINITION, sha }), refused("invalid", /not a commit sha/), String(sha));
    assert.equal(existsSync(dir), false);
    await assert.rejects(refreshAgentHome(home, { sha, definition: DEFINITION, skills: {} }), refused("invalid", /not a commit sha/), String(sha));
    await assert.rejects(startRun(home, { runId: `bad-${index}`, host: "test", sha }), refused("invalid", /not a commit sha/), String(sha));
  }
  assert.equal((await readAgentHome(home)).source.sha, SHA_1);
  assert.deepEqual((await readAgentHome(home)).runs, {});
});
