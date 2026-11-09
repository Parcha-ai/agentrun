// A pi run's claim (adapterRunSpecFromLaunch) lays the run's skills in its folder through layOwnSkills, the one writer:
// the revision's own skills, and a desktop's or a phone's kind skill beside them, before the system prompt reads them.
// An agent skill of the kind skill's name is the agent's. Another computer kind, or none, gets no kind skill.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIND_SKILLS } from "../dist/workspace/index.js";
import { specFor } from "./runner-spec-support.mjs";

const skillsIn = (folder) => readdirSync(join(folder, ".agents", "skills")).sort();

test("a desktop run's claim lays desktop-computer/SKILL.md beside the revision's own skill", async (t) => {
  const { workFolder } = await specFor(t, { skills: { "cite/SKILL.md": "---\nname: cite\ndescription: Cite.\n---\nCite.\n" }, launch: { computer: { kind: "desktop", provider: "e2b" } } });
  assert.deepEqual(skillsIn(workFolder), ["cite", "desktop-computer"]);
  assert.equal(readFileSync(join(workFolder, ".agents", "skills", "desktop-computer", "SKILL.md"), "utf8"), KIND_SKILLS.desktop.text);
});

test("an agent's own skill of the kind skill's name is kept at the claim, and the kind's is not laid", async (t) => {
  const own = "---\nname: phone-computer\ndescription: Our own phone notes.\n---\nOurs.\n";
  const { workFolder } = await specFor(t, { skills: { "phone-computer/SKILL.md": own }, launch: { computer: { kind: "phone", provider: "phone-harness" } } });
  assert.deepEqual(skillsIn(workFolder), ["phone-computer"]);
  assert.equal(readFileSync(join(workFolder, ".agents", "skills", "phone-computer", "SKILL.md"), "utf8"), own);
});

test("a runner place with no computer setting gets no kind skill", async (t) => {
  const { workFolder } = await specFor(t, { skills: { "cite/SKILL.md": "---\nname: cite\ndescription: Cite.\n---\nCite.\n" } });
  assert.deepEqual(skillsIn(workFolder), ["cite"]);
});
