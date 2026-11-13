// A later round's proposal keeps the seed the run was laid from as the conflict base of its skills and workflows, and
// checks only its notes against the main the earlier rounds merged into (propose.ts notesSeed): a skill another run
// changed after this one started is still a conflict at the merge, while a note an earlier round added stays a supersedes
// target.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { learningCommit } from "../dist/learn/commit.js";
import { seedOf } from "../dist/learning.js";
import { proposeRun } from "../dist/propose.js";
import { learningWorkspace } from "../dist/workspace/index.js";
import { note } from "./learn-format-support.mjs";

const AGENT = "agent-1";
const SKILL = (step) => `---\nname: check-refunds\ndescription: Check refunds\n---\n${step}\n`;
const skillBlock = (step) => `\`\`\`\`skill check-refunds\n${SKILL(step)}\`\`\`\``;
const NOTE = note({ name: "Units", description: "Units", body: "Convert every amount to one unit first.\n" });

async function commit(data, file, text) {
  const landing = learningWorkspace({ mode: "local", data, agentId: AGENT });
  try {
    const made = await learningCommit(landing.workspace, { kind: "person", action: "created", file, text, ifMatch: null });
    assert.equal(made.ok, true, JSON.stringify(made));
  } finally {
    await landing.end();
  }
}

test("a follow-up round proposes against the run's seed for skills and main's notes for notes", async (t) => {
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "learn-notes-seed-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  await commit(data, "skills/check-refunds/SKILL.md", SKILL("Step one."));
  const { sha: seed } = await seedOf(data, AGENT);
  // Main moves on after the run started: a note an earlier round added.
  await commit(data, "units.md", NOTE);
  const { sha: main } = await seedOf(data, AGENT);
  assert.notEqual(main, seed);

  const runDir = mkdtempSync(join(data, "run-"));
  const folder = learningWorkspace({ mode: "local", data, agentId: AGENT });
  let result;
  try {
    const answer = [skillBlock("Step one, then two."), `\`\`\`note units-2.md\n${note({ name: "Units two", description: "Units two", body: "Compare amounts only after converting them to one unit.\n", extra: "supersedes: [units.md]\n" })}\`\`\``].join("\n\n");
    result = await proposeRun({ folder: folder.workspace, runDir, seed, notesSeed: main, turn: { answer, asked: [] }, refuse: [], outcome: "completed" });
  } finally {
    await folder.end();
  }
  assert.equal(result.state, "proposed", JSON.stringify(result));
  assert.equal(JSON.parse(readFileSync(join(runDir, "learning-proposal.json"), "utf8")).seed, seed, "the skill's conflict base is the seed the run started from");
  assert.deepEqual([result.notes, result.skills], [1, 1], "the note is checked as the main's it changes");
});
