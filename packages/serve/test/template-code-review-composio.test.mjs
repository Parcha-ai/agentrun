// code-review-composio: code-review on a server that reaches GitHub through Composio alone (a hosted install: no GitHub
// App, no checkout, no shell). A package lists each toolkit once, so it is a sibling package, and
// scripts/code-review-composio.mjs keeps the two one review: rules and findings schema byte-equal, the three skill files
// code-review's with a declared table of replacements, each old passage found exactly once.
import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { readPackages } from "../dist/templates.js";
import { differences, REPLACED, replaced, SHARED, SIBLING, SOURCE } from "../scripts/code-review-composio.mjs";
import { scratch } from "./support.mjs";

const TOOLS = [
  "GITHUB_GET_A_PULL_REQUEST",
  "GITHUB_LIST_PULL_REQUESTS_FILES",
  "GITHUB_GET_REPOSITORY_CONTENT",
  "GITHUB_LIST_REVIEW_COMMENTS_ON_A_PULL_REQUEST",
  "GITHUB_LIST_REVIEWS_FOR_A_PULL_REQUEST",
  "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST",
];
const SCOPE = { owner: "${parameters.owner}", repo: "${parameters.repo}" };
/** The GitHub App server's tool names, which code-review's skill calls and this package does not have. */
const APP_TOOLS = /pull_request_read|get_file_contents|pull_request_review_write|add_comment_to_pending_review|get_review_comments|submit_pending|delete_pending/;
const filesUnder = (root, dir) => readdirSync(join(root, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name))).sort();

test("code-review-composio's rules and findings schema are code-review's byte for byte, and its three skill files are code-review's after the declared replacements, nothing else", () => {
  assert.deepEqual(differences(), []);
  const declared = [...SHARED, ...Object.keys(REPLACED)].sort();
  assert.deepEqual([...filesUnder(SOURCE, "skills"), ...filesUnder(SOURCE, "rules")].sort(), declared, "every file of code-review's skill and rules is shared or replaced, so a new one can't be left out");
  assert.deepEqual([...filesUnder(SIBLING, "skills"), ...filesUnder(SIBLING, "rules")].sort(), declared, "and the sibling holds no other");
});

test("drift fails: an old passage code-review no longer has, or has twice, is refused by name, and any other byte changed on either side is a difference", async (t) => {
  const file = "skills/review/SKILL.md";
  const source = readFileSync(join(SOURCE, file), "utf8");
  const [old] = REPLACED[file][0];
  assert.throws(() => replaced(file, source.replace(old, old.toUpperCase())), /replacement 0 expects its old passage exactly once in code-review's file, and it occurs nowhere/);
  assert.throws(() => replaced(file, `${source}\n${old}\n`), /replacement 0 expects its old passage exactly once in code-review's file, and it occurs more than once/);

  const root = await scratch(t);
  const [src, sib] = [join(root, "code-review") + "/", join(root, "code-review-composio") + "/"];
  cpSync(SOURCE, src, { recursive: true });
  cpSync(SIBLING, sib, { recursive: true });
  assert.deepEqual(differences(sib, src), [], "the copies agree");
  writeFileSync(join(src, "rules/CODEREVIEW.md"), `${readFileSync(join(src, "rules/CODEREVIEW.md"), "utf8")}\n- one more rule\n`);
  writeFileSync(join(sib, "skills/review/DEEP.md"), readFileSync(join(sib, "skills/review/DEEP.md"), "utf8").replace("## The change", "## The change "));
  assert.deepEqual(differences(sib, src), ["rules/CODEREVIEW.md: differs from code-review's", "skills/review/DEEP.md: differs from code-review's after this script's replacements"]);
});

test("its skill calls only the Composio tools the package lists, posts in one COMMENT review with inline comments, and keeps code-review's 8 KB guides", () => {
  const pkg = readPackages().find((p) => p.name === "code-review-composio");
  for (const [path, text] of Object.entries(pkg.skills).filter(([path]) => path.endsWith(".md"))) {
    assert.doesNotMatch(text, APP_TOOLS, `${path}: no GitHub App tool`);
    assert.ok(Buffer.byteLength(text) <= 8192, `${path}: at most 8 KB, read whole on every review`);
    for (const named of text.matchAll(/\bGITHUB_[A-Z_]+\b/g)) assert.ok(TOOLS.includes(named[0]), `${path}: ${named[0]} is a tool the package lists`);
  }
  const skill = pkg.skills["review/SKILL.md"];
  assert.match(skill, /One `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST`:\n`pull_number`, `commit_id: <head_sha>`, `event: COMMENT`, `comments` with one entry per merged finding/);
  assert.match(skill, /\(`path`, `line`, `side: RIGHT`, and `start_line` with `start_side: RIGHT`/);
  assert.match(skill, /There is none here: no shell, no `repo\/`/);
  assert.match(skill, /Their `tools`: `\["read", "mcp:github\/GITHUB_LIST_PULL_REQUESTS_FILES",\n"mcp:github\/GITHUB_GET_REPOSITORY_CONTENT"\]`/);
});

test("the package: no computer and no checkout, one required Composio GitHub need with every tool held to the repository and the review held to COMMENT, and a trigger on each new pull request there", () => {
  const pkg = readPackages().find((p) => p.name === "code-review-composio");
  const review = readPackages().find((p) => p.name === "code-review");
  assert.deepEqual([pkg.tools, pkg.computer, pkg.checkout, pkg.toolPolicy], [["read", "subagent"], ["none"], undefined, undefined]);
  assert.deepEqual([pkg.output, pkg.approvals, pkg.learning, pkg.budget, pkg.parameters], [review.output, "never", false, review.budget, review.parameters], "the same answer, cap and parameters as code-review");
  assert.equal(pkg.mcp.length, 1);
  const [need] = pkg.mcp;
  assert.deepEqual([need.source, need.toolkit, need.tools, need.required], ["composio", "github", TOOLS, true]);
  assert.deepEqual(need.allow, TOOLS.filter((tool) => tool !== "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST"), "reads asked to be allowed; the post is the owner's tick");
  for (const tool of TOOLS) assert.deepEqual(need.pin[tool], tool === "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST" ? { ...SCOPE, event: ["COMMENT"] } : SCOPE, `${tool}: held to the one repository`);
  assert.equal(pkg.triggers.length, 1);
  const [trigger] = pkg.triggers;
  assert.deepEqual([trigger.source.kind, trigger.source.server, trigger.source.event, trigger.source.config], ["composio", "github", "GITHUB_PULL_REQUEST_CREATED", { repo: "${parameters.owner}/${parameters.repo}", state: "open" }]);
  assert.deepEqual(trigger.source.accept, [{ event: "GITHUB_PULL_REQUEST_CREATED" }]);
  assert.equal(trigger.target.kind, "start_run");
  assert.ok(pkg.evals.includes("inline-at-line"));
});
