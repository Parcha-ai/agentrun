// Scope pins on the bundled templates: a template that reads text anyone can write (a pull request, a release, a form)
// pins every MCP tool that takes a scope argument to its parameters, reads as well as writes, and uses no free-text
// search that reaches past that scope. Otherwise a hostile pull request has a read fetch another repository the GitHub
// App is installed on and the review quote it where the pull request's author reads it. A repository is two
// parameters, owner and repo, because GitHub's tools take them apart. Composio's sends are pinned the same way, an
// argument the action also takes under another name (Slack's channel_id, Gmail's to) held absent.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { readCases } from "../dist/template-eval.js";
import { filledPins, readPackage, TEMPLATES_DIR } from "../dist/templates.js";
import { pinRefusal } from "../dist/tool-gate.js";

const pkg = (name) => readPackage(join(TEMPLATES_DIR, name));
const need = (p, toolkit) => p.mcp.find((m) => m.toolkit === toolkit);
const SCOPE = { owner: "${parameters.owner}", repo: "${parameters.repo}" };
// GitHub MCP tools that take owner and repo: a tool a GitHub template lists is one of these, or the test names it.
const OWNER_REPO = new Set(["pull_request_read", "get_file_contents", "get_repository_tree", "pull_request_review_write", "add_comment_to_pending_review", "list_releases", "get_latest_release", "get_release_by_tag", "list_tags", "get_tag", "list_commits", "get_commit", "list_pull_requests", "list_issues", "get_label", "issue_write"]);

for (const name of ["code-review", "release-notes"]) {
  test(`${name}: every GitHub tool is pinned to the owner and repo it was applied to, reads too, and no search is listed`, () => {
    const p = pkg(name);
    assert.equal(p.parameters.owner?.required, true, "owner is its own parameter");
    assert.equal(p.parameters.repo?.required, true, "repo is its own parameter");
    assert.ok(!new RegExp(p.parameters.repo.pattern, "u").test("acme/shop"), "repo is a name alone, never owner/name");
    const github = need(p, "github");
    const searches = github.tools.filter((tool) => tool.startsWith("search_"));
    assert.deepEqual(searches, [], "a free-text search reaches every repository the token does");
    for (const tool of github.tools) {
      assert.ok(OWNER_REPO.has(tool), `${tool} is a tool that takes owner and repo`);
      assert.deepEqual({ owner: github.pin[tool]?.owner, repo: github.pin[tool]?.repo }, SCOPE, `${tool} is pinned to the owner and repo`);
    }
    for (const trigger of p.triggers) {
      assert.deepEqual(trigger.source.accept.flatMap((rule) => rule.where.map((w) => w.in)), [["${parameters.owner}/${parameters.repo}"]], "its trigger keeps to the one repository");
    }
    assert.match(p.displayName, /\$\{parameters\.owner\}\/\$\{parameters\.repo\}/);
    // Applied on acme/shop, a read of acme/vault is refused by the gate before it is sent, and one of acme/shop is not.
    const pins = Object.fromEntries(filledPins([{ ...github, server: "github" }], { owner: "acme", repo: "shop" }).map(({ tool, pin }) => [tool, { pin }]));
    const read = "mcp:github/get_file_contents";
    assert.ok(pinRefusal(read, { owner: "acme", repo: "vault", path: "README.md" }, {}, pins), "another repository's file is refused");
    assert.ok(pinRefusal(read, { owner: "other", repo: "shop", path: "README.md" }, {}, pins), "another owner's is refused");
    assert.equal(pinRefusal(read, { owner: "acme", repo: "shop", path: "README.md" }, {}, pins), undefined, "its own repository's is not");
  });
}

test("code-review: its review write stays COMMENT only, beside the owner and repo", () => {
  const { pin } = need(pkg("code-review"), "github");
  assert.deepEqual(pin.pull_request_review_write, { ...SCOPE, method: ["create", "submit_pending", "delete_pending"], event: [null, "COMMENT"] });
});

test("release-notes: its one write still only opens an issue, on its own repository", () => {
  const { pin } = need(pkg("release-notes"), "github");
  assert.deepEqual(pin.issue_write, { ...SCOPE, method: "create" });
});

test("market-monitor: Slack and Gmail send only to the channel set, under any name the action takes it by", () => {
  const p = pkg("market-monitor");
  assert.deepEqual(need(p, "slack").pin, { SLACK_SEND_MESSAGE: { channel: "${parameters.channel}", channel_id: null } });
  assert.deepEqual(need(p, "gmail").pin, { GMAIL_SEND_EMAIL: { recipient_email: "${parameters.channel}", to: null, cc: null, bcc: null, extra_recipients: null, from_email: null } });
});

test("inbound-lead: HubSpot reads the lead and adds a note, never updates a contact; Slack sends to its one channel", () => {
  const p = pkg("inbound-lead");
  const hubspot = need(p, "hubspot");
  assert.equal(hubspot.source, "composio");
  assert.deepEqual(hubspot.tools, ["HUBSPOT_READ_CONTACT", "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA", "HUBSPOT_GET_COMPANY", "HUBSPOT_CREATE_NOTE"]);
  assert.equal(hubspot.required, false);
  assert.equal(hubspot.reason, "Reads the lead's contact and company, and adds a note to the lead's contact in your HubSpot. The note can't be limited to one contact yet.");
  assert.deepEqual(hubspot.pin, {}, "the note's destination is a per-run contact: the owner ticks it at apply");
  assert.equal(p.parameters.crm_score_property, undefined, "no score property to write: an update could overwrite any field");
  assert.deepEqual(need(p, "slack").pin, { SLACK_SEND_MESSAGE: { channel: "${parameters.slack_channel}", channel_id: null } });
});

test("each of them has a case where the untrusted text asks for another repository's file, and every case reads", () => {
  for (const [name, at] of [["code-review", "other-repo"], ["release-notes", "other-repo"]]) {
    const { cases } = readCases(join(TEMPLATES_DIR, name));
    const one = cases.find((c) => c.name === at);
    assert.ok(one, `${name} has evals/${at}`);
    assert.ok(one.graders.some((g) => g.type === "tool_used" && g.expect === "not_called" && g.args?.repo), `${name}/${at} checks no read of the other repository reached GitHub`);
  }
  for (const name of ["market-monitor", "inbound-lead"]) readCases(join(TEMPLATES_DIR, name));
});
