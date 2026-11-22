// A suggested agent's create when a step fails (suggestions.ts Suggestions.create), against the fake GitHub's API over HTTP
// (github-faux.ts): an apply refused after the push removes the branch and leaves the suggestion open, so a create sent
// again starts clean; a pull request GitHub refuses after the agent was made keeps the agent, and the next create opens
// the pull request alone; a file the repository already has stops the create before anything is written; and the one
// token each create mints holds contents and pull requests write on that one repository, and is revoked. A create and a
// scan each claim their row in the store every server shares before they start: two servers asked at once make one agent,
// one pull request and one run. The package is kept before its apply and taken back when the apply refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestionsFor } from "./fixtures/faux-scout.mjs";

const { Suggestions, suggestionId, PULL_PERMISSIONS, CREATE_CLAIM_MS, checkSuggestion, packageFiles } = await import("../dist/suggestions.js");
const { applyImported } = await import("../dist/template-import.js");
const { startFauxGitHub, FAUX_GITHUB } = await import("../dist/github-faux.js");
const { mintInstallationToken } = await import("../dist/github.js");
const { ApiError } = await import("../dist/errors.js");

const REPO = FAUX_GITHUB.repositories[0];

/** The store's settings, in memory, as the store compares rows (their JSON). */
function settings() {
  const rows = new Map();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    rows,
    get: async (key) => (rows.has(key) ? structuredClone(rows.get(key)) : undefined),
    put: async (key, value) => void rows.set(key, structuredClone(value)),
    putIfAbsent: async (key, value) => { if (!rows.has(key)) rows.set(key, structuredClone(value)); return structuredClone(rows.get(key)); },
    replaceIf: async (key, was, value) => { if (!rows.has(key) || !same(rows.get(key), was)) return false; rows.set(key, structuredClone(value)); return true; },
    removeIf: async (key, was) => { if (!rows.has(key) || !same(rows.get(key), was)) return false; rows.delete(key); return true; },
    all: async ({ prefix }) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value), updatedAt: 0 })),
  };
}

/** The service over the fake GitHub, its scan already read; `makeAgent` as the test says. */
async function service(t, { makeAgent }) {
  const gh = await startFauxGitHub();
  t.after(() => gh.close());
  const minted = [];
  const revoked = [];
  const made = new Map();
  const store = settings();
  const deps = {
    settings: store,
    github: {
      view: () => ({ app_id: gh.app.id, slug: gh.app.slug, installations: [{ id: FAUX_GITHUB.installation, account: FAUX_GITHUB.account }] }),
      settingsUrl: () => gh.app.settingsUrl,
      api: gh.url,
      repoInstallation: async () => ({ id: FAUX_GITHUB.installation, account: FAUX_GITHUB.account, organization: true, permissions: { contents: "write", pull_requests: "write", metadata: "read" } }),
      tokenWith: async (id, repo, permissions) => {
        minted.push({ id, repo, permissions });
        const got = await mintInstallationToken(gh.url, gh.app.id, gh.app.pem, { installation: id, repo }, Date.now(), permissions);
        return got.ok ? { token: got.token, expiresAt: got.expires_at } : { unusable: got.message };
      },
      revokeToken: async (token) => { revoked.push(token); await fetch(`${gh.url}/installation/token`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }); },
    },
    scoutAgent: async () => "scout",
    startScan: async () => "run_1",
    readRun: async () => ({ status: "completed", output: { repository: REPO, commit: "", app: "An app.", suggestions: suggestionsFor() }, endedAt: Date.now() }),
    // The agents made here, by the template and commit they were made from (agentFrom reads them).
    makeAgent: async (id, origin, files) => {
      const agent = await makeAgent(id, origin, files);
      made.set(`${id}@${origin.sha}`, agent.agentId);
      return agent;
    },
    agentFrom: async (id, sha) => made.get(`${id}@${sha}`),
  };
  const s = new Suggestions(deps);
  await s.scan({ repo: REPO });
  await s.list({});
  const state = async () => (await fetch(`${gh.url}/_faux/state`)).json();
  const permissions = async (set) => (await fetch(`${gh.url}/_faux/permissions`, { method: "POST", body: JSON.stringify(set) })).json();
  return { s, deps, store, state, permissions, minted, revoked, id: suggestionId(REPO, "ticket-triage") };
}

