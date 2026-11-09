// An inline-agent run over the one store (store.runs.createInline): a run whose agent is given inline and mapped to a
// source system by an external reference ("<source>:<kind>:<id>") and a version. The agent (one per reference) and the
// revision (one per version) are written on the first run that names them, in the same transaction as the run and its
// launch; a later run under the same reference and version reuses them, and a different body under a version is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { storeOn } from "./store-helpers.mjs";

const { ExternalBodyConflict } = await import("../dist/store/index.js");
const { getAgent, commitAgent, setCurrentRevision, setAgentArchived } = await import("../dist/agents-store.js");

const BODY = { instructions: "Answer the question.", tools: [], skills: {} };
const launchOf = (content = "hi") => ({ body: { input: { content }, title: content, place: { mode: "runner" } } });

/** createInline arguments for a run of expert `id` at `version`, with `body`. Fresh ids for the agent, revision and run. */
let seq = 0;
function inline({ id = "42", version = "1", body = BODY, name = "Expert 42", description = null, runId } = {}) {
  seq += 1;
  return {
    agent: { id: `agent-${seq}`, name, description, ref: `grep:expert:${id}` },
    revision: { id: `rev-${seq}`, version: String(version), kind: "agentic", body, skills: {} },
    run: { id: runId ?? `run-${seq}` },
    launch: launchOf(),
  };
}

test("first use writes the agent by its external reference and the revision by its version, then the run", async (t) => {
  const { store } = await storeOn(t);
  const args = inline({ id: "42", version: "7" });
  const run = await store.runs.createInline(args);
  assert.equal(run.state, "queued");
  // One agent, carrying the reference; one revision, carrying the version and made current.
  const agents = await store.agents.list();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].externalRef, "grep:expert:42");
  assert.equal(run.agentId, agents[0].id);
  const revisions = await store.agents.revisions(agents[0].id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].externalVersion, "7");
  assert.equal(run.revisionId, revisions[0].id);
  assert.equal((await store.agents.get(agents[0].id)).currentRevision, revisions[0].id);
  // The run's launch was written in the same transaction.
  assert.ok(await store.runs.launch(run.id));
});

test("a second run under the same reference and version reuses the agent and revision, adds neither", async (t) => {
  const { store } = await storeOn(t);
  const first = await store.runs.createInline(inline({ id: "42", version: "7", runId: "run-a" }));
  const second = await store.runs.createInline(inline({ id: "42", version: "7", runId: "run-b" }));
  const agents = await store.agents.list();
  assert.equal(agents.length, 1, "one agent");
  assert.equal((await store.agents.revisions(agents[0].id)).length, 1, "one revision");
  assert.equal(first.agentId, second.agentId);
  assert.equal(first.revisionId, second.revisionId);
  assert.deepEqual((await store.runs.list({ agentId: agents[0].id })).map((r) => r.id).sort(), ["run-a", "run-b"]);
});

test("two concurrent first uses make exactly one agent and one revision", async (t) => {
  const { store } = await storeOn(t);
  const [a, b] = await Promise.all([
    store.runs.createInline(inline({ id: "42", version: "7", runId: "run-a" })),
    store.runs.createInline(inline({ id: "42", version: "7", runId: "run-b" })),
  ]);
  const agents = await store.agents.list();
  assert.equal(agents.length, 1, "one agent, not two");
  assert.equal((await store.agents.revisions(agents[0].id)).length, 1, "one revision, not two");
  assert.equal(a.agentId, b.agentId);
  assert.equal(a.revisionId, b.revisionId);
});

test("a different body under an existing version is refused, nothing written", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.createInline(inline({ id: "42", version: "7", runId: "run-a", body: BODY }));
  const changed = { ...BODY, instructions: "A different instruction." };
  await assert.rejects(
    () => store.runs.createInline(inline({ id: "42", version: "7", runId: "run-b", body: changed })),
    (e) => e instanceof ExternalBodyConflict,
  );
  const agents = await store.agents.list();
  assert.equal((await store.agents.revisions(agents[0].id)).length, 1, "no second revision");
  assert.deepEqual((await store.runs.list({ agentId: agents[0].id })).map((r) => r.id), ["run-a"], "no second run");
});

