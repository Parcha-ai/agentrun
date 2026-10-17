import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createAgentHome, readAgentHome, refreshAgentHome, startRun } from "@parcha/pi-durable-agent";
import { readSeed, seedLearning } from "../dist/index.js";
import { agentRepo, ask, commitMain, done, learning, learningFiles, openRun, scratch, sectionOf } from "./support.mjs";

const SKILL = "---\nname: cite\ndescription: Quote the page you read.\n---\n# Cite\n";
const L1 = learning("L-00000000001a", "Company registries match the legal name without Inc or LLC; search both forms.");
const L2 = learning("L-00000000001b", "The state registry rate-limits at 1 request a second.", { type: "fact" });

/** The definition and skills at `sha`, read from the agent repository as the agent home caches them. */
async function definitionAt(repo, sha) {
  const definition = JSON.parse(await repo.read("agent.json", sha));
  const skills = {};
  for (const entry of await repo.list(".agents/skills", sha)) if (entry.type === "blob") skills[entry.path.slice(".agents/skills/".length)] = await repo.read(entry.path, sha);
  return { definition, skills };
}

test("the host loop: the agent home follows the repo to a sha, the run starts at that sha, and seedLearning records the same one", async () => {
  const root = await scratch();
  const { repo, main: first } = await agentRepo(root, { ".agents/skills/cite/SKILL.md": SKILL, ...learningFiles([L1]) });
  const home = await createAgentHome(path.join(root, "home"), { ...(await definitionAt(repo, first)), sha: first });
  const second = await commitMain(repo, learningFiles([L2]));
  assert.deepEqual(await refreshAgentHome(home, { sha: second, from: first, ...(await definitionAt(repo, second)) }), { changed: true });

  const started = await startRun(home, { runId: "run-1", host: "test", sha: second });
  assert.equal(started.sha, second);
  assert.equal(await readFile(path.join(started.workspace, ".agents/skills/cite/SKILL.md"), "utf8"), SKILL, "the agent home seeded the skills at the sha");
  let section;
  const run = await openRun(started.storePath, { steps: [(c) => { section = sectionOf(c); return done(); }] });
  try {
    const seeded = await seedLearning({ repo, ref: started.sha, target: run.harness, into: started.workspace });
    assert.equal(seeded.sha, second);
    assert.equal((await readSeed(run.harness)).sha, second, "learn.seed holds the sha the run started at");
    assert.ok(existsSync(path.join(started.workspace, ".agent/learnings", `${L2.id}.md`)));
    assert.equal(existsSync(path.join(started.workspace, ".git")), false, "no git directory in the run's working directory");
    await ask(run.harness);
    assert.match(section, new RegExp(`your repo at ${second.slice(0, 12)}`));
    assert.match(section, /legal name/);
    assert.match(section, /rate-limits/);
  } finally {
    await run.close();
  }
  assert.equal((await readAgentHome(home)).runs["run-1"].sha, second, "the runs index records the same sha");
});
