// Agent CRUD and revisions over the one store (agents-store.ts): create, edit (a new revision made current), the dedup that
// makes a PUT sent twice one revision, going back to a prior body as a new revision, If-Match, roll back to an older
// revision, archive, and the views. The argument pin survives a round trip and an equal pin is one revision (the ruling
// learning-1's pin-survival test joins). A real store on a temp file.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../dist/errors.js";
import {
  agentRevision, agentRevisions, agentView, commitAgent, createAgent, definitionOf, getAgent, listAgents,
  setAgentArchived, setCurrentRevision,
} from "../dist/agents-store.js";
import { storeOn } from "./store-helpers.mjs";

const DEF = (over = {}) => ({ name: "Researcher", instructions: "Research the company.", tools: ["read"], ...over });
const SKILLS = { "read/SKILL.md": "Read the site." };

test("create: a new agent and its first revision, current; a given id already here is agent_exists; the body is checked", async (t) => {
  const { store } = await storeOn(t);
  const entry = await createAgent(store, { definition: DEF({ id: "alpha" }), skills: SKILLS });
  assert.equal(entry.agent.id, "alpha");
  assert.equal(entry.version, 1);
  assert.equal(entry.revisions, 1);
  assert.equal(entry.revision.kind, "agentic");
  assert.equal(entry.revision.body.instructions, "Research the company.");
  assert.match(entry.revision.body.skills["read/SKILL.md"], /^[0-9a-f]{64}$/);
  assert.deepEqual(entry.revision.skills, SKILLS, "the skill texts ride on the revision's row");
  assert.equal((await store.agents.get("alpha")).currentRevision, entry.revision.id);
  await assert.rejects(createAgent(store, { definition: DEF({ id: "alpha" }) }), (e) => e instanceof ApiError && e.code === "agent_exists");
  await assert.rejects(createAgent(store, { definition: DEF({ id: "beta", instructions: 3 }) }), (e) => e instanceof ApiError && e.code === "input_invalid");
});

