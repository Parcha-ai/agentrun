// A revision's skills laid in a run's folder through its Workspace (workspace/revision-skills.ts): every file under
// .agents/skills/ at its path, what was there before gone, a bad path refused before anything is written, and never
// through a link.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { layRevisionSkills, localWorkspace } from "../dist/workspace/index.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-revision-skills-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  mkdirSync(join(dir, "outside"));
  return { work: join(dir, "work"), outside: join(dir, "outside") };
}

test("a revision's skills are laid under .agents/skills/, each file at its path, and what was there before goes", async () => {
  const { work } = scratch();
  mkdirSync(join(work, ".agents", "skills", "old"), { recursive: true });
  writeFileSync(join(work, ".agents", "skills", "old", "SKILL.md"), "an earlier lay");
  writeFileSync(join(work, "report.md"), "the run's own");
  await layRevisionSkills(localWorkspace(work), { "cite/SKILL.md": "# Cite\n", "cite/reference/sources.md": "Primary first.\n", "team/review/SKILL.md": "# Review\n" });
  assert.deepEqual(readdirSync(join(work, ".agents", "skills")).sort(), ["cite", "team"]);
  assert.equal(readFileSync(join(work, ".agents", "skills", "cite", "reference", "sources.md"), "utf8"), "Primary first.\n");
  assert.equal(readFileSync(join(work, ".agents", "skills", "team", "review", "SKILL.md"), "utf8"), "# Review\n");
  assert.equal(readFileSync(join(work, "report.md"), "utf8"), "the run's own", "nothing outside .agents/skills/ is touched");
  await layRevisionSkills(localWorkspace(work), {});
  assert.deepEqual(readdirSync(join(work, ".agents", "skills")), [], "none: the folder is left empty");
});

test("a skill path that would leave .agents/skills/ is refused before anything is written", async () => {
  const { work } = scratch();
  for (const bad of ["../escape.md", "a/../../x", "/abs/SKILL.md", "a//b", "a\\b", ""]) {
    await assert.rejects(layRevisionSkills(localWorkspace(work), { "ok/SKILL.md": "fine", [bad]: "bad" }), (error) => error?.code === "ESCAPE", JSON.stringify(bad));
    assert.deepEqual(readdirSync(work), [], `${JSON.stringify(bad)}: nothing written`);
  }
});

test("a link at .agents/ or .agents/skills/ is never written through: ESCAPE, and nothing lands where it points", async () => {
  const { work, outside } = scratch();
  symlinkSync(outside, join(work, ".agents"));
  await assert.rejects(layRevisionSkills(localWorkspace(work), { "cite/SKILL.md": "# Cite\n" }), (error) => error?.code === "ESCAPE");
  assert.deepEqual(readdirSync(outside), []);
});
