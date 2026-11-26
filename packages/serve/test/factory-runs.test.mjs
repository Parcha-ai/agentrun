import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { factoryRunsPage } from "../dist/factory-runs.js";
import { keptFactory, listingOverStore, summaryOverStore } from "../dist/store-view.js";
import { connect, connectable, deliver } from "./github-support.mjs";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { serve } from "./support.mjs";
import { schemaProblems } from "./schema-support.mjs";
import { firings, made } from "./trigger-support.mjs";

const url = (query = "scope=active") => new URL(`https://run.test/v2/runs?${query}`);
// The page hands its rows to its caller together (factoryRunsPage): here each is its id alone.
const brief = async (rows) => rows.map((row) => ({ run_id: row.id }));
const launch = { body: { input: { content: "Work." }, title: "Work", place: { mode: "runner" } } };
async function make(store, id, { state, outcome, agent = "agent-1", revision = "rev-1" } = {}) {
  await store.runs.create({ id, agentId: agent, revisionId: revision }, launch);
  if (!state || state === "queued") return;
  const claim = await store.claim(id, "runner-test", { leaseMs: 60_000 });
  if (state === "running") return;
  if (state === "parked") return store.release(claim, { state: "parked" });
  await store.runs.update(claim, { state, outcome, endedAt: T0 + 1000 });
}

test("factory active selects old work before limiting history; continuable, parked and archived executions stay visible", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  await store.agents.create({ id: "workflow", name: "Workflow" }, { id: "workflow-rev", kind: "workflow", body: { workflow: {} } });
  for (const [id, state, outcome] of [["old-queued", "queued"], ["old-running", "running"], ["old-parked", "parked"], ["old-stopped", "stopped", "stopped"], ["old-archived", "queued"]]) await make(store, id, { state, outcome });
  await store.runs.archive("old-archived", true);
  clock.now += 10_000;
  for (let n = 0; n < 125; n++) await make(store, `history-${n}`, { state: "ended", outcome: "completed" });
  await make(store, "cancelled", { state: "stopped", outcome: "cancelled" });
  await make(store, "workflow-stopped", { state: "stopped", outcome: "stopped", agent: "workflow", revision: "workflow-rev" });
  await make(store, "review", { state: "ended", outcome: "escalated" });
  await make(store, "failed", { state: "failed" });
  await make(store, "archived-review", { state: "ended", outcome: "escalated" });
  await store.runs.archive("archived-review", true);
  await make(store, "archived-failed", { state: "failed" });
  await store.runs.archive("archived-failed", true);
  await store.importRun({ id: "imported-review", agentId: "agent-1", revisionId: "rev-1", importedFrom: { source: "codex", session: "imported" }, launch, outcome: "escalated", costUsd: null, summary: null, startedAt: clock.now, endedAt: clock.now, transcript: [] });
  const opened = [];
  const page = await factoryRunsPage(store, url(), {}, async rows => { opened.push(...rows.map(row => row.id)); return brief(rows); }, () => clock.now);
  assert.deepEqual(opened.sort(), ["old-archived", "old-parked", "old-queued", "old-running", "old-stopped"]);
  assert.equal(page.next_cursor, null);
  assert.equal(page.scope, "active");
  assert.equal(page.observed_at, new Date(clock.now).toISOString());
  assert.deepEqual((await factoryRunsPage(store, url("scope=review"), {}, brief)).runs.map(r => r.run_id).sort(), ["failed", "review"]);
  await store.agents.archive("agent-1", true);
  assert.equal((await factoryRunsPage(store, url(), {}, brief)).runs.length, 5, "an archived agent can still have active work");
  assert.deepEqual((await factoryRunsPage(store, url("scope=review"), {}, brief)).runs, [], "archived terminal history is acknowledged");
});

test("factory keysets survive changing membership and tie timestamps, with bounded per-page reads", async (t) => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  for (const id of ["run-a", "run-b", "run-c", "run-d"]) await make(store, id);
  const opened = [];
  const first = await factoryRunsPage(store, url("scope=active&limit=2"), { agent: "agent-1" }, async rows => { opened.push(...rows.map(row => row.id)); return brief(rows); });
  assert.deepEqual(opened, ["run-d", "run-c"]);
  assert.ok(first.next_cursor);
  const claim = await store.claim("run-d", "finisher", { leaseMs: 60_000 });
  await store.runs.update(claim, { state: "ended", outcome: "completed", endedAt: clock.now });
  clock.now += 1000;
  await make(store, "run-new");
  const next = await factoryRunsPage(store, url(`scope=active&limit=2&cursor=${first.next_cursor}`), { agent: "agent-1" }, brief);
  assert.deepEqual(next.runs.map(r => r.run_id), ["run-b", "run-a"]);
  assert.equal(next.next_cursor, null);
  for (const [query, filter] of [["scope=review", { agent: "agent-1" }], ["scope=active", {}], ["scope=active", { agent: "agent-1", revision: "rev-1" }]]) {
    await assert.rejects(factoryRunsPage(store, url(`${query}&cursor=${first.next_cursor}`), filter, brief), { code: "bad_request" });
  }
});

