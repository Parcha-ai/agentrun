// A template whose GitHub MCP tools need a permission Connect GitHub's App does not ask for (its manifest's
// APP_PERMISSIONS) is warned of at apply, in plain words, on a server whose github MCP server runs on the App's tokens
// (auth github_app): release-notes' issue_write needs issues: write, and the App reads issues only. The warning is
// worked out from the manifest's own permissions and a table of what each tool needs, so the two can't drift: widen the
// manifest and it goes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { APP_PERMISSIONS } from "../dist/github-connection.js";
import { appPermissionWarnings, TOOL_PERMISSIONS } from "../dist/template-github-permissions.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { scratch, serve, withEnv } from "./support.mjs";

const RELEASE_NOTES = { name: "release-notes", mcp: [{ server: "github", tools: ["list_releases", "pull_request_read", "issue_write"], required: false, allow: [], pin: {} }] };
const CODE_REVIEW = { name: "code-review", mcp: [{ server: "github", tools: ["pull_request_read", "pull_request_review_write", "add_comment_to_pending_review"], required: false, allow: [], pin: {} }] };
const WORDS = "This server's GitHub App can read issues but not write them: release-notes keeps its draft in its answer.";

test("a template granted a GitHub tool the App's manifest does not allow is warned of in words, by the template's name; one within the manifest is not; a widened manifest warns of none", () => {
  const onApp = () => true;
  const warned = appPermissionWarnings(RELEASE_NOTES, onApp);
  assert.deepEqual(warned, [{ field: "grants.mcp:github/issue_write", reason: "not_set_up_here", message: WORDS }]);
  assert.deepEqual(appPermissionWarnings(CODE_REVIEW, onApp), [], "pull_requests: write is in the manifest");
  assert.deepEqual(appPermissionWarnings({ ...RELEASE_NOTES, name: "my-notes" }, onApp)[0].message, WORDS.replace("release-notes", "my-notes"), "named from the template applied");
  // The mutant: a manifest that asks for issues: write warns of nothing.
  assert.deepEqual(appPermissionWarnings(RELEASE_NOTES, onApp, { ...APP_PERMISSIONS, issues: "write" }), []);
  // Only where the github MCP server runs on the App's tokens: a saved token of the owner's own is theirs to scope.
  assert.deepEqual(appPermissionWarnings(RELEASE_NOTES, () => false), []);
  // Every tool the table names asks for a permission the manifest knows.
  for (const [tool, need] of Object.entries(TOOL_PERMISSIONS)) assert.ok(need.permission in APP_PERMISSIONS, `${tool} needs ${need.permission}, which the manifest names`);
});

/** A server whose MCP server `github` is saved as `auth` (its row put in the store before the server starts: on the
 *  cutover a github_app server's save-time listing waits on the store registry's App token, github-tokens.test.mjs). */
async function savedGitHub(t, auth) {
  const data = join(await scratch(t), "agents");
  await mkdir(data, { recursive: true });
  const store = await openSqliteStore({ dataDir: data, role: "server" });
  try {
    const tools = ["list_releases", "get_latest_release", "get_release_by_tag", "list_tags", "get_tag", "list_commits", "get_commit", "search_pull_requests", "pull_request_read", "get_file_contents", "search_issues", "get_label", "issue_write", "search_code", "get_repository_tree", "pull_request_review_write", "add_comment_to_pending_review"].map((name) => ({ name, description: `GitHub's ${name}.`, input_schema: { type: "object", properties: {}, additionalProperties: true } }));
    await store.mcp.put({ name: "github", url: "https://api.githubcopilot.com/mcp/", auth, tools });
  } finally {
    await store.close();
  }
  return serve(t, { data });
}

test("release-notes applied where the github MCP server runs on the App's tokens says, in its apply answer, that its draft stays in its answer; code-review is not warned, nor release-notes on the owner's own token", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const { api } = await savedGitHub(t, "github_app");
  const notes = await api("POST", "/templates/release-notes/apply", { parameters: { repo: "acme/widgets" } });
  assert.equal(notes.status, 201, JSON.stringify(notes.body));
  assert.deepEqual(notes.body.warnings.filter((w) => w.field === "grants.mcp:github/issue_write"), [{ field: "grants.mcp:github/issue_write", reason: "not_set_up_here", message: WORDS }]);
  const review = await api("POST", "/templates/code-review/apply", { parameters: { repo: "acme/widgets" } });
  assert.equal(review.status, 201, JSON.stringify(review.body));
  assert.ok(!review.body.warnings.some((w) => w.message.includes("GitHub App can")), JSON.stringify(review.body.warnings));
  const own = await savedGitHub(t, "bearer");
  const mine = await own.api("POST", "/templates/release-notes/apply", { parameters: { repo: "acme/widgets" } });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.ok(!mine.body.warnings.some((w) => w.message.includes("GitHub App can")), "the owner's own token is theirs to scope");
});
