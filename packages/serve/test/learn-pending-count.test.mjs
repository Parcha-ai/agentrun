// How many workflow drafts wait for the owner's OK, on the agent itself: GET /agents and GET /agents/{id} say
// `learning.pending` (drafts whose README.md is held with `status: pending`), for an agent that learns; read once per
// commit of its folder's main, never per list call.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { learningRepo, seedOf } from "../dist/learning.js";
import { pendingTestHooks } from "../dist/learning-routes.js";
import { workflow } from "./learn-format-support.mjs";
import { git } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

/** Agent `id`'s learning folder made as a first run makes it, then `files` committed on main. */
async function commit(data, id, files) {
  await seedOf(data, id);
  const repo = learningRepo(data, id);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
}
const readme = (name) => `---\nname: ${name}\ndescription: Answers the ${name} question; use when asked\n---\n`;
const held = (text) => text.replace(/\n---\n/, "\nstatus: pending\n---\n");
/** Workflow draft `name`'s two files, its README.md held when `waits`. */
const draft = (name, waits = false) => ({ [`workflows/${name}/README.md`]: waits ? held(readme(name)) : readme(name), [`workflows/${name}/workflow.json`]: workflow({ name }) });

test("an agent that learns says how many workflow drafts wait for its owner's OK, in the list and on its own view; one approved counts no more", async (t) => {
  const { api, data, baseUrl } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("waits", { learning: true }))).status, 201);
  await commit(data, "waits", { ...draft("held-one", true), ...draft("kept"), ...draft("held-two", true) });
  const listed = (await api("GET", "/agents")).body.agents.find((a) => a.agent_id === "waits");
  assert.deepEqual(listed.learning, { pending: 2 }, JSON.stringify(listed.learning));
  const view = (await api("GET", "/agents/waits")).body;
  assert.deepEqual(view.learning, { pending: 2 });
  // The contract pins it: the Agent schema says it, and the served view is one it allows.
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.equal(doc.components.schemas.Agent.properties.learning.properties.pending.type, "integer");
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Agent.properties.learning, view.learning), [], JSON.stringify(view.learning));
  // The owner's OK, as main records it: the README's status gone.
  await commit(data, "waits", { "workflows/held-one/README.md": readme("held-one") });
  assert.deepEqual((await api("GET", "/agents/waits")).body.learning, { pending: 1 });
});

test("an agent that does not learn has no learning field, nor does one on a server whose learning is off", async (t) => {
  const { api } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  assert.equal("learning" in (await api("GET", "/agents/plain")).body, false);
  const off = await serve(t, { learning: "off" });
  assert.equal((await off.api("POST", "/agents", agent("off-learner", { learning: true }))).status, 201);
  assert.equal("learning" in (await off.api("GET", "/agents/off-learner")).body, false);
});

test("the count is read once per commit of the folder's main: a list again reads nothing, a new commit is read again", async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("cached", { learning: true }))).status, 201);
  await commit(data, "cached", draft("held-one", true));
  await api("GET", "/agents");
  const reads = pendingTestHooks.reads;
  await api("GET", "/agents");
  await api("GET", "/agents/cached");
  assert.equal(pendingTestHooks.reads, reads, "no read while main stays");
  await commit(data, "cached", draft("held-two", true));
  assert.deepEqual((await api("GET", "/agents/cached")).body.learning, { pending: 2 });
  assert.equal(pendingTestHooks.reads, reads + 1, "one read for the new commit");
});

test("pendingCount: a folder it cannot read counts as unknown (undefined), not 0; one never made counts 0; and requests that miss the cache together read the folder once", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pendingCount } = await import("../dist/learning-routes.js");
  const data = mkdtempSync(join(tmpdir(), "pending-"));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  assert.equal(await pendingCount(data, "never-made"), 0, "a folder never made: nothing waits");
  // A folder the server cannot read: a link where it should be.
  const broken = learningRepo(data, "broken");
  mkdirSync(dirname(broken), { recursive: true });
  symlinkSync(data, broken);
  assert.equal(await pendingCount(data, "broken"), undefined, "a folder that can't be read: unknown, so the field is left out");
  // Two calls on a commit not yet counted read it once.
  await seedOf(data, "two");
  const before = pendingTestHooks.reads;
  const [a, b] = await Promise.all([pendingCount(data, "two"), pendingCount(data, "two")]);
  assert.deepEqual([a, b], [0, 0]);
  assert.equal(pendingTestHooks.reads - before, 1, "one read for both");
});