test("factory rejects malformed cursors and filters before querying", async () => {
  const store = { runs: { list: () => { throw new Error("must not read"); } } };
  for (const query of ["scope=unknown", "scope=active&status=working", "scope=active&archived=false", "scope=active&limit=0", "scope=active&limit=101", "scope=active&limit=1.5", "scope=active&cursor=0", `scope=active&cursor=factory.${Buffer.from(JSON.stringify({ version: 1, scope: "active", before: { startedAt: 1, id: "bad/id" } })).toString("base64url")}`]) {
    await assert.rejects(factoryRunsPage(store, url(query), {}, brief), { code: "bad_request" }, query);
  }
  await assert.rejects(factoryRunsPage(store, url(), { revision: "bad/id" }, brief), { code: "bad_request" });
});

test("active factory includes independently stored internal workers while ordinary history and terminal review keep their boundary", async t => {
  // The internal worker a store still makes beside a person's run is an audit's shadow run (learn/audit.ts): its id is
  // the served run's after "audit.". A learning run of its own is no longer queued at a run's end.
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await make(store, "parent", { state: "ended", outcome: "completed" });
  await make(store, "audit.parent");
  assert.deepEqual((await factoryRunsPage(store, url(), {}, brief)).runs.map(r => r.run_id), ["audit.parent"]);
  const summary = await summaryOverStore(store, "audit.parent", { origin: "https://run.test", serverSecrets: () => [], factory: true });
  assert.equal(summary.factory.source, "managed");
  assert.equal(summary.factory.control, "managed");
  assert.equal(summary.factory.controls.cancel, true);
  assert.deepEqual((await store.runs.listed({ limit: 50 })).rows.map(({ row }) => row.id), ["parent"]);
  const worker = await store.claim("audit.parent", "runner-test", { leaseMs: 60_000 });
  await store.runs.update(worker, { state: "failed", endedAt: T0 + 2000 });
  assert.deepEqual((await factoryRunsPage(store, url("scope=review"), {}, brief)).runs, []);
  assert.deepEqual((await factoryRunsPage(store, url(), {}, brief)).runs, []);
});

test("HTTP factory scope carries metadata and cursor; ordinary history keeps its prior response", async (t) => {
  const { api, store } = await serve(t, { runner: false });
  await store.agents.create({ id: "agent-1", name: "Agent" }, { id: "rev-1", kind: "agentic", body: { instructions: "Work.", computer: { kind: "sandbox", provider: "docker" } } });
  await make(store, "run-a");
  await make(store, "run-b");
  const scoped = await api("GET", "/runs?scope=active&limit=1");
  assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.scope, "active");
  assert.ok(scoped.body.observed_at);
  assert.ok(scoped.body.next_cursor);
  assert.equal(scoped.body.runs[0].factory.source, "managed");
  assert.equal(scoped.body.runs[0].computer.state, "starting");
  assert.equal(scoped.body.runs[0].computer.kind, "sandbox");
  const document = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(document, { $ref: "#/components/schemas/RunList" }, scoped.body), []);
  const agent = await api("GET", `/agents/agent-1/runs?scope=active&limit=1`);
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal(agent.body.runs[0].run_id, "run-b");
  const history = await api("GET", "/runs?limit=1");
  assert.equal(history.status, 200);
  assert.equal("scope" in history.body, false);
  assert.equal("factory" in history.body.runs[0], false);
  assert.equal("computer" in history.body.runs[0], false);
  assert.equal((await api("GET", "/runs?scope=active&status=working")).status, 400);
});