test("the same version's body is matched field-for-field, not by key order (canonical)", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.createInline(inline({ id: "42", version: "7", runId: "run-a", body: { instructions: "Go.", tools: ["read"], skills: {} } }));
  // The same body with its keys in another order is the same revision, not a conflict.
  const reordered = { skills: {}, tools: ["read"], instructions: "Go." };
  const second = await store.runs.createInline(inline({ id: "42", version: "7", runId: "run-b", body: reordered }));
  assert.equal((await store.agents.revisions(second.agentId)).length, 1, "one revision");
});

test("a new version's first use is a new revision on the same agent, made current, and brings the agent's name and description up to it", async (t) => {
  const { store } = await storeOn(t);
  const first = await store.runs.createInline(inline({ id: "42", version: "7", runId: "run-a", name: "Due diligence", description: "The old blurb" }));
  const second = await store.runs.createInline(inline({ id: "42", version: "8", runId: "run-b", name: "Due diligence (v2)", description: "The new blurb", body: { ...BODY, instructions: "Newer." } }));
  assert.equal(first.agentId, second.agentId, "same agent");
  const revisions = await store.agents.revisions(first.agentId);
  assert.equal(revisions.length, 2, "two revisions");
  const agent = await store.agents.get(first.agentId);
  assert.equal(agent.currentRevision, second.revisionId, "the newer version is current");
  // The source is the truth: the agent's name and description follow the new version.
  assert.equal(agent.name, "Due diligence (v2)");
  assert.equal(agent.description, "The new blurb");
});

test("reusing an existing version changes nothing, including the agent's name", async (t) => {
  const { store } = await storeOn(t);
  const first = await store.runs.createInline(inline({ id: "42", version: "7", runId: "run-a", name: "Due diligence" }));
  // A second run under the same version, even with a different name sent, leaves the agent as its first use wrote it.
  await store.runs.createInline(inline({ id: "42", version: "7", runId: "run-b", name: "A renamed send" }));
  assert.equal((await store.agents.get(first.agentId)).name, "Due diligence", "the name is unchanged on reuse");
});

test("a different expert reference is a different agent", async (t) => {
  const { store } = await storeOn(t);
  await store.runs.createInline(inline({ id: "42", version: "1", runId: "run-a" }));
  await store.runs.createInline(inline({ id: "43", version: "1", runId: "run-b" }));
  assert.equal((await store.agents.list()).length, 2, "two agents");
});

// ---- an externally owned agent is read-only through /v2/agents --------------------------------------------------------

/** The entry of the agent an inline run just mapped (its one agent), for the serve-layer agent writers. */
async function externalEntry(store) {
  await store.runs.createInline(inline({ id: "42", version: "1", runId: "run-a" }));
  const [agent] = await store.agents.list();
  return (await getAgent(store, agent.id));
}

test("an edit of an external agent through the definition route is refused, forbidden", async (t) => {
  const { store } = await storeOn(t);
  const entry = await externalEntry(store);
  await assert.rejects(
    () => commitAgent(store, entry, { definition: { instructions: "Changed here." }, skills: {} }),
    (e) => e.code === "forbidden" && /managed by its source/.test(e.message),
  );
});

test("setting the current revision of an external agent is refused, forbidden", async (t) => {
  const { store } = await storeOn(t);
  const entry = await externalEntry(store);
  await assert.rejects(
    () => setCurrentRevision(store, entry, entry.revision.id),
    (e) => e.code === "forbidden" && /managed by its source/.test(e.message),
  );
});

test("archiving an external agent is refused, forbidden", async (t) => {
  const { store } = await storeOn(t);
  const entry = await externalEntry(store);
  await assert.rejects(
    () => setAgentArchived(store, entry.agent.id, true),
    (e) => e.code === "forbidden" && /managed by its source/.test(e.message),
  );
  assert.equal((await store.agents.get(entry.agent.id)).archivedAt, null, "nothing archived");
});

test("reads of an external agent work as for any agent", async (t) => {
  const { store } = await storeOn(t);
  const entry = await externalEntry(store);
  const read = await getAgent(store, entry.agent.id);
  assert.equal(read.agent.externalRef, "grep:expert:42");
  assert.equal(read.revision.id, entry.revision.id);
});
