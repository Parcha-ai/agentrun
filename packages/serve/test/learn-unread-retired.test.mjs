// A learned skill or workflow draft whose front matter can't be read reads retired (learnedStatus: never given to a run),
// but no one retired it: the agent's learning view says the host could not read it (`retired: {by: "host", why:
// "unreadable"}`), never that a run or a person retired it (#2444). One retired the usual way keeps who did it.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { learningRepo, seedOf } from "../dist/learning.js";
import { git, resnap } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

/** Agent `id`'s learning folder made as a first run makes it, then `files` committed on main by hand. */
async function commit(data, id, files) {
  await seedOf(data, id);
  const repo = learningRepo(data, id);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "by hand"]);
  await resnap(data, id);
}

test("a skill whose front matter can't be read reads retired by the host, unreadable, never by a run; one retired in its front matter keeps by run", async (t) => {
  const { api, data, baseUrl } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("fronts", { learning: true }))).status, 201);
  await commit(data, "fronts", {
    "skills/unclosed/SKILL.md": "---\nname: unclosed\ndescription: A skill whose front matter never closes\n\nUse it for everything.\n",
    "skills/frozen/SKILL.md": "---\nname: frozen\ndescription: A skill whose status is none the host writes\nstatus: frozen\n---\nUse it.\n",
    "skills/shelved/SKILL.md": "---\nname: shelved\ndescription: A skill retired in its own front matter\nstatus: retired\n---\nUse it.\n",
  });
  const view = (await api("GET", "/agents/fronts/learning")).body;
  const by = Object.fromEntries(view.skills.map((skill) => [skill.name, [skill.status, skill.retired && { by: skill.retired.by, why: skill.retired.why }]]));
  assert.deepEqual(by.unclosed, ["retired", { by: "host", why: "unreadable" }], JSON.stringify(view.skills));
  assert.deepEqual(by.frozen, ["retired", { by: "host", why: "unreadable" }]);
  assert.deepEqual(by.shelved, ["retired", { by: "run", why: undefined }], "retired in so many words: who set it, as before");
  for (const skill of view.skills) assert.equal(typeof skill.retired.at, "string");
  // A later write that leaves the unreadable skill as it is: the view still says the host could not read it.
  await commit(data, "fronts", { "skills/later/SKILL.md": "---\nname: later\ndescription: A skill landed after\n---\nUse it.\n" });
  const after = (await api("GET", "/agents/fronts/learning")).body;
  assert.deepEqual(after.skills.find((skill) => skill.name === "unclosed").retired.by, "host", "unchanged since, read the same way");
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schema = doc.paths["/agents/{agent_id}/learning"].get.responses["200"].content["application/json"].schema;
  assert.deepEqual(schemaProblems(doc, schema, view), [], "the view meets its contract");
});
