// A pi run's claim (adapterRunSpecFromLaunch) lays the run's skills in its folder through layOwnSkills, the one writer:
// the revision's own skills, and a desktop's or a phone's kind skill beside them, before the system prompt reads them.
// The kind is the agent's computer setting, where the store keeps it (the revision's body.computer): a launch carries no
// computer. The system prompt names the kind skill as it names the revision's own. An agent skill of the kind skill's
// name is the agent's. Another computer kind, or none, gets no kind skill.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KIND_SKILLS } from "../dist/workspace/index.js";
import { specFor } from "./runner-spec-support.mjs";

const skillsIn = (folder) => readdirSync(join(folder, ".agents", "skills")).sort();
const CITE = { "cite/SKILL.md": "---\nname: cite\ndescription: Cite.\n---\nCite.\n" };
const DESKTOP = { kind: "desktop", provider: "e2b" };
const PHONE = { kind: "phone", provider: "phone-harness" };

for (const [kind, computer] of [["desktop", DESKTOP], ["phone", PHONE]]) {
  const name = `${kind}-computer`;
  test(`a ${kind} run's claim lays ${name}/SKILL.md beside the revision's own skill, and its system prompt names it as it names the revision's`, async (t) => {
    const { spec, workFolder } = await specFor(t, { skills: CITE, body: { computer } });
    assert.deepEqual(skillsIn(workFolder), ["cite", name]);
    assert.equal(readFileSync(join(workFolder, ".agents", "skills", name, "SKILL.md"), "utf8"), KIND_SKILLS[kind].text);
    const prompt = spec.session.system.join("\n");
    assert.match(prompt, /<skill name="cite">/, "the revision's own skill is in the prompt");
    assert.match(prompt, new RegExp(`<skill name="${name}">`), `the kind skill is in the prompt the same way: ${prompt.slice(0, 400)}`);
  });

  test(`a ${kind} run that reads its files is told the kind skill's path, as the revision's own skills are listed`, async (t) => {
    const { spec } = await specFor(t, { skills: CITE, body: { tools: ["read"], computer } });
    const prompt = spec.session.system.join("\n");
    assert.match(prompt, /^- cite: /m, "the revision's own skill is listed");
    assert.match(prompt, new RegExp(`^- ${name}: .*\\.agents/skills/${name}/SKILL\\.md`, "m"), `the kind skill is listed with its path: ${prompt.slice(0, 600)}`);
  });
}

test("an agent's own skill of the kind skill's name is kept at the claim, and the kind's is not laid", async (t) => {
  const own = "---\nname: phone-computer\ndescription: Our own phone notes.\n---\nOurs.\n";
  const { spec, workFolder } = await specFor(t, { skills: { "phone-computer/SKILL.md": own }, body: { computer: PHONE } });
  assert.deepEqual(skillsIn(workFolder), ["phone-computer"]);
  assert.equal(readFileSync(join(workFolder, ".agents", "skills", "phone-computer", "SKILL.md"), "utf8"), own);
  const prompt = spec.session.system.join("\n");
  assert.equal(prompt.match(/<skill name="phone-computer">/g)?.length, 1, "named once, the agent's");
  assert.match(prompt, /Ours\./);
});

test("a runner place with no computer setting gets no kind skill", async (t) => {
  const { spec, workFolder } = await specFor(t, { skills: CITE });
  assert.deepEqual(skillsIn(workFolder), ["cite"]);
  assert.doesNotMatch(spec.session.system.join("\n"), /-computer/);
});

test("a sandbox computer gets no kind skill", async (t) => {
  const { workFolder } = await specFor(t, { skills: CITE, body: { computer: { kind: "sandbox", provider: "docker" } } });
  assert.deepEqual(skillsIn(workFolder), ["cite"]);
});
