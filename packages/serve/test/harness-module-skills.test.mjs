// A harness module's adapter harness that loads skills itself (kit.adapterEntry with a skillCheck) is handed the skills
// its check accepts (ModuleLaunch.skills), and the run's prompt no longer holds them; one with no skillCheck is handed
// none, and the prompt keeps them, as pi's does.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const ACP_INDEX = pathToFileURL(fileURLToPath(new URL("../../run-adapters-acp/dist/index.js", import.meta.url))).href;
const ACP_TESTING = pathToFileURL(fileURLToPath(new URL("../../run-adapters-acp/dist/testing.js", import.meta.url))).href;
const MODEL = "anthropic/claude-haiku-4-5";
const SKILL_TEXT = "SKILL-BODY-cite-7f3a";

/** A module with two adapter harnesses on the fake ACP agent: `skill-taker` (a skillCheck that refuses nothing) and
 *  `skill-leaver` (none). Each builder notes what its launch holds of skills, and each session what its prompt holds. */
function skillModule(dir) {
  const path = join(dir, "skill-module.mjs");
  writeFileSync(path, `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acpAdapter, gooseFacts } from ${JSON.stringify(ACP_INDEX)};
import { fakeAgentRecipe } from ${JSON.stringify(ACP_TESTING)};
const dir = ${JSON.stringify(dir)};
const harness = (id, kit, extra) => kit.adapterEntry(Object.freeze({ ...gooseFacts, id, label: id }), (launch) => {
  writeFileSync(join(dir, id + "-launch.json"), JSON.stringify({ skills: launch.skills ?? null }));
  const adapter = acpAdapter({ recipe: fakeAgentRecipe(id, dir, [{ say: "SKILLS_RAN" }], { load: true, http: true, style: "goose" }), log: launch.log });
  return { ...adapter, check: adapter.check.bind(adapter), open: async (spec, io) => {
    writeFileSync(join(dir, id + "-system.txt"), spec.system.join("\\n\\n"));
    return adapter.open(spec, io);
  } };
}, extra);
export const entries = (_builtins, kit) => ({
  "skill-taker": harness("skill-taker", kit, { skillCheck: async () => () => [] }),
  "skill-leaver": harness("skill-leaver", kit),
});\n`);
  return path;
}

/** A run of `harness` on an agent with the skill `cite`: what its builder's launch held, and what its prompt held. */
async function runWithSkill(api, dir, harness) {
  const id = `${harness}-agent`;
  const created = await api("POST", "/agents", { ...agent(id, { harness, model: MODEL, skills: ["cite"] }), skills: { "cite/SKILL.md": `---\nname: cite\ndescription: Cite sources.\n---\n${SKILL_TEXT}\n` } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", `/agents/${id}/runs`, { input: { content: "Follow the script." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  const { last } = await follow(api, run.body.run_id, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", JSON.stringify(last));
  const launch = join(dir, `${harness}-launch.json`);
  assert.ok(existsSync(launch), `${harness}'s builder ran`);
  return { launch: JSON.parse(readFileSync(launch, "utf8")), system: readFileSync(join(dir, `${harness}-system.txt`), "utf8") };
}

test("a module's adapter harness with a skillCheck is handed the skills it accepts, and the prompt drops them; one without is handed none, and the prompt keeps them", { skip: process.platform !== "linux" ? "the run's confinement is Linux's" : !existsSync("/usr/bin/setpriv") && "no setpriv here", timeout: 180_000 }, async (t) => {
  const dir = await scratch(t);
  withEnv(t, { ANTHROPIC_API_KEY: "fake-test-key", AGENT_MODEL: MODEL });
  const { api } = await serve(t, { faux: undefined, harnessModules: [skillModule(dir)] });
  const taker = await runWithSkill(api, dir, "skill-taker");
  assert.deepEqual(taker.launch.skills?.map((skill) => skill.name), ["cite"], `the accepted skill reaches the builder: ${JSON.stringify(taker.launch)}`);
  assert.ok(Object.values(taker.launch.skills[0].files).some((text) => text.includes(SKILL_TEXT)), "with its files");
  assert.ok(!taker.system.includes(SKILL_TEXT), "and the prompt no longer holds it");
  const leaver = await runWithSkill(api, dir, "skill-leaver");
  assert.equal(leaver.launch.skills, null, "no skillCheck: no skills handed over");
  assert.ok(leaver.system.includes(SKILL_TEXT), "and the prompt keeps the skill");
});