test("the store reads the kept listings of the runs named in one read: each run's listing, mark and whether it is behind, a shadow run's too", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await make(store, "parent", { state: "ended", outcome: "completed" });
  await make(store, "audit.parent");
  assert.deepEqual(await store.runs.listings([]), []);
  const unbuilt = await store.runs.listings(["parent", "audit.parent", "no-such-run"]);
  assert.deepEqual(unbuilt.map((read) => read.id).sort(), ["audit.parent", "parent"], "a run there is none of has no entry");
  for (const read of unbuilt) assert.deepEqual([read.listing, read.behind, read.agentArchivedAt], [null, true, null], `${read.id}: never built, so behind`);
  const deps = { origin: "https://run.test", serverSecrets: () => [] };
  for (const { id, listMark } of unbuilt) assert.equal(await store.runs.putListing(id, listMark, await listingOverStore(store, id, deps)), true);
  const built = new Map((await store.runs.listings(["audit.parent", "parent"])).map((read) => [read.id, read]));
  for (const id of ["parent", "audit.parent"]) {
    const read = built.get(id);
    assert.equal(read.behind, false, `${id}: built at its mark`);
    assert.equal(read.listing.item.run_id, id);
    assert.equal("factory" in read.listing.item, false, "the list item is the runs list's own: the factory's part is kept beside it");
    assert.equal(read.listing.factory.activity.source, "managed");
    assert.equal("observation" in read.listing.factory.activity, false, "who observes the run now is read when it is listed, never kept");
    assert.deepEqual(read.listing.factory.observed, { basis: "runner" });
  }
  await store.agents.archive("agent-1", true);
  assert.ok((await store.runs.listings(["parent"]))[0].agentArchivedAt > 0, "its agent's archive time, as a list reads it");
  // A purged run is a tombstone: it has no listing to read, so a page that read its row before the purge builds none.
  const worker = await store.claim("audit.parent", "runner-test", { leaseMs: 60_000 });
  await store.runs.update(worker, { state: "failed", endedAt: T0 + 2000 });
  await store.runs.purge("audit.parent", { meters: null, spend: { usd: null }, learning: null });
  await store.runs.purge("parent", { meters: null, spend: { usd: null }, learning: null });
  assert.deepEqual(await store.runs.listings(["parent", "audit.parent"]), []);
});

test("what a listing keeps for the factory is cut again of a secret saved since its build, and a listing that kept none says so", async (t) => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Work." }, title: "Work", place: { mode: "runner" }, repo: "example/project" } });
  const listing = await listingOverStore(store, "run-1", { origin: "https://run.test", serverSecrets: () => [] });
  assert.equal(keptFactory(listing, []).activity.github.repository, "example/project");
  assert.equal(JSON.stringify(keptFactory(listing, ["example/project"])).includes("example/project"), false, "a value that became a secret after the build is not shown from the kept part");
  const { factory: _factory, ...earlier } = listing;
  assert.equal(keptFactory(earlier, []), undefined, "a listing an earlier server built keeps no factory part");
});

/** A run's factory fields but its watermark, which a kept listing holds as of its own build. */
const withoutVersion = ({ lifecycle_version: _version, ...factory }) => factory;

