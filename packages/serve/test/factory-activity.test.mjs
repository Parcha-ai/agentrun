import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { factoryChildren, factoryGithub, factoryLastActivity, factoryObservation } from "../dist/factory-activity.js";
import { summaryOverStore } from "../dist/store-view.js";
import { launchBody } from "../dist/run-launch.js";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";

const identity = text => text;
const head = "a".repeat(40);
const base = { title: "Work", input: { content: "Work" }, place: { mode: "runner" } };
const triggered = (tag, body = {}) => ({ ...base, trigger: { id: "trigger-1", firing_key: "delivery-1" }, inputOrigin: { kind: "trigger", source: "github", trigger_id: "trigger-1", owner: false }, input: { content: `<trigger-payload source="github" repo="example/project" ${tag} untrusted>${JSON.stringify(body)}</trigger-payload>` } });

test("factory GitHub context requires a trusted structured source, never a prose URL or an owner-written wrapper", () => {
  assert.equal(factoryGithub({ ...base, input: { content: "Fix https://github.com/example/project/pull/42" } }, identity), null);
  const pr = triggered(`number="42" head_sha="${head}"`);
  const expected = { repository: "example/project", issue: null, pull_request: 42, head_sha: head, provenance: "github_trigger" };
  assert.deepEqual(factoryGithub(pr, identity), expected);
  assert.deepEqual(factoryGithub({ ...pr, repo: "example/project" }, identity), expected, "an explicit same-repo binding must not drop trusted PR/head metadata");
  assert.deepEqual(factoryGithub({ ...pr, repo: "another/project" }, identity), { repository: "another/project", issue: null, pull_request: null, head_sha: null, provenance: "launch" }, "conflicting sources never attach a PR from the other repo");
  for (const changed of [{ trigger: undefined }, { inputOrigin: undefined }, { inputOrigin: { ...pr.inputOrigin, trigger_id: "other" } }, { inputOrigin: { ...pr.inputOrigin, owner: true } }, { inputOrigin: { ...pr.inputOrigin, source: "webhook" } }]) assert.equal(factoryGithub({ ...pr, ...changed }, identity), null);
  assert.equal(factoryGithub({ ...pr, input: { content: '<trigger-payload source="github" untrusted>{"url":"https://github.com/example/project"}</trigger-payload>' } }, identity), null);
});

test("GitHub issue comments distinguish issue from PR only from structured payload; secrets and malformed repositories are withheld", () => {
  assert.deepEqual(factoryGithub(triggered('number="12"', { issue: { number: 12 } }), identity), { repository: "example/project", issue: 12, pull_request: null, head_sha: null, provenance: "github_trigger" });
  assert.deepEqual(factoryGithub(triggered('number="12"', { issue: { number: 12, pull_request: {} } }), identity), { repository: "example/project", issue: null, pull_request: 12, head_sha: null, provenance: "github_trigger" });
  const cut = triggered('number="12"');
  cut.input.content = cut.input.content.replace("{}", "{truncated");
  assert.equal(factoryGithub(cut, identity).issue, null);
  assert.equal(factoryGithub(cut, identity).pull_request, null);
  assert.equal(factoryGithub(triggered(`number="42" head_sha="${head}"`), text => text.replace("example/project", "[redacted]")), null);
  assert.equal(factoryGithub(triggered(`number="42" head_sha="${head}"`), text => text.replace(head, "[redacted]")).head_sha, null);
  for (const repo of ["../project", "example/..", "example/.", "example-/project", "example/project?token=secret", "example/project/path", "example/project\n"]) assert.equal(factoryGithub({ ...base, repo }, identity), null, repo);
});

test("factory observation distinguishes transport heartbeat, runner lease and missing SDK reporting", async () => {
  const connector = { last_seen: T0, expires: T0 + 120_000, revoked: false };
  const store = { settings: { get: async () => connector } };
  const launch = { ...base, native: { remote: { connector_id: "connector-1" } } };
  assert.deepEqual(await factoryObservation(store, launch, true, T0 + 50_000, () => T0 + 50_000), { basis: "connector", status: "offline", last_seen_at: new Date(T0).toISOString() }, "a live runner cannot conceal a disconnected native source");
  assert.equal((await factoryObservation(store, launch, false, undefined, () => T0 + 10_000)).status, "current");
  connector.revoked = true;
  assert.equal((await factoryObservation(store, launch, true, T0, () => T0)).status, "revoked");
  assert.deepEqual(await factoryObservation({}, { ...base, sdk: { runtime: "codex-sdk" } }, true, T0, () => T0), { basis: "unreported", status: "unreported", last_seen_at: null });
  assert.deepEqual(await factoryObservation({}, base, false, T0, () => T0), { basis: "runner", status: "unreported", last_seen_at: new Date(T0).toISOString() });
  await assert.rejects(factoryObservation({ settings: { get: async () => { throw new Error("store unavailable"); } } }, launch, true, T0, () => T0), /store unavailable/, "a failed read is not a disconnected source");
  assert.equal(factoryLastActivity({ entries: [], tasks: [] }), null);
  assert.equal(factoryLastActivity({ entries: [{ data: { at: T0 } }, { model: [{ timestamp: T0 + 1000 }] }, { data: { at: Infinity } }], tasks: [] }), new Date(T0 + 1000).toISOString());
});