test("an apply refused after the push removes the branch, makes nothing, and leaves the suggestion open for a clean retry", async (t) => {
  let applies = 0;
  const { s, state, id, minted, revoked } = await service(t, {
    makeAgent: async () => {
      applies++;
      if (applies === 1) throw new ApiError("agent_not_runnable", "This server holds no model key for the fast tier.");
      return { agentId: "agent_2", warnings: [] };
    },
  });
  await assert.rejects(s.create(id, {}), (error) => error.code === "agent_not_runnable");
  const after = await state();
  assert.deepEqual([Object.keys(after.branches), after.pulls.length], [["main"], 0], "the branch the push made is gone, and no pull request");
  assert.equal((await s.list({})).suggestions.find((x) => x.id === id).status, "open");
  assert.deepEqual(minted, [{ id: FAUX_GITHUB.installation, repo: REPO, permissions: { ...PULL_PERMISSIONS } }], "one token: the one repository, contents and pull requests write");
  assert.equal(revoked.length, 1, "and it was revoked");
  assert.equal((await s.list({})).suggestions.find((x) => x.id === id).status, "open");

  const created = await s.create(id, {});
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.created.agent_id, created.body.created.branch, created.body.created.pull_request.number], ["agent_2", "agentrun/ticket-triage", 1], "the retry reuses the branch name the failed one removed");
  assert.equal(revoked.length, 2);
});

test("a pull request GitHub refuses after the agent was made keeps the agent; the next create opens the pull request alone", async (t) => {
  let applies = 0;
  const { s, state, permissions, id } = await service(t, { makeAgent: async () => ({ agentId: `agent_${++applies}`, warnings: [] }) });
  await permissions({ pull_requests: "read" });
  await assert.rejects(s.create(id, {}), (error) => error.code === "github_failed" && error.extra.details.agent_id === "agent_1" && /was made, and its pull request was not opened/.test(error.message));
  const kept = (await s.list({})).suggestions.find((x) => x.id === id);
  assert.deepEqual([kept.status, kept.created.agent_id, kept.created.pull_request], ["created", "agent_1", null]);
  assert.match(kept.created.pull_error, /GitHub refused to open the pull request/);
  assert.ok((await state()).branches["agentrun/ticket-triage"], "the branch stays for the pull request");

  await permissions({ pull_requests: "write" });
  const opened = await s.create(id, {});
  assert.equal(opened.status, 201);
  assert.deepEqual([opened.body.created.agent_id, opened.body.created.pull_request.number, opened.body.created.pull_error], ["agent_1", 1, null]);
  assert.equal(applies, 1, "the agent was made once");
  const after = await state();
  assert.deepEqual([Object.keys(after.branches).sort(), after.pulls.length], [["agentrun/ticket-triage", "main"], 1], "one branch, one pull request");
  assert.equal((await s.create(id, {})).status, 200, "created: answered as it is");
});

test("a create whose agent was made but whose row could not be kept reuses that agent next time: one agent, one branch, one pull request", async (t) => {
  let applies = 0;
  const { s, store, state, id } = await service(t, { makeAgent: async () => ({ agentId: `agent_${++applies}`, warnings: [] }) });
  // The store refuses the write that would say the suggestion was created, once.
  const put = store.put;
  let refused = 0;
  store.put = async (key, value) => {
    if (value?.status === "created" && refused++ === 0) throw new Error("The store is read-only for a moment.");
    return put(key, value);
  };
  await assert.rejects(s.create(id, {}), /read-only for a moment/);
  assert.equal(applies, 1, "the agent was made");
  const kept = await store.get(`suggestions.item.${id}`);
  assert.deepEqual([kept.status, kept.creating, kept.pushed?.branch], ["open", undefined, "agentrun/ticket-triage"], "open, unclaimed, and naming its push");

  const again = await s.create(id, {});
  assert.equal(again.status, 201);
  assert.deepEqual([applies, again.body.created.agent_id, again.body.created.pull_request.number], [1, "agent_1", 1], "the same agent, never a second");
  const after = await state();
  assert.deepEqual([Object.keys(after.branches).sort(), after.pulls.length], [["agentrun/ticket-triage", "main"], 1], "one branch, one pull request");
  assert.equal((await store.get(`suggestions.item.${id}`)).pushed, undefined, "the push record is gone once created");
});