test("HTTP factory scope shows each run from its kept listing as the run's own factory read gives it, and as it stands after each write, with no lister pass between", { timeout: 120_000 }, async (t) => {
  // listerIdleMs Infinity: the lister builds only when asked, so a page after a write is the page's own build.
  const { api, store, baseUrl, listingSettled } = await serve(t, { runner: false, listerIdleMs: Infinity });
  await agentWithRevision(store);
  await make(store, "run-queued");
  await make(store, "run-failed", { state: "failed" });
  await store.runs.create({ id: "run-working", agentId: "agent-1", revisionId: "rev-1" }, launch);
  const claim = await store.claim("run-working", "runner-test", { leaseMs: 600_000 });
  await listingSettled();
  const pageOf = async (scope) => {
    const answer = await api("GET", `/runs?scope=${scope}`);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return new Map(answer.body.runs.map((run) => [run.run_id, run]));
  };
  const deps = { origin: new URL(baseUrl).origin, serverSecrets: () => [], factory: true };
  const sameAsRead = async (page, why) => {
    for (const [id, item] of page) {
      const read = await summaryOverStore(store, id, deps);
      assert.deepEqual(withoutVersion(item.factory), withoutVersion(read.factory), `${why}: ${id} shows the factory fields its own read gives`);
      for (const key of ["status", "state", "ended_at", "pending", "error", "title", "agent_id"]) assert.deepEqual(item[key], read[key], `${why}: ${id} shows ${key} as its own read does`);
      assert.ok(BigInt(item.factory.lifecycle_version) <= BigInt(read.factory.lifecycle_version), `${why}: ${id}'s watermark is its listing's build's, never later than now`);
    }
  };
  const active = await pageOf("active");
  assert.deepEqual([...active.keys()].sort(), ["run-queued", "run-working"]);
  assert.deepEqual(active.get("run-working").factory.observation, { basis: "runner", status: "current", last_seen_at: null }, "a held run is observed now, by its row's claim");
  assert.equal(active.get("run-queued").factory.observation.status, "unreported");
  await sameAsRead(active, "built by the lister");
  await sameAsRead(await pageOf("review"), "built by the lister");
  assert.deepEqual(await pageOf("active"), active, "an unchanged board reads the same again");

  // A listing an earlier server built is current and keeps nothing for the factory: the page builds it again, once, and
  // writes it back with its factory part.
  const [{ listing: built, listMark }] = await store.runs.listings(["run-queued"]);
  const { factory: _factory, ...earlier } = built;
  assert.equal(await store.runs.putListing("run-queued", listMark, { ...earlier, status: "queued", live: false, until: null, flags: 0 }), true);
  assert.equal("factory" in (await store.runs.listings(["run-queued"]))[0].listing, false, "as an earlier server left it");
  assert.deepEqual((await pageOf("active")).get("run-queued"), active.get("run-queued"), "shown as before, from a build of its own");
  const [again] = await store.runs.listings(["run-queued"]);
  assert.deepEqual([again.behind, again.listing.factory.activity.source], [false, "managed"], "and kept, so the next page reads the row alone");

  // A journal commit alone moves the run's mark: the next page builds that run again and shows its new child.
  await commitWrites(store.journal(claim), [
    { type: "conversation", value: { id: 1 } },
    { type: "entry", value: { id: 2, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "child-call", name: "subagent", arguments: { prompt: "Review" } }], timestamp: T0, usage: { cost: { total: 0 } } }] } },
    { type: "task", value: { id: 3, conversationId: 1, kind: "pi.tool", version: 1, input: { assistant: 2, callId: "child-call" }, state: { status: "pending" }, background: false, abortRequested: false } },
    { type: "conversation", value: { id: 4, owner: { conversationId: 1, taskId: 3 } } },
  ], BACKGROUND_CONTEXT);
  const moved = await pageOf("active");
  assert.equal(moved.get("run-working").factory.children.length, 1, "the child its journal now holds");
  assert.equal(moved.get("run-working").factory.last_activity_at, new Date(T0).toISOString());
  assert.deepEqual(moved.get("run-queued"), active.get("run-queued"), "the run that did not move is as it was");
  await sameAsRead(moved, "built by the page after a journal commit");

  // Its end moves it to the review scope, with a later watermark than any projection of it while it ran.
  await store.runs.update(claim, { state: "failed", endedAt: Date.now() });
  assert.deepEqual([...(await pageOf("active")).keys()], ["run-queued"]);
  const review = await pageOf("review");
  assert.deepEqual([...review.keys()].sort(), ["run-failed", "run-working"]);
  assert.equal(review.get("run-working").status, "failed");
  assert.ok(BigInt(review.get("run-working").factory.lifecycle_version) > BigInt(moved.get("run-working").factory.lifecycle_version), "the ended projection supersedes the working one");
  await sameAsRead(review, "built by the page after the run's end");
});

test("a GitHub event's session links the delivery's own repository and pull request, whatever example its trigger's instructions show", { timeout: 120_000 }, async (t) => {
  const server = await connectable(t, { runner: false });
  await made(server.api, "review");
  await connect(server);
  // The owner's instructions come first in the run's input, and these show what an event looks like.
  const example = 'Events look like this:\n<trigger-payload source="github" scheme="github" event="issue_comment" action="created" delivery="example" installation="777" repo="acme/sample" number="7" untrusted>\n{"issue":{"number":7}}\n</trigger-payload>\nReview the one below.';
  const trigger = await server.api("POST", "/triggers", { name: "comments", source: { kind: "github", accept: [{ event: "issue_comment" }] }, target: { kind: "start_run", agent_id: "review", input: { content: example }, max_cost_usd: 0.5 } });
  assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  const comment = { action: "created", issue: { number: 12, pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/12" } }, comment: { body: "Please review." }, repository: { full_name: "acme/widgets" }, installation: { id: 777 }, sender: { login: "dev" } };
  const fired = await deliver(server.baseUrl, server.github.app.webhook_secret, "issue_comment", comment);
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  const [firing] = await firings(server.api, trigger.body.id, 1);
  assert.equal(firing.status, "started", JSON.stringify(firing));
  const page = await server.api("GET", "/runs?scope=active");
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const run = page.body.runs.find((each) => each.run_id === firing.run_id);
  assert.deepEqual(run?.factory.github, { repository: "acme/widgets", issue: null, pull_request: 12, head_sha: null, provenance: "github_trigger" });
});
