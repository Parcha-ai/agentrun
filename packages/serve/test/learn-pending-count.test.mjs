// How many workflow drafts wait for the owner's OK, on the agent itself: GET /agents and GET /agents/{id} say
// `learning.pending` (drafts whose README.md is held with `status: pending`), for an agent that learns; read once per
// save of its learning, never per list call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pendingTestHooks } from "../dist/learning-routes.js";
import { workflow } from "./learn-format-support.mjs";
import { putLearning } from "./learn-support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { agent, serve } from "./support.mjs";

/** Agent `id`'s first save made as a first run makes it, then `files` saved on its learning, each call a run's merge. */
let merges = 0;
async function commit(store, id, files) {
  await store.learning.seed(id);
  await putLearning(store, id, files, { runId: `run-hand-${++merges}` });
}
const readme = (name) => `---\nname: ${name}\ndescription: Answers the ${name} question; use when asked\n---\n`;
const held = (text) => text.replace(/\n---\n/, "\nstatus: pending\n---\n");
/** Workflow draft `name`'s two files, its README.md held when `waits`. */
const draft = (name, waits = false) => ({ [`workflows/${name}/README.md`]: waits ? held(readme(name)) : readme(name), [`workflows/${name}/workflow.json`]: workflow({ name }) });

test("an agent that learns says how many workflow drafts wait for its owner's OK, in the list and on its own view; one approved counts no more", async (t) => {
  const { api, store, baseUrl } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("waits", { learning: true }))).status, 201);
  await commit(store, "waits", { ...draft("held-one", true), ...draft("kept"), ...draft("held-two", true) });
  const listed = (await api("GET", "/agents")).body.agents.find((a) => a.agent_id === "waits");
  assert.deepEqual(listed.learning, { pending: 2 }, JSON.stringify(listed.learning));
  const view = (await api("GET", "/agents/waits")).body;
  assert.deepEqual(view.learning, { pending: 2 });
  // The contract pins it: the Agent schema says it, and the served view is one it allows.
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  assert.equal(doc.components.schemas.Agent.properties.learning.properties.pending.type, "integer");
  assert.deepEqual(schemaProblems(doc, doc.components.schemas.Agent.properties.learning, view.learning), [], JSON.stringify(view.learning));
  // The owner's OK, as the newest save records it: the README's status gone.
  await commit(store, "waits", { "workflows/held-one/README.md": readme("held-one") });
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

test("the count is read once per save of the agent's learning: a list again reads nothing, a new save is read again", async (t) => {
  const { api, store } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("cached", { learning: true }))).status, 201);
  await commit(store, "cached", draft("held-one", true));
  await api("GET", "/agents");
  const reads = pendingTestHooks.reads;
  await api("GET", "/agents");
  await api("GET", "/agents/cached");
  assert.equal(pendingTestHooks.reads, reads, "no read while the newest save stays");
  await commit(store, "cached", draft("held-two", true));
  assert.deepEqual((await api("GET", "/agents/cached")).body.learning, { pending: 2 });
  assert.equal(pendingTestHooks.reads, reads + 1, "one read for the new save");
});

test("a purge of a run that wrote a waiting draft is read again: its draft counts no more, though the save the count read stays", async (t) => {
  const { api, store } = await serve(t, { learning: "on" });
  assert.equal((await api("POST", "/agents", agent("purging", { learning: true }))).status, 201);
  await commit(store, "purging", draft("held-one", true));
  const gone = `run-hand-${merges}`;
  await commit(store, "purging", draft("held-two", true));
  assert.deepEqual((await api("GET", "/agents/purging")).body.learning, { pending: 2 });
  const reads = pendingTestHooks.reads;
  // The purge rewrites the saves in place; its own save (the host's, after the newest) is what tells the count to read.
  await store.learning.purgeRun("purging", gone);
  assert.deepEqual((await api("GET", "/agents/purging")).body.learning, { pending: 1 }, "the purged run's draft counts no more");
  assert.equal(pendingTestHooks.reads, reads + 1, "one read for the purge");
});

// Review on #3746 (PRRT_kwDOUmdVMs68K745): a list asks the count of every agent; while an agent's newest save stays, its
// count is answered from the newest save's id alone, never by loading its items and their history (rows.newest).
test("a warm count reads only the newest save's id: statusesOf again loads no item (rows.newest), and a new save reads again", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { statusesOf } = await import("../dist/learning-routes.js");
  const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pending-warm-"));
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  t.after(async () => {
    await store.close();
    rmSync(data, { recursive: true, force: true });
  });
  await commit(store, "warm", draft("held-one", true));
  let loads = 0;
  const counted = { learning: { ...store.learning, newest: async (agentId) => (loads++, store.learning.newest(agentId)) } };
  const pending = async () => [...(await statusesOf(counted, "warm")).values()].filter((one) => one.status === "pending").length;
  assert.equal(await pending(), 1);
  const cold = loads;
  assert.ok(cold >= 1, "the first count loads the agent's learning");
  assert.equal(await pending(), 1);
  assert.equal(loads, cold, "a warm count loads none of it");
  await commit(store, "warm", draft("held-two", true));
  assert.equal(await pending(), 2, "a new save is read again");
  assert.ok(loads > cold);
});

test("pendingCount: learning it cannot read counts as unknown (undefined), not 0; an agent with no save counts 0", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pendingCount } = await import("../dist/learning-routes.js");
  const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
  const data = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pending-"));
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  t.after(async () => {
    await store.close();
    rmSync(data, { recursive: true, force: true });
  });
  assert.equal(await pendingCount(store, "never-made"), 0, "no save: nothing waits");
  await store.learning.seed("two");
  assert.equal(await pendingCount(store, "two"), 0);
  // Learning whose read fails (the store down): unknown, so the field is left out.
  const broken = { learning: { ...store.learning, newest: async () => { throw new Error("the store is down"); } } };
  assert.equal(await pendingCount(broken, "broken"), undefined, "learning that can't be read: unknown");
});
