// A revision's skills laid in a run's folder through its Workspace at a claim (workspace/revision-skills.ts
// layOwnSkills): every file under .agents/skills/ at its path, never over what is there (a learned skill, an earlier
// claim's folder, the run's own edit), nothing removed, a bad path refused before anything is written, and never through
// a link.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { layOwnSkills, localWorkspace } from "../dist/workspace/index.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-revision-skills-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  mkdirSync(join(dir, "outside"));
  return { work: join(dir, "work"), outside: join(dir, "outside") };
}

test("a revision's skills are laid under .agents/skills/, each file at its path, and nothing that was there goes", async () => {
  const { work } = scratch();
  mkdirSync(join(work, ".agents", "skills", "old"), { recursive: true });
  writeFileSync(join(work, ".agents", "skills", "old", "SKILL.md"), "an earlier lay");
  writeFileSync(join(work, "report.md"), "the run's own");
  await layOwnSkills(localWorkspace(work), { "cite/SKILL.md": "# Cite\n", "cite/reference/sources.md": "Primary first.\n", "team/review/SKILL.md": "# Review\n" });
  assert.deepEqual(readdirSync(join(work, ".agents", "skills")).sort(), ["cite", "old", "team"]);
  assert.equal(readFileSync(join(work, ".agents", "skills", "cite", "reference", "sources.md"), "utf8"), "Primary first.\n");
  assert.equal(readFileSync(join(work, ".agents", "skills", "team", "review", "SKILL.md"), "utf8"), "# Review\n");
  assert.equal(readFileSync(join(work, ".agents", "skills", "old", "SKILL.md"), "utf8"), "an earlier lay", "a folder no revision skill names stays");
  assert.equal(readFileSync(join(work, "report.md"), "utf8"), "the run's own", "nothing outside .agents/skills/ is touched");
  await layOwnSkills(localWorkspace(work), {});
  assert.deepEqual(readdirSync(join(work, ".agents", "skills")).sort(), ["cite", "old", "team"], "none given: nothing is removed");
});

test("a skill path that would leave .agents/skills/ is refused before anything is written", async () => {
  const { work } = scratch();
  for (const bad of ["../escape.md", "a/../../x", "/abs/SKILL.md", "a//b", "a\\b", ""]) {
    await assert.rejects(layOwnSkills(localWorkspace(work), { "ok/SKILL.md": "fine", [bad]: "bad" }), (error) => error?.code === "ESCAPE", JSON.stringify(bad));
    assert.deepEqual(readdirSync(work), [], `${JSON.stringify(bad)}: nothing written`);
  }
});

test("a link at .agents/ or .agents/skills/ is never written through: ESCAPE, and nothing lands where it points", async () => {
  const { work, outside } = scratch();
  symlinkSync(outside, join(work, ".agents"));
  await assert.rejects(layOwnSkills(localWorkspace(work), { "cite/SKILL.md": "# Cite\n" }), (error) => error?.code === "ESCAPE");
  assert.deepEqual(readdirSync(outside), []);
});

test("at a claim, a revision's own skills are laid where they are missing, never over what is there: a learned skill and an earlier claim's folder stay", async () => {
  const { work } = scratch();
  const ws = localWorkspace(work);
  // Nothing there yet (a fresh run): every file is written.
  await layOwnSkills(ws, { "review/SKILL.md": "# Review\n", "review/REVIEW.md": "Rules.\n" });
  assert.equal(readFileSync(join(work, ".agents/skills/review/SKILL.md"), "utf8"), "# Review\n");
  assert.equal(readFileSync(join(work, ".agents/skills/review/REVIEW.md"), "utf8"), "Rules.\n");
  // A learned skill laid at the run's start, and the run's own edit of its skill since: both stay at the next claim.
  mkdirSync(join(work, ".agents/skills/learned-one"), { recursive: true });
  writeFileSync(join(work, ".agents/skills/learned-one/SKILL.md"), "# Learned\n");
  writeFileSync(join(work, ".agents/skills/review/SKILL.md"), "# Review, as the run left it\n");
  await layOwnSkills(ws, { "review/SKILL.md": "# Review\n", "review/REVIEW.md": "Rules.\n", "cite/SKILL.md": "# Cite\n" });
  assert.deepEqual(readdirSync(join(work, ".agents/skills")).sort(), ["cite", "learned-one", "review"]);
  assert.equal(readFileSync(join(work, ".agents/skills/review/SKILL.md"), "utf8"), "# Review, as the run left it\n", "a folder already there is left as it is");
  assert.equal(readFileSync(join(work, ".agents/skills/learned-one/SKILL.md"), "utf8"), "# Learned\n");
  assert.equal(readFileSync(join(work, ".agents/skills/cite/SKILL.md"), "utf8"), "# Cite\n", "a missing one is laid");
  // A path leaving .agents/skills/ writes nothing.
  await assert.rejects(layOwnSkills(ws, { "../escape/SKILL.md": "x" }), (error) => error.code === "ESCAPE");
});
