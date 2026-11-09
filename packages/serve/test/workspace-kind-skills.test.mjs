// A run whose computer is a desktop or a phone gets that kind's skill (desktop-computer, phone-computer: how to look, act,
// check and recover on it) in its .agents/skills/, laid at the claim with the agent's own skills through the run's
// Workspace (layOwnSkills, the one writer). An agent skill of the same name is the agent's and stays as it is; a skill
// already there (a learned one, an earlier claim's kind skill) is never removed or written over; another kind, or none,
// gets no kind skill.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { KIND_SKILLS, layOwnSkills, localWorkspace } from "../dist/workspace/index.js";

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

test("a desktop or phone run's claim lays its kind's skill beside the agent's own", async () => {
  for (const kind of ["desktop", "phone"]) {
    const work = scratch();
    await layOwnSkills(localWorkspace(work), { "cite/SKILL.md": "# Cite\n" }, { computer: kind });
    const name = `${kind}-computer`;
    assert.deepEqual(skillsIn(work), ["cite", name].sort(), kind);
    assert.equal(readFileSync(join(work, ".agents", "skills", name, "SKILL.md"), "utf8"), source(kind));
    assert.equal(readFileSync(join(work, ".agents", "skills", "cite", "SKILL.md"), "utf8"), "# Cite\n");
  }
});

test("a desktop run with no skills of its own still gets its kind's skill", async () => {
  const work = scratch();
  await layOwnSkills(localWorkspace(work), {}, { computer: "desktop" });
  assert.deepEqual(skillsIn(work), ["desktop-computer"]);
});

test("an agent skill of the kind skill's name is the agent's: it stays, and the kind's is not laid", async () => {
  const work = scratch();
  await layOwnSkills(localWorkspace(work), { "phone-computer/SKILL.md": "# Our own phone notes\n" }, { computer: "phone" });
  assert.deepEqual(skillsIn(work), ["phone-computer"]);
  assert.equal(readFileSync(join(work, ".agents", "skills", "phone-computer", "SKILL.md"), "utf8"), "# Our own phone notes\n");
});

test("at a later claim, a learned skill survives and the kind's folder already there is left as it is", async () => {
  const work = scratch();
  const ws = localWorkspace(work);
  await layOwnSkills(ws, { "cite/SKILL.md": "# Cite\n" }, { computer: "desktop" });
  mkdirSync(join(work, ".agents", "skills", "learned-one"), { recursive: true });
  writeFileSync(join(work, ".agents", "skills", "learned-one", "SKILL.md"), "# Learned\n");
  writeFileSync(join(work, ".agents", "skills", "desktop-computer", "SKILL.md"), "# Desktop, as the run left it\n");
  await layOwnSkills(ws, { "cite/SKILL.md": "# Cite\n" }, { computer: "desktop" });
  assert.deepEqual(skillsIn(work), ["cite", "desktop-computer", "learned-one"]);
  assert.equal(readFileSync(join(work, ".agents", "skills", "learned-one", "SKILL.md"), "utf8"), "# Learned\n", "the learned skill survives the claim");
  assert.equal(readFileSync(join(work, ".agents", "skills", "desktop-computer", "SKILL.md"), "utf8"), "# Desktop, as the run left it\n", "not written over");
});

test("any other computer, or none, gets no kind skill", async () => {
  for (const computer of [undefined, "none", "sandbox", "browser"]) {
    const work = scratch();
    await layOwnSkills(localWorkspace(work), { "cite/SKILL.md": "# Cite\n" }, computer === undefined ? undefined : { computer });
    assert.deepEqual(skillsIn(work), ["cite"], String(computer));
  }
});