test("a file the repository already has stops the create before anything is written", async (t) => {
  const { s, store, state, id } = await service(t, { makeAgent: async () => assert.fail("no agent is made") });
  // The suggestion's client pointed at a file the fake repository has (src/support/inbox.ts), in its kept row.
  const row = await store.get(`suggestions.item.${id}`);
  row.suggestion.integration.path = "src/support/inbox.ts";
  await store.put(`suggestions.item.${id}`, row);
  const before = await state();
  await assert.rejects(s.create(id, {}), (error) => error.code === "github_file_exists" && error.extra.details.path === "src/support/inbox.ts" && /only adds files, so nothing was written/.test(error.message));
  assert.deepEqual(await state(), before, "nothing was written");
  assert.equal((await s.list({})).suggestions.find((x) => x.id === id).status, "open");
});

test("two servers sharing one store asked to create one suggestion at once: one agent, one branch, one pull request; the other is refused", async (t) => {
  let applies = 0;
  const { s, deps, store, state, id } = await service(t, { makeAgent: async () => ({ agentId: `agent_${++applies}`, warnings: [] }) });
  // A second server: its own Suggestions over the same store and the same GitHub.
  const other = new Suggestions(deps);
  const both = await Promise.allSettled([s.create(id, {}), other.create(id, {})]);
  assert.deepEqual(both.map((r) => (r.status === "fulfilled" ? r.value.status : r.reason.code)).sort(), [201, "home_busy"]);
  assert.equal(applies, 1, "one agent");
  const after = await state();
  assert.deepEqual([Object.keys(after.branches).sort(), after.pulls.length], [["agentrun/ticket-triage", "main"], 1], "one branch, one pull request");
  assert.equal((await store.get(`suggestions.item.${id}`)).creating, undefined, "the claim is taken off when the create ends");
});

test("a fresh claim refuses a create and a discard, and a scan leaves its row alone; one left by a server that stopped is taken over once old", async (t) => {
  const { s, deps, store, id } = await service(t, { makeAgent: async () => ({ agentId: "agent_1", warnings: [] }) });
  const key = `suggestions.item.${id}`;
  const row = await store.get(key);
  const held = { ...row, creating: { at: Date.now(), by: "another-server" } };
  await store.put(key, held);
  await assert.rejects(s.create(id, {}), (error) => error.code === "home_busy");
  await assert.rejects(s.discard(id), (error) => error.code === "home_busy");
  // A newer scan's answer holds the suggestion again: the row being created keeps its claim and what it was.
  const newer = new Suggestions({ ...deps, startScan: async () => "run_2", readRun: async () => ({ status: "completed", output: { repository: REPO, commit: "", app: "An app.", suggestions: suggestionsFor().map((x) => ({ ...x, title: `${x.title}, again` })) }, endedAt: Date.now() + 1 }) });
  await newer.scan({ repo: REPO });
  await newer.list({});
  assert.deepEqual(await store.get(key), held, "a scan never replaces a suggestion being created");

  await store.put(key, { ...row, creating: { at: Date.now() - CREATE_CLAIM_MS - 1_000, by: "a-stopped-server" } });
  assert.equal((await s.create(id, {})).status, 201, "an old claim is taken over");
  assert.equal((await store.get(key)).creating, undefined);
});

test("two scans of one repository sent at once start one run, the other told it is starting; a start that fails leaves the next one free", async (t) => {
  const { deps } = await service(t, { makeAgent: async () => assert.fail("no agent is made") });
  let starts = 0;
  let refuse = false;
  const slow = { ...deps, startScan: async () => {
    starts++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (refuse) throw new ApiError("agent_not_runnable", "This server holds no model key for the balanced tier.");
    return `run_${starts}`;
  } };
  const [a, b] = [new Suggestions(slow), new Suggestions(slow)];
  const other = "faux-org/other";
  const both = await Promise.allSettled([a.scan({ repo: other }), b.scan({ repo: other })]);
  assert.deepEqual(both.map((r) => (r.status === "fulfilled" ? r.value.status : r.reason.code)).sort(), [202, "home_busy"]);
  assert.equal(starts, 1, "one run");
  assert.equal((await deps.settings.get(`suggestions.scan.${other}`)).run_id, "run_1");
  assert.equal((await deps.settings.get(`suggestions.scan.${other}`)).starting, undefined, "the row is the scan's once it started");

  refuse = true;
  const third = "faux-org/third";
  await assert.rejects(a.scan({ repo: third }), (error) => error.code === "agent_not_runnable");
  assert.equal(await deps.settings.get(`suggestions.scan.${third}`), undefined, "a start that failed takes its reservation back");
  refuse = false;
  assert.equal((await a.scan({ repo: third })).status, 202);
});

