// A Gemini CLI home is planned like the other sources': its session's project is the path the CLI recorded for it, so
// the session is imported under that folder and not left out as one with no project directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentIdOf, planImport, untiedFound } from "../dist/import.js";

/** A Gemini home with one project and one session in it, written an hour ago unless `fresh`. */
function home(t, { fresh = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "import-gemini-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(home, "code", "gemini-app");
  mkdirSync(project, { recursive: true });
  const chats = join(home, ".gemini", "tmp", "gemini-app", "chats");
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(home, ".gemini", "tmp", "gemini-app", ".project_root"), `${project}\n`);
  const file = join(chats, "session-2026-01-01T00-00-abcd1234.jsonl");
  const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  writeFileSync(
    file,
    [
      { sessionId: "abcd1234-0000-4000-8000-000000000000", projectHash: "0".repeat(64), startTime: at(0), lastUpdated: at(2) },
      { id: "u1", timestamp: at(1), type: "user", content: [{ text: "Fixture question." }] },
      { id: "a1", timestamp: at(2), type: "gemini", content: "Done.", model: "gemini-fixture-pro", tokens: { input: 10, output: 2, cached: 0, total: 12 } },
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  if (!fresh) {
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
  }
  return { home, project, temp: join(root, "tmp") };
}

test("a Gemini CLI session is planned under the project its .project_root names, not left out as one with no project", async (t) => {
  const h = home(t);
  const found = await planImport({ home: h.home, env: { PATH: "/usr/bin" }, temp: h.temp, sources: ["gemini"] });
  assert.deepEqual(found.skipped.map((s) => s.kind), []);
  assert.deepEqual(found.projects.map((p) => [p.name, p.sessions.length]), [["gemini-app", 1]]);
});

test("a Gemini CLI session still being written, in the project chosen, is reported as left out (live), not missing", async (t) => {
  const h = home(t, { fresh: true });
  const found = await planImport({ home: h.home, env: { PATH: "/usr/bin" }, temp: h.temp, sources: ["gemini"], only: [agentIdOf(h.project)] });
  assert.deepEqual(found.skipped.map((s) => s.kind), ["live"]);
  const other = await planImport({ home: h.home, env: { PATH: "/usr/bin" }, temp: h.temp, sources: ["gemini"], only: [agentIdOf(join(h.project, "elsewhere"))] });
  assert.deepEqual(other.skipped, [], "a project not chosen has none of it");
});

test("a Gemini subagent whose parent's file is gone is untied, not lost: its usage is in the summary's totals, and it is no session or run", async (t) => {
  const h = home(t);
  const folder = join(h.home, ".gemini", "tmp", "gemini-app", "chats", "ffffffff-0000-4000-8000-000000000000");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "orphan.jsonl");
  const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  writeFileSync(
    file,
    [
      { sessionId: "orphan", projectHash: "0".repeat(64), startTime: at(0), lastUpdated: at(3), kind: "subagent" },
      { id: "oa1", timestamp: at(3), type: "gemini", content: "Orphan.", model: "gemini-fixture-pro", tokens: { input: 500, output: 70, cached: 0, total: 570 } },
    ].map((record) => `${JSON.stringify(record)}\n`).join(""),
  );
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(file, old, old);
  const plan = await planImport({ home: h.home, env: { PATH: "/usr/bin" }, temp: h.temp, sources: ["gemini"] });
  assert.deepEqual(plan.projects.map((p) => [p.name, p.sessions.length]), [["gemini-app", 1]], "no session of its own");
  const found = await untiedFound(plan);
  assert.deepEqual(found.map((f) => [f.source, f.metrics.input, f.metrics.output]), [["gemini", 500, 70]]);
});

test("a legacy .json whose migrated .jsonl is beside it is left out as a copy, not as a session with no words", async (t) => {
  const h = home(t);
  const chats = join(h.home, ".gemini", "tmp", "gemini-app", "chats");
  const legacy = join(chats, "session-2026-01-01T00-00-abcd1234.json");
  const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  writeFileSync(legacy, JSON.stringify({ sessionId: "abcd1234-0000-4000-8000-000000000000", projectHash: "0".repeat(64), startTime: at(0), lastUpdated: at(2), messages: [
    { id: "u1", timestamp: at(1), type: "user", content: [{ text: "Fixture question." }] },
    { id: "a1", timestamp: at(2), type: "gemini", content: "Done.", model: "gemini-fixture-pro", tokens: { input: 10, output: 2, cached: 0, total: 12 } },
  ] }));
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(legacy, old, old);
  const found = await planImport({ home: h.home, env: { PATH: "/usr/bin" }, temp: h.temp, sources: ["gemini"] });
  assert.deepEqual(found.skipped.map((s) => s.kind), ["copies"]);
  assert.deepEqual(found.projects.map((p) => [p.name, p.sessions.length]), [["gemini-app", 1]]);
});