test("a minted id when none is given; list is newest first and leaves archived agents out", async (t) => {
  const { store, clock } = await storeOn(t);
  const a = await createAgent(store, { definition: DEF({ name: "A" }) });
  assert.match(a.agent.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a UUIDv7");
  clock.now += 10;
  const b = await createAgent(store, { definition: DEF({ name: "B", id: "bravo" }) });
  const ids = (await listAgents(store)).map((e) => e.agent.id);
  assert.deepEqual(ids, [b.agent.id, a.agent.id], "newest first");
  await setAgentArchived(store, "bravo", true);
  assert.deepEqual((await listAgents(store)).map((e) => e.agent.id), [a.agent.id]);
  assert.equal((await getAgent(store, "bravo")).agent.archivedAt !== null, true);
  const firstArchivedAt = (await getAgent(store, "bravo")).agent.archivedAt;
  clock.now += 5_000;
  await setAgentArchived(store, "bravo", true);
  assert.equal((await getAgent(store, "bravo")).agent.archivedAt, firstArchivedAt, "re-archiving an already-archived agent keeps the first time");
  await setAgentArchived(store, "bravo", false);
  assert.equal((await getAgent(store, "bravo")).agent.archivedAt, null);
  await assert.rejects(setAgentArchived(store, "nobody", true), (e) => e instanceof ApiError && e.code === "not_found");
});

test("edit: a new revision made current; an edit equal to the current writes nothing; going back to a prior body is a new revision", async (t) => {
  const { store, clock } = await storeOn(t);
  let entry = await createAgent(store, { definition: DEF({ id: "a" }), skills: SKILLS });
  const rev1 = entry.revision.id;
  clock.now += 10;
  // The same definition again is the current revision: no new revision, the entry unchanged.
  const same = await commitAgent(store, entry, { definition: DEF({ id: "a" }), skills: SKILLS });
  assert.equal(same.revision.id, rev1);
  assert.equal(same.revisions, 1, "a PUT sent twice makes one revision");
  // An edit: the next revision, made current.
  entry = await commitAgent(store, same, { definition: DEF({ id: "a", instructions: "Research; cite." }), skills: SKILLS });
  assert.notEqual(entry.revision.id, rev1);
  assert.equal(entry.version, 2);
  assert.equal(entry.revisions, 2);
  assert.equal((await store.agents.get("a")).currentRevision, entry.revision.id);
  // Going back to the first body: a new revision (a fresh id), not a return to rev1.
  const back = await commitAgent(store, entry, { definition: DEF({ id: "a" }), skills: SKILLS });
  assert.notEqual(back.revision.id, rev1);
  assert.equal(back.revisions, 3);
});

test("an edit keeps the agent's id, name and description, and carries over the skills, harness and place it leaves out", async (t) => {
  const { store } = await storeOn(t);
  const entry = await createAgent(store, { definition: DEF({ id: "a", harness: "claude-agent", place: { mode: "sandbox", box: "docker" } }), skills: SKILLS });
  // An edit with only new instructions keeps the skills, harness and place from the current revision.
  const next = await commitAgent(store, entry, { definition: DEF({ id: "a", instructions: "Research deeply." }) });
  assert.equal(next.revision.body.harness, "claude-agent");
  assert.deepEqual(next.revision.body.place, { mode: "sandbox", box: "docker" });
  assert.deepEqual(next.revision.skills, SKILLS, "skills carried over when the edit names none");
  // Name or description cannot be changed by an edit.
  await assert.rejects(commitAgent(store, next, { definition: DEF({ id: "a", name: "Renamed", instructions: "x" }) }), (e) => e instanceof ApiError && e.code === "input_invalid");
});

test("If-Match: an edit on a stale current revision is precondition_failed and writes nothing", async (t) => {
  const { store } = await storeOn(t);
  const entry = await createAgent(store, { definition: DEF({ id: "a" }), skills: SKILLS });
  const moved = await commitAgent(store, entry, { definition: DEF({ id: "a", instructions: "Moved on." }), skills: SKILLS });
  await assert.rejects(
    commitAgent(store, entry, { definition: DEF({ id: "a", instructions: "On the old one." }), skills: SKILLS }, { ifCurrent: entry.revision.id }),
    (e) => e instanceof ApiError && e.code === "precondition_failed",
  );
  // The matching If-Match commits.
  const ok = await commitAgent(store, moved, { definition: DEF({ id: "a", instructions: "On the current one." }), skills: SKILLS }, { ifCurrent: moved.revision.id });
  assert.equal(ok.version, 3);
});

test("roll back to an older revision with setCurrent; a revision of another agent is refused", async (t) => {
  const { store } = await storeOn(t);
  const a = await createAgent(store, { definition: DEF({ id: "a" }), skills: SKILLS });
  const rev1 = a.revision.id;
  const a2 = await commitAgent(store, a, { definition: DEF({ id: "a", instructions: "Second." }), skills: SKILLS });
  const rolled = await setCurrentRevision(store, a2, rev1);
  assert.equal(rolled.revision.id, rev1);
  assert.equal(rolled.version, 1, "the first revision is current again");
  assert.equal(rolled.revisions, 2, "both revisions are kept");
  const b = await createAgent(store, { definition: DEF({ id: "b" }), skills: SKILLS });
  await assert.rejects(setCurrentRevision(store, b, rev1), (e) => e instanceof ApiError && e.code === "not_found");
});

test("revisions: newest first, each with its number, the current one marked; one that is not the agent's is null", async (t) => {
  const { store } = await storeOn(t);
  const a = await createAgent(store, { definition: DEF({ id: "a" }), skills: SKILLS });
  const a2 = await commitAgent(store, a, { definition: DEF({ id: "a", instructions: "Second." }), skills: SKILLS });
  const rows = await agentRevisions(store, "a");
  assert.deepEqual(rows.map((r) => [r.version, r.current]), [[2, true], [1, false]], "newest first, current marked");
  const one = await agentRevision(store, "a", a.revision.id);
  assert.equal(one.version, 1);
  assert.equal(one.current, false);
  assert.equal(await agentRevision(store, "a", "not-a-revision"), null);
  // A revision of another agent is not this agent's.
  const b = await createAgent(store, { definition: DEF({ id: "b" }), skills: SKILLS });
  assert.equal(await agentRevision(store, "a", b.revision.id), null);
  void a2;
});

test("tool settings survive a round trip, sorted, and equal settings are one revision; a change is a new revision", async (t) => {
  const { store } = await storeOn(t);
  const withSet = (set) => DEF({ id: "a", tool_settings: set });
  const entry = await createAgent(store, { definition: withSet({ web_search: { provider: "exa-keyless" }, web_fetch: { provider: "parallel" } }), skills: SKILLS });
  const def = definitionOf(entry.agent, entry.revision, entry.version);
  assert.deepEqual(Object.entries(def.tool_settings), [["web_fetch", { provider: "parallel" }], ["web_search", { provider: "exa-keyless" }]], "kept, sorted");
  // The same settings, the tools in another order, are the same revision: none is added (the basis the pin's "equal pins =
  // one revision" rides on once it is wired through tool-plane's canonicalToolSettings).
  const again = await commitAgent(store, entry, { definition: withSet({ web_fetch: { provider: "parallel" }, web_search: { provider: "exa-keyless" } }), skills: SKILLS });
  assert.equal(again.revision.id, entry.revision.id, "equal settings are one revision");
  assert.equal(again.revisions, 1);
  const changed = await commitAgent(store, again, { definition: withSet({ web_search: { provider: "parallel" } }), skills: SKILLS });
  assert.notEqual(changed.revision.id, entry.revision.id);
  assert.equal(changed.revisions, 2);
});

test("tool settings go through the one copy: an argument pin is checked, kept canonical (keys sorted), and an equal pin is one revision; a bad setting is refused", async (t) => {
  const { store } = await storeOn(t);
  const withPin = (pin) => DEF({ id: "a", tool_settings: { "mcp:github/pull_request_review_write": { pin } } });
  // settingsIssues accepts a valid pin on an MCP tool's key (the request-layer AGENT_LAYER_PINS gate is validate.ts's, not
  // this module's); canonicalToolSettings sorts the pin's arguments.
  const entry = await createAgent(store, { definition: withPin({ event: "APPROVE", body: "lgtm" }), skills: SKILLS });
  const def = definitionOf(entry.agent, entry.revision, entry.version);
  assert.deepEqual(def.tool_settings["mcp:github/pull_request_review_write"].pin, { body: "lgtm", event: "APPROVE" }, "the pin is kept, its arguments sorted");
  // The same pin, the arguments in another order, is the same revision: the one copy makes them one body.
  const again = await commitAgent(store, entry, { definition: withPin({ body: "lgtm", event: "APPROVE" }), skills: SKILLS });
  assert.equal(again.revision.id, entry.revision.id, "an equal pin is one revision");
  assert.equal(again.revisions, 1);
  // A different pin is a new revision.
  const changed = await commitAgent(store, again, { definition: withPin({ event: "REQUEST_CHANGES" }), skills: SKILLS });
  assert.notEqual(changed.revision.id, entry.revision.id);
  // A tool setting the one copy refuses (a provider that is not offered) is an input error, nothing written.
  await assert.rejects(createAgent(store, { definition: DEF({ id: "b", tool_settings: { web_search: { provider: "nope" } } }) }), (e) => e instanceof ApiError && e.code === "input_invalid");
});

test("agentView: the contract shape, its skills with sizes, the sign-ins and run counts the caller passes in", async (t) => {
  const { store } = await storeOn(t);
  const entry = await createAgent(store, { definition: DEF({ id: "a" }), skills: SKILLS });
  const view = agentView(entry, "http://console.example", { runs: { count: 3, live: 1 }, signIns: [{ key: "default", provider: "browserbase", state: "ready", held_by: null, verified_at: null }] });
  assert.equal(view.agent_id, "a");
  assert.equal(view.kind, "agentic");
  assert.equal(view.revision, entry.revision.id);
  assert.deepEqual(view.runs, { count: 3, live: 1 });
  assert.equal(view.sign_ins.length, 1);
  assert.equal(view.skills[0].path, "read/SKILL.md");
  assert.equal(view.skills[0].size_bytes, Buffer.byteLength("Read the site.", "utf8"));
  assert.equal(view.home_etag, `"${entry.revision.id}"`);
  assert.equal(view.definition.id, "a");
  assert.match(view.created_at, /^\d{4}-\d{2}-\d{2}T/);
});