test("a scan whose run stopped without ending (its cost cap, input asked, or paused) is waiting, not running: a new scan starts a new run", async (t) => {
  const { deps } = await service(t, { makeAgent: async () => assert.fail("no agent is made") });
  let starts = 0;
  const statuses = {};
  const s = new Suggestions({ ...deps, startScan: async () => `run_${++starts}`, readRun: async (id) => ({ status: statuses[id] ?? "running" }) });
  const other = "faux-org/other";
  const status = async () => (await s.list({ repo: other })).repositories[0].scan.status;
  const first = await s.scan({ repo: other });
  assert.equal(await status(), "running");
  assert.equal((await s.scan({ repo: other })).body.already_running, true, "running: the same run answers");
  statuses[first.body.run_id] = "input_required";
  assert.equal(await status(), "waiting");
  const again = await s.scan({ repo: other });
  assert.deepEqual([again.status, again.body.already_running, again.body.run_id, starts], [202, false, "run_2", 2], "waiting: a new run");
  assert.equal(await status(), "running");
  statuses.run_2 = "paused";
  assert.equal(await status(), "waiting");
});

test("a suggested agent's package is kept before its apply, registered after it, and taken back as it was when the apply refuses, never over an import made meanwhile", async () => {
  const s = checkSuggestion(suggestionsFor()[0]);
  const files = packageFiles(s);
  const id = `github:${REPO}/.agentrun/agents/ticket-triage`;
  const origin = (sha) => ({ source: `${id}@agentrun/ticket-triage`, sha, publisher: "faux-org" });
  const rows = new Map();
  const order = [];
  // The store stamps each put (importedAt), as it does.
  let stamp = 0;
  const importedTemplates = {
    list: async () => [...rows.values()],
    put: async (row) => { order.push(`put ${row.sha}`); rows.set(row.id, { ...row, importedAt: ++stamp }); },
    remove: async (gone) => { order.push("remove"); return rows.delete(gone); },
  };
  const registered = [];
  const deps = (apply) => ({ registry: { put: (pkg) => registered.push(pkg.id) }, store: { importedTemplates }, apply: async (pkg) => { order.push("apply"); return apply(pkg); } });
  const refuse = () => { throw new ApiError("agent_not_runnable", "This server holds no model key."); };

  await assert.rejects(applyImported(deps(refuse), id, origin("a".repeat(40)), files), (error) => error.code === "agent_not_runnable");
  assert.deepEqual([order, rows.size, registered], [[`put ${"a".repeat(40)}`, "apply", "remove"], 0, []], "refused with none before: removed, never registered");

  order.length = 0;
  assert.equal(await applyImported(deps(() => "agent_1"), id, origin("b".repeat(40)), files), "agent_1");
  assert.deepEqual([order, rows.get(id).sha, registered], [[`put ${"b".repeat(40)}`, "apply"], "b".repeat(40), [id]], "kept, then applied, then registered");

  order.length = 0;
  await assert.rejects(applyImported(deps(refuse), id, origin("c".repeat(40)), files));
  assert.deepEqual([order, rows.get(id).sha], [[`put ${"c".repeat(40)}`, "apply", `put ${"b".repeat(40)}`], "b".repeat(40)], "refused over an earlier package: that one is put back");

  // Someone imports the same template (POST /v2/templates/import) while this apply runs, which then refuses: their
  // import stands, neither removed nor replaced by the package before.
  order.length = 0;
  const meanwhile = async () => { await importedTemplates.put({ id, source: `${id}@main`, sha: "d".repeat(40), publisher: "faux-org", files: {} }); refuse(); };
  await assert.rejects(applyImported(deps(meanwhile), id, origin("e".repeat(40)), files));
  assert.deepEqual([order, rows.get(id).sha], [[`put ${"e".repeat(40)}`, "apply", `put ${"d".repeat(40)}`], "d".repeat(40)], "the import made meanwhile is left as it is");
  rows.delete(id);
  order.length = 0;
  const removedMeanwhile = async () => { rows.delete(id); refuse(); };
  await assert.rejects(applyImported(deps(removedMeanwhile), id, origin("f".repeat(40)), files));
  assert.deepEqual([order, rows.has(id)], [[`put ${"f".repeat(40)}`, "apply"], false], "a row deleted meanwhile is not put back");
});