test("only a recorded active durable subagent ownership edge creates a child identity; labels are redacted before truncation", async () => {
  const secret = "s".repeat(200);
  const records = {
    entries: [{ id: 2, model: [{ content: [{ type: "toolCall", name: "subagent", id: "call-1", arguments: { prompt: `Review ${secret} next.` } }] }] }, { id: 3, model: [{ content: [{ type: "toolCall", name: "native.tool", id: "nested", arguments: {} }] }] }],
    tasks: [{ id: 10, kind: "pi.tool", state: { status: "running" }, input: { assistant: 2, callId: "call-1" } }, { id: 11, kind: "pi.tool", state: { status: "terminal" }, input: { assistant: 2, callId: "call-1" } }, { id: 12, kind: "pi.tool", state: { status: "running" }, input: { assistant: 3, callId: "nested" } }],
  };
  const conversations = [{ id: 1 }, { id: 20, owner: { conversationId: 1, taskId: 10 } }, { id: 21, owner: { conversationId: 1, taskId: 11 } }, { id: 22, owner: { conversationId: 1, taskId: 12 } }, { id: 23, owner: { conversationId: 1, taskId: 999 } }];
  const store = { readJournal: () => ({ scanConversations: async () => ({ items: conversations }) }) };
  const children = await factoryChildren(store, "run-1", records, text => text.replace(secret, "[redacted]"));
  assert.deepEqual(children, [{ id: "run-1:conversation:20", conversation_id: 20, parent_call_id: "call-1", status: "active", label: "Review [redacted] next." }]);
  assert.deepEqual(await factoryChildren(store, "run-1", records, text => text.replace("call-1", "[redacted]")), []);
});

test("scoped summaries retain SDK observer semantics and snapshot lifecycle versions without changing ordinary summaries", async t => {
  const { store, clock } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "sdk-run", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody({ ...base, sdk: { runtime: "codex-sdk", instructions: "Work." } }) });
  const claim = await store.claim("sdk-run", "runner-test", { leaseMs: 60_000 });
  const deps = { origin: "https://run.test", serverSecrets: () => [], factory: true, now: () => clock.now };
  const active = await summaryOverStore(store, "sdk-run", deps);
  assert.equal(active.factory.source, "sdk");
  assert.equal(active.factory.control, "observed");
  assert.deepEqual(active.factory.controls, { stop: false, cancel: false, approve: false });
  assert.equal(active.factory.observation.status, "unreported");
  assert.equal(active.factory.last_activity_at, null);
  assert.match(active.factory.lifecycle_version, /^\d+$/);
  await store.runs.update(claim, { state: "ended", outcome: "escalated", endedAt: clock.now });
  const ended = await summaryOverStore(store, "sdk-run", deps);
  assert.ok(BigInt(ended.factory.lifecycle_version) > BigInt(active.factory.lifecycle_version));
  assert.deepEqual(ended.factory.children, []);
  assert.equal("factory" in await summaryOverStore(store, "sdk-run", { ...deps, factory: false }), false);
});

test("factory lifecycle watermark and run status share one snapshot across a concurrent end", async t => {
  const { store, file, clock } = await storeOn(t);
  const { store: writer } = await storeOn(t, { file, clock, role: "runner" });
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody(base) });
  const claim = await writer.claim("run-1", "runner-test", { leaseMs: 60_000 });
  const before = await store.runs.changesHead();
  let ended = false;
  const interleaved = new Proxy(store, { get(target, key) {
    if (key !== "snapshot") { const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; }
    return callback => target.snapshot(snapshot => callback(new Proxy(snapshot, { get(snap, name) {
      if (name !== "runs") { const value = Reflect.get(snap, name, snap); return typeof value === "function" ? value.bind(snap) : value; }
      return new Proxy(snap.runs, { get(runs, method) {
        if (method !== "get") return Reflect.get(runs, method, runs);
        return async (...args) => {
          const row = await runs.get(...args);
          if (!ended) {
            ended = true;
            await writer.runs.update(claim, { state: "ended", outcome: "escalated", endedAt: clock.now });
          }
          return row;
        };
      } });
    } })));
  } });
  const deps = { origin: "https://run.test", serverSecrets: () => [], factory: true, now: () => clock.now };
  const during = await summaryOverStore(interleaved, "run-1", deps);
  assert.equal(during.factory.lifecycle_version, before, "the version cannot see the end that the status did not see");
  assert.notEqual(during.status, "completed");
  const after = await summaryOverStore(store, "run-1", deps);
  assert.equal(after.status, "completed");
  assert.ok(BigInt(after.factory.lifecycle_version) > BigInt(before));
});

test("a stopped continuable turn stays visible without advertising cancel on its already-ended store row", async t => {
  const { store } = await storeOn(t);
  await agentWithRevision(store);
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launchBody(base) });
  const claim = await store.claim("run-1", "runner-test", { leaseMs: 60_000 });
  await commitWrites(store.journal(claim), [
    { type: "conversation", value: { id: 1 } },
    { type: "entry", value: { id: 2, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "tool_use", content: [{ type: "toolCall", id: "child-call", name: "subagent", arguments: { prompt: "Review" } }], timestamp: T0, usage: { cost: { total: 0 } } }] } },
    { type: "task", value: { id: 3, conversationId: 1, kind: "pi.tool", version: 1, input: { assistant: 2, callId: "child-call" }, state: { status: "pending" }, background: false, abortRequested: false } },
    { type: "conversation", value: { id: 4, owner: { conversationId: 1, taskId: 3 } } },
  ], BACKGROUND_CONTEXT);
  const deps = { origin: "https://run.test", serverSecrets: () => [], factory: true };
  assert.equal((await summaryOverStore(store, "run-1", deps)).factory.children.length, 1);
  await store.runs.update(claim, { state: "stopped", outcome: "stopped", endedAt: T0 });
  const summary = await summaryOverStore(store, "run-1", deps);
  assert.equal(summary.status, "input_required");
  assert.deepEqual(summary.factory.controls, { stop: false, cancel: false, approve: false });
  assert.deepEqual(summary.factory.children, [], "an unfinished journal task on a stopped turn does not establish active child execution");
});
