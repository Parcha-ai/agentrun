// A suggested agent's create when a step fails (suggestions.ts Suggestions.create), against the fake GitHub's API over HTTP
// (github-faux.ts): an apply refused after the push removes the branch and leaves the suggestion open, so a create sent
// again starts clean; a pull request GitHub refuses after the agent was made keeps the agent, and the next create opens
// the pull request alone; a file the repository already has stops the create before anything is written; and the one
// token each create mints holds contents and pull requests write on that one repository, and is revoked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestionsFor } from "./fixtures/faux-scout.mjs";

const { Suggestions, suggestionId, PULL_PERMISSIONS } = await import("../dist/suggestions.js");
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
  const store = settings();
  const s = new Suggestions({
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
    makeAgent,
  });
  await s.scan({ repo: REPO });
  await s.list({});
  const state = async () => (await fetch(`${gh.url}/_faux/state`)).json();
  const permissions = async (set) => (await fetch(`${gh.url}/_faux/permissions`, { method: "POST", body: JSON.stringify(set) })).json();
  return { s, store, state, permissions, minted, revoked, id: suggestionId(REPO, "ticket-triage") };
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
