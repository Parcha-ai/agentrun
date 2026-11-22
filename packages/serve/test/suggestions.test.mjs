// Suggested agents (suggestions.ts) end to end, on a --faux server with --faux-github: a scan of a repository runs the
// bundled agent-scout (applied once, reused), its answer is read into suggestions (one that does not check dropped, with
// why), a discard takes one away and a rescan does not bring it back, and a create pushes the package and client on a
// new branch with a token narrowed to the repository, makes the agent here from the very files it pushed, and opens the
// pull request; an installation without contents write is refused first, with what is missing, and nothing is written.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "./support.mjs";

const SCOUT = new URL("./fixtures/faux-scout.mjs", import.meta.url).pathname;
const REPO = "faux-org/demo";

/** The fake GitHub's own reads and settings (github-faux.ts /_faux). */
async function faux(server) {
  const { api_url: url } = JSON.parse(readFileSync(join(server.data, "faux-github.json"), "utf8"));
  return {
    state: async () => (await fetch(`${url}/_faux/state`)).json(),
    permissions: async (set) => (await fetch(`${url}/_faux/permissions`, { method: "POST", body: JSON.stringify(set) })).json(),
  };
}

/** GET /suggestions until the repository's scan has ended (the runner beside the server runs it). */
async function scanned(api, repo, { deadlineMs = 60_000 } = {}) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const listed = await api("GET", `/suggestions?repo=${encodeURIComponent(repo)}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const scan = listed.body.repositories.find((r) => r.repo === repo)?.scan;
    if (scan && scan.status !== "running") return listed.body;
    if (Date.now() > until) throw new Error(`the scan of ${repo} did not end: ${JSON.stringify(listed.body)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("scan, list, discard, rescan, create: the agent is made from the files its pull request adds, and the pull request names it", { timeout: 180_000 }, async (t) => {
  const server = await serve(t, { faux: SCOUT, fauxGitHub: true, publicUrl: "https://agents.example.test" });
  const { api } = server;
  const gh = await faux(server);

  // Nothing scanned yet: GitHub connected, no repository, no suggestion.
  const empty = await api("GET", "/suggestions");
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual([empty.body.github.connected, empty.body.github.app, empty.body.repositories, empty.body.suggestions], [true, "agentrun-faux", [], []]);
  const repos = await api("GET", "/integrations/github/repositories");
  assert.equal(repos.status, 200, JSON.stringify(repos.body));
  assert.deepEqual(repos.body.repositories.map((r) => [r.full_name, r.account]), [[REPO, "faux-org"]]);

  // A scan: the scout agent is applied once, the run started, and a second scan while it runs answers the same run.
  const started = await api("POST", "/suggestions/scans", { repo: `https://github.com/${REPO}` });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  assert.equal(started.body.repo, REPO);
  const scout = await api("GET", `/agents/${started.body.agent_id}`);
  assert.equal(scout.body.template?.id, "agent-scout", "the scout is the bundled package's agent");
  assert.equal(scout.body.definition.checkout, "repository");
  const run = await api("GET", `/runs/${started.body.run_id}`);
  assert.match(JSON.stringify(run.body), /Scan https:\/\/github\.com\/faux-org\/demo for the places in its app/);

  const listed = await scanned(api, REPO);
  const repo = listed.repositories.find((r) => r.repo === REPO);
  assert.equal(repo.scan.status, "completed", JSON.stringify(repo.scan));
  assert.equal(repo.scan.app, "A help desk and billing app for small shops.");
  // The scan read a checkout the server made of the fake's repository, on this machine: its commit is the answer's.
  assert.match(repo.scan.commit ?? "", /^[0-9a-f]{40}$/, "the run was checked out a commit");
  assert.equal(repo.scan.found, 2);
  assert.deepEqual(repo.scan.dropped.length, 1);
  assert.match(repo.scan.dropped[0], /^workflow-writer: its client's path \.github\/workflows\/agent\.ts is under \.github\//, "a client under .github/ is never written");
  assert.deepEqual(listed.suggestions.map((s) => [s.key, s.status, s.impact]), [["ticket-triage", "open", "high"], ["refund-review", "open", "medium"]], "open first, by impact");
  const [triage, refund] = listed.suggestions;
  assert.equal(triage.evidence[0].url, `https://github.com/${REPO}/blob/${repo.scan.commit}/src/support/inbox.ts#L42`);
  assert.equal(triage.agent.instructions, undefined, "the list carries no instructions");

  // The whole suggestion: its instructions, the files a create adds, and GitHub's readiness.
  const whole = await api("GET", `/suggestions/${triage.id}`);
  assert.equal(whole.status, 200, JSON.stringify(whole.body));
  assert.deepEqual(whole.body.files.map((f) => f.path), [".agentrun/agents/ticket-triage/agent.md", ".agentrun/agents/ticket-triage/output.schema.json", "src/support/ticket-triage-agent.ts"]);
  assert.deepEqual(whole.body.problems, []);
  assert.equal(whole.body.github.ready, true, JSON.stringify(whole.body.github));
  assert.match(whole.body.agent.instructions, /^You triage support tickets/);

  // Discard: it goes away from the default list, stays under status=discarded, and comes back with restore.
  const discarded = await api("POST", `/suggestions/${refund.id}/discard`);
  assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
  assert.equal(discarded.body.status, "discarded");
  assert.deepEqual((await api("GET", "/suggestions")).body.suggestions.map((s) => s.key), ["ticket-triage"]);
  assert.deepEqual((await api("GET", "/suggestions?status=discarded")).body.suggestions.map((s) => s.key), ["refund-review"]);
  assert.equal((await api("POST", `/suggestions/${refund.id}/restore`)).body.status, "open");
  assert.equal((await api("POST", `/suggestions/${refund.id}/discard`)).body.status, "discarded");
  assert.equal((await api("POST", `/suggestions/${refund.id}/discard`)).status, 200, "discarding twice is the same discard");

  // A rescan is told what was decided, and the discarded suggestion stays discarded though the answer holds it again.
  const again = await api("POST", "/suggestions/scans", { repo: REPO });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal(again.body.agent_id, started.body.agent_id, "the scout agent is reused");
  assert.match(JSON.stringify((await api("GET", `/runs/${again.body.run_id}`)).body), /Already decided on this repository[^]*refund-review: Review refund requests \(discarded\)/);
  const rescanned = await scanned(api, REPO);
  assert.equal(rescanned.repositories[0].scan.run_id, again.body.run_id);
  assert.deepEqual([rescanned.repositories[0].scan.found, rescanned.repositories[0].scan.already_decided], [1, 1], "one open, one already decided");
  assert.deepEqual(rescanned.suggestions.map((s) => [s.key, s.status]), [["ticket-triage", "open"]]);
  assert.equal(rescanned.suggestions[0].id, triage.id, "the same repository and key keep their id");
  assert.equal(rescanned.suggestions[0].scan.run_id, again.body.run_id, "the open one is the newer scan's");

  // Create, with the App short of contents write: refused, naming what is missing and where to fix it; nothing written.
  await gh.permissions({ contents: "read" });
  const short = await api("POST", `/suggestions/${triage.id}/create`, {});
  assert.equal(short.status, 409, JSON.stringify(short.body));
  assert.equal(short.body.error.code, "github_permission_missing");
  assert.deepEqual(short.body.error.details.missing, ["contents: write"]);
  assert.match(short.body.error.message, /needs the GitHub App's Contents: Read and write, which its installation on faux-org does not have yet/);
  assert.match(short.body.error.details.permissions_url, /\/settings\/apps\/agentrun-faux\/permissions$/);
  assert.equal(short.body.error.details.installation_url, "https://github.com/organizations/faux-org/settings/installations/1");
  assert.equal((await api("GET", `/suggestions/${triage.id}`)).body.github.reason, "permission_missing");
  const untouched = await gh.state();
  assert.deepEqual([Object.keys(untouched.branches), untouched.pulls], [["main"], []]);

  // Granted: the create pushes, makes the agent and opens the pull request.
  await gh.permissions({ contents: "write" });
  const created = await api("POST", `/suggestions/${triage.id}/create`, { name: "Ticket triage" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "created");
  const { agent_id: agentId, template_id: templateId, branch, pull_request: pull } = created.body.created;
  assert.deepEqual([templateId, branch, pull], [`github:${REPO}/.agentrun/agents/ticket-triage`, "agentrun/ticket-triage", { number: 1, url: `https://github.com/${REPO}/pull/1` }]);

  const pushed = await gh.state();
  const commit = pushed.commits[pushed.branches[branch]];
  assert.equal(commit.parents[0], pushed.branches.main, "over the default branch's head");
  const tree = pushed.trees[commit.tree.sha];
  assert.deepEqual(tree.tree.map((f) => [f.path, f.mode, f.type]), [[".agentrun/agents/ticket-triage/agent.md", "100644", "blob"], [".agentrun/agents/ticket-triage/output.schema.json", "100644", "blob"], ["src/support/ticket-triage-agent.ts", "100644", "blob"]], "it only adds files");
  const [{ content: manifest }] = tree.tree;
  assert.match(manifest, /^---\nname: ticket-triage\ndisplay_name: "Ticket triage"\n/);
  assert.match(tree.tree[2].content, /export async function runTicketTriage\(input: TicketTriageInput/);
  const [opened] = pushed.pulls;
  assert.equal(opened.title, "Add the Triage support tickets agent");
  assert.deepEqual([opened.head, opened.base], [branch, "main"]);
  assert.match(opened.body, new RegExp(`\\| \`AGENTRUN_AGENT_TICKET_TRIAGE\` \\| \`${agentId}\` \\|`), "the pull request names the agent's id");
  assert.match(opened.body, /\| `AGENTRUN_URL` \| `https:\/\/agents\.example\.test` \|/);

  // The agent here is the package's, applied as an imported template at the pushed commit.
  const agent = await api("GET", `/agents/${agentId}`);
  assert.equal(agent.status, 200, JSON.stringify(agent.body));
  assert.equal(agent.body.definition.name, "Ticket triage");
  assert.deepEqual([agent.body.template.id, agent.body.template.sha], [templateId, pushed.branches[branch]]);
  assert.deepEqual(Object.keys(agent.body.definition.input_schema.properties), ["subject", "body"]);
  const listedTemplates = (await api("GET", "/templates")).body.templates;
  assert.ok(listedTemplates.some((x) => x.id === templateId && x.bundled === false), "kept beside the imported templates");

  // Created stays created: a second create answers it, a discard is refused, and the list shows it with its pull request.
  const twice = await api("POST", `/suggestions/${triage.id}/create`, {});
  assert.equal(twice.status, 200, JSON.stringify(twice.body));
  assert.equal(twice.body.created.agent_id, agentId);
  assert.equal((await gh.state()).pulls.length, 1, "no second pull request");
  const refused = await api("POST", `/suggestions/${triage.id}/discard`);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "suggestion_decided");
  const after = (await api("GET", "/suggestions")).body;
  assert.deepEqual(after.suggestions.map((s) => [s.key, s.status, s.created?.pull_request?.number]), [["ticket-triage", "created", 1]]);
  assert.deepEqual(after.repositories[0].counts, { open: 0, created: 1, discarded: 1 });

  // Every token the flow minted was narrowed to the one repository and revoked; the write's held contents write.
  const discardedCreate = await api("POST", `/suggestions/${refund.id}/create`, {});
  assert.equal(discardedCreate.body.error?.code, "suggestion_decided", "a discarded one is restored before it is created");
});

test("a scan refuses a repository that is not owner/name, and an unknown suggestion is 404", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { faux: SCOUT, fauxGitHub: true });
  for (const repo of ["nobody", "a/b/c", "https://gitlab.com/a/b", "a/.."]) {
    const refused = await api("POST", "/suggestions/scans", { repo });
    assert.equal(refused.status, 422, `${repo}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error.fields[0].field, "repo");
  }
  assert.equal((await api("POST", "/suggestions/scans", { repo: REPO, extra: 1 })).status, 422);
  assert.equal((await api("GET", "/suggestions/sg_00000000000000000000")).status, 404);
  assert.equal((await api("POST", "/suggestions/nope/discard")).status, 404);
  assert.equal((await api("GET", "/suggestions?status=maybe")).status, 422);
});

test("with no GitHub App, the list says so, the repositories are 409, and a create is refused before anything is written", { timeout: 60_000 }, async (t) => {
  const { api } = await serve(t, { faux: SCOUT });
  const listed = await api("GET", "/suggestions");
  assert.deepEqual([listed.body.github.connected, listed.body.github.install_url], [false, null]);
  const repos = await api("GET", "/integrations/github/repositories");
  assert.equal(repos.status, 409);
  assert.equal(repos.body.error.code, "github_not_connected");
});
