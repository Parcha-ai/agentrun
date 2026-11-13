// A template whose GitHub MCP tools need a permission the GitHub App's installation does not hold is warned of at apply,
// in plain words, on a server whose github MCP server runs on the App's tokens (auth github_app): release-notes'
// issue_write needs Issues: write. The warning is worked out from the permissions map GitHub gives for each installation
// (GET /app/installations/{id}), never from what the App's manifest asks for, and says what is missing, per tool and per
// account. A map that cannot be read says the check could not be made: it never guesses either way. The warning is one of
// the grants.<tool> family, beside a tool the server denies.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { appPermissionWarnings, TOOL_PERMISSIONS } from "../dist/template-github-permissions.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { scratch, serve, withEnv } from "./support.mjs";

const RELEASE_NOTES = { name: "release-notes", mcp: [{ server: "github", tools: ["list_releases", "pull_request_read", "issue_write"], required: false, allow: [], pin: {} }] };
const CODE_REVIEW = { name: "code-review", mcp: [{ server: "github", tools: ["pull_request_read", "pull_request_review_write", "add_comment_to_pending_review"], required: false, allow: [], pin: {} }] };
const READ_ISSUES = { installations: [{ account: "acme", permissions: { issues: "read", pull_requests: "write", metadata: "read" } }] };
const WRITE_ISSUES = { installations: [{ account: "acme", permissions: { issues: "write", pull_requests: "write", metadata: "read" } }] };
const WORDS = "mcp:github/issue_write needs Issues: write, and this server's GitHub App has Issues: read on acme, so GitHub refuses it: release-notes keeps its draft in its answer. The App's owner can add Issues: write to it on GitHub.";
const onApp = () => true;
const reads = (held) => async () => held;

test("a permissions map lacking issues: write warns for issue_write, by the template's name and the account; one that has it does not", async () => {
  assert.deepEqual(await appPermissionWarnings(RELEASE_NOTES, onApp, reads(READ_ISSUES)), [{ field: "grants.mcp:github/issue_write", reason: "not_allowed", message: WORDS }]);
  assert.equal((await appPermissionWarnings({ ...RELEASE_NOTES, name: "my-notes" }, onApp, reads(READ_ISSUES)))[0].message, WORDS.replace("release-notes", "my-notes"), "named from the template applied");
  assert.deepEqual(await appPermissionWarnings(RELEASE_NOTES, onApp, reads(WRITE_ISSUES)), [], "the installation holds Issues: write");
  // A permission the map has none of is said as none, and each short installation is named.
  const two = { installations: [{ account: "acme", permissions: { metadata: "read" } }, { account: "beta", permissions: { issues: "write" } }, { account: "gamma", permissions: { issues: "read" } }] };
  assert.match((await appPermissionWarnings(RELEASE_NOTES, onApp, reads(two)))[0].message, /has no Issues permission on acme, Issues: read on gamma, so GitHub refuses it/);
  // A template with no tool that needs more is never warned of, and GitHub is not asked.
  let asked = 0;
  assert.deepEqual(await appPermissionWarnings(CODE_REVIEW, onApp, async () => (asked++, READ_ISSUES)), []);
  assert.equal(asked, 0);
  // Only where the github MCP server runs on the App's tokens: a saved token of the owner's own is theirs to scope.
  assert.deepEqual(await appPermissionWarnings(RELEASE_NOTES, () => false, async () => (asked++, READ_ISSUES)), []);
  assert.equal(asked, 0);
  for (const [tool, need] of Object.entries(TOOL_PERMISSIONS)) assert.ok(need.permission && need.level, `${tool} names what it needs`);
});

test("a permissions map that could not be read says the check could not be made, and warns of neither a lack nor a fit", async () => {
  const warned = await appPermissionWarnings(RELEASE_NOTES, onApp, reads({ unreadable: "GitHub gave no permissions for the installation on acme (HTTP 502)" }));
  assert.deepEqual(warned, [{ field: "grants.mcp:github/issue_write", reason: "not_set_up_here", message: "mcp:github/issue_write needs Issues: write of the GitHub App, and this server could not check whether it has it (GitHub gave no permissions for the installation on acme (HTTP 502)): if release-notes can't use it, it keeps its draft in its answer." }]);
  assert.ok(!warned[0].message.includes("refuses"), "never says GitHub refuses it");
});

/** A server whose MCP server `github` is saved as `auth` (its row put in the store before the server starts: on the
 *  cutover a github_app server's save-time listing waits on the store registry's App token, github-tokens.test.mjs). */
async function savedGitHub(t, auth, options = {}) {
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  try {
    const tools = ["list_releases", "get_latest_release", "get_release_by_tag", "list_tags", "get_tag", "list_commits", "get_commit", "search_pull_requests", "pull_request_read", "get_file_contents", "search_issues", "get_label", "issue_write", "search_code", "get_repository_tree", "pull_request_review_write", "add_comment_to_pending_review"].map((name) => ({ name, description: `GitHub's ${name}.`, input_schema: { type: "object", properties: {}, additionalProperties: true } }));
    await store.mcp.put({ name: "github", url: "https://api.githubcopilot.com/mcp/", auth, tools });
  } finally {
    await store.close();
  }
  return serve(t, { data, ...options });
}

test("release-notes applied against an installation whose GitHub says Issues: read names it in the apply answer; with no App to ask it says it could not check; code-review and the owner's own token are not warned", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await savedGitHub(t, "github_app", { fauxGitHub: true });
  const notes = await api("POST", "/templates/release-notes/apply", { parameters: { repo: "acme/widgets" } });
  assert.equal(notes.status, 201, JSON.stringify(notes.body));
  assert.deepEqual(notes.body.warnings.filter((w) => w.field === "grants.mcp:github/issue_write"), [{ field: "grants.mcp:github/issue_write", reason: "not_allowed", message: WORDS.replace("on acme", "on faux-org") }]);
  const review = await api("POST", "/templates/code-review/apply", { parameters: { repo: "acme/widgets" } });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.ok(!review.body.warnings.some((w) => w.message.includes("GitHub App has")), JSON.stringify(review.body.warnings));
  const bare = await savedGitHub(t, "github_app");
  const unchecked = await bare.api("POST", "/templates/release-notes/apply", { parameters: { repo: "acme/widgets" } });
  assert.equal(unchecked.status, 201, JSON.stringify(unchecked.body));
  const said = unchecked.body.warnings.filter((w) => w.field === "grants.mcp:github/issue_write");
  assert.equal(said.length, 1, JSON.stringify(unchecked.body.warnings));
  assert.match(said[0].message, /could not check whether it has it \(this server has no GitHub App\)/);
  const own = await savedGitHub(t, "bearer");
  const mine = await own.api("POST", "/templates/release-notes/apply", { parameters: { repo: "acme/widgets" } });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.ok(!mine.body.warnings.some((w) => /GitHub App/.test(w.message)), "the owner's own token is theirs to scope");
});
