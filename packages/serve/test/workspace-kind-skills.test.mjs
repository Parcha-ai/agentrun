// A run whose computer is a desktop or a phone gets that kind's skill (desktop-computer, phone-computer: how to look, act,
// check and recover on it) in its .agents/skills/, laid with the agent's own skills through the run's Workspace. An
// agent skill of the same name is the agent's and stays as it is; another kind, or none, gets no kind skill.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { KIND_SKILLS, layRevisionSkills, localWorkspace } from "../dist/workspace/index.js";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function scratch() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-kind-skills-"));
  dirs.push(dir);
  mkdirSync(join(dir, "work"));
  return join(dir, "work");
}
const source = (kind) => readFileSync(fileURLToPath(new URL(`../src/workspace/kind-skills/${kind}/SKILL.md`, import.meta.url)), "utf8");
const skillsIn = (work) => readdirSync(join(work, ".agents", "skills")).sort();

test("the kind skills are the repo's own SKILL.md files, by the names their front matter gives", () => {
  assert.deepEqual(Object.keys(KIND_SKILLS).sort(), ["desktop", "phone"]);
  assert.equal(KIND_SKILLS.desktop.name, "desktop-computer");
  assert.equal(KIND_SKILLS.phone.name, "phone-computer");
  assert.equal(KIND_SKILLS.desktop.text, source("desktop"));
  assert.equal(KIND_SKILLS.phone.text, source("phone"));
  for (const skill of Object.values(KIND_SKILLS)) assert.match(skill.text, new RegExp(`^---\\nname: ${skill.name}\\ndescription: `));
});

test("a desktop or phone run gets its kind's skill beside the agent's own", async () => {
  for (const kind of ["desktop", "phone"]) {
    const work = scratch();
    await layRevisionSkills(localWorkspace(work), { "cite/SKILL.md": "# Cite\n" }, { computer: kind });
    const name = `${kind}-computer`;
    assert.deepEqual(skillsIn(work), ["cite", name].sort(), kind);
    assert.equal(readFileSync(join(work, ".agents", "skills", name, "SKILL.md"), "utf8"), source(kind));
    assert.equal(readFileSync(join(work, ".agents", "skills", "cite", "SKILL.md"), "utf8"), "# Cite\n");
  }
});

test("an agent skill of the kind skill's name is the agent's: it stays, and the kind's is not laid", async () => {
  const work = scratch();
  await layRevisionSkills(localWorkspace(work), { "phone-computer/SKILL.md": "# Our own phone notes\n" }, { computer: "phone" });
  assert.deepEqual(skillsIn(work), ["phone-computer"]);
  assert.equal(readFileSync(join(work, ".agents", "skills", "phone-computer", "SKILL.md"), "utf8"), "# Our own phone notes\n");
});

test("any other computer, or none, gets no kind skill", async () => {
  for (const computer of [undefined, "none", "sandbox", "browser"]) {
    const work = scratch();
    await layRevisionSkills(localWorkspace(work), { "cite/SKILL.md": "# Cite\n" }, computer === undefined ? undefined : { computer });
    assert.deepEqual(skillsIn(work), ["cite"], String(computer));
  }
});
