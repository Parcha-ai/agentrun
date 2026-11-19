// A workflow draft whose README.md's front matter can't be read reads retired (learnedStatus: never given to a run),
// but no one retired it: the agent's learning view says the host could not read it (`retired: {by: "host", why:
// "unreadable"}`), never that a run or a person retired it (#2444). One retired the usual way keeps who did it.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { learningRepo, seedOf } from "../dist/learning.js";
import { workflow } from "./learn-format-support.mjs";
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
/** Workflow draft `name` with README.md `readme`. */
const draft = (name, readme) => ({ [`workflows/${name}/README.md`]: readme, [`workflows/${name}/workflow.json`]: workflow({ name }) });

test("a draft whose README's front matter can't be read reads retired by the host, unreadable, never by a run; one retired in its front matter keeps by run", async (t) => {
  const { api, data, baseUrl } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("fronts", { learning: true }))).status, 201);
  await commit(data, "fronts", {
    ...draft("unclosed", "---\nname: unclosed\ndescription: A draft whose front matter never closes\n\nUse it for everything.\n"),
    ...draft("frozen", "---\nname: frozen\ndescription: A draft whose status is none the host writes\nstatus: frozen\n---\n"),
    ...draft("shelved", "---\nname: shelved\ndescription: A draft retired in its own front matter\nstatus: retired\n---\n"),
  });
  const view = (await api("GET", "/agents/fronts/learning")).body;
  const by = Object.fromEntries(view.workflows.map((flow) => [flow.name, [flow.status, flow.retired && { by: flow.retired.by, why: flow.retired.why }]]));
  assert.deepEqual(by.unclosed, ["retired", { by: "host", why: "unreadable" }], JSON.stringify(view.workflows));
  assert.deepEqual(by.frozen, ["retired", { by: "host", why: "unreadable" }]);
  assert.deepEqual(by.shelved, ["retired", { by: "run", why: undefined }], "retired in so many words: who set it, as before");
  for (const flow of view.workflows) assert.equal(typeof flow.retired.at, "string");
  // A later write that leaves the unreadable draft as it is: the view still says the host could not read it.
  await commit(data, "fronts", draft("later", "---\nname: later\ndescription: A draft landed after\n---\n"));
  const after = (await api("GET", "/agents/fronts/learning")).body;
  assert.deepEqual(after.workflows.find((flow) => flow.name === "unclosed").retired.by, "host", "unchanged since, read the same way");
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const schema = doc.paths["/agents/{agent_id}/learning"].get.responses["200"].content["application/json"].schema;
  assert.deepEqual(schemaProblems(doc, schema, view), [], "the view meets its contract");
});
