// Review on #2337: claude-agent loads a skill with its own Skill tool, a native call that never reaches the adapter loop's
// call records (it is no host tool). A run's `used.skills` still says the learned skill was read when the model loaded
// it, by the plugin-qualified name the harness gives it (`agentrun:<name>`), and not when it loaded another.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { agentFolderOf } from "../dist/files.js";
import * as learning from "../dist/learning.js";
import { git, resnap } from "./learn-support.mjs";
import { agent, follow, serve, withEnv } from "./support.mjs";

const skillMd = (name, body) => `---\nname: ${name}\ndescription: What ${name} is for.\n---\n${body}\n`;

/** Agent `id`'s learning folder, as a first run makes it, with learned skills `names` committed on main. */
async function learnedSkills(data, id, names) {
  mkdirSync(data, { recursive: true });
  await learning.seedOf(data, id);
  const repo = join(agentFolderOf(data, id), "learning");
  const files = names.map((name) => `skills/${name}/SKILL.md`);
  for (const [i, path] of files.entries()) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), skillMd(names[i], `Follow ${names[i]}.`));
  }
  git(repo, ["add", "--", ...files]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, id);
}

test("a claude-agent run that loads a learned skill with its own Skill tool reads it in its learning's used.skills; one it did not load reads unread", { timeout: 180_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  let loaded = false;
  const fake = await fakeAnthropic({
    reply: (request) => {
      // The first request offered the Skill tool loads check-units, by its plugin-qualified name; every other is answered.
      if (!loaded && request.tools.includes("Skill")) {
        loaded = true;
        return { tool: { name: "Skill", input: { skill: "agentrun:check-units" } } };
      }
      return { text: "Claude answered." };
    },
  });
  t.after(() => fake.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: fake.url, AGENT_MODEL: "anthropic/claude-haiku-5-5" }, ["AGENT_MODEL_BASE_URL"]);
  const { api, data } = await serve(t, { faux: undefined });
  await learnedSkills(data, "native", ["check-units", "find-policies"]);
  const created = await api("POST", "/agents", agent("native", { learning: true, harness: "claude-agent", model: "anthropic/claude-haiku-5-5", instructions: "Answer the question.", skills: [] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const run = await api("POST", "/agents/native/runs", { input: { content: "Use the check-units skill, then answer." } });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(api, run.body.run_id, ["completed"], { deadlineMs: 120_000 });
  assert.ok(loaded, "the model loaded the skill");
  const read = await api("GET", `/runs/${run.body.run_id}/learning`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const used = Object.fromEntries((read.body?.used?.skills ?? []).map(({ name, read: was }) => [name, was]));
  assert.deepEqual(used, { "check-units": true, "find-policies": false }, JSON.stringify(read.body?.used));
});
