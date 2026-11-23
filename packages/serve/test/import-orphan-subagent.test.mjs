// A subagent whose session's file is gone is untied: it counts on its own line in serve's import (its usage is in the
// summary's totals), as a Codex subagent naming no parent does, and is no session or run. Claude Code's lives in
// <session id>/subagents/ beside its session's .jsonl.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planImport, untiedFound } from "../dist/import.js";
import { claudeSession, claudeSubagent } from "./fixtures/import-sessions.mjs";
import { scratch } from "./support.mjs";

test("a Claude Code subagent whose session's .jsonl is gone has its usage in untiedFound, and one with its parent does not count twice", async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const project = join(home, "code", "orphans");
  mkdirSync(project, { recursive: true });
  claudeSession(home, project, 1);
  claudeSubagent(home, project, 1, 1);
  // Session 2's file was deleted; its subagent stays in the folder.
  claudeSubagent(home, project, 2, 1);
  const plan = await planImport({ home, env: { PATH: "/usr/bin" }, temp: join(root, "tmp"), sources: ["claude-code"] });
  assert.deepEqual(plan.projects.map((p) => p.sessions.length), [1], "no session of its own");
  const found = await untiedFound(plan);
  // The subagent's two requests: 11 in and 13 out, then 17 in and 19 out.
  assert.equal(found.length, 1, "only the orphan: the other subagent is its session's");
  assert.equal(found[0].source, "claude-code");
  assert.deepEqual([found[0].metrics.input, found[0].metrics.output], [11 + 17, 13 + 19], "its usage");
});
