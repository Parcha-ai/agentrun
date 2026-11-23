// A Gemini CLI home is planned like the other sources': its session's project is the path the CLI recorded for it, so
// the session is imported under that folder and not left out as one with no project directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { planImport } from "../dist/import.js";

test("a Gemini CLI session is planned under the project its .project_root names, not left out as one with no project", (t) => {
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
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(file, old, old);
  const plan = planImport({ home, env: { PATH: "/usr/bin" }, temp: join(root, "tmp"), sources: ["gemini"] });
  return plan.then((found) => {
    assert.deepEqual(found.skipped.map((s) => s.kind), []);
    assert.deepEqual(found.projects.map((p) => [p.name, p.sessions.length]), [["gemini-app", 1]]);
  });
});
